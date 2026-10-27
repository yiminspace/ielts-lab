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


REPOSITORIES = {
    'api': 'ghcr.io/yiminspace/ielts-api',
    'web': 'ghcr.io/yiminspace/ielts-web',
}
SOURCE_LABEL = 'https://github.com/yiminspace/ielts-lab'


def inspect_image(reference):
    result = run(['docker', 'image', 'inspect', reference], stdout=subprocess.PIPE,
                 stderr=subprocess.PIPE, timeout=30)
    images = json.loads(result.stdout)
    if not isinstance(images, list) or len(images) != 1:
        raise ValueError('Image inspection failed')
    return images[0]


def validate_image(image, sha, *, expected_id=None, requested_ref=None):
    image_id = image.get('Id')
    config = image.get('Config') or {}
    labels = config.get('Labels') or {}
    revisions = [value[8:] for value in config.get('Env', []) if value.startswith('GIT_SHA=')]
    if (not isinstance(image_id, str) or not DIGEST.fullmatch(image_id) or
            (expected_id is not None and image_id != expected_id) or
            image.get('Os') != 'linux' or image.get('Architecture') != 'amd64' or
            labels.get('org.opencontainers.image.source') != SOURCE_LABEL or
            labels.get('org.opencontainers.image.revision') != sha or revisions != [sha]):
        raise ValueError('Image identity, platform or release metadata does not match')
    if requested_ref is not None and requested_ref not in image.get('RepoDigests', []):
        raise ValueError('Docker did not retain the requested registry digest')
    return image_id


def read_source_manifest(repository, digest):
    if repository not in REPOSITORIES.values() or not DIGEST.fullmatch(digest):
        raise ValueError('Image source is not allowed')
    # run() constructs a minimal environment without inherited HTTP(S)/ALL_PROXY.
    result = run(['skopeo', 'inspect', '--raw', f'docker://{repository}@{digest}'],
                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
    raw = result.stdout
    if (len(raw) > 2 * 1024 * 1024 or
            'sha256:' + hashlib.sha256(raw).hexdigest() != digest):
        raise ValueError('Registry manifest digest does not match the requested digest')
    manifest = json.loads(raw)
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 2:
        raise ValueError('Unsupported image manifest')
    return manifest


def resolve_source(repository, digest):
    manifest = read_source_manifest(repository, digest)
    selected_digest = digest
    if 'manifests' in manifest:
        entries = manifest['manifests']
        if not isinstance(entries, list):
            raise ValueError('Invalid image index')
        # Buildx may add unknown/unknown provenance entries; never select those.
        candidates = [entry for entry in entries if isinstance(entry, dict) and
                      entry.get('platform', {}).get('os') == 'linux' and
                      entry.get('platform', {}).get('architecture') == 'amd64' and
                      entry.get('platform', {}).get('variant') in (None, '')]
        if len(candidates) != 1 or not DIGEST.fullmatch(candidates[0].get('digest', '')):
            raise ValueError('Image index must contain one Linux amd64 image')
        selected_digest = candidates[0]['digest']
        manifest = read_source_manifest(repository, selected_digest)
        if 'manifests' in manifest:
            raise ValueError('Nested image indexes are not supported')
    config_digest = manifest.get('config', {}).get('digest')
    if not isinstance(config_digest, str) or not DIGEST.fullmatch(config_digest):
        raise ValueError('Image manifest has no valid config digest')
    return selected_digest, config_digest


def prepare_image(role, requested_digest, sha, stage):
    if role not in REPOSITORIES or not DIGEST.fullmatch(requested_digest):
        raise ValueError('Image source is not allowed')
    repository = REPOSITORIES[role]
    requested_ref = f'{repository}@{requested_digest}'
    try:
        run(['docker', 'pull', '--platform', 'linux/amd64', requested_ref],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        # Userspace copy bypasses a broken daemon proxy without changing it.
        selected_digest, expected_id = resolve_source(repository, requested_digest)
        try:
            cached = inspect_image(expected_id)
        except subprocess.CalledProcessError:
            cached = None
        if cached is None:
            with tempfile.TemporaryDirectory(prefix=role + '-image-', dir=stage) as temporary:
                directory = Path(temporary)
                os.chmod(directory, 0o700)
                archive = directory / 'image.tar'
                run(['skopeo', '--override-os', 'linux', '--override-arch', 'amd64', 'copy',
                     '--retry-times', '2', f'docker://{repository}@{selected_digest}',
                     f'docker-archive:{archive}'], stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, timeout=1200)
                os.chmod(archive, 0o600)
                run(['docker', 'load', '--input', str(archive)], stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, timeout=180)
            cached = inspect_image(expected_id)
        # Cached/preloaded images need the same remote digest chain and metadata.
        image_id = validate_image(cached, sha, expected_id=expected_id)
    else:
        image_id = validate_image(inspect_image(requested_ref), sha, requested_ref=requested_ref)
    # Shared platform deploys prune dangling images. Keep a fixed local tag so a
    # just-replaced release remains available for rollback; execution still uses ID.
    local_tag = f'ielts-local/ielts-{role}:sha256-{image_id[7:]}'
    run(['docker', 'tag', image_id, local_tag], stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=30)
    return {'requested': requested_ref, 'imageId': image_id}


def rollback_images(previous):
    sha = previous.get('version')
    if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Previous release version is invalid')
    images = {}
    for role, repository in REPOSITORIES.items():
        requested = previous.get(role)
        prefix = repository + '@'
        if (not isinstance(requested, str) or not requested.startswith(prefix) or
                not DIGEST.fullmatch(requested[len(prefix):])):
            raise ValueError('Previous release source is not allowed')
        image_id = previous.get(role + 'ImageId')
        if image_id is not None:
            if not isinstance(image_id, str) or not DIGEST.fullmatch(image_id):
                raise ValueError('Previous release image identity is invalid')
            images['IELTS_' + role.upper() + '_IMAGE'] = validate_image(
                inspect_image(image_id), sha, expected_id=image_id)
        else:
            # Existing pre-fallback manifests retain only a pinned registry ref.
            images['IELTS_' + role.upper() + '_IMAGE'] = validate_image(
                inspect_image(requested), sha, requested_ref=requested)
    return images


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
            api_artifact = prepare_image('api', api, sha, stage)
            web_artifact = prepare_image('web', web, sha, stage)
            api_image = api_artifact['imageId']
            web_image = web_artifact['imageId']
            run(['docker','run','--rm','--pull','never','--network','web-proxy','--env-file',str(stage/'migration.env'),
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
                run([*compose,'up','-d','--no-build','--pull','never','--wait','--wait-timeout','120'],env=images)
                for container, port in [('ielts-api',4318),('ielts-web',4317)]:
                    script = f"fetch('http://127.0.0.1:{port}/health').then(async r=>{{const b=await r.json();if(!r.ok||b.version!==process.argv[1])process.exit(1)}}).catch(()=>process.exit(1))"
                    run(['docker','exec',container,'node','-e',script,sha])
            except Exception:
                if (stage/'previous.env').exists():
                    os.replace(stage/'previous.env',previous)
                    # Application rollback assumes the migration remains backward compatible.
                    if (BASE/'release.json').is_file():
                        old = json.loads((BASE/'release.json').read_text())
                        restored_images = rollback_images(old)
                        run([*compose,'up','-d','--no-build','--pull','never','--wait','--wait-timeout','120'],env=restored_images)
                raise
            # Fixed image pointers permit restart after host reboot without access to CI.
            image_file = BASE/'.env'
            content = ''.join(f'{key}={value}\n' for key,value in images.items()).encode()
            write_private(stage/'images.env',content); os.replace(stage/'images.env',image_file)
            manifest = {'version':sha,'api':api_artifact['requested'],'web':web_artifact['requested'],
                        'apiImageId':api_image,'webImageId':web_image,'deployedAt':int(time.time())}
            write_private(stage/'release.json',(json.dumps(manifest)+'\n').encode());os.replace(stage/'release.json',BASE/'release.json')
            print(f'IELTS release verified: {sha}')

if __name__ == '__main__':
    try: main()
    except Exception:
        # Underlying Docker/driver exception text may contain secret configuration.
        sys.exit('IELTS release failed; inspect the service locally with authorized access')
