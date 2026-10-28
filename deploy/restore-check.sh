#!/usr/bin/env bash
# Restore only into a NEW isolated test container and a private temporary file tree.
set -euo pipefail
[[ $# == 1 && -d "$1" ]] || { echo 'Usage: restore-check.sh /private/backup-folder' >&2; exit 1; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup="$(cd -- "$1" && pwd)"
python3 "$script_dir/backup.py" --verify "$backup"
name="ielts-restore-check-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT HUP INT TERM
# Synthetic password: isolated disposable container, no exposed port.
docker run -d --name "$name" --network none -e POSTGRES_PASSWORD=ielts-disposable-restore -e POSTGRES_DB=ielts_restore postgres:16-alpine >/dev/null
ready=false
for attempt in $(seq 1 30); do
  if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
$ready || { echo 'Disposable restore database did not become ready' >&2; exit 1; }
docker exec -i "$name" pg_restore --username postgres --dbname ielts_restore --no-owner --no-acl --exit-on-error < "$backup/ielts.dump"
# Keep private database rows in Python memory; display only validation counts.
python3 - "$backup" "$name" "$script_dir/backup.py" <<'PY'
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

folder, container = Path(sys.argv[1]), sys.argv[2]
spec = importlib.util.spec_from_file_location("ielts_backup", sys.argv[3])
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

def query(sql):
    return subprocess.check_output([
        "docker", "exec", container, "psql", "--username", "postgres", "--dbname", "ielts_restore",
        "--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", sql,
    ], text=True, stderr=subprocess.PIPE)

with tempfile.TemporaryDirectory(prefix="ielts-file-restore-") as temporary:
    backup.restore_files(folder, temporary)
    recordings = [line for line in query("SELECT filename FROM recordings").splitlines() if line]
    daily = []
    if query("SELECT to_regclass('public.daily_lessons') IS NOT NULL").strip() == "t":
        raw = query("SELECT json_build_object('user_id',user_id,'mode',mode,'id',id,'data',data)::text FROM daily_lessons")
        daily = [json.loads(line) for line in raw.splitlines() if line]
    recording_count, daily_count = backup.verify_references(temporary, recordings, daily)
    print(f"Isolated restoration verified: {recording_count} recording and {daily_count} Daily audio references; SQLite integrity checked when present")
PY
