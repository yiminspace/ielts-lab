import importlib.util
from pathlib import Path
import tempfile
import os
import subprocess
import sys
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('ielts_config',ROOT/'deploy/validate-env.py')
config=importlib.util.module_from_spec(spec);spec.loader.exec_module(config)

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

    def test_migration_runtime_url_must_match(self):
        runtime,migration=fixture();migration['DATABASE_URL']='postgres://ielts_app:different@postgres/ielts_db'
        with self.assertRaises(ValueError):config.validate(runtime,migration)

if __name__=='__main__':unittest.main()
