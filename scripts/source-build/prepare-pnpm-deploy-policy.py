#!/usr/bin/env python3
"""Temporarily approve the pinned Harness subprocess helper for pnpm deploy."""
from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys

from harness_pin import read_harness_identity

_IDENTITY = read_harness_identity()
SOURCE_COMMIT = _IDENTITY.commit
PACKAGE_NAME = "@deepseek-ai/dsh-subprocess-local"
PACKAGE_VERSION = _IDENTITY.version
PACKAGE_PATH = "packages/subprocess/subprocess-local"
BUILD_SCRIPT_PATH = f"{PACKAGE_PATH}/scripts/ensure-spawn-helper.mjs"
ORIGINAL_SELECTOR = (
    "  '@deepseek-ai/dsh-subprocess-local@file:"
    "packages/subprocess/subprocess-local': true"
)


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: prepare-pnpm-deploy-policy.py <pnpm-workspace.yaml> <manifest.json>")
    workspace_path, manifest_path = map(pathlib.Path, sys.argv[1:])
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace_path.parent, text=True).strip()
    root_manifest = json.loads((workspace_path.parent / "package.json").read_text(encoding="utf-8"))
    if commit != SOURCE_COMMIT or root_manifest.get("version") != PACKAGE_VERSION:
        raise ValueError(f"pnpm deploy policy requires the official {PACKAGE_VERSION} source")
    original = workspace_path.read_bytes()
    needle = ORIGINAL_SELECTOR.encode("ascii")
    if original.count(needle) != 1:
        raise ValueError("pinned Harness allowBuilds source selector changed or is ambiguous")
    package_root = workspace_path.parent / PACKAGE_PATH
    deploy_selector = f"  '{PACKAGE_NAME}@{package_root.resolve().as_uri()}': true"
    deploy_selector_bytes = deploy_selector.encode("utf-8")
    if deploy_selector_bytes in original:
        raise ValueError("temporary pnpm deploy selector already exists in pinned workspace config")

    package_json = package_root / "package.json"
    build_script = workspace_path.parent / BUILD_SCRIPT_PATH
    package_manifest = json.loads(package_json.read_text(encoding="utf-8"))
    if package_manifest.get("name") != PACKAGE_NAME or package_manifest.get("version") != PACKAGE_VERSION:
        raise ValueError("pinned subprocess helper package identity changed")
    script_bytes = build_script.read_bytes()
    if b"chmodSync(helper, 0o755)" not in script_bytes or b"import.meta.resolve('node-pty')" not in script_bytes:
        raise ValueError("pinned subprocess helper postinstall behavior changed")

    newline = b"\r\n" if b"\r\n" in original else b"\n"
    insertion = needle + newline + deploy_selector_bytes
    effective = original.replace(needle, insertion, 1)
    workspace_path.write_bytes(effective)

    manifest = {
        "harnessSourceCommit": SOURCE_COMMIT,
        "workspaceConfig": {
            "path": "pnpm-workspace.yaml",
            "originalSha256": sha256(original),
            "effectiveSha256": sha256(effective),
            "temporarySelector": deploy_selector.strip(),
        },
        "allowedBuildScript": {
            "package": f"{PACKAGE_NAME}@{PACKAGE_VERSION}",
            "sourcePath": BUILD_SCRIPT_PATH,
            "packageJsonSha256": sha256(package_json.read_bytes()),
            "scriptSha256": sha256(script_bytes),
            "effect": "restore executable permission on the pinned node-pty spawn-helper",
            "reason": "pnpm deploy rewrites the existing relative file: workspace selector into an absolute file: source; this temporary selector matches only the exact pinned local package path",
        },
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"prepared exact pnpm deploy build policy for {PACKAGE_NAME}@{PACKAGE_VERSION}")


if __name__ == "__main__":
    main()
