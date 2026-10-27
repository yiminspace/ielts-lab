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

def validate(runtime, migration):
    if set(runtime) - RUNTIME_KEYS or not {"IELTS_AUTH_REQUIRED", "OWNER_USER_ID", "PUBLIC_ORIGIN", "AUTHKIT_API_URL", "DATABASE_URL", "SESSION_SECRET"} <= runtime.keys(): raise ValueError('runtime configuration fields do not match contract')
    if runtime['IELTS_AUTH_REQUIRED'] != '1' or runtime.get('NODE_ENV', 'production') != 'production': raise ValueError('production authentication is required')
    if runtime['PUBLIC_ORIGIN'] != 'https://ielts.yiminlab.site' or runtime['AUTHKIT_API_URL'] != 'https://api.yiminlab.site': raise ValueError('unexpected service origins')
    if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', runtime['OWNER_USER_ID']) or len(runtime['SESSION_SECRET'].encode()) < 32: raise ValueError('invalid identity or session configuration')
    if set(migration) != {'DATABASE_URL', 'MIGRATION_DATABASE_URL'} or migration['DATABASE_URL'] != runtime['DATABASE_URL']: raise ValueError('migration configuration mismatch')
    app = urlsplit(runtime['DATABASE_URL']); owner = urlsplit(migration['MIGRATION_DATABASE_URL'])
    for url in (app, owner):
        if url.scheme not in ('postgres', 'postgresql') or url.hostname != 'postgres' or url.path != '/ielts_db' or not url.password or url.query or url.fragment: raise ValueError('database target must be the private IELTS database')
    if unquote(app.username or '') != 'ielts_app' or unquote(owner.username or '') != 'ielts_migrator': raise ValueError('dedicated runtime and migration roles are required')

if __name__ == '__main__':
    try:
        validate(read_env(sys.argv[1]), read_env(sys.argv[2]))
        print('Deployment configuration shape verified')
    except Exception:
        sys.exit('Deployment configuration is invalid; no values were printed')
