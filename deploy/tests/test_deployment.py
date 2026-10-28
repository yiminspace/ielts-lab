import importlib.util
import io
import runpy
import tarfile
from unittest import mock
from pathlib import Path
import tempfile
import os
import subprocess
import sys
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('ielts_config',ROOT/'deploy/validate-env.py')
config=importlib.util.module_from_spec(spec);spec.loader.exec_module(config)
release_spec=importlib.util.spec_from_file_location('ielts_fixed_release',ROOT/'deploy/server/release.py')
release=importlib.util.module_from_spec(release_spec);release_spec.loader.exec_module(release)

def fixture():
    runtime={'NODE_ENV':'production','IELTS_AUTH_REQUIRED':'1','PUBLIC_ORIGIN':'https://ielts.yiminlab.site','AUTHKIT_API_URL':'https://api.yiminlab.site',
      'OWNER_USER_ID':'00000000-0000-4000-8000-000000000001','DATABASE_URL':'postgres://ielts_app:synthetic-test@postgres/ielts_db','SESSION_SECRET':'synthetic-session-test-'*3}
    migration={'DATABASE_URL':runtime['DATABASE_URL'],'MIGRATION_DATABASE_URL':'postgres://ielts_migrator:synthetic-test@postgres/ielts_db'}
    return runtime,migration

class DeploymentConfigurationTests(unittest.TestCase):
    def test_runtime_credentials_are_separate_from_migration_and_admin(self):
        runtime,migration=fixture();config.validate(runtime,migration)
        for key in ('MIGRATION_DATABASE_URL','PROVISION_DATABASE_URL'):
            contaminated={**runtime,key:'must-not-reach-runtime'}
            with self.assertRaises(ValueError):config.validate(contaminated,migration)

    def test_public_or_remote_database_and_shared_privileged_roles_are_rejected(self):
        for uri in ('postgres://postgres:synthetic@postgres/ielts_db','postgres://ielts_app:synthetic@public.example/ielts_db','postgres://ielts_app:synthetic@postgres/auth_db'):
            runtime,migration=fixture();runtime['DATABASE_URL']=uri;migration['DATABASE_URL']=uri
            with self.assertRaises(ValueError):config.validate(runtime,migration)

    def test_authentication_cannot_be_disabled_by_a_payload(self):
        runtime,migration=fixture();runtime['IELTS_AUTH_REQUIRED']='0'
        with self.assertRaises(ValueError):config.validate(runtime,migration)

    def test_config_parser_never_executes_shell_and_rejects_duplicate_fields(self):
        with tempfile.TemporaryDirectory() as folder:
            file=Path(folder)/'config.env';marker=Path(folder)/'marker'
            file.write_text(f"VALUE=$(touch {marker})\n")
            self.assertEqual(config.read_env(file)['VALUE'],f'$(touch {marker})')
            self.assertFalse(marker.exists())
            file.write_text('DATABASE_URL=one\nDATABASE_URL=two\n')
            with self.assertRaises(ValueError):config.read_env(file)

    def test_ssh_entry_rejects_arbitrary_commands_and_shell_injection(self):
        for command in ('', 'id', 'bash -c id', 'ielts-release sha256:bad sha256:bad bad; id'):
            result=subprocess.run([sys.executable,str(ROOT/'deploy/server/ssh-entry.py')],env={**os.environ,'SSH_ORIGINAL_COMMAND':command},capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('Only a fixed IELTS release command',result.stderr)

    def test_ssh_entry_accepts_only_exact_legacy_and_learning_immutable_argument_shapes(self):
        api,web,learning,sha='sha256:'+'1'*64,'sha256:'+'2'*64,'sha256:'+'3'*64,'a'*40
        for arguments in ([api,web,sha],[api,web,learning,sha]):
            with self.subTest(arguments=len(arguments)), mock.patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':'ielts-release '+' '.join(arguments)}), mock.patch.object(os,'execv') as execute:
                runpy.run_path(str(ROOT/'deploy/server/ssh-entry.py'),run_name='__main__')
                self.assertEqual(execute.call_args.args,('/usr/bin/sudo',['sudo','-n','--','/usr/local/sbin/ielts-release',*arguments]))
        for command in ('ielts-release '+api+' '+web+' '+learning+' '+sha+' extra',
                        'ielts-release '+api+' '+web+' '+learning+' '+sha+'\n',
                        'ielts-release '+api+' '+web+' '+learning+' '+sha+';id',
                        'ielts-release  '+api+' '+web+' '+sha):
            with self.subTest(command=command), mock.patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':command}), mock.patch.object(os,'execv') as execute:
                with self.assertRaises(SystemExit):runpy.run_path(str(ROOT/'deploy/server/ssh-entry.py'),run_name='__main__')
                execute.assert_not_called()

    def test_release_tar_accepts_exact_bounded_regular_files_without_extraction(self):
        names=['runtime.env','migration.env','api-learning.env','learning.env']
        def payload(mutation):
            result=io.BytesIO()
            with tarfile.open(fileobj=result,mode='w:') as archive:
                entries=[tarfile.TarInfo(name) for name in names]
                for entry in entries:entry.size=6
                mutation(entries)
                for entry in entries:
                    archive.addfile(entry,io.BytesIO(b'x'*entry.size) if entry.isfile() else None)
            return result.getvalue()
        attacks=[lambda entries:entries.append(tarfile.TarInfo('extra.py')),
                 lambda entries:setattr(entries[0],'name','../runtime.env'),
                 lambda entries:entries.append(entries[0]),
                 lambda entries:setattr(entries[0],'size',256*1024+1),
                 lambda entries:setattr(entries[0],'size',0),
                 lambda entries:setattr(entries[0],'type',tarfile.SYMTYPE),
                 lambda entries:setattr(entries[0],'type',tarfile.LNKTYPE)]
        for mutation in attacks:
            with self.subTest(attack=attacks.index(mutation)), tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(ValueError):release.receive_configurations(payload(mutation),Path(folder),True)
        with tempfile.TemporaryDirectory() as folder:
            release.receive_configurations(payload(lambda entries:None),Path(folder),True)
            self.assertEqual({file.name for file in Path(folder).iterdir()},set(names))
            self.assertTrue(all(file.stat().st_mode&0o777==0o600 for file in Path(folder).iterdir()))

    def test_persistent_learning_directories_are_private_and_reject_symlinks(self):
        with tempfile.TemporaryDirectory() as folder,mock.patch.object(release,'BASE',Path(folder)),mock.patch.object(release.os,'chown') as chown:
            release.persistent_directories()
            self.assertEqual(chown.call_args_list,[mock.call(Path(folder)/'data/daily',1000,1000),mock.call(Path(folder)/'data/runtime',10001,10001)])
            (Path(folder)/'data/runtime').rmdir()
            (Path(folder)/'data/runtime').symlink_to(Path(folder)/'data/daily',target_is_directory=True)
            with self.assertRaises(ValueError):release.persistent_directories()

    def test_migration_runtime_url_must_match(self):
        runtime,migration=fixture();migration['DATABASE_URL']='postgres://ielts_app:different@postgres/ielts_db'
        with self.assertRaises(ValueError):config.validate(runtime,migration)

    def test_learning_credentials_are_isolated_and_destinations_are_fixed(self):
        runtime,migration=fixture()
        api={'IELTS_RUNTIME_TOKEN':'synthetic-runtime-token-original-'*2}
        learning={**api,'IELTS_MODEL':'ark-agent-plan/deepseek-v4-flash','IELTS_LLM_BASE_URL':'http://bifrost:8080/v1',
          'IELTS_LLM_API_KEY':'original-synthetic-virtual-key','IELTS_ASR_MODEL':'ark-plan-media/doubao-seed-asr-2.0',
          'IELTS_TTS_MODEL':'ark-plan-media/doubao-seed-tts-2.0','IELTS_TTS_VOICE':'original_voice'}
        config.validate(runtime,migration,api,learning)
        for changed in ({**api,'IELTS_LLM_API_KEY':'must-stay-out-of-node'},{**api,'DAILY_ROOT':'/etc'},
                        {**api,'IELTS_RUNTIME_URL':'http://untrusted.invalid'}):
            with self.assertRaises(ValueError):config.validate(runtime,migration,changed,learning)
        for changed in ({**learning,'IELTS_RUNTIME_TOKEN':'different-original-token-value-'*2},
                        {**learning,'IELTS_LLM_BASE_URL':'https://untrusted.invalid/v1'},
                        {**learning,'RUNTIME_DATABASE':'/etc/runtime.sqlite'}):
            with self.assertRaises(ValueError):config.validate(runtime,migration,api,changed)

if __name__=='__main__':unittest.main()
