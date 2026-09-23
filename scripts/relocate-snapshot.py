#!/usr/bin/env python3
"""Relocate a Termux-derived snapshot rootfs from /data/data/com.termux to the
DSH app prefix.  Streams tar.xz -> tar.xz, fixing:

  1. symlinks whose absolute target starts with /data/data/com.termux ->
     rewritten to a RELATIVE target inside the archive (target file lives at
     the same relative path under the archive root);
  2. text files (no NUL bytes, <= 4 MiB) containing the old prefix ->
     rewritten to the new app prefix (variable-length replacement);
  3. build residue (node-gyp CMake artifacts, installed-tests, compile_commands
     etc.) -> dropped;
  4. git 家族的 ELF：编译期写死的 SHELL_PATH 做**等长**原地替换（唯一例外，
     理由见下）。

ELF binaries are intentionally NOT rewritten (variable-length replacement
would corrupt them); their functional paths are covered by shellEnv()
environment variables (SSL_CERT_FILE / CURL_CA_BUNDLE / GIT_SSL_CAINFO / ...).

EXCEPTION — git SHELL_PATH (apk issue #247): SHELL_PATH 是**唯一没有运行时
覆盖点**的编译期路径。同类对照：`--exec-path` 有 `GIT_EXEC_PATH`（本仓已用
`usr/bin/git` wrapper 覆盖，issue #80/#87）、CA 有 `GIT_SSL_CAINFO`，而 shell
路径**没有任何环境变量可改**；而 git 的 `credential.helper` / `!` 前缀 alias /
hook 一律经 run-command 的 shell 执行 ⇒ 旧前缀不存在时它们全部 `cannot exec`。
落点只有 `usr/bin/git.real` 与 `usr/libexec/git-core/*`（共 8 个 ELF，实测各含
该串 1 次）。替换成更短的 `/system/bin/sh` + NUL 填充 ⇒ **等长**替换，文件长度
与 ELF 节表/偏移全不变，故不违反上面那条「ELF 不做变长重写」的禁令。

判据：`python3 relocate-snapshot.py --self-test`（无仓库依赖，可判红）。

usage: python relocate-snapshot.py <in.tar.xz> <out.tar.xz> [--new-prefix PATH]
       python3 relocate-snapshot.py --self-test
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

# apk issue #247 —— git 编译期 SHELL_PATH（38 B，无任何运行时覆盖点）。
# 替换为更短的 /system/bin/sh（14 B）并用 NUL 填充到原长：**等长**替换，
# 不触碰 ELF 的任何偏移，因此可以安全地作用于二进制。
SHELL_PATH_OLD = b"/data/data/com.termux/files/usr/bin/sh"
SHELL_PATH_NEW = b"/system/bin/sh"
assert len(SHELL_PATH_NEW) < len(SHELL_PATH_OLD), \
    "等长替换要求新串严格短于旧串（旧=%d 新=%d）" % (len(SHELL_PATH_OLD), len(SHELL_PATH_NEW))
SHELL_PATH_PAD = SHELL_PATH_NEW + b"\0" * (len(SHELL_PATH_OLD) - len(SHELL_PATH_NEW))
SHELL_PATH_GIT_EXACT = ("usr/bin/git.real",)
SHELL_PATH_GIT_PREFIX = "usr/libexec/git-core/"

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


def is_git_shell_path_elf(name: str) -> bool:
    """git 家族里带编译期 SHELL_PATH 的 ELF —— 等长替换的唯一白名单。

    白名单而不是「所有含旧串的 ELF」：快照内另有 node / dash / make /
    tar.real 等 20+ 个 ELF 也含同一字面量（多为 help/编译期默认值），
    它们不在本 issue 的因果链上，一律维持原状。
    """
    return name in SHELL_PATH_GIT_EXACT or name.startswith(SHELL_PATH_GIT_PREFIX)


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


def _copy_member(member: tarfile.TarInfo, content: bytes) -> tarfile.TarInfo:
    """Rebuild a TarInfo (stream mode r| -> w| ignores in-place mutation)."""
    m = tarfile.TarInfo(member.name)
    m.size = len(content)
    m.mode = member.mode
    m.mtime = member.mtime
    m.uid = member.uid
    m.gid = member.gid
    m.uname = member.uname
    m.gname = member.gname
    m.type = member.type
    m.linkname = member.linkname
    return m


def relocate(src: str, dst: str, new_prefix: str) -> dict:
    """把 src 的 tar.xz 重定位后写出 dst，返回计数。"""
    new_bytes = new_prefix.encode()
    stats = {"symlinks": 0, "texts": 0, "dropped": 0, "skipped_binary": 0,
             "elf_shell_path": 0}
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
                    if is_git_shell_path_elf(member.name):
                        # issue #247：等长替换，且不理会 4 MiB 上限（本族实测
                        # 2.0–3.4 MiB，此处显式认领是为了将来变大也不静默漏掉）。
                        content = data.read()
                        if SHELL_PATH_OLD in content:
                            replaced = content.replace(SHELL_PATH_OLD, SHELL_PATH_PAD)
                            assert len(replaced) == len(content), \
                                "等长替换被破坏：%d -> %d" % (len(content), len(replaced))
                            stats["elf_shell_path"] += 1
                            tout.addfile(_copy_member(member, replaced), io.BytesIO(replaced))
                        else:
                            tout.addfile(_copy_member(member, content), io.BytesIO(content))
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
                        stats["texts"] += 1
                        tout.addfile(_copy_member(member, replaced), io.BytesIO(replaced))
                    else:
                        tout.addfile(member, io.BytesIO(content))
                    continue
                tout.addfile(member)
    return stats


# --------------------------------------------------------------------------
# self-test（apk issue #247）：合成一个 tar.xz、跑一遍重定位、逐条断言。
# 无仓库依赖、无网络、无设备，可直接进 CI：
#   python3 relocate-snapshot.py --self-test
# --------------------------------------------------------------------------
def _build_fixture(path: str) -> dict:
    def elf() -> bytes:
        # 形态贴近真品：ELF magic + 若干 NUL + 那个 38 字节常量 + 尾部标记。
        return (b"\x7fELF\x02\x01\x01\x00" + b"\x00" * 8 + SHELL_PATH_OLD
                + b"\x00" * 4 + b"TAIL-MARKER")

    members = {
        "usr/bin/git.real": elf(),
        "usr/libexec/git-core/git-remote-http": elf(),
        "usr/bin/curl": elf(),  # 非白名单 ELF：必须原样保留
        "usr/share/relocated.txt": ("PREFIX=" + OLD_S + "/bin\n").encode(),
    }
    with lzma.open(path, "wb") as fh:
        with tarfile.open(fileobj=fh, mode="w|") as tar:
            for name, content in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(content)
                info.mode = 0o644
                tar.addfile(info, io.BytesIO(content))
            link = tarfile.TarInfo("usr/lib/libfoo.so")
            link.type = tarfile.SYMTYPE
            link.linkname = OLD_S + "/files/usr/lib/libbar.so"
            tar.addfile(link)
    return members


def self_test() -> int:
    import tempfile

    tmp = tempfile.mkdtemp(prefix="relocate-snapshot-selftest-")
    src = os.path.join(tmp, "in.tar.xz")
    dst = os.path.join(tmp, "out.tar.xz")
    members = _build_fixture(src)
    stats = relocate(src, dst, DEFAULT_NEW)

    got = {}
    with lzma.open(dst, "rb") as fh, tarfile.open(fileobj=fh, mode="r|") as tar:
        for m in tar:
            if m.isfile():
                got[m.name] = tar.extractfile(m).read()
            elif m.issym():
                got[m.name] = b"->" + m.linkname.encode()

    fails = []

    def check(label: str, cond: bool) -> None:
        print(("PASS  " if cond else "FAIL  ") + label)
        if not cond:
            fails.append(label)

    git = got.get("usr/bin/git.real", b"")
    check("git.real 被等长改写（长度与尾部标记都不变）",
          len(git) == len(members["usr/bin/git.real"]) and git.endswith(b"TAIL-MARKER"))
    check("git.real 内旧前缀串已消失", SHELL_PATH_OLD not in git)
    check("git.real 内新串就位（/system/bin/sh + NUL 填充）", SHELL_PATH_PAD in git)
    check("libexec/git-core 同族一并改写",
          SHELL_PATH_PAD in got.get("usr/libexec/git-core/git-remote-http", b""))
    check("非白名单 ELF 未被越权改写（curl 仍含旧串）",
          SHELL_PATH_OLD in got.get("usr/bin/curl", b""))
    check("文本文件仍按新前缀重定位（原逻辑未受影响）",
          DEFAULT_NEW.encode() in got.get("usr/share/relocated.txt", b""))
    check("符号链接仍被相对化（原逻辑未受影响）",
          got.get("usr/lib/libfoo.so") == b"->libbar.so")
    check("计数正确（elf_shell_path=2）", stats.get("elf_shell_path") == 2)

    print("self-test: %s (%d 项失败)" % ("ALL PASS" if not fails else "FAILED", len(fails)))
    return 1 if fails else 0


def main() -> None:
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    new_prefix = DEFAULT_NEW
    if "--new-prefix" in sys.argv:
        i = sys.argv.index("--new-prefix")
        new_prefix = sys.argv[i + 1]
    if len(args) != 2:
        print("usage: relocate-snapshot.py <in.tar.xz> <out.tar.xz> [--new-prefix PATH]")
        print("       relocate-snapshot.py --self-test")
        sys.exit(1)
    src, dst = args[0], args[1]
    stats = relocate(src, dst, new_prefix)
    print(f"relocated: symlinks={stats['symlinks']} texts={stats['texts']} "
          f"dropped={stats['dropped']} binary-skipped={stats['skipped_binary']} "
          f"git-shell-path={stats['elf_shell_path']}")
    print("DONE")


if __name__ == "__main__":
    main()
