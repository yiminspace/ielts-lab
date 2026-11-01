import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "runtime_pin", ROOT / "deploy/runtime-pin.py"
)
pin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pin)


class RuntimePinTests(unittest.TestCase):
    def test_checked_in_pin_and_lock_agree(self):
        self.assertRegex(pin.runtime_pin(ROOT / "services/learning"), r"^[0-9a-f]{40}$")

    def test_rejects_unfixed_sources_and_inconsistent_locks_before_private_checkout(
        self,
    ):
        ref = "a" * 40
        for repository, revision, locked, count, extra in [
            (pin.REPOSITORY, ref, ref, 1, ""),
            ("https://example.invalid/runtime.git", ref, ref, 1, ""),
            (pin.REPOSITORY, "main", ref, 1, ""),
            (pin.REPOSITORY, ref, "b" * 40, 1, ""),
            (pin.REPOSITORY, ref, ref, 0, ""),
            (pin.REPOSITORY, ref, ref, 2, ""),
            (pin.REPOSITORY, ref, ref, 1, ', branch = "main"'),
        ]:
            with (
                self.subTest(
                    repository=repository,
                    revision=revision,
                    locked=locked,
                    count=count,
                    extra=extra,
                ),
                tempfile.TemporaryDirectory() as folder,
            ):
                project = Path(folder)
                (project / "pyproject.toml").write_text(
                    '[tool.uv.sources]\nagent-runtime = {git = "'
                    + repository
                    + '", rev = "'
                    + revision
                    + '"'
                    + extra
                    + "}\n"
                )
                (project / "uv.lock").write_text(
                    (
                        '[[package]]\nname = "agent-runtime"\nsource = {git = "'
                        + pin.REPOSITORY
                        + "?rev="
                        + locked
                        + "#"
                        + locked
                        + '"}\n'
                    )
                    * count
                )
                if (repository, revision, locked, count, extra) == (
                    pin.REPOSITORY,
                    ref,
                    ref,
                    1,
                    "",
                ):
                    self.assertEqual(pin.runtime_pin(project), ref)
                else:
                    with self.assertRaises(ValueError):
                        pin.runtime_pin(project)
