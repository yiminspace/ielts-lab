#!/usr/bin/env bash
# Restore into a NEW local test container, never the shared production database.
set -euo pipefail
[[ $# == 1 && -d "$1" ]] || { echo 'Usage: restore-check.sh /private/backup-folder' >&2; exit 1; }
backup="$(cd "$1" && pwd)"
python3 deploy/backup.py --verify "$backup"
name="ielts-restore-check-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT HUP INT TERM
# This synthetic password protects only an isolated, disposable container with no exposed port.
docker run -d --name "$name" --network none -e POSTGRES_PASSWORD=ielts-disposable-restore -e POSTGRES_DB=ielts_restore postgres:16-alpine >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$name" pg_restore --username postgres --dbname ielts_restore --no-owner --no-acl --exit-on-error < "$backup/ielts.dump"
docker exec "$name" psql --username postgres --dbname ielts_restore --no-psqlrc --tuples-only --command 'SELECT max(version) FROM schema_migrations WHERE rolled_back_at IS NULL'
echo 'Database restored into an isolated disposable container; file archive checks passed'
python3 - "$backup" "$name" <<'PY'
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
backup=Path(sys.argv[1]);container=sys.argv[2]
with tempfile.TemporaryDirectory(prefix='ielts-file-restore-') as temporary:
    target=Path(temporary)
    for category in ('archive','recordings'):
        root=target/category;root.mkdir()
        with tarfile.open(backup/f'{category}.tar','r:') as archive:
            for member in archive:
                if not member.isfile():continue
                file=root/member.name;file.parent.mkdir(parents=True,exist_ok=True)
                with archive.extractfile(member) as source,file.open('wb') as output:shutil.copyfileobj(source,output)
    raw=subprocess.check_output(['docker','exec',container,'psql','--username','postgres','--dbname','ielts_restore','--no-psqlrc','--tuples-only','--no-align','--command','SELECT filename FROM recordings'],text=True)
    filenames=[line for line in raw.splitlines() if line]
    missing=sum(not(target/'recordings'/name).is_file() for name in filenames)
    if missing:sys.exit(f'Restored database references {missing} missing recording files')
    print(f'File restoration verified; {len(filenames)} recording references resolved')
PY
