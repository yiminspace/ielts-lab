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


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()


def digest(value):
    return 'sha256:' + hashlib.sha256(value).hexdigest()


def raw_config(sha=SHA, role='api'):
    return encoded({'os': 'linux', 'architecture': 'amd64',
                    'config': {'Env': ['GIT_SHA=' + sha, 'ROLE=' + role], 'Labels': {
                        'org.opencontainers.image.source': release.SOURCE_LABEL,
                        'org.opencontainers.image.revision': sha}},
                    'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + 'd' * 64]}})


API_CONFIG = raw_config()
WEB_CONFIG = raw_config(role='web')
API_ID = digest(API_CONFIG)
WEB_ID = digest(WEB_CONFIG)
MANIFEST_ID = 'sha256:' + 'e' * 64


def image(image_id=API_ID, sha=SHA, requested=None):
    config = json.loads(raw_config(sha))
    return {'Id': image_id, 'Os': 'linux', 'Architecture': 'amd64',
            'RepoDigests': [requested] if requested else [],
            'Config': config['config'],
            'RootFS': {'Type': 'layers', 'Layers': config['rootfs']['diff_ids']}}


def saved_archive(config=API_CONFIG, path='arbitrary/config.json', reference=None, duplicate=False):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w:') as archive:
        entries = [(path, config), ('layers/original-layer.tar', b'original synthetic layer')]
        if duplicate: entries.append(('another/config.json', config))
        entries.append(('manifest.json', encoded([{'Config': reference or path, 'Layers': ['layers/original-layer.tar']}])) )
        for name, raw in entries:
            member = tarfile.TarInfo(name); member.size = len(raw)
            archive.addfile(member, io.BytesIO(raw))
    return result.getvalue()


def export_process(raw):
    return types.SimpleNamespace(stdout=io.BytesIO(raw), wait=mock.Mock(return_value=0),
                                 poll=mock.Mock(return_value=0), kill=mock.Mock())


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
        self.pull_succeeds = False
        self.saved_config = API_CONFIG
        self.saved_path = 'arbitrary/config.json'
        self.cache_tag = 'ielts-local/ielts-api:sha256-' + API_ID[7:]

    def command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ['docker', 'pull']:
            if not self.pull_succeeds:
                raise subprocess.CalledProcessError(1, args, stderr=b'synthetic proxy EOF')
            self.loaded = True
        if args[:3] == ['skopeo', 'inspect', '--raw']:
            requested = args[-1].rsplit('@', 1)[1]
            return subprocess.CompletedProcess(args, 0, stdout=self.manifests[requested])
        if 'copy' in args and args[0] == 'skopeo':
            destination = args[-1].removeprefix('docker-archive:')
            archive_name, tag = destination.split(':', 1)
            self.assertEqual(tag, self.cache_tag)
            archive = Path(archive_name)
            self.assertEqual(archive.parent.stat().st_mode & 0o777, 0o700)
            archive.write_bytes(b'original fake image archive')
        if args[:2] == ['docker', 'load']:
            self.assertEqual(Path(args[-1]).stat().st_mode & 0o777, 0o600)
            self.loaded = True
        if args[:3] == ['docker', 'image', 'inspect']:
            self.assertIn(args[-1], [self.cache_tag, release.REPOSITORIES['api'] + '@' + self.leaf_digest])
            if not self.loaded:
                raise subprocess.CalledProcessError(1, args, stderr=b'No such image')
            return subprocess.CompletedProcess(args, 0, stdout=encoded([self.observed]))
        return subprocess.CompletedProcess(args, 0, stdout=b'')

    def export(self, args, **kwargs):
        self.assertEqual(args, ['docker', 'image', 'save', self.observed['Id']])
        self.calls.append((args, kwargs))
        return export_process(saved_archive(self.saved_config, self.saved_path))

    @contextlib.contextmanager
    def commands(self):
        with mock.patch.object(release, 'run', side_effect=self.command), \
             mock.patch.object(release.subprocess, 'Popen', side_effect=self.export):
            yield

    def test_index_child_config_chain_and_both_engine_ids_are_verified(self):
        for actual_id, path in [(API_ID, API_ID[7:] + '.json'),
                                (MANIFEST_ID, 'blobs/sha256/' + API_ID[7:])]:
            with self.subTest(engine_id=actual_id):
                self.loaded = False
                self.observed = image(actual_id)
                self.saved_path = path
                with self.commands():
                    result = release.prepare_image('api', self.index_digest, SHA, self.stage)
                self.assertEqual(result, {'requested': release.REPOSITORIES['api'] + '@' + self.index_digest,
                                          'imageId': actual_id})
                self.assertEqual(list(self.stage.iterdir()), [])
                self.assertTrue(any(args == ['docker','tag',actual_id,self.cache_tag] for args,_ in self.calls))
        copy_call = next(args for args, _ in self.calls if args[0] == 'skopeo' and 'copy' in args)
        self.assertIn('docker://' + release.REPOSITORIES['api'] + '@' + self.leaf_digest, copy_call)
        self.assertTrue(copy_call[-1].endswith(':' + self.cache_tag))

    def test_verified_cached_manifest_id_avoids_pull_and_copy_but_checks_remote_config(self):
        self.loaded = True
        self.observed = image(MANIFEST_ID)
        with self.commands():
            self.assertEqual(release.prepare_image('api', self.index_digest, SHA, self.stage)['imageId'], MANIFEST_ID)
        self.assertFalse(any('copy' in args or args[:2] in (['docker', 'load'], ['docker', 'pull']) for args, _ in self.calls))
        self.assertEqual(sum(args[:3] == ['skopeo', 'inspect', '--raw'] for args, _ in self.calls), 2)
        self.assertTrue(any(args[:3] == ['docker','image','save'] for args,_ in self.calls))

    def test_cached_and_newly_loaded_wrong_config_are_rejected(self):
        self.saved_config = WEB_CONFIG
        for cached in [True, False]:
            self.loaded = cached
            self.observed = image(MANIFEST_ID)
            with self.subTest(cached=cached), self.commands():
                with self.assertRaisesRegex(ValueError, 'config digest'):
                    release.prepare_image('api', self.index_digest, SHA, self.stage)
            self.assertEqual(list(self.stage.iterdir()), [])

    def test_cached_and_newly_loaded_wrong_rootfs_are_rejected(self):
        for cached in [True, False]:
            self.loaded = cached
            self.observed = image(MANIFEST_ID)
            self.observed['RootFS']['Layers'] = ['sha256:' + '9' * 64]
            with self.subTest(cached=cached), self.commands():
                with self.assertRaisesRegex(ValueError, 'rootfs'):
                    release.prepare_image('api', self.index_digest, SHA, self.stage)
            self.assertEqual(list(self.stage.iterdir()), [])

    def test_archive_config_must_be_uniquely_referenced_by_its_manifest(self):
        for raw in [saved_archive(reference='wrong/config.json'), saved_archive(duplicate=True)]:
            with self.subTest(archive_size=len(raw)), self.assertRaisesRegex(ValueError, 'config'):
                release.read_saved_config(io.BytesIO(raw), API_ID)

    def test_digest_verified_raw_config_also_requires_release_metadata(self):
        raw = raw_config(OLD_SHA)
        with mock.patch.object(release.subprocess, 'Popen', return_value=export_process(saved_archive(raw))):
            with self.assertRaisesRegex(ValueError, 'identity, platform or release metadata'):
                release.verify_saved_image(image(MANIFEST_ID), SHA, digest(raw))

    def test_corrupt_requested_index_aborts_before_copy_or_load(self):
        self.manifests[self.index_digest] += b' '
        with self.commands():
            with self.assertRaisesRegex(ValueError, 'manifest digest'):
                release.prepare_image('api', self.index_digest, SHA, self.stage)
        self.assertFalse(any(args[:2] == ['docker', 'load'] or 'copy' in args for args, _ in self.calls))

    def test_corrupt_child_manifest_aborts_before_load(self):
        self.manifests[self.leaf_digest] += b' '
        with self.commands():
            with self.assertRaisesRegex(ValueError, 'manifest digest'):
                release.prepare_image('api', self.index_digest, SHA, self.stage)
        self.assertFalse(any(args[:2] == ['docker', 'load'] for args, _ in self.calls))

    def test_ambiguous_amd64_or_provenance_only_index_is_rejected(self):
        for entries in ([{'digest': self.leaf_digest, 'platform': {'os': 'unknown', 'architecture': 'unknown'}}],
                        [{'digest': self.leaf_digest, 'platform': {'os': 'linux', 'architecture': 'amd64'}}] * 2):
            raw = encoded({'schemaVersion': 2, 'manifests': entries})
            self.manifests[digest(raw)] = raw
            with self.commands():
                with self.assertRaisesRegex(ValueError, 'one Linux amd64'):
                    release.prepare_image('api', digest(raw), SHA, self.stage)

    def test_loaded_image_requires_valid_immutable_id_and_release_metadata(self):
        for mutation in ('image-id', 'source', 'revision', 'git-sha', 'platform'):
            self.loaded = False
            self.observed = image()
            if mutation == 'image-id': self.observed['Id'] = 'image:latest'
            if mutation == 'source': self.observed['Config']['Labels']['org.opencontainers.image.source'] = 'https://evil.example/repo'
            if mutation == 'revision': self.observed['Config']['Labels']['org.opencontainers.image.revision'] = OLD_SHA
            if mutation == 'git-sha': self.observed['Config']['Env'] = ['GIT_SHA=' + OLD_SHA]
            if mutation == 'platform': self.observed['Architecture'] = 'arm64'
            with self.subTest(mutation=mutation), self.commands():
                with self.assertRaisesRegex(ValueError, 'identity, platform or release metadata'):
                    release.prepare_image('api', self.index_digest, SHA, self.stage)
            self.assertEqual(list(self.stage.iterdir()), [])

    def test_successful_daemon_pull_checks_requested_digest_and_saved_config(self):
        selected = release.REPOSITORIES['api'] + '@' + self.leaf_digest
        self.pull_succeeds = True
        self.observed = image(MANIFEST_ID, requested=selected)
        with self.commands():
            self.assertEqual(release.prepare_image('api', self.index_digest, SHA, self.stage)['imageId'], MANIFEST_ID)
        self.assertFalse(any('copy' in args for args, _ in self.calls))
        self.assertTrue(any(args[:3] == ['docker','image','save'] for args,_ in self.calls))
        pull = next(args for args, _ in self.calls if args[:2] == ['docker','pull'])
        self.assertEqual(pull[-1], selected)
        self.loaded = False
        self.observed['RepoDigests'] = [release.REPOSITORIES['api'] + '@' + WEB_DIGEST]
        with self.commands():
            with self.assertRaisesRegex(ValueError, 'requested registry digest'):
                release.prepare_image('api', self.index_digest, SHA, self.stage)

    def test_source_is_fixed_and_proxy_environment_is_not_inherited(self):
        with mock.patch.object(release, 'run') as call:
            with self.assertRaises(ValueError): release.prepare_image('other-repository', API_DIGEST, SHA, self.stage)
            call.assert_not_called()
        proxies = {key: 'http://synthetic-proxy.invalid' for key in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')}
        with mock.patch.dict(os.environ, proxies), mock.patch.object(release.subprocess, 'run') as command:
            release.run(['skopeo','inspect','--raw','docker://example'])
        self.assertFalse(set(proxies) & command.call_args.kwargs['env'].keys())
        with mock.patch.dict(os.environ, proxies), mock.patch.object(release.subprocess, 'Popen', return_value=export_process(saved_archive())) as command:
            release.verify_saved_image(image(), SHA, API_ID)
        self.assertFalse(set(proxies) & command.call_args.kwargs['env'].keys())


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
            role = 'api' if 'ielts-api' in requested else 'web'
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
             mock.patch.object(release, 'resolve_source', side_effect=lambda repository, requested: ('sha256:' + '5' * 64, API_ID if 'ielts-api' in repository else WEB_ID)), \
             mock.patch.object(release.subprocess, 'Popen', side_effect=lambda args, **kwargs: export_process(saved_archive(API_CONFIG if args[-1] == API_ID else WEB_CONFIG))), \
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
