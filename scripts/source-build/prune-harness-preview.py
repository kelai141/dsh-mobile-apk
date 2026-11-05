#!/usr/bin/env python3
"""Exclude Harness web preview build outputs that upstream excludes from publication."""
from __future__ import annotations

import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

from harness_pin import read_harness_identity

_IDENTITY = read_harness_identity()
HARNESS_COMMIT = _IDENTITY.commit

PACKAGE_NAME = "@deepseek-ai/dsh-web-frontend"
PACKAGE_VERSION = _IDENTITY.version
EXPECTED_FILES = ["dist", "!dist/**/*.map", "!dist/preview.html", "!dist/preview"]


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def files_under(root: pathlib.Path) -> list[dict[str, object]]:
    entries = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"unexpected symlink in excluded Harness preview output: {path}")
        if path.is_file():
            entries.append({
                "path": path.relative_to(root).as_posix(),
                "size": path.stat().st_size,
                "sha256": digest(path),
            })
    return entries


def package_identity(package_root: pathlib.Path) -> bytes:
    package_file = package_root / "package.json"
    package_bytes = package_file.read_bytes()
    package = json.loads(package_bytes)
    if package.get("name") != PACKAGE_NAME or package.get("version") != PACKAGE_VERSION:
        raise ValueError(f"unexpected deployed Harness web package identity at {package_root}")
    if package.get("files") != EXPECTED_FILES:
        raise ValueError("Harness web publication exclusions changed; review preview pruning policy")
    return package_bytes


def prune_package_outputs(package_root: pathlib.Path, label: str, required: bool) -> list[dict[str, object]]:
    package_bytes = package_identity(package_root)
    dist = package_root / "dist"
    preview = dist / "preview"
    preview_html = dist / "preview.html"
    entries: list[dict[str, object]] = []
    if preview.is_symlink() or preview_html.is_symlink():
        raise ValueError(f"refusing to prune symlinked Harness preview output in {label}")
    if preview.is_dir():
        files = files_under(preview)
        if not files or not any(str(item["path"]).endswith(".js") for item in files):
            raise ValueError(f"Harness preview bundle is empty at {label}")
        entries.extend({
            "root": label,
            "path": "dist/preview/" + str(item["path"]),
            "size": item["size"],
            "sha256": item["sha256"],
        } for item in files)
        shutil.rmtree(preview)
    elif required:
        raise ValueError(f"source-built Harness preview directory is missing at {label}")
    if preview_html.is_file():
        entries.append({
            "root": label,
            "path": "dist/preview.html",
            "size": preview_html.stat().st_size,
            "sha256": digest(preview_html),
        })
        preview_html.unlink()
    elif required:
        raise ValueError(f"source-built Harness preview page is missing at {label}")
    if required and not entries:
        raise ValueError(f"source-built Harness preview outputs were unexpectedly empty at {label}")
    return entries


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: prune-harness-preview.py <harness-source-root> <dsh-deploy-root> <provenance.json>")
    source_root, deploy_root, manifest_path = map(pathlib.Path, sys.argv[1:])
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source_root, text=True).strip()
    root_manifest = json.loads((source_root / "package.json").read_text(encoding="utf-8"))
    if commit != HARNESS_COMMIT or root_manifest.get("version") != PACKAGE_VERSION:
        raise ValueError(f"preview pruning requires the official {PACKAGE_VERSION} source")
    package_root = source_root / "apps" / "web"
    package_file = package_root / "package.json"
    package_bytes = package_file.read_bytes()
    if package_identity(package_root) != package_bytes:
        raise ValueError("Harness web package manifest changed during preview verification")
    removed = prune_package_outputs(package_root, "source/apps/web", required=True)

    node_modules = deploy_root / "node_modules"
    candidates = {node_modules / "@deepseek-ai" / "dsh-web-frontend"}
    pnpm_store = node_modules / ".pnpm"
    if pnpm_store.is_dir():
        for package_json in pnpm_store.rglob("package.json"):
            try:
                package = json.loads(package_json.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if package.get("name") == PACKAGE_NAME:
                candidates.add(package_json.parent)
    seen = set()
    for candidate in sorted(candidates):
        package_json = candidate / "package.json"
        if not package_json.is_file():
            continue
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        if resolved != package_root.resolve():
            try:
                resolved.relative_to(deploy_root.resolve())
            except ValueError as error:
                raise ValueError(f"deployed Harness web package escapes the source/deploy roots: {candidate} -> {resolved}") from error
        seen.add(resolved)
        removed.extend(prune_package_outputs(resolved, "deploy/" + candidate.relative_to(deploy_root).as_posix(), required=False))
    if not seen:
        raise ValueError("deployed runtime is missing the pinned Harness web package")

    manifest = {
        "source": "https://github.com/deepseek-ai/deepseek-harness",
        "sourceCommit": commit,
        "package": f"{PACKAGE_NAME}@{PACKAGE_VERSION}",
        "packageJsonSha256": hashlib.sha256(package_bytes).hexdigest(),
        "upstreamFilesPolicy": EXPECTED_FILES,
        "removedBecause": "The source-built experimental WebWorker preview outputs are explicitly excluded by the pinned package's upstream files allowlist; the Android runtime uses the standard dist/index.html surface.",
        "removedFiles": removed,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if not removed:
        raise ValueError("no Harness preview outputs were removed; expected source/deploy output to be present")
    print(f"removed {len(removed)} source-built Harness preview files excluded by upstream package policy")


if __name__ == "__main__":
    main()
