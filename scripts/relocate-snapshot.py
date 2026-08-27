#!/usr/bin/env python3
"""Relocate a Termux-derived snapshot rootfs from /data/data/com.termux to the
DSH app prefix.  Streams tar.xz -> tar.xz, fixing:

  1. symlinks whose absolute target starts with /data/data/com.termux ->
     rewritten to a RELATIVE target inside the archive (target file lives at
     the same relative path under the archive root);
  2. text files (no NUL bytes, <= 4 MiB) containing the old prefix ->
     rewritten to the new app prefix (variable-length replacement);
  3. build residue (node-gyp CMake artifacts, installed-tests, compile_commands
     etc.) -> dropped.

ELF binaries are intentionally NOT rewritten (variable-length replacement
would corrupt them); their functional paths are covered by shellEnv()
environment variables (SSL_CERT_FILE / CURL_CA_BUNDLE / GIT_SSL_CAINFO / ...).

usage: python relocate-snapshot.py <in.tar.xz> <out.tar.xz> [--new-prefix PATH]
"""
import io
import lzma
import os
import posixpath
import sys
import tarfile

OLD = b"/data/data/com.termux"
OLD_S = "/data/data/com.termux"
DEFAULT_NEW = "/data/user/0/com.dsharnessmobile.shell"
# legacy package-name prefixes (pre-FX-1) that must also be relocated:
LEGACY_PKG = b"com.dshmobile.shell"
LEGACY_PKG_S = "com.dshmobile.shell"
NEW_PKG_S = "com.dsharnessmobile.shell"

# build-residue fragments/suffixes — intermediate files only.  Native module
# products (*.node / *.so under node_modules/<pkg>/build/Release) are KEPT.
DROP_FRAGMENTS = (
    "/CMakeFiles/",
    "/installed-tests/",
)
DROP_SUFFIXES = (
    ".o.d",
    ".ninja_deps",
    ".ninja_log",
    "CMakeCache.txt",
    "CMakeConfigureLog.yaml",
    "compile_commands.json",
    "build.ninja",
    "Makefile.cmake",
    "makefile.cmake",
    "cmake_install.cmake",
    "koffi_unity.cpp.o",
)


def should_drop(name: str) -> bool:
    n = name
    if any(f in n for f in DROP_FRAGMENTS):
        return True
    if n.endswith(DROP_SUFFIXES):
        return True
    # inside node-gyp build dirs: drop intermediate object files (*.o) but keep
    # final artifacts (*.node, *.so) — koffi/node-pty need their native modules.
    if "/node_modules/" in n and "/build/" in n:
        base = n.rsplit("/", 1)[-1]
        if base.endswith(".o"):
            return True
    return False


def relativize(member_name: str, linkname: str, new_prefix: str) -> str:
    """Rewrite an absolute /data/data/com.termux target to a relative link
    pointing at the same file inside the relocated archive."""
    rest = linkname[len(OLD_S):]  # e.g. /files/usr/lib/librhash.so.1
    if rest.startswith("/files/"):
        rest = rest[len("/files/"):]
    else:
        rest = rest.lstrip("/")
    # archive root path of the target (usr/... or home/...)
    target_abs = rest  # relative to archive root, e.g. usr/lib/librhash.so.1
    base = posixpath.dirname(member_name) or "."
    rel = posixpath.relpath(target_abs, base)
    return rel


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    new_prefix = DEFAULT_NEW
    if "--new-prefix" in sys.argv:
        i = sys.argv.index("--new-prefix")
        new_prefix = sys.argv[i + 1]
    if len(args) != 2:
        print("usage: relocate-snapshot.py <in.tar.xz> <out.tar.xz> [--new-prefix PATH]")
        sys.exit(1)
    src, dst = args[0], args[1]
    new_bytes = new_prefix.encode()

    stats = {"symlinks": 0, "texts": 0, "dropped": 0, "skipped_binary": 0}
    with lzma.open(src, "rb") as fin, lzma.open(dst, "wb") as fout:
        with tarfile.open(fileobj=fin, mode="r|") as tin, tarfile.open(fileobj=fout, mode="w|") as tout:
            for member in tin:
                if should_drop(member.name):
                    stats["dropped"] += 1
                    continue
                if member.issym() or member.islnk():
                    link = member.linkname
                    new_link = None
                    if link.startswith(OLD_S):
                        new_link = relativize(member.name, link, new_prefix)
                        stats["symlinks"] += 1
                    elif LEGACY_PKG_S in link:
                        # legacy package-name absolute target (com.dshmobile.shell):
                        # rewrite to the new package path, keep absolute form
                        # (matches how the app resolves its own files dir).
                        new_link = link.replace(LEGACY_PKG_S, NEW_PKG_S)
                        stats["symlinks"] += 1
                    if new_link is not None:
                        # Rebuild the TarInfo: mutating linkname in place is not
                        # honored by tarfile stream mode (r| -> w|) writes.
                        m = tarfile.TarInfo(member.name)
                        m.type = member.type
                        m.linkname = new_link
                        m.mode = member.mode
                        m.uid = member.uid
                        m.gid = member.gid
                        m.uname = member.uname
                        m.gname = member.gname
                        m.mtime = member.mtime
                        tout.addfile(m)
                    else:
                        tout.addfile(member)
                    continue
                if member.isfile():
                    data = tin.extractfile(member)
                    if data is None:
                        tout.addfile(member)
                        continue
                    if member.size > 4 * 1024 * 1024:
                        # big file: copy through, but still cheap-scan for prefix
                        stats["skipped_binary"] += 1
                        tout.addfile(member, data)
                        continue
                    content = data.read()
                    if b"\x00" in content:
                        stats["skipped_binary"] += 1
                        tout.addfile(member, io.BytesIO(content))
                        continue
                    if OLD in content or LEGACY_PKG in content:
                        replaced = content.replace(OLD, new_bytes).replace(LEGACY_PKG, NEW_PKG_S.encode())
                        m = tarfile.TarInfo(member.name)
                        m.size = len(replaced)
                        m.mode = member.mode
                        m.mtime = member.mtime
                        m.uid = member.uid
                        m.gid = member.gid
                        m.uname = member.uname
                        m.gname = member.gname
                        m.type = member.type
                        m.linkname = member.linkname
                        tout.addfile(m, io.BytesIO(replaced))
                        stats["texts"] += 1
                    else:
                        tout.addfile(member, io.BytesIO(content))
                    continue
                tout.addfile(member)
    print(f"relocated: symlinks={stats['symlinks']} texts={stats['texts']} "
          f"dropped={stats['dropped']} binary-skipped={stats['skipped_binary']}")
    print("DONE")


if __name__ == "__main__":
    main()
