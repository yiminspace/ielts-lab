import copy
import fcntl
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ielts_backup", ROOT / "deploy/backup.py")
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

OWNER = "00000000-0000-4000-8000-000000000001"
LESSON = "daily-" + "a" * 40
ASSET = "recording-" + "b" * 32
FILENAME = ASSET + ".wav"
RECORDING = "00000000-0000-4000-8000-000000000002.wav"
AUDIO = b"original synthetic audio only"


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ielts-backup-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.base = self.root / "application"
        self.data = self.base / "data"
        for category in ("archive", "recordings", "daily", "runtime"):
            (self.data / category).mkdir(parents=True)
        (self.data / "archive/original.txt").write_text("Original synthetic material.")
        (self.data / "recordings" / RECORDING).write_bytes(AUDIO)
        daily = self.data / "daily" / "audio" / OWNER / "archive" / LESSON
        daily.mkdir(parents=True)
        (daily / FILENAME).write_bytes(AUDIO)
        self.database = self.data / "runtime/runtime.sqlite"
        with sqlite3.connect(self.database) as db:
            db.execute("CREATE TABLE runs(id TEXT PRIMARY KEY, owner_id TEXT)")
            db.execute("INSERT INTO runs VALUES(?,?)", ("synthetic-run", OWNER))
        self.row = {
            "user_id": OWNER,
            "mode": "archive",
            "id": LESSON,
            "data": {
                "_assets": [
                    {
                        "id": ASSET,
                        "filename": FILENAME,
                        "size": len(AUDIO),
                        "checksum": hashlib.sha256(AUDIO).hexdigest(),
                    }
                ],
                "recordings": [{"id": ASSET}],
                "conversation": {"messages": []},
                "pending": {"runId": "synthetic-run"},
            },
        }

    def make_backup(self, version=2, present=True):
        folder = self.root / ("fixture-" + str(len(list(self.root.glob("fixture-*")))))
        folder.mkdir()
        (folder / "ielts.dump").write_bytes(b"synthetic pg_dump fixture")
        categories = (
            ("archive", "recordings", "daily", "runtime")
            if version == 2
            else ("archive", "recordings")
        )
        for category in categories:
            if category == "runtime" and not present:
                with tarfile.open(folder / "runtime.tar", "w:"):
                    pass
            else:
                backup._pack(self.data / category, folder / f"{category}.tar")
        manifest = {
            "format": version,
            "database": "ielts_db",
            "createdAt": 1,
            "files": {file.name: backup.digest(file) for file in folder.iterdir()},
        }
        if version == 2:
            manifest["runtime"] = {"database": "runtime.sqlite", "present": present}
        self.write_manifest(folder, manifest)
        return folder

    @staticmethod
    def write_manifest(folder, manifest):
        (folder / "manifest.json").write_text(json.dumps(manifest))

    def rehash(self, folder, name):
        manifest = json.loads((folder / "manifest.json").read_text())
        manifest["files"][name] = backup.digest(folder / name)
        self.write_manifest(folder, manifest)

    def test_format_two_restores_daily_audio_and_runtime_owner_links(self):
        folder = self.make_backup()
        target = self.root / "restored"
        self.assertEqual(
            backup.verify(folder, check_postgres=False, quiet=True)["format"], 2
        )
        backup.restore_files(folder, target)
        self.assertEqual(
            backup.verify_references(target, [RECORDING], [self.row]), (1, 1)
        )
        self.assertEqual(
            (
                target / "daily" / "audio" / OWNER / "archive" / LESSON / FILENAME
            ).read_bytes(),
            AUDIO,
        )
        self.assertEqual(target.stat().st_mode & 0o777, 0o700)
        self.assertEqual(
            (target / "runtime/runtime.sqlite").stat().st_mode & 0o777, 0o600
        )

    def test_format_one_remains_compatible(self):
        folder = self.make_backup(version=1)
        self.assertEqual(
            backup.verify(folder, check_postgres=False, quiet=True)["format"], 1
        )
        target = self.root / "legacy-restored"
        backup.restore_files(folder, target)
        self.assertEqual(backup.verify_references(target, [RECORDING], []), (1, 0))
        self.assertEqual(list((target / "daily").iterdir()), [])
        self.assertEqual(list((target / "runtime").iterdir()), [])

    def test_pre_activation_format_two_can_explicitly_have_no_sqlite(self):
        folder = self.make_backup(present=False)
        backup.verify(folder, check_postgres=False, quiet=True)
        manifest = json.loads((folder / "manifest.json").read_text())
        manifest["runtime"]["present"] = True
        self.write_manifest(folder, manifest)
        with self.assertRaisesRegex(ValueError, "database is missing"):
            backup.verify(folder, check_postgres=False, quiet=True)

    def test_checksums_unknown_files_and_linked_manifest_are_rejected(self):
        folder = self.make_backup()
        (folder / "ielts.dump").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum"):
            backup.verify(folder, check_postgres=False)
        self.rehash(folder, "ielts.dump")
        manifest = json.loads((folder / "manifest.json").read_text())
        manifest["files"]["../../outside"] = "a" * 64
        self.write_manifest(folder, manifest)
        with self.assertRaisesRegex(ValueError, "file set"):
            backup.verify(folder, check_postgres=False)
        manifest["files"].pop("../../outside")
        outside = self.root / "manifest-copy"
        outside.write_text(json.dumps(manifest))
        (folder / "manifest.json").unlink()
        (folder / "manifest.json").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "manifest"):
            backup.verify(folder, check_postgres=False)

    def test_dangerous_tar_paths_links_and_special_files_are_rejected_before_extraction(
        self,
    ):
        for name, kind in (
            ("../escaped", tarfile.REGTYPE),
            ("/absolute", tarfile.REGTYPE),
            ("a/../../escaped", tarfile.REGTYPE),
            ("C:/escaped", tarfile.REGTYPE),
            ("a\\escaped", tarfile.REGTYPE),
            ("linked", tarfile.SYMTYPE),
            ("hard", tarfile.LNKTYPE),
            ("fifo", tarfile.FIFOTYPE),
        ):
            with self.subTest(name=name, kind=kind):
                folder = self.make_backup()
                with tarfile.open(folder / "daily.tar", "w:") as archive:
                    info = tarfile.TarInfo(name)
                    info.type = kind
                    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                        info.linkname = "../../escaped"
                    if kind == tarfile.REGTYPE:
                        info.size = 1
                        archive.addfile(info, io.BytesIO(b"x"))
                    else:
                        archive.addfile(info)
                self.rehash(folder, "daily.tar")
                with self.assertRaisesRegex(ValueError, "Unsafe archive"):
                    backup.restore_files(folder, self.root / "dangerous-target")
                self.assertFalse((self.root / "escaped").exists())

    def test_corrupt_runtime_is_rejected_even_with_a_matching_tar_hash(self):
        folder = self.make_backup()
        self.database.write_bytes(b"not a SQLite database")
        backup._pack(self.data / "runtime", folder / "runtime.tar")
        self.rehash(folder, "runtime.tar")
        with self.assertRaisesRegex(ValueError, "SQLite integrity"):
            backup.verify(folder, check_postgres=False)

    def test_wal_commits_are_included_and_validated(self):
        db = sqlite3.connect(self.database)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE wal_fixture(value TEXT)")
            db.execute("INSERT INTO wal_fixture VALUES('original synthetic row')")
            db.commit()
            folder = self.make_backup()
            with tarfile.open(folder / "runtime.tar", "r:") as archive:
                self.assertIn("runtime.sqlite-wal", archive.getnames())
            target = self.root / "wal-restored"
            backup.restore_files(folder, target)
            with sqlite3.connect(target / "runtime/runtime.sqlite") as restored:
                self.assertEqual(
                    restored.execute("SELECT count(*) FROM wal_fixture").fetchone(),
                    (1,),
                )
        finally:
            db.close()

    def test_missing_or_changed_daily_assets_and_runtime_links_fail_restore_validation(
        self,
    ):
        folder = self.make_backup()
        target = self.root / "references"
        backup.restore_files(folder, target)
        for mutation in ("checksum", "owner", "runtime", "metadata"):
            row = copy.deepcopy(self.row)
            if mutation == "checksum":
                row["data"]["_assets"][0]["checksum"] = "0" * 64
            elif mutation == "owner":
                row["user_id"] = "00000000-0000-4000-8000-000000000099"
            elif mutation == "runtime":
                row["data"]["pending"]["runId"] = "missing-run"
            else:
                row["data"]["_assets"] = []
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                backup.verify_references(target, [RECORDING], [row])
        (target / "daily" / "audio" / OWNER / "archive" / LESSON / FILENAME).unlink()
        with self.assertRaisesRegex(ValueError, "Daily audio"):
            backup.verify_references(target, [], [self.row])

    def docker(self, *, learning=True, stopped_learning=False, fail_dump=False):
        calls, stopped = [], set()

        def run(command, **kwargs):
            calls.append(command)
            if command[:3] == ["docker", "ps", "--all"]:
                return SimpleNamespace(
                    stdout="ielts-api\n" + ("ielts-learning\n" if learning else "")
                )
            if command[:2] == ["docker", "inspect"]:
                return SimpleNamespace(
                    stdout="false\n"
                    if stopped_learning and command[-1] == "ielts-learning"
                    else "true\n"
                )
            if command[:2] == ["docker", "stop"]:
                stopped.add(command[-1])
            if "pg_dump" in command:
                expected = (
                    {"ielts-api", "ielts-learning"}
                    if learning and not stopped_learning
                    else {"ielts-api"}
                )
                self.assertEqual(stopped, expected)
                if fail_dump:
                    raise subprocess.CalledProcessError(1, command)
                kwargs["stdout"].write(b"synthetic pg_dump fixture")
            return SimpleNamespace(stdout="")

        return calls, run

    def test_backup_quiesces_both_writers_and_restarts_original_services(self):
        calls, run = self.docker()
        destination = self.root / "consistent"
        with patch.object(backup.subprocess, "run", side_effect=run):
            backup.backup(self.base, destination, True)
        self.assertEqual(
            [call[-1] for call in calls if call[:2] == ["docker", "stop"]],
            ["ielts-api", "ielts-learning"],
        )
        self.assertEqual(
            [call[-1] for call in calls if call[:2] == ["docker", "start"]],
            ["ielts-learning", "ielts-api"],
        )
        self.assertEqual(
            json.loads((destination / "manifest.json").read_text())["format"], 2
        )
        self.assertEqual(destination.stat().st_mode & 0o777, 0o700)
        self.assertTrue(
            all(file.stat().st_mode & 0o777 == 0o600 for file in destination.iterdir())
        )

    def test_dump_failure_restarts_every_previously_running_writer(self):
        calls, run = self.docker(fail_dump=True)
        with (
            patch.object(backup.subprocess, "run", side_effect=run),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            backup.backup(self.base, self.root / "failed", True)
        self.assertEqual(
            [call[-1] for call in calls if call[:2] == ["docker", "start"]],
            ["ielts-learning", "ielts-api"],
        )

    def test_absent_or_stopped_learning_does_not_get_started(self):
        for learning, stopped in ((False, False), (True, True)):
            calls, run = self.docker(learning=learning, stopped_learning=stopped)
            destination = self.root / f"legacy-{learning}-{stopped}"
            with patch.object(backup.subprocess, "run", side_effect=run):
                backup.backup(self.base, destination, True)
            self.assertEqual(
                [call[-1] for call in calls if call[:2] == ["docker", "start"]],
                ["ielts-api"],
            )

    def test_quiesce_and_new_external_destination_are_required(self):
        with self.assertRaises(ValueError):
            backup.backup(self.base, self.root / "no-quiesce", False)
        with self.assertRaises(ValueError):
            backup.backup(self.base, self.data / "archive/recursive-backup", True)

    def test_backup_uses_the_same_exclusive_maintenance_lock_as_release(self):
        lock_file = self.base / ".maintenance.lock"
        with lock_file.open("a") as release_lock:
            fcntl.flock(release_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with (
                patch.object(backup.subprocess, "run") as docker,
                self.assertRaisesRegex(ValueError, "maintenance operation"),
            ):
                backup.backup(self.base, self.root / "locked-backup", True)
            docker.assert_not_called()
        self.assertFalse((self.root / "locked-backup").exists())
        calls, run = self.docker()
        with patch.object(backup.subprocess, "run", side_effect=run):
            backup.backup(self.base, self.root / "unlocked-backup", True)
        self.assertTrue(calls)
        self.assertEqual(lock_file.stat().st_mode & 0o777, 0o600)

    def test_restore_script_only_targets_an_isolated_database(self):
        script = ROOT / "deploy/restore-check.sh"
        subprocess.run(["bash", "-n", str(script)], check=True)
        text = script.read_text()
        self.assertIn("--network none", text)
        self.assertIn("--dbname ielts_restore", text)
        self.assertNotIn("--dbname ielts_db", text)
        self.assertIn("backup.verify_references", text)


if __name__ == "__main__":
    unittest.main()
