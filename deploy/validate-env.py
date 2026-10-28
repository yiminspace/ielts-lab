#!/usr/bin/env python3
"""Validate config shape without printing values or executing shell expressions."""
from pathlib import Path
from urllib.parse import urlsplit, unquote
import re
import sys

RUNTIME_KEYS = {"NODE_ENV", "IELTS_AUTH_REQUIRED", "OWNER_USER_ID", "PUBLIC_ORIGIN", "AUTHKIT_API_URL", "DATABASE_URL", "SESSION_SECRET", "ARCHIVE_ROOT", "RECORDINGS_ROOT", "HOST", "PORT"}

def read_env(file):
    result = {}
    for line in Path(file).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'): continue
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)', line)
        if not match or match[1] in result: raise ValueError('invalid or duplicate configuration field')
        value = match[2]
        if value.startswith(('"', "'")):
            if len(value) < 2 or value[-1] != value[0]: raise ValueError('invalid quoted configuration value')
            value = value[1:-1]
        if not value or any(ord(c) < 32 for c in value): raise ValueError('empty or invalid configuration value')
        result[match[1]] = value
    return result

def validate(runtime, migration, api_learning=None, learning=None):
    if set(runtime) - RUNTIME_KEYS or not {"IELTS_AUTH_REQUIRED", "OWNER_USER_ID", "PUBLIC_ORIGIN", "AUTHKIT_API_URL", "DATABASE_URL", "SESSION_SECRET"} <= runtime.keys(): raise ValueError('runtime configuration fields do not match contract')
    if runtime['IELTS_AUTH_REQUIRED'] != '1' or runtime.get('NODE_ENV', 'production') != 'production': raise ValueError('production authentication is required')
    if runtime['PUBLIC_ORIGIN'] != 'https://ielts.yiminlab.site' or runtime['AUTHKIT_API_URL'] != 'https://api.yiminlab.site': raise ValueError('unexpected service origins')
    if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', runtime['OWNER_USER_ID']) or len(runtime['SESSION_SECRET'].encode()) < 32: raise ValueError('invalid identity or session configuration')
    if set(migration) != {'DATABASE_URL', 'MIGRATION_DATABASE_URL'} or migration['DATABASE_URL'] != runtime['DATABASE_URL']: raise ValueError('migration configuration mismatch')
    app = urlsplit(runtime['DATABASE_URL']); owner = urlsplit(migration['MIGRATION_DATABASE_URL'])
    for url in (app, owner):
        if url.scheme not in ('postgres', 'postgresql') or url.hostname != 'postgres' or url.path != '/ielts_db' or not url.password or url.query or url.fragment: raise ValueError('database target must be the private IELTS database')
    if unquote(app.username or '') != 'ielts_app' or unquote(owner.username or '') != 'ielts_migrator': raise ValueError('dedicated runtime and migration roles are required')
    if api_learning is not None or learning is not None:
        validate_learning(api_learning, learning)


def validate_learning(api_learning, learning):
    if not isinstance(api_learning, dict) or not isinstance(learning, dict): raise ValueError('both learning configurations are required')
    api_allowed={'IELTS_RUNTIME_TOKEN','IELTS_RUNTIME_URL','DAILY_ROOT'}
    required={'IELTS_RUNTIME_TOKEN','IELTS_MODEL','IELTS_LLM_BASE_URL','IELTS_LLM_API_KEY','IELTS_ASR_MODEL','IELTS_TTS_MODEL','IELTS_TTS_VOICE'}
    if set(api_learning)-api_allowed or not {'IELTS_RUNTIME_TOKEN'}<=api_learning.keys(): raise ValueError('invalid API learning configuration')
    if set(learning)-(required|{'RUNTIME_DATABASE'}) or not required<=learning.keys(): raise ValueError('invalid learning configuration')
    token=api_learning['IELTS_RUNTIME_TOKEN']
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}',token) or token!=learning['IELTS_RUNTIME_TOKEN']: raise ValueError('learning authentication configuration mismatch')
    if api_learning.get('IELTS_RUNTIME_URL','http://ielts-learning:4320')!='http://ielts-learning:4320': raise ValueError('unexpected internal runtime address')
    if api_learning.get('DAILY_ROOT','/data/daily')!='/data/daily' or learning.get('RUNTIME_DATABASE','/data/runtime/runtime.sqlite')!='/data/runtime/runtime.sqlite': raise ValueError('unexpected learning data path')
    gateway=urlsplit(learning['IELTS_LLM_BASE_URL'])
    if gateway.username or gateway.password or gateway.query or gateway.fragment or gateway.path.rstrip('/')!='/v1': raise ValueError('invalid model gateway address')
    if not ((gateway.scheme=='http' and gateway.hostname=='bifrost' and gateway.port==8080) or
            (gateway.scheme=='https' and gateway.hostname=='bifrost.yiminlab.site' and gateway.port in (None,443))): raise ValueError('unexpected model gateway')
    if not 16<=len(learning['IELTS_LLM_API_KEY'])<=4096: raise ValueError('invalid model credential')
    for field in ('IELTS_MODEL','IELTS_ASR_MODEL','IELTS_TTS_MODEL','IELTS_TTS_VOICE'):
        if not re.fullmatch(r'[A-Za-z0-9_./:-]{1,300}',learning[field]): raise ValueError('invalid model identity')

if __name__ == '__main__':
    try:
        if len(sys.argv) not in (3,5): raise ValueError('invalid configuration arguments')
        validate(read_env(sys.argv[1]), read_env(sys.argv[2]),
                 *(read_env(name) for name in sys.argv[3:]))
        print('Deployment configuration shape verified')
    except Exception:
        sys.exit('Deployment configuration is invalid; no values were printed')
