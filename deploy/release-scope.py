#!/usr/bin/env python3
"""Classify changes from the running components, not merely the last push."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

SHA = re.compile(r"[0-9a-f]{40}")
SHARED_API = {"apps/web/src/lib/questions.mjs", "apps/web/src/lib/test-track.mjs"}


def path_kind(path):
    if path in SHARED_API:
        return "backend"
    if path.startswith("apps/web/") or path in {
        "deploy/web.Dockerfile",
        "deploy/web-server.mjs",
    }:
        return "web"
    if path.startswith(("docs/", "tests/")) or path in {"README.md", "AGENTS.md"}:
        return "metadata"
    return "backend"


def changed_paths(root, base, head):
    if not SHA.fullmatch(base) or not SHA.fullmatch(head):
        raise ValueError("Invalid deployment revision")
    subprocess.run(
        ["git", "merge-base", "--is-ancestor", base, head],
        cwd=root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    raw = subprocess.check_output(
        ["git", "diff", "--no-renames", "--name-only", "-z", base, head], cwd=root
    )
    return [path for path in raw.decode().split("\0") if path]


def classify(root, head, api_base, web_base):
    if any(
        path_kind(path) == "backend" for path in changed_paths(root, api_base, head)
    ):
        return "full"
    return (
        "web"
        if any(
            path_kind(path) != "metadata"
            for path in changed_paths(root, web_base, head)
        )
        else "none"
    )


def running_version(path, service):
    with urllib.request.urlopen(
        "https://ielts.yiminlab.site" + path, timeout=10
    ) as response:
        raw = response.read(4097)
    if len(raw) > 4096:
        raise ValueError("Health response is too large")
    body = json.loads(raw)
    if not isinstance(body, dict):
        raise ValueError("Invalid health response")
    version = body.get("version", "")
    if (
        body.get("service") != service
        or body.get("status") != "ok"
        or not SHA.fullmatch(version)
    ):
        raise ValueError("Cannot establish the running component revision")
    return version


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", choices=("push", "workflow_dispatch"), required=True)
    parser.add_argument("--head", required=True)
    args = parser.parse_args()
    mode, api_base = "full", ""
    if args.event == "push":
        try:
            api_base = running_version("/health", "ielts-api")
            web_base = running_version("/web-health", "ielts-web")
            mode = classify(Path.cwd(), args.head, api_base, web_base)
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            # Unknown or divergent deployment state must never skip backend work.
            mode, api_base = "full", ""
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"mode={mode}\napi_base={api_base}\n")
    print(f"Release scope: {mode}")


if __name__ == "__main__":
    main()
