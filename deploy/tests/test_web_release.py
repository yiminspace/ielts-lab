import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from test_release_images import (
    image,
    API_ID,
    WEB_ID,
    LEARNING_ID,
    API_DIGEST,
    WEB_DIGEST,
    LEARNING_DIGEST,
    SHA,
    OLD_SHA,
)

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "web_release", ROOT / "deploy/server/release.py"
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class WebReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        for name in ["compose.yml", "learning.compose.yml", *release.CONFIG_FILES]:
            (self.base / name).write_text("original unchanged fixture")
        self.old_web = "sha256:" + "9" * 64
        self.previous = {
            "version": OLD_SHA,
            "api": release.REPOSITORIES["api"] + "@" + API_DIGEST,
            "web": release.REPOSITORIES["web"] + "@" + WEB_DIGEST,
            "learning": release.REPOSITORIES["learning"] + "@" + LEARNING_DIGEST,
            "apiImageId": API_ID,
            "webImageId": self.old_web,
            "learningImageId": LEARNING_ID,
        }
        (self.base / "release.json").write_text(json.dumps(self.previous))
        (self.base / ".env").write_text("original image pointers")
        self.before = {
            path.name: (path.read_bytes(), path.stat().st_mtime_ns)
            for path in self.base.iterdir()
        }
        self.calls = []

    def command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout=b"")

    def invoke(self, command=None, base=OLD_SHA):
        with (
            tempfile.TemporaryDirectory(dir=self.base) as stage,
            mock.patch.object(release, "BASE", self.base),
            mock.patch.object(release, "run", side_effect=command or self.command),
            mock.patch.object(
                release, "inspect_image", side_effect=lambda ref: image(ref, OLD_SHA)
            ),
            mock.patch.object(
                release,
                "prepare_image",
                return_value={
                    "requested": release.REPOSITORIES["web"] + "@" + WEB_DIGEST,
                    "imageId": WEB_ID,
                },
            ),
        ):
            release.release_web(WEB_DIGEST, SHA, base, Path(stage))

    def assert_only_web_touched(self):
        for name in ["compose.yml", "learning.compose.yml", *release.CONFIG_FILES]:
            path = self.base / name
            self.assertEqual(
                (path.read_bytes(), path.stat().st_mtime_ns), self.before[name]
            )
        for args, _ in self.calls:
            self.assertFalse(args[:2] in (["docker", "run"], ["docker", "rm"]))
            if args[:2] == ["docker", "compose"]:
                self.assertEqual(args[-1], "ielts-web")
                self.assertIn("--no-deps", args)
            if args[:2] == ["docker", "exec"]:
                self.assertEqual(args[2], "ielts-web")

    def test_web_only_keeps_backend_images_config_and_global_version(self):
        self.invoke()
        self.assert_only_web_touched()
        current = json.loads((self.base / "release.json").read_text())
        self.assertEqual(current["version"], OLD_SHA)
        self.assertEqual(current["webVersion"], SHA)
        self.assertEqual(current["apiImageId"], API_ID)
        self.assertEqual(current["learningImageId"], LEARNING_ID)
        self.assertEqual(current["webImageId"], WEB_ID)
        self.assertIn("IELTS_API_IMAGE=" + API_ID, (self.base / ".env").read_text())

    def test_failed_web_health_restores_only_web_and_its_metadata(self):
        def command(args, **kwargs):
            self.command(args, **kwargs)
            if args[:3] == ["docker", "exec", "ielts-web"] and args[-1] == SHA:
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, stdout=b"")

        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke(command)
        self.assert_only_web_touched()
        for name in (".env", "release.json"):
            self.assertEqual((self.base / name).read_bytes(), self.before[name][0])
        updates = [
            kwargs["env"]
            for args, kwargs in self.calls
            if args[:2] == ["docker", "compose"]
        ]
        self.assertEqual(
            [item["IELTS_WEB_IMAGE"] for item in updates], [WEB_ID, self.old_web]
        )

    def test_changed_backend_baseline_rejects_web_release_before_container_changes(
        self,
    ):
        with self.assertRaisesRegex(ValueError, "Backend changed"):
            self.invoke(base=SHA)
        self.assertEqual(self.calls, [])

    def test_full_rollback_accepts_mixed_web_and_backend_revisions(self):
        previous = {**self.previous, "webVersion": SHA}

        def inspect(ref):
            return image(ref, SHA if ref == self.old_web else OLD_SHA)

        with mock.patch.object(release, "inspect_image", side_effect=inspect):
            self.assertEqual(
                release.rollback_images(previous)["IELTS_WEB_IMAGE"], self.old_web
            )
