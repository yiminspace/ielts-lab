#!/usr/bin/env python3
"""Root-owned fixed release endpoint; never execute files supplied by CI."""
from pathlib import Path
import hashlib
import fcntl
import signal
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

BASE = Path('/srv/ielts-lab')
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')

def run(args, **kwargs):
    # Do not forward arbitrary SSH client environment to privileged subprocesses.
    env = {'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME':'/root'}
    env.update(kwargs.pop('env', {}))
    return subprocess.run(args, check=True, env=env, **kwargs)

def write_private(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as output: output.write(data)

def main():
    if os.geteuid() != 0 or len(sys.argv) != 4: raise ValueError('Invalid release invocation')
    api, web, sha = sys.argv[1:]
    if not DIGEST.fullmatch(api) or not DIGEST.fullmatch(web) or not re.fullmatch(r'[0-9a-f]{40}', sha): raise ValueError('Invalid immutable image references')
    if not BASE.is_dir() or BASE.is_symlink() or not (BASE/'compose.yml').is_file(): raise ValueError('Trusted deployment directory is not installed')
    with open(BASE/'.maintenance.lock', 'a') as maintenance:
        os.chmod(BASE/'.maintenance.lock', 0o600)
        fcntl.flock(maintenance, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def receive_timeout(signum, frame): raise TimeoutError('Release payload timed out')
        signal.signal(signal.SIGALRM, receive_timeout); signal.alarm(15)
        try: payload = sys.stdin.buffer.read(1024*1024+1)
        finally: signal.alarm(0)
        if len(payload) > 1024*1024: raise ValueError('Configuration payload exceeds limit')
        with tempfile.TemporaryDirectory(prefix='ielts-release-', dir=BASE) as temporary:
            stage = Path(temporary); os.chmod(stage, 0o700)
            with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as archive:
                members = archive.getmembers()
                if len(members) != 2 or {item.name for item in members} != {'runtime.env','migration.env'}: raise ValueError('Unexpected deployment payload')
                for item in members:
                    if not item.isfile() or item.size > 256*1024: raise ValueError('Only bounded regular configuration files are accepted')
                    write_private(stage/item.name, archive.extractfile(item).read())
            spec = importlib.util.spec_from_file_location('ielts_validate', '/usr/local/lib/ielts-lab/validate-env.py')
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            module.validate(module.read_env(stage/'runtime.env'), module.read_env(stage/'migration.env'))
            api_image = f'ghcr.io/yiminspace/ielts-api@{api}'
            web_image = f'ghcr.io/yiminspace/ielts-web@{web}'
            # Public immutable GHCR images need no registry credentials in the application.
            run(['docker','pull',api_image]); run(['docker','pull',web_image])
            run(['docker','run','--rm','--network','web-proxy','--env-file',str(stage/'migration.env'),
                 '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',api_image,
                 'node','services/api/scripts/migrate.mjs','up'])
            previous = BASE/'runtime.env'
            if previous.exists():
                if previous.is_symlink() or not previous.is_file(): raise ValueError('Runtime configuration must be a regular file')
                shutil.copyfile(previous, stage/'previous.env'); os.chmod(stage/'previous.env',0o600)
            os.replace(stage/'runtime.env', previous); os.chmod(previous,0o600)
            images = {'IELTS_API_IMAGE':api_image,'IELTS_WEB_IMAGE':web_image}
            compose = ['docker','compose','-f',str(BASE/'compose.yml')]
            try:
                run([*compose,'up','-d','--no-build','--wait','--wait-timeout','120'],env=images)
                for container, port in [('ielts-api',4318),('ielts-web',4317)]:
                    script = f"fetch('http://127.0.0.1:{port}/health').then(async r=>{{const b=await r.json();if(!r.ok||b.version!==process.argv[1])process.exit(1)}}).catch(()=>process.exit(1))"
                    run(['docker','exec',container,'node','-e',script,sha])
            except Exception:
                if (stage/'previous.env').exists():
                    os.replace(stage/'previous.env',previous)
                    # Application rollback assumes the migration remains backward compatible.
                    if (BASE/'release.json').is_file():
                        old = json.loads((BASE/'release.json').read_text())
                        for key, prefix in [('api','ghcr.io/yiminspace/ielts-api@'),('web','ghcr.io/yiminspace/ielts-web@')]:
                            if not str(old.get(key,'')).startswith(prefix) or not DIGEST.fullmatch(old[key][len(prefix):]): raise ValueError('Invalid previous release')
                        run([*compose,'up','-d','--no-build','--wait','--wait-timeout','120'],env={'IELTS_API_IMAGE':old['api'],'IELTS_WEB_IMAGE':old['web']})
                raise
            # Fixed image pointers permit restart after host reboot without access to CI.
            image_file = BASE/'.env'
            content = ''.join(f'{key}={value}\n' for key,value in images.items()).encode()
            write_private(stage/'images.env',content); os.replace(stage/'images.env',image_file)
            manifest = {'version':sha,'api':api_image,'web':web_image,'deployedAt':int(time.time())}
            write_private(stage/'release.json',(json.dumps(manifest)+'\n').encode());os.replace(stage/'release.json',BASE/'release.json')
            print(f'IELTS release verified: {sha}')

if __name__ == '__main__':
    try: main()
    except Exception:
        # Underlying Docker/driver exception text may contain secret configuration.
        sys.exit('IELTS release failed; inspect the service locally with authorized access')
