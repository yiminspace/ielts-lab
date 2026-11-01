#!/usr/bin/env python3
"""Validate the private dependency before granting a trusted build access to it."""

import re
import tomllib
from pathlib import Path

REPOSITORY = "https://github.com/yiminspace/agent-runtime.git"


def runtime_pin(project: Path) -> str:
    config = tomllib.loads((project / "pyproject.toml").read_text())
    source = config["tool"]["uv"]["sources"]["agent-runtime"]
    if set(source) != {"git", "rev"} or source["git"] != REPOSITORY:
        raise ValueError("The runtime must come from the fixed private repository")
    ref = source["rev"]
    if not isinstance(ref, str) or not re.fullmatch(r"[0-9a-f]{40}", ref):
        raise ValueError("The runtime must be pinned to a full commit SHA")
    lock = tomllib.loads((project / "uv.lock").read_text())
    packages = [
        item for item in lock.get("package", []) if item["name"] == "agent-runtime"
    ]
    expected = REPOSITORY + "?rev=" + ref + "#" + ref
    if len(packages) != 1 or packages[0].get("source", {}).get("git") != expected:
        raise ValueError("The runtime lock must match the configured commit")
    return ref


if __name__ == "__main__":
    print(runtime_pin(Path("services/learning")))
