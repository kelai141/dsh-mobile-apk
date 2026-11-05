#!/usr/bin/env python3
"""Turn the pinned official Termux bootstrap ZIP into a clean snapshot base."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import zipfile

from harness_pin import read_harness_identity

_IDENTITY = read_harness_identity()
HARNESS_COMMIT = _IDENTITY.commit
HARNESS_VERSION = _IDENTITY.version

BOOTSTRAP_VERSION = "bootstrap-2026.09.20-r1+apt.android-7"
BOOTSTRAP_SHA256 = "65ba578133ea2f4e5cc07234568815397cf9e1236b5da8c06ce6753cf036cc69"
BOOTSTRAP_URL = (
    "https://github.com/termux/termux-packages/releases/download/"
    "bootstrap-2026.09.20-r1%2Bapt.android-7/bootstrap-aarch64.zip"
)


def safe_member(root: pathlib.Path, relative: str) -> pathlib.Path:
    rel = pathlib.PurePosixPath(relative)
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError(f"unsafe bootstrap path: {relative}")
    dest = root.joinpath(*rel.parts)
    try:
        dest.resolve(strict=False).relative_to(root.resolve())
    except ValueError:
        raise ValueError(f"bootstrap path escaped staging root: {relative}")
    return dest


def materialize_zip(zip_path: pathlib.Path, root: pathlib.Path) -> None:
    with zipfile.ZipFile(zip_path) as archive:
        names = set(archive.namelist())
        for info in archive.infolist():
            name = info.filename.rstrip("/")
            if not name or name == "SYMLINKS.txt":
                continue
            dest = safe_member(root, name)
            if info.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            mode = info.external_attr >> 16
            dest.parent.mkdir(parents=True, exist_ok=True)
            payload = archive.read(info)
            if stat.S_ISLNK(mode):
                target = payload.decode("utf-8")
                dest.symlink_to(target)
            else:
                dest.write_bytes(payload)
                if mode:
                    dest.chmod(mode & 0o777)

        if "SYMLINKS.txt" not in names:
            raise ValueError("official bootstrap is missing SYMLINKS.txt")
        symlinks = archive.read("SYMLINKS.txt").decode("utf-8-sig").splitlines()
        for row in symlinks:
            if not row.strip():
                continue
            try:
                target_name, link_name = row.split("←", 1)
            except ValueError as error:
                raise ValueError(f"invalid SYMLINKS.txt row: {row!r}") from error
            target_name, link_name = target_name.strip(), link_name.strip()
            if target_name.startswith("/") and not target_name.startswith("/data/data/com.termux/files/usr/"):
                raise ValueError(f"unexpected absolute Termux bootstrap target: {target_name}")
            if link_name.startswith("./"):
                link_name = link_name[2:]
            link = safe_member(root, link_name)
            link.parent.mkdir(parents=True, exist_ok=True)
            if link.exists() or link.is_symlink():
                if link.is_dir() and not link.is_symlink():
                    shutil.rmtree(link)
                else:
                    link.unlink()
            # Termux's installer recreates the raw readlink target verbatim;
            # retain that exact behavior so the snapshot builder can relocate
            # Termux-prefix absolute links using its normal sanitizer.
            link.symlink_to(target_name)


def seed_profiles(source_root: pathlib.Path, stage_root: pathlib.Path) -> None:
    home = stage_root / "home" / ".dsh"
    home.mkdir(parents=True, exist_ok=True)
    helper = pathlib.Path(__file__).with_name("seed-dsh-profiles.mjs").resolve()
    subprocess.run(
        ["pnpm", "exec", "tsx", str(helper), str(source_root.resolve()), str(home.resolve())],
        cwd=source_root,
        check=True,
    )


def tree_manifest(root: pathlib.Path) -> list[dict[str, object]]:
    entries = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            target = os.readlink(path)
            if pathlib.PurePosixPath(target).is_absolute():
                raise ValueError(f"absolute symlink in deployed DSH runtime: {relative} -> {target}")
            resolved = (path.parent / target).resolve(strict=False)
            try:
                resolved.relative_to(root.resolve())
            except ValueError as error:
                raise ValueError(f"DSH runtime symlink escapes deployment: {relative} -> {target}") from error
            entries.append({"path": relative, "type": "symlink", "target": target})
        elif path.is_file():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            entries.append({"path": relative, "type": "file", "sha256": digest})
        elif path.is_dir():
            entries.append({"path": relative, "type": "directory"})
    return entries


def main() -> None:
    if len(sys.argv) == 4 and sys.argv[1] == '--extract-bootstrap-only':
        zip_path, extracted_usr = map(pathlib.Path, sys.argv[2:])
        actual = hashlib.sha256(zip_path.read_bytes()).hexdigest()
        if actual != BOOTSTRAP_SHA256:
            raise ValueError(f"official Termux bootstrap SHA-256 mismatch: {actual}")
        extracted_usr.mkdir(parents=True, exist_ok=True)
        materialize_zip(zip_path, extracted_usr)
        print(f"extracted authenticated Termux bootstrap for repository key verification: {extracted_usr}")
        return
    if len(sys.argv) != 5:
        raise SystemExit("usage: prepare-termux-bootstrap.py <bootstrap-aarch64.zip> <source-root> <dsh-deploy-root> <output-base-usr.tar.xz>")
    zip_path, source_root, dsh_deploy, out_path = map(pathlib.Path, sys.argv[1:])
    source_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source_root, text=True).strip()
    source_manifest = json.loads((source_root / "package.json").read_text(encoding="utf-8"))
    if source_commit != HARNESS_COMMIT or source_manifest.get("version") != HARNESS_VERSION:
        raise ValueError(f"bootstrap assembly requires the official {HARNESS_VERSION} source")
    actual = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    if actual != BOOTSTRAP_SHA256:
        raise ValueError(f"official Termux bootstrap SHA-256 mismatch: {actual}")
    dsh_manifest = json.loads((dsh_deploy / "package.json").read_text(encoding="utf-8"))
    if dsh_manifest.get("name") != "@deepseek-ai/dsh" or dsh_manifest.get("version") != HARNESS_VERSION:
        raise ValueError(f"deployed DSH runtime must be @deepseek-ai/dsh@{HARNESS_VERSION}")
    if not (dsh_deploy / "lib" / "bin.js").is_file() or not (dsh_deploy / "node_modules").is_dir():
        raise ValueError("deployed DSH runtime is missing its built CLI or isolated dependency tree")
    dsh_files = tree_manifest(dsh_deploy)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    stage_parent = out_path.parent / ".bootstrap-stage"
    shutil.rmtree(stage_parent, ignore_errors=True)
    stage_parent.mkdir(parents=True)
    termux_root = stage_parent / "termux"
    termux_root.mkdir()
    materialize_zip(zip_path, termux_root)

    stage = stage_parent / "base"
    (stage / "usr").mkdir(parents=True)
    for item in termux_root.iterdir():
        shutil.move(str(item), str(stage / "usr" / item.name))
    dsh_target = stage / "usr" / "lib" / "node_modules" / "@deepseek-ai" / "dsh"
    dsh_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(dsh_deploy, dsh_target, symlinks=True)
    seed_profiles(source_root, stage)

    tmp_tar = out_path.with_suffix(".tar")
    try:
        subprocess.run(
            [
                "tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
                "-cf", str(tmp_tar.resolve()), "-C", str(stage.resolve()), "usr", "home",
            ],
            check=True,
        )
        with tmp_tar.open("rb") as source, out_path.open("wb") as dest:
            subprocess.run(["xz", "-T4", "-9e", "-c"], stdin=source, stdout=dest, check=True)
    finally:
        tmp_tar.unlink(missing_ok=True)

    manifest = {
        "termuxBootstrap": {
            "version": BOOTSTRAP_VERSION,
            "url": BOOTSTRAP_URL,
            "sha256": actual,
        },
        "profileTemplates": {
            "source": "packages/boot/app-boot/src/profile.ts",
            "deepseekHarnessCommit": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source_root, text=True
            ).strip(),
            "profiles": ["web", "headless"],
        },
        "deepSeekHarnessRuntime": {
            "package": f"@deepseek-ai/dsh@{HARNESS_VERSION}",
            "sourceCommit": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source_root, text=True
            ).strip(),
            "deploymentFileCount": len(dsh_files),
            "deploymentFiles": dsh_files,
        },
        "baseTarSha256": hashlib.sha256(out_path.read_bytes()).hexdigest(),
    }
    out_path.with_suffix(out_path.suffix + ".provenance.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"prepared official Termux bootstrap base: {out_path} ({manifest['baseTarSha256']})")
    shutil.rmtree(stage_parent, ignore_errors=True)


if __name__ == "__main__":
    main()
