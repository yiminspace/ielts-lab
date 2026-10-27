#!/usr/bin/env python3
"""Consistent private IELTS backup. Run as administrator in a maintenance window."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import tarfile
import tempfile
import time


def digest(file):
    h=hashlib.sha256()
    with file.open('rb') as stream:
        while block:=stream.read(1024*1024):h.update(block)
    return h.hexdigest()

def verify(folder):
    folder=Path(folder);manifest=json.loads((folder/'manifest.json').read_text())
    required={'ielts.dump','archive.tar','recordings.tar'}
    if not required <= manifest['files'].keys() or set(manifest['files']) - (required|{'release.json'}):raise ValueError('Invalid backup manifest')
    for name, expected in manifest['files'].items():
        path=folder/name
        if path.is_symlink() or not path.is_file() or digest(path)!=expected:raise ValueError('Backup checksum mismatch')
    for name in ('archive.tar','recordings.tar'):
        with tarfile.open(folder/name,'r:') as archive:
            for member in archive:
                if member.name.startswith('/') or '..' in Path(member.name).parts or not(member.isfile() or member.isdir()):raise ValueError('Unsafe archive entry')
    # Listing verifies pg_dump archive structure without displaying actual records.
    subprocess.run(['docker','run','--rm','-v',f'{folder.resolve()}:/backup:ro','postgres:16-alpine','pg_restore','--list','/backup/ielts.dump'],check=True,stdout=subprocess.DEVNULL)
    print('Backup checksums, file archives and PostgreSQL archive verified')

def backup(base, destination, quiesce):
    if not quiesce:raise ValueError('Use --quiesce after choosing an application maintenance window')
    base=Path(base).resolve();destination=Path(destination).resolve()
    if destination.exists():raise ValueError('Backup destination must be new')
    destination.mkdir(parents=True,mode=0o700);os.chmod(destination,0o700)
    was_running=subprocess.run(['docker','inspect','--format','{{.State.Running}}','ielts-api'],capture_output=True,text=True,check=True).stdout.strip()=='true'
    try:
        if was_running:subprocess.run(['docker','stop','--time','30','ielts-api'],check=True,stdout=subprocess.DEVNULL)
        with (destination/'ielts.dump').open('wb') as output:
            subprocess.run(['docker','exec','postgres','pg_dump','--username','postgres','--format=custom','--no-owner','--no-acl','ielts_db'],check=True,stdout=output)
        for name in ('archive','recordings'):
            root=base/'data'/name
            with tarfile.open(destination/f'{name}.tar','w:') as output:
                for file in sorted(root.rglob('*')):
                    if file.is_symlink():raise ValueError('Backup refuses symbolic links')
                    if file.is_file():output.add(file,arcname=file.relative_to(root),recursive=False)
        if (base/'release.json').is_file():(destination/'release.json').write_bytes((base/'release.json').read_bytes())
        files={file.name:digest(file) for file in destination.iterdir() if file.is_file()}
        (destination/'manifest.json').write_text(json.dumps({'format':1,'createdAt':int(time.time()),'database':'ielts_db','files':files},indent=2)+'\n')
        for file in destination.iterdir():os.chmod(file,0o600)
    finally:
        if was_running:subprocess.run(['docker','start','ielts-api'],check=True,stdout=subprocess.DEVNULL)
    verify(destination)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify',type=Path)
    parser.add_argument('--base',type=Path,default=Path('/srv/ielts-lab'))
    parser.add_argument('--destination',type=Path)
    parser.add_argument('--quiesce',action='store_true')
    args=parser.parse_args()
    if args.verify:verify(args.verify)
    elif args.destination:backup(args.base,args.destination,args.quiesce)
    else:parser.error('Choose --verify or --destination with --quiesce')
