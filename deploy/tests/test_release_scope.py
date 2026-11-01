import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("scope", ROOT / "deploy/release-scope.py")
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class ReleaseScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Original Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.base = self.commit("README.md", "Original fixture")

    def git(self, *args):
        return (
            subprocess.check_output(
                ["git", *args], cwd=self.root, stderr=subprocess.DEVNULL
            )
            .decode()
            .strip()
        )

    def commit(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        self.git("add", "--", path)
        self.git("commit", "-qm", "Original fixture change")
        return self.git("rev-parse", "HEAD")

    def test_frontend_with_tests_and_coverage_selects_only_web(self):
        self.commit("apps/web/src/example.css", "body { color: black; }")
        self.commit("tests/browser/original.spec.ts", "// original fixture")
        head = self.commit("docs/coverage.md", "Original verification note")
        self.assertEqual(scope.classify(self.root, head, self.base, self.base), "web")
        self.assertEqual(scope.classify(self.root, head, self.base, head), "none")
        docs_only = self.commit(
            "docs/coverage.md", "Updated original verification note"
        )
        self.assertEqual(scope.classify(self.root, docs_only, self.base, head), "none")

    def test_failed_backend_release_is_not_hidden_by_later_frontend_push(self):
        self.commit("services/api/example.mjs", "// original API fixture")
        head = self.commit("apps/web/src/example.css", "body { color: black; }")
        self.assertEqual(scope.classify(self.root, head, self.base, self.base), "full")

    def test_shared_api_code_dependency_locks_and_deploy_code_require_full_release(
        self,
    ):
        for path in [
            *scope.SHARED_API,
            "package-lock.json",
            "services/learning/src/example.py",
            "deploy/server/release.py",
            ".github/workflows/release.yml",
        ]:
            with self.subTest(path=path):
                before = self.git("rev-parse", "HEAD")
                head = self.commit(path, "Original fixture")
                self.assertEqual(
                    scope.classify(self.root, head, before, before), "full"
                )

    def test_backend_to_frontend_rename_is_still_backend_change(self):
        before = self.commit("services/api/example.mjs", "original fixture")
        (self.root / "apps/web/src").mkdir(parents=True)
        self.git("mv", "services/api/example.mjs", "apps/web/src/example.mjs")
        self.git("commit", "-qm", "Original fixture rename")
        self.assertEqual(
            scope.classify(self.root, self.git("rev-parse", "HEAD"), before, before),
            "full",
        )

    def test_unknown_production_version_falls_back_to_full(self):
        output = self.root / "output"
        with (
            mock.patch.object(
                scope, "running_version", side_effect=ValueError("unavailable")
            ),
            mock.patch.object(
                scope.os, "environ", {**os.environ, "GITHUB_OUTPUT": str(output)}
            ),
            mock.patch("sys.argv", ["scope", "--event", "push", "--head", self.base]),
        ):
            scope.main()
        self.assertEqual(output.read_text(), "mode=full\napi_base=\n")

    def test_unknown_and_divergent_git_revisions_are_not_assumed_compatible(self):
        with self.assertRaises(subprocess.CalledProcessError):
            scope.classify(self.root, self.base, "0" * 40, self.base)
        later = self.commit("apps/web/src/example.css", "original fixture")
        with self.assertRaises(subprocess.CalledProcessError):
            scope.classify(self.root, self.base, later, self.base)
