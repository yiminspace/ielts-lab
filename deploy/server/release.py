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
import threading
import time

BASE = Path('/srv/ielts-lab')
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')

def command_environment():
    # Do not forward arbitrary SSH client environment to privileged subprocesses.
    return {'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME':'/root'}


def run(args, **kwargs):
    env = command_environment()
    env.update(kwargs.pop('env', {}))
    return subprocess.run(args, check=True, env=env, **kwargs)


REPOSITORIES = {
    'api': 'ghcr.io/yiminspace/ielts-api',
    'web': 'ghcr.io/yiminspace/ielts-web',
    'learning': 'ghcr.io/yiminspace/ielts-learning',
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


def read_saved_config(stream, expected_config):
    """Read bounded metadata from a Docker save stream without extracting layers.

    The Docker archive manifest supplies the config path. Its naming differs
    between classic and containerd image stores, so never infer it from image ID.
    """
    if not isinstance(expected_config, str) or not DIGEST.fullmatch(expected_config):
        raise ValueError('Expected image config digest is invalid')
    manifest = None
    manifest_seen = False
    matching = []
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            if member.name == 'manifest.json':
                if manifest_seen or not member.isfile():
                    raise ValueError('Docker archive manifest is ambiguous or invalid')
                manifest_seen = True
            if not member.isfile() or member.size > 2 * 1024 * 1024:
                if member.name == 'manifest.json':
                    raise ValueError('Docker archive manifest exceeds its limit')
                continue
            # Only bounded metadata is read into memory; layer tar members stream
            # past without extraction or buffering the full image archive.
            raw = archive.extractfile(member).read()
            if member.name == 'manifest.json':
                manifest = json.loads(raw)
            if 'sha256:' + hashlib.sha256(raw).hexdigest() == expected_config:
                matching.append((member.name, raw))
                if len(matching) > 1:
                    raise ValueError('Docker archive config is ambiguous')
    if (not isinstance(manifest, list) or len(manifest) != 1 or
            not isinstance(manifest[0], dict) or len(matching) != 1 or
            manifest[0].get('Config') != matching[0][0]):
        raise ValueError('Saved image config digest does not match the requested manifest')
    config = json.loads(matching[0][1])
    if not isinstance(config, dict):
        raise ValueError('Saved image config is invalid')
    return config


def verify_saved_image(image, sha, expected_config):
    """Bind an engine's immutable ID to the remotely verified raw config."""
    image_id = validate_image(image, sha)
    # Docker 29's containerd store can report a manifest ID where older engines
    # report the config ID. Export by actual immutable ID and hash the raw config.
    process = subprocess.Popen(['docker', 'image', 'save', image_id],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env=command_environment())
    timer = threading.Timer(180, process.kill)
    timer.daemon = True
    timer.start()
    try:
        saved = read_saved_config(process.stdout, expected_config)
        if process.wait(timeout=15) != 0:
            raise ValueError('Docker image export failed')
    finally:
        timer.cancel()
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
    rootfs = saved.get('rootfs') or {}
    observed = image.get('RootFS') or {}
    layers = rootfs.get('diff_ids')
    if (rootfs.get('type') != 'layers' or observed.get('Type') != 'layers' or
            not isinstance(layers, list) or
            not all(isinstance(value, str) and DIGEST.fullmatch(value) for value in layers) or
            layers != observed.get('Layers')):
        raise ValueError('Saved image rootfs does not match the inspected image')
    # Metadata must agree in both the raw, digest-verified config and inspection.
    validate_image({'Id': image_id, 'Os': saved.get('os'),
                    'Architecture': saved.get('architecture'),
                    'Config': saved.get('config')}, sha)
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
    selected_digest, expected_config = resolve_source(repository, requested_digest)
    selected_ref = f'{repository}@{selected_digest}'
    local_tag = f'ielts-local/ielts-{role}:sha256-{expected_config[7:]}'
    try:
        cached = inspect_image(local_tag)
    except subprocess.CalledProcessError:
        cached = None
    if cached is None:
        try:
            run(['docker', 'pull', '--platform', 'linux/amd64', selected_ref],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            # Userspace copy bypasses a broken daemon proxy without changing it.
            with tempfile.TemporaryDirectory(prefix=role + '-image-', dir=stage) as temporary:
                directory = Path(temporary)
                os.chmod(directory, 0o700)
                archive = directory / 'image.tar'
                run(['skopeo', '--override-os', 'linux', '--override-arch', 'amd64', 'copy',
                     '--retry-times', '2', f'docker://{repository}@{selected_digest}',
                     f'docker-archive:{archive}:{local_tag}'], stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, timeout=1200)
                os.chmod(archive, 0o600)
                run(['docker', 'load', '--input', str(archive)], stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, timeout=180)
            cached = inspect_image(local_tag)
        else:
            cached = inspect_image(selected_ref)
            validate_image(cached, sha, requested_ref=selected_ref)
    # Cached/preloaded and freshly loaded images need the same remote digest
    # chain, raw config, rootfs and release metadata, regardless of engine layout.
    image_id = verify_saved_image(cached, sha, expected_config)
    # Shared platform deploys prune dangling images. Keep a fixed local tag so a
    # just-replaced release remains available for rollback; execution still uses ID.
    run(['docker', 'tag', image_id, local_tag], stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=30)
    return {'requested': requested_ref, 'imageId': image_id}


def rollback_images(previous):
    sha = previous.get('version')
    if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Previous release version is invalid')
    images = {}
    roles = ['api', 'web'] + (['learning'] if 'learning' in previous else [])
    if 'learningImageId' in previous and 'learning' not in previous:
        raise ValueError('Previous learning release source is missing')
    for role in roles:
        repository = REPOSITORIES[role]
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

CONFIG_FILES = ('runtime.env', 'api-learning.env', 'learning.env')
STATE_FILES = (*CONFIG_FILES, '.env', 'release.json')


def parse_invocation(arguments):
    if len(arguments) == 3:
        api, web, sha = arguments
        requested = {'api': api, 'web': web}
    elif len(arguments) == 4:
        api, web, learning, sha = arguments
        requested = {'api': api, 'web': web, 'learning': learning}
    else:
        raise ValueError('Invalid release invocation')
    if (not re.fullmatch(r'[0-9a-f]{40}', sha) or
            any(not DIGEST.fullmatch(value) for value in requested.values())):
        raise ValueError('Invalid immutable image references')
    return requested, sha


def receive_configurations(payload, stage, with_learning):
    expected = {'runtime.env', 'migration.env'}
    if with_learning:
        expected |= {'api-learning.env', 'learning.env'}
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as archive:
        members = archive.getmembers()
        if len(members) != len(expected) or {item.name for item in members} != expected:
            raise ValueError('Unexpected deployment payload')
        for item in members:
            if not item.isfile() or not 0 < item.size <= 256 * 1024:
                raise ValueError('Only bounded regular configuration files are accepted')
            raw = archive.extractfile(item).read()
            if len(raw) != item.size:
                raise ValueError('Configuration payload was truncated')
            write_private(stage / item.name, raw)


def snapshot_state(stage):
    backup = stage / 'previous'
    backup.mkdir(mode=0o700)
    existing = set()
    for name in STATE_FILES:
        current = BASE / name
        if current.is_symlink() or (current.exists() and not current.is_file()):
            raise ValueError('Deployment state must consist of regular files')
        if current.exists():
            if current.stat().st_size > 256 * 1024:
                raise ValueError('Previous deployment state exceeds its limit')
            shutil.copyfile(current, backup / name)
            os.chmod(backup / name, 0o600)
            existing.add(name)
    return existing


def restore_state(stage, existing):
    for name in STATE_FILES:
        destination = BASE / name
        if name in existing:
            os.replace(stage / 'previous' / name, destination)
            os.chmod(destination, 0o600)
        elif destination.is_symlink() or destination.is_file():
            destination.unlink()
        elif destination.exists():
            raise ValueError('Cannot restore unexpected deployment state')


def persistent_directories():
    data = BASE / 'data'
    if data.is_symlink() or (data.exists() and not data.is_dir()):
        raise ValueError('Persistent data parent must be a regular directory')
    data.mkdir(mode=0o700, exist_ok=True)
    for name, owner in [('daily', 1000), ('runtime', 10001)]:
        directory = data / name
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError('Persistent data must not be a symlink')
        directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        os.chown(directory, owner, owner)


def compose_command(images):
    arguments = ['docker', 'compose', '-f', str(BASE / 'compose.yml')]
    if 'IELTS_LEARNING_IMAGE' in images:
        overlay = BASE / 'learning.compose.yml'
        if overlay.is_symlink() or not overlay.is_file():
            raise ValueError('Trusted learning deployment overlay is not installed')
        arguments += ['-f', str(overlay)]
    return arguments


def stop_learning():
    # Remove only the fixed container. Its private bind-mounted data stays intact.
    try:
        run(['docker', 'rm', '--force', 'ielts-learning'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    except subprocess.CalledProcessError as error:
        if b'No such container' not in (error.stderr or b''):
            raise


def verify_health(sha, with_learning):
    for container, port in [('ielts-api', 4318), ('ielts-web', 4317)]:
        script = f"fetch('http://127.0.0.1:{port}/health').then(async r=>{{const b=await r.json();if(!r.ok||b.version!==process.argv[1])process.exit(1)}}).catch(()=>process.exit(1))"
        run(['docker', 'exec', container, 'node', '-e', script, sha],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if with_learning:
        script = """import json, os, sys, urllib.request, urllib.error
base = 'http://127.0.0.1:4320'
with urllib.request.urlopen(base + '/healthz', timeout=10) as response:
    if response.status != 200:
        raise SystemExit(1)
request = urllib.request.Request(base + '/health', headers={
    'Authorization': 'Bearer ' + os.environ['IELTS_RUNTIME_TOKEN']})
with urllib.request.urlopen(request, timeout=10) as response:
    body = json.load(response)
    if response.status != 200 or body.get('version') != sys.argv[1]:
        raise SystemExit(1)
try:
    urllib.request.urlopen(base + '/health', timeout=10)
except urllib.error.HTTPError as error:
    if error.code != 401:
        raise SystemExit(1)
else:
    raise SystemExit(1)
"""
        run(['docker', 'exec', 'ielts-learning', 'python', '-c', script, sha],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)


def main():
    if os.geteuid() != 0:
        raise ValueError('Invalid release invocation')
    requested, sha = parse_invocation(sys.argv[1:])
    with_learning = 'learning' in requested
    compose_file = BASE / 'compose.yml'
    if (not BASE.is_dir() or BASE.is_symlink() or
            compose_file.is_symlink() or not compose_file.is_file()):
        raise ValueError('Trusted deployment directory is not installed')
    with open(BASE / '.maintenance.lock', 'a') as maintenance:
        os.chmod(BASE / '.maintenance.lock', 0o600)
        fcntl.flock(maintenance, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def receive_timeout(signum, frame):
            raise TimeoutError('Release payload timed out')
        signal.signal(signal.SIGALRM, receive_timeout)
        signal.alarm(15)
        try:
            payload = sys.stdin.buffer.read(1024 * 1024 + 1)
        finally:
            signal.alarm(0)
        if len(payload) > 1024 * 1024:
            raise ValueError('Configuration payload exceeds limit')
        with tempfile.TemporaryDirectory(prefix='ielts-release-', dir=BASE) as temporary:
            stage = Path(temporary)
            os.chmod(stage, 0o700)
            receive_configurations(payload, stage, with_learning)
            spec = importlib.util.spec_from_file_location('ielts_validate', '/usr/local/lib/ielts-lab/validate-env.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            configurations = [module.read_env(stage / 'runtime.env'), module.read_env(stage / 'migration.env')]
            if with_learning:
                configurations += [module.read_env(stage / 'api-learning.env'), module.read_env(stage / 'learning.env')]
            module.validate(*configurations)
            # Validate all image sources before a migration or active config change.
            artifacts = {role: prepare_image(role, value, sha, stage) for role, value in requested.items()}
            images = {'IELTS_' + role.upper() + '_IMAGE': artifact['imageId'] for role, artifact in artifacts.items()}
            compose = compose_command(images)
            existing = snapshot_state(stage)
            previous = json.loads((stage / 'previous' / 'release.json').read_text()) if 'release.json' in existing else None
            # A rollback is prepared in advance; databases and schema are never rolled back.
            restored_images = rollback_images(previous) if previous is not None else None
            if with_learning:
                persistent_directories()
            run(['docker', 'run', '--rm', '--pull', 'never', '--network', 'web-proxy',
                 '--env-file', str(stage / 'migration.env'), '--read-only', '--cap-drop', 'ALL',
                 '--security-opt', 'no-new-privileges:true', images['IELTS_API_IMAGE'],
                 'node', 'services/api/scripts/migrate.mjs', 'up'])
            try:
                active_names = CONFIG_FILES if with_learning else ('runtime.env',)
                for name in CONFIG_FILES:
                    destination = BASE / name
                    if name in active_names:
                        os.replace(stage / name, destination)
                        os.chmod(destination, 0o600)
                    elif destination.exists():
                        destination.unlink()
                if not with_learning:
                    stop_learning()
                run([*compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120'], env=images)
                verify_health(sha, with_learning)
                # Fixed immutable pointers allow restart without access to CI.
                content = ''.join(f'{key}={value}\n' for key, value in images.items()).encode()
                write_private(stage / 'images.env', content)
                os.replace(stage / 'images.env', BASE / '.env')
                manifest = {'version': sha, 'deployedAt': int(time.time())}
                for role, artifact in artifacts.items():
                    manifest[role] = artifact['requested']
                    manifest[role + 'ImageId'] = artifact['imageId']
                write_private(stage / 'release.json', (json.dumps(manifest) + '\n').encode())
                os.replace(stage / 'release.json', BASE / 'release.json')
            except Exception:
                restore_state(stage, existing)
                if restored_images is not None:
                    if 'IELTS_LEARNING_IMAGE' not in restored_images:
                        stop_learning()
                    old_compose = compose_command(restored_images)
                    run([*old_compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120'], env=restored_images)
                raise
            print(f'IELTS release verified: {sha}')

if __name__ == '__main__':
    try: main()
    except Exception:
        # Underlying Docker/driver exception text may contain secret configuration.
        sys.exit('IELTS release failed; inspect the service locally with authorized access')
