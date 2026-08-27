#!/usr/bin/env python3
"""inject-snapshot.py — byte-level tar stream injection: replace plugins inside a snapshot (preserving symlink metadata).

On Windows, bsdtar needs admin rights to unpack symlinks (silent failure drops symlinks → missing node SONAME libs).
This script streams via Python tarfile: symlinks are tar entry metadata (typeflag=2),
never materialized on the filesystem, so no privilege issues. Input and output are both tar.xz.

Usage:
  python inject-snapshot.py <snapshot.tar.xz> <out.tar.xz> <pkg1_dir> <pkg2_dir> ...
Each <pkg_dir> is a plugin repo root (with lib/ and package.json), matched by directory name against
home/.dsh/profiles/{web,headless}/node_modules/@dsh-android/<name>/,
replacing only lib/* (minus *.map) and package.json.
"""
import io
import lzma
import os
import sys
import tarfile

PLUGIN_ROOT = "home/.dsh/profiles"
INJECT_FILES = {"package.json"}


def is_injectable(name, pkg_names):
    # name looks like home/.dsh/profiles/<profile>/node_modules/@dsh-android/<pkg>/lib/... or .../<pkg>/package.json
    parts = name.split("/")
    if len(parts) < 8 or parts[0:2] != ["home", ".dsh"]:
        return False
    if parts[2] != "profiles" or parts[3] not in ("web", "headless"):
        return False
    if parts[4:6] != ["node_modules", "@dsh-android"]:
        return False
    pkg = parts[6]
    if pkg not in pkg_names:
        return False
    rel = "/".join(parts[7:])
    if rel.startswith("lib/"):
        return not rel.endswith(".map")  # sourcemaps stay out of the release (security gate)
    return rel in INJECT_FILES


def build_replacements(pkg_dirs):
    """pkg name -> {relative lib path -> bytes} + package.json bytes"""
    out = {}
    for d in pkg_dirs:
        name = os.path.basename(os.path.normpath(d))
        files = {}
        lib = os.path.join(d, "lib")
        for root, _dirs, fnames in os.walk(lib):
            for fn in fnames:
                if fn.endswith(".map"):
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, lib).replace("\\", "/")
                with open(full, "rb") as f:
                    files["lib/" + rel] = f.read()
        with open(os.path.join(d, "package.json"), "rb") as f:
            files["package.json"] = f.read()
        out[name] = files
    return out


def main():
    src, dst = sys.argv[1], sys.argv[2]
    pkg_dirs = sys.argv[3:]
    repl = build_replacements(pkg_dirs)
    pkg_names = set(repl.keys())
    print("injecting packages:", sorted(pkg_names))

    with lzma.open(src, "rb") as f:
        raw = f.read()
    # 预扫描与主循环各自持有独立流（BytesIO 指针会被 tarfile 消费推进）
    scan_buf = io.BytesIO(raw)
    inbuf = io.BytesIO(raw)
    outbuf = io.BytesIO()
    replaced = 0
    added = 0
    # 快照内已存在的 @dsh-android 包（替换语义）；不存在的包走新增（add 语义）
    existing = set()
    with tarfile.open(fileobj=scan_buf, mode="r:*") as tin:
        for member in tin:
            if is_injectable(member.name, pkg_names):
                existing.add(member.name.split("/")[6])
    print("existing packages:", sorted(existing))
    need_add = [n for n in pkg_names if n not in existing]

    with tarfile.open(fileobj=inbuf, mode="r:*") as tin, \
            tarfile.open(fileobj=outbuf, mode="w", format=tarfile.PAX_FORMAT) as tout:
        for member in tin:
            if member.isfile() and is_injectable(member.name, pkg_names):
                pkg = member.name.split("/")[6]
                rel = "/".join(member.name.split("/")[7:])
                data = repl[pkg][rel]
                newm = tarfile.TarInfo(member.name)
                newm.size = len(data)
                newm.mtime = int(member.mtime)
                newm.mode = member.mode
                tout.addfile(newm, io.BytesIO(data))
                replaced += 1
            elif member.isfile():
                fobj = tin.extractfile(member)
                tout.addfile(member, fobj)
            else:
                # symlink/dir/hardlink etc.: no content, copy metadata as-is
                tout.addfile(member)
        for pkg in need_add:
            base = "home/.dsh/profiles/web/node_modules/@dsh-android/" + pkg
            for dirpath in [base, base + "/lib"]:
                ti = tarfile.TarInfo(dirpath)
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o755
                ti.mtime = int(__import__("time").time())
                tout.addfile(ti)
            for rel, data in sorted(repl[pkg].items()):
                ti = tarfile.TarInfo(base + "/" + rel)
                ti.size = len(data)
                ti.mode = 0o644
                ti.mtime = int(__import__("time").time())
                tout.addfile(ti, io.BytesIO(data))
                added += 1
            print("  [add] %s (%d files)" % (pkg, len(repl[pkg])))
    print("replaced entries:", replaced, "| added packages:", added, "(", ", ".join(need_add) if need_add else "(none)", ")")
    with lzma.open(dst, "wb", preset=9) as f:
        f.write(outbuf.getvalue())
    print("written:", dst, os.path.getsize(dst), "bytes")


if __name__ == "__main__":
    main()
