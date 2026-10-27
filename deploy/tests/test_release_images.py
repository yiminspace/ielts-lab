"""Exercise pinned image loading and rollback without registry/server access."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ielts_release_images', ROOT / 'deploy/server/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SHA = 'a' * 40
OLD_SHA = 'b' * 40
API_DIGEST = 'sha256:' + '1' * 64
WEB_DIGEST = 'sha256:' + '2' * 64
API_ID = 'sha256:' + '3' * 64
WEB_ID = 'sha256:' + '4' * 64


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()


def digest(value):
    return 'sha256:' + hashlib.sha256(value).hexdigest()


def image(image_id=API_ID, sha=SHA, requested=None):
    return {
        'Id': image_id, 'Os': 'linux', 'Architecture': 'amd64',
        'RepoDigests': [requested] if requested else [],
        'Config': {'Env': ['GIT_SHA=' + sha], 'Labels': {
            'org.opencontainers.image.source': release.SOURCE_LABEL,
            'org.opencontainers.image.revision': sha,
        }},
    }


class ImageAcquisitionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.stage = Path(self.temp.name)
        self.calls = []
        self.leaf = encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                             'config': {'digest': API_ID}, 'layers': []})
        self.leaf_digest = digest(self.leaf)
        self.index = encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [
            {'digest': self.leaf_digest, 'platform': {'os': 'linux', 'architecture': 'amd64'}},
            {'digest': 'sha256:' + 'f' * 64, 'platform': {'os': 'unknown', 'architecture': 'unknown'}},
        ]})
        self.index_digest = digest(self.index)
        self.manifests = {self.index_digest: self.index, self.leaf_digest: self.leaf}
        self.observed = image()
        self.loaded = False

    def fallback_command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ['docker', 'pull']:
            raise subprocess.CalledProcessError(1, args, stderr=b'synthetic proxy EOF')
        if args[:3] == ['skopeo', 'inspect', '--raw']:
            requested = args[-1].rsplit('@', 1)[1]
            return subprocess.CompletedProcess(args, 0, stdout=self.manifests[requested])
        if 'copy' in args and args[0] == 'skopeo':
            archive = Path(args[-1].removeprefix('docker-archive:'))
            self.assertEqual(archive.parent.stat().st_mode & 0o777, 0o700)
            archive.write_bytes(b'original fake image archive')
        if args[:2] == ['docker', 'load']:
            self.assertEqual(Path(args[-1]).stat().st_mode & 0o777, 0o600)
            self.loaded = True
        if args[:3] == ['docker', 'image', 'inspect']:
            self.assertEqual(args[-1], API_ID)
            if not self.loaded:
                raise subprocess.CalledProcessError(1, args, stderr=b'No such image')
            return subprocess.CompletedProcess(args, 0, stdout=encoded([self.observed]))
        return subprocess.CompletedProcess(args, 0, stdout=b'')

    def test_index_child_config_chain_is_verified_and_runtime_uses_config_image_id(self):
        with mock.patch.object(release, 'run', side_effect=self.fallback_command):
            result = release.prepare_image('api', self.index_digest, SHA, self.stage)
        self.assertEqual(result, {'requested': release.REPOSITORIES['api'] + '@' + self.index_digest, 'imageId': API_ID})
        copy_call = next(args for args, _ in self.calls if args[0] == 'skopeo' and 'copy' in args)
        self.assertIn('docker://' + release.REPOSITORIES['api'] + '@' + self.leaf_digest, copy_call)
        self.assertNotIn('docker://' + release.REPOSITORIES['api'] + '@sha256:' + 'f' * 64, copy_call)
        self.assertEqual(list(self.stage.iterdir()), [])
        self.assertTrue(any(args == ['docker','tag',API_ID,'ielts-local/ielts-api:sha256-'+API_ID[7:]] for args,_ in self.calls))

    def test_verified_cached_image_avoids_copy_but_still_checks_remote_digest_and_metadata(self):
        self.loaded = True
        with mock.patch.object(release, 'run', side_effect=self.fallback_command):
            self.assertEqual(release.prepare_image('api', self.index_digest, SHA, self.stage)['imageId'], API_ID)
        self.assertFalse(any('copy' in args or args[:2] == ['docker', 'load'] for args, _ in self.calls))
        self.assertEqual(sum(args[:3] == ['skopeo', 'inspect', '--raw'] for args, _ in self.calls), 2)
        self.observed['Config']['Labels']['org.opencontainers.image.revision'] = OLD_SHA
        with mock.patch.object(release, 'run', side_effect=self.fallback_command):
            with self.assertRaisesRegex(ValueError, 'identity, platform or release metadata'):
                release.prepare_image('api', self.index_digest, SHA, self.stage)

    def test_corrupt_requested_index_aborts_before_copy_or_load(self):
        self.manifests[self.index_digest] += b' '
        with mock.patch.object(release, 'run', side_effect=self.fallback_command):
            with self.assertRaisesRegex(ValueError, 'manifest digest'):
                release.prepare_image('api', self.index_digest, SHA, self.stage)
        self.assertFalse(any(args[:2] == ['docker', 'load'] or 'copy' in args for args, _ in self.calls))

    def test_corrupt_child_manifest_aborts_before_load(self):
        self.manifests[self.leaf_digest] += b' '
        with mock.patch.object(release, 'run', side_effect=self.fallback_command):
            with self.assertRaisesRegex(ValueError, 'manifest digest'):
                release.prepare_image('api', self.index_digest, SHA, self.stage)
        self.assertFalse(any(args[:2] == ['docker', 'load'] for args, _ in self.calls))

    def test_ambiguous_amd64_or_provenance_only_index_is_rejected(self):
        for entries in ([{'digest': self.leaf_digest, 'platform': {'os': 'unknown', 'architecture': 'unknown'}}],
                        [{'digest': self.leaf_digest, 'platform': {'os': 'linux', 'architecture': 'amd64'}}] * 2):
            raw = encoded({'schemaVersion': 2, 'manifests': entries})
            self.manifests[digest(raw)] = raw
            with mock.patch.object(release, 'run', side_effect=self.fallback_command):
                with self.assertRaisesRegex(ValueError, 'one Linux amd64'):
                    release.prepare_image('api', digest(raw), SHA, self.stage)

    def test_loaded_image_must_match_manifest_config_and_release_metadata(self):
        for mutation in ('image-id', 'source', 'revision', 'git-sha', 'platform'):
            self.observed = image()
            if mutation == 'image-id': self.observed['Id'] = WEB_ID
            if mutation == 'source': self.observed['Config']['Labels']['org.opencontainers.image.source'] = 'https://evil.example/repo'
            if mutation == 'revision': self.observed['Config']['Labels']['org.opencontainers.image.revision'] = OLD_SHA
            if mutation == 'git-sha': self.observed['Config']['Env'] = ['GIT_SHA=' + OLD_SHA]
            if mutation == 'platform': self.observed['Architecture'] = 'arm64'
            with self.subTest(mutation=mutation), mock.patch.object(release, 'run', side_effect=self.fallback_command):
                with self.assertRaisesRegex(ValueError, 'identity, platform or release metadata'):
                    release.prepare_image('api', self.index_digest, SHA, self.stage)
            self.assertEqual(list(self.stage.iterdir()), [])

    def test_successful_daemon_pull_still_checks_requested_digest_and_metadata(self):
        requested = release.REPOSITORIES['api'] + '@' + API_DIGEST
        def command(args, **kwargs):
            self.calls.append((args, kwargs))
            if args[:3] == ['docker', 'image', 'inspect']:
                return subprocess.CompletedProcess(args, 0, stdout=encoded([image(requested=requested)]))
            return subprocess.CompletedProcess(args, 0, stdout=b'')
        with mock.patch.object(release, 'run', side_effect=command):
            self.assertEqual(release.prepare_image('api', API_DIGEST, SHA, self.stage)['imageId'], API_ID)
        self.assertFalse(any(args[0] == 'skopeo' for args, _ in self.calls))
        bad = image(requested=release.REPOSITORIES['api'] + '@' + WEB_DIGEST)
        with mock.patch.object(release, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=encoded([bad]))):
            with self.assertRaisesRegex(ValueError, 'requested registry digest'):
                release.prepare_image('api', API_DIGEST, SHA, self.stage)

    def test_source_is_fixed_and_proxy_environment_is_not_inherited(self):
        with mock.patch.object(release, 'run') as call:
            with self.assertRaises(ValueError): release.prepare_image('other-repository', API_DIGEST, SHA, self.stage)
            call.assert_not_called()
        proxies = {key: 'http://synthetic-proxy.invalid' for key in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')}
        with mock.patch.dict(os.environ, proxies), mock.patch.object(release.subprocess, 'run') as run:
            release.run(['skopeo','inspect','--raw','docker://example'])
        self.assertFalse(set(proxies) & run.call_args.kwargs['env'].keys())


class ReleaseIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        (self.base / 'compose.yml').write_text('original synthetic compose fixture')
        self.calls = []
        self.payload = io.BytesIO()
        contents = {
            'runtime.env': '\n'.join([
                'NODE_ENV=production', 'IELTS_AUTH_REQUIRED=1',
                'PUBLIC_ORIGIN=https://ielts.yiminlab.site', 'AUTHKIT_API_URL=https://api.yiminlab.site',
                'OWNER_USER_ID=00000000-0000-4000-8000-000000000001',
                'DATABASE_URL=postgres://ielts_app:synthetic@postgres/ielts_db',
                'SESSION_SECRET=' + 'synthetic-session-' * 3]) + '\n',
            'migration.env': 'DATABASE_URL=postgres://ielts_app:synthetic@postgres/ielts_db\nMIGRATION_DATABASE_URL=postgres://ielts_migrator:synthetic@postgres/ielts_db\n',
        }
        with tarfile.open(fileobj=self.payload, mode='w:') as archive:
            for name, text in contents.items():
                member = tarfile.TarInfo(name); member.size = len(text.encode()); archive.addfile(member, io.BytesIO(text.encode()))
        self.payload.seek(0)

    def command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:3] == ['docker','image','inspect']:
            requested = args[-1]
            role = 'api' if 'ielts-api@' in requested else 'web'
            result = image(API_ID if role == 'api' else WEB_ID, requested=requested)
            return subprocess.CompletedProcess(args, 0, stdout=encoded([result]))
        return subprocess.CompletedProcess(args, 0, stdout=b'')

    def invoke(self, command=None):
        original_spec = importlib.util.spec_from_file_location
        def validator(name, path): return original_spec(name, ROOT / 'deploy/validate-env.py')
        with mock.patch.object(release, 'BASE', self.base), mock.patch.object(release.os, 'geteuid', return_value=0), \
             mock.patch.object(release.sys, 'argv', ['release.py',API_DIGEST,WEB_DIGEST,SHA]), \
             mock.patch.object(release.sys, 'stdin', types.SimpleNamespace(buffer=self.payload)), \
             mock.patch.object(release.signal, 'signal'), mock.patch.object(release.signal, 'alarm'), \
             mock.patch.object(release.importlib.util, 'spec_from_file_location', side_effect=validator), \
             mock.patch.object(release, 'run', side_effect=command or self.command), contextlib.redirect_stdout(io.StringIO()):
            release.main()

    def test_commit_sha_and_image_ids_are_persisted_and_all_execution_disallows_pull(self):
        self.invoke()
        stored = json.loads((self.base/'release.json').read_text())
        self.assertEqual(stored['api'],release.REPOSITORIES['api']+'@'+API_DIGEST)
        self.assertEqual(stored['apiImageId'],API_ID)
        self.assertEqual(stored['webImageId'],WEB_ID)
        self.assertEqual(stored['version'],SHA)
        self.assertIn('IELTS_API_IMAGE='+API_ID,(self.base/'.env').read_text())
        migration = next(args for args,_ in self.calls if args[:2] == ['docker','run'])
        self.assertIn(API_ID,migration)
        self.assertEqual(migration[migration.index('--pull')+1],'never')
        compose = next((args,kwargs) for args,kwargs in self.calls if args[:2] == ['docker','compose'])
        self.assertEqual(compose[1]['env']['IELTS_API_IMAGE'],API_ID)
        self.assertEqual(compose[0][compose[0].index('--pull')+1],'never')
        self.assertEqual((self.base/'runtime.env').stat().st_mode&0o777,0o600)

    def test_bad_image_is_rejected_before_migration_or_runtime_configuration_replacement(self):
        (self.base/'runtime.env').write_text('old configuration remains')
        def command(args,**kwargs):
            if args[:3] == ['docker','image','inspect']:
                bad = image(requested=args[-1]);bad['Config']['Labels']['org.opencontainers.image.revision']=OLD_SHA
                self.calls.append((args,kwargs))
                return subprocess.CompletedProcess(args,0,stdout=encoded([bad]))
            return self.command(args,**kwargs)
        with self.assertRaises(ValueError):self.invoke(command)
        self.assertEqual((self.base/'runtime.env').read_text(),'old configuration remains')
        self.assertFalse(any(args[:2] == ['docker','run'] or args[:2] == ['docker','compose'] for args,_ in self.calls))

    def test_rollback_only_accepts_fixed_sources_and_validated_local_ids(self):
        old = {'version':OLD_SHA,'api':release.REPOSITORIES['api']+'@'+API_DIGEST,'web':release.REPOSITORIES['web']+'@'+WEB_DIGEST,'apiImageId':API_ID,'webImageId':WEB_ID}
        with mock.patch.object(release,'inspect_image',side_effect=lambda value:image(value,OLD_SHA)):
            self.assertEqual(release.rollback_images(old),{'IELTS_API_IMAGE':API_ID,'IELTS_WEB_IMAGE':WEB_ID})
        for mutation in ({**old,'api':'ghcr.io/other/ielts-api@'+API_DIGEST},{**old,'apiImageId':'ielts-api:latest'},{**old,'version':'dev'}):
            with self.assertRaises(ValueError):release.rollback_images(mutation)
        with mock.patch.object(release,'inspect_image',return_value=image(API_ID,SHA)):
            with self.assertRaises(ValueError):release.rollback_images(old)

    def test_legacy_rollback_is_resolved_to_verified_image_ids(self):
        old = {'version':OLD_SHA,'api':release.REPOSITORIES['api']+'@'+API_DIGEST,'web':release.REPOSITORIES['web']+'@'+WEB_DIGEST}
        def observed(reference): return image(API_ID if 'ielts-api' in reference else WEB_ID,OLD_SHA,reference)
        with mock.patch.object(release,'inspect_image',side_effect=observed):
            self.assertEqual(release.rollback_images(old),{'IELTS_API_IMAGE':API_ID,'IELTS_WEB_IMAGE':WEB_ID})


if __name__ == '__main__':unittest.main()
