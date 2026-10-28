#!/usr/bin/env python3
"""Consistent private IELTS backup. Run in an explicit maintenance window."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
import time
from urllib.parse import quote


LEGACY_FILES = {"ielts.dump", "archive.tar", "recordings.tar"}
NEW_FILES = LEGACY_FILES | {"daily.tar", "runtime.tar"}
SQLITE_NAME = "runtime.sqlite"
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
OWNER = re.compile(r"[a-f0-9-]{36}\Z", re.I)
LESSON = re.compile(r"daily-[a-f0-9]{40}\Z")
ASSET = re.compile(r"(?:recording|teacher)-[a-f0-9]{32}\Z")
AUDIO = re.compile(r"(?:recording|teacher)-[a-f0-9]{32}\.(?:webm|ogg|m4a|mp3|wav)\Z")
RECORDING = re.compile(r"[a-f0-9-]{36}\.(?:webm|ogg|mp4|m4a|wav|mp3)\Z", re.I)


def digest(file):
    checksum = hashlib.sha256()
    with Path(file).open("rb") as stream:
        while block := stream.read(1024 * 1024):
            checksum.update(block)
    return checksum.hexdigest()


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate backup manifest field")
        result[key] = value
    return result


def _regular(file):
    return file.exists() and stat.S_ISREG(file.lstat().st_mode)


def _manifest(folder):
    folder = Path(folder)
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError("Backup must be a real directory")
    manifest_file = folder / "manifest.json"
    if not _regular(manifest_file) or manifest_file.stat().st_size > 65536:
        raise ValueError("Invalid backup manifest")
    manifest = json.loads(manifest_file.read_text(), object_pairs_hook=_unique_object)
    version = manifest.get("format")
    if (
        type(version) is not int
        or version not in (1, 2)
        or manifest.get("database") != "ielts_db"
    ):
        raise ValueError("Unsupported backup format")
    required = LEGACY_FILES if version == 1 else NEW_FILES
    files = manifest.get("files")
    if (
        not isinstance(files, dict)
        or not required <= files.keys()
        or set(files) - (required | {"release.json"})
    ):
        raise ValueError("Invalid backup file set")
    if version == 2:
        runtime = manifest.get("runtime")
        if (
            not isinstance(runtime, dict)
            or runtime.get("database") != SQLITE_NAME
            or type(runtime.get("present")) is not bool
        ):
            raise ValueError("Invalid runtime backup metadata")
    for name, expected in files.items():
        path = folder / name
        if (
            not isinstance(expected, str)
            or not SHA256.fullmatch(expected)
            or not _regular(path)
        ):
            raise ValueError("Invalid backup file")
        if digest(path) != expected:
            raise ValueError("Backup checksum mismatch")
    return manifest


def _tar_members(archive):
    """Reject traversal, links, duplicate paths and special files before extracting anything."""
    seen = {}
    members = archive.getmembers()
    for member in members:
        name = member.name.rstrip("/")
        parts = name.split("/")
        if (
            not name
            or "\\" in name
            or "\0" in name
            or PurePosixPath(name).is_absolute()
            or any(part in ("", ".", "..") for part in parts)
            or re.match(r"^[A-Za-z]:", name)
            or not (member.isfile() or member.isdir())
            or name in seen
        ):
            raise ValueError("Unsafe archive entry")
        seen[name] = member
    for name in seen:
        for parent in PurePosixPath(name).parents:
            if str(parent) in seen and not seen[str(parent)].isdir():
                raise ValueError("Archive file conflicts with a directory")
    return members


def _extract(archive_path, target):
    target = Path(target)
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:") as archive:
        for member in _tar_members(archive):
            file = target / member.name.rstrip("/")
            if member.isdir():
                file.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.extractfile(member) as source:
                descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as output:
                    shutil.copyfileobj(source, output)


def _sqlite_integrity(root, present):
    database = Path(root) / SQLITE_NAME
    if not present:
        if any(Path(root).glob(SQLITE_NAME + "*")):
            raise ValueError("Unexpected SQLite files in an empty runtime backup")
        return
    if not _regular(database):
        raise ValueError("Runtime database is missing")
    try:
        uri = "file:" + quote(str(database.resolve())) + "?mode=ro"
        with sqlite3.connect(uri, uri=True) as connection:
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.execute("PRAGMA query_only=ON")
            if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("Runtime SQLite integrity check failed")
    except sqlite3.DatabaseError:
        raise ValueError("Runtime SQLite integrity check failed") from None


def verify(folder, *, check_postgres=True, quiet=False):
    folder = Path(folder)
    manifest = _manifest(folder)
    categories = (
        ("archive", "recordings", "daily", "runtime")
        if manifest["format"] == 2
        else ("archive", "recordings")
    )
    for category in categories:
        with tarfile.open(folder / f"{category}.tar", "r:") as archive:
            _tar_members(archive)
    if manifest["format"] == 2:
        with tempfile.TemporaryDirectory(prefix="ielts-runtime-check-") as temporary:
            root = Path(temporary) / "runtime"
            _extract(folder / "runtime.tar", root)
            _sqlite_integrity(root, manifest["runtime"]["present"])
    if check_postgres:
        subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "-v",
                f"{folder.resolve()}:/backup:ro",
                "postgres:16-alpine",
                "pg_restore",
                "--list",
                "/backup/ielts.dump",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
    if not quiet:
        print(
            f"Backup format {manifest['format']}: private file and archive checks passed"
        )
    return manifest


def restore_files(folder, target):
    """Restore only into a new private temporary tree, never a production destination."""
    folder, target = Path(folder), Path(target)
    if target.is_symlink() or (target.exists() and any(target.iterdir())):
        raise ValueError("File restore target must be new or empty")
    manifest = verify(folder, check_postgres=False, quiet=True)
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(target, 0o700)
    for category in ("archive", "recordings", "daily", "runtime"):
        root = target / category
        archive = folder / f"{category}.tar"
        if archive.name in manifest["files"]:
            _extract(archive, root)
        else:
            root.mkdir(mode=0o700)
    if manifest["format"] == 2:
        _sqlite_integrity(target / "runtime", manifest["runtime"]["present"])
    return manifest


def verify_references(target, recordings, daily_lessons):
    """Check captured SQL rows in private process memory; return counts, never contents."""
    target = Path(target)
    recording_count = 0
    for name in recordings:
        if (
            not isinstance(name, str)
            or not RECORDING.fullmatch(name)
            or not _regular(target / "recordings" / name)
        ):
            raise ValueError(
                "Restored database has a missing or invalid recording reference"
            )
        recording_count += 1
    daily_count = 0
    sqlite_path = target / "runtime" / SQLITE_NAME
    for row in daily_lessons:
        owner, mode, lesson_id, data = (
            row["user_id"],
            row["mode"],
            row["id"],
            row["data"],
        )
        if (
            not OWNER.fullmatch(owner)
            or mode not in ("archive", "demo")
            or not LESSON.fullmatch(lesson_id)
        ):
            raise ValueError("Restored database has an invalid Daily identity")
        assets = {}
        for asset in data.get("_assets", []):
            asset_id, filename = asset.get("id", ""), asset.get("filename", "")
            if (
                not ASSET.fullmatch(asset_id)
                or not AUDIO.fullmatch(filename)
                or filename.rsplit(".", 1)[0] != asset_id
                or asset_id in assets
            ):
                raise ValueError("Restored database has invalid Daily audio metadata")
            file = target / "daily" / "audio" / owner / mode / lesson_id / filename
            if (
                not _regular(file)
                or type(asset.get("size")) is not int
                or file.stat().st_size != asset["size"]
                or not isinstance(asset.get("checksum"), str)
                or not SHA256.fullmatch(asset["checksum"])
                or digest(file) != asset["checksum"]
            ):
                raise ValueError(
                    "Restored Daily audio does not match database metadata"
                )
            assets[asset_id] = asset
            daily_count += 1
        for recording in data.get("recordings", []):
            if recording.get("id") not in assets:
                raise ValueError("Restored Daily recording has no saved audio asset")
        for message in data.get("conversation", {}).get("messages", []):
            if not message.get("audioUrl"):
                continue
            prefix = f"/api/daily/{lesson_id}/recordings/"
            url = message["audioUrl"]
            if (
                not isinstance(url, str)
                or not url.startswith(prefix)
                or not url.endswith("/audio")
            ):
                raise ValueError(
                    "Restored Daily message has an invalid audio reference"
                )
            if url[len(prefix) : -len("/audio")] not in assets:
                raise ValueError("Restored Daily message has no saved audio asset")
        for field in ("pending", "failedJob"):
            pending = data.get(field)
            if not isinstance(pending, dict) or not pending.get("runId"):
                continue
            if not _regular(sqlite_path):
                raise ValueError("Restored Daily task has no runtime database")
            with sqlite3.connect(
                "file:" + quote(str(sqlite_path.resolve())) + "?mode=ro", uri=True
            ) as db:
                runtime = db.execute(
                    "SELECT owner_id FROM runs WHERE id=?", (pending["runId"],)
                ).fetchone()
            if not runtime or runtime[0] != owner:
                raise ValueError(
                    "Restored Daily task has no matching owner runtime run"
                )
    return recording_count, daily_count


def _pack(root, output, *, optional=False):
    if root.is_symlink() or (root.exists() and not root.is_dir()):
        raise ValueError("Backup source must be a real directory")
    if not root.exists() and not optional:
        raise ValueError("Required backup directory is missing")
    with tarfile.open(output, "w:", dereference=True) as archive:
        for file in sorted(root.rglob("*")):
            mode = file.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise ValueError("Backup refuses links and special files")
            archive.add(file, arcname=file.relative_to(root), recursive=False)


@contextmanager
def _maintenance_lock(base):
    descriptor = os.open(
        base / ".maintenance.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(descriptor, "a") as lock:
        os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError(
                "Another deployment or backup maintenance operation is active"
            ) from None
        yield


def backup(base, destination, quiesce):
    if not quiesce:
        raise ValueError(
            "Use --quiesce after choosing an application maintenance window"
        )
    base, destination = Path(base).resolve(), Path(destination).resolve()
    if destination.exists() or destination.is_relative_to(base / "data"):
        raise ValueError("Backup destination must be new and outside application data")
    with _maintenance_lock(base):
        _backup_locked(base, destination)


def _backup_locked(base, destination):
    old_umask = os.umask(0o077)
    running = []
    try:
        destination.mkdir(parents=True, mode=0o700)
        names = subprocess.run(
            ["docker", "ps", "--all", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        if "ielts-api" not in names:
            raise ValueError("IELTS API container is missing")
        for name in ("ielts-api", "ielts-learning"):
            if name not in names:
                continue
            state = subprocess.run(
                ["docker", "inspect", "--format", "{{.State.Running}}", name],
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            if state not in ("true", "false"):
                raise ValueError("Container running state could not be determined")
            if state == "true":
                running.append(name)
        try:
            for name in running:
                subprocess.run(
                    ["docker", "stop", "--time", "30", name],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
            with (destination / "ielts.dump").open("wb") as output:
                subprocess.run(
                    [
                        "docker",
                        "exec",
                        "postgres",
                        "pg_dump",
                        "--username",
                        "postgres",
                        "--format=custom",
                        "--no-owner",
                        "--no-acl",
                        "ielts_db",
                    ],
                    check=True,
                    stdout=output,
                    stderr=subprocess.PIPE,
                )
            for category in ("archive", "recordings", "daily", "runtime"):
                _pack(
                    base / "data" / category,
                    destination / f"{category}.tar",
                    optional=category in ("daily", "runtime"),
                )
            release = base / "release.json"
            if release.is_symlink():
                raise ValueError("Release metadata must not be a symbolic link")
            if release.is_file():
                (destination / "release.json").write_bytes(release.read_bytes())
            files = {
                file.name: digest(file)
                for file in destination.iterdir()
                if file.is_file()
            }
            manifest = {
                "format": 2,
                "createdAt": int(time.time()),
                "database": "ielts_db",
                "files": files,
                "runtime": {
                    "database": SQLITE_NAME,
                    "present": (base / "data" / "runtime" / SQLITE_NAME).is_file(),
                },
            }
            (destination / "manifest.json").write_text(
                json.dumps(manifest, indent=2) + "\n"
            )
            for file in destination.iterdir():
                os.chmod(file, 0o600)
        finally:
            errors = []
            for name in reversed(running):
                try:
                    subprocess.run(
                        ["docker", "start", name],
                        check=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                    )
                except subprocess.CalledProcessError:
                    errors.append(name)
            if errors:
                raise RuntimeError("Application containers could not all be restarted")
    finally:
        os.umask(old_umask)
    verify(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--base", type=Path, default=Path("/srv/ielts-lab"))
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--quiesce", action="store_true")
    args = parser.parse_args()
    if args.verify:
        verify(args.verify)
    elif args.destination:
        backup(args.base, args.destination, args.quiesce)
    else:
        parser.error("Choose --verify or --destination with --quiesce")
