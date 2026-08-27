#!/usr/bin/env python3
"""inject-external-plugins.py — 通用插件注入（非 @dsh-android 命名空间，node_modules 根级包）。

与 inject-snapshot.py（@dsh-android 专用）互补：处理 dsh-undo-savepoint、dshmarketplace-plugin
等根级插件包。字节级 tar 流注入，保留 symlink 元数据（Windows 上 bsdtar 解包 symlink 需特权，
本脚本直接从 tar 流替换条目，不在文件系统物化链接）。

用法：
  python inject-external-plugins.py <snapshot.tar.xz> <out.tar.xz> <pkg_dir>...
每个 <pkg_dir> 是插件包目录（含 package.json；可含 lib/ skills/ 等），按目录名匹配
home/.dsh/profiles/{web,headless}/node_modules/<name>/，注入：package.json + lib/*
（-*.map）+ skills/* + README* + LICENSE + cordis.patch.yml + spec.json。
"""
import io
import lzma
import os
import sys
import tarfile

PROFILES = ("web", "headless")
INCLUDE_FILES = ("package.json", "cordis.patch.yml", "spec.json", "README.md", "README.zh-CN.md", "LICENSE")


def is_injectable(name, pkg_names):
    """命中即返回 (pkg, rel)；未命中返回 None。支持 scoped 包名。"""
    for pkg in pkg_names:
        marker = f"/node_modules/{pkg}/"
        idx = name.find(marker)
        if idx < 0 or not name.startswith("home/.dsh/profiles/"):
            continue
        rel = name[idx + len(marker):]
        if rel.startswith("lib/") and not rel.endswith(".map"):
            return (pkg, rel)
        if rel.startswith("skills/"):
            return (pkg, rel)
        if rel in INCLUDE_FILES:
            return (pkg, rel)
    return None


def build_replacements(pkg_dirs):
    out = {}
    for d in pkg_dirs:
        # 真实包名（package.json；scoped 名含 '/'，层级随路径自然展开）
        import json as _json
        try:
            with open(os.path.join(d, "package.json"), "rb") as f:
                name = _json.load(f)["name"]
        except Exception:
            name = os.path.basename(os.path.normpath(d))
        files = {}
        for sub in ("lib", "skills"):
            base = os.path.join(d, sub)
            if not os.path.isdir(base):
                continue
            for root, _dirs, fnames in os.walk(base):
                for fn in fnames:
                    if fn.endswith(".map"):
                        continue
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, d).replace("\\", "/")
                    with open(full, "rb") as f:
                        files[rel] = f.read()
        for fn in INCLUDE_FILES:
            full = os.path.join(d, fn)
            if os.path.isfile(full):
                with open(full, "rb") as f:
                    files[fn] = f.read()
        if files:
            out[name] = files
    return out


def main():
    src, dst = sys.argv[1], sys.argv[2]
    pkg_dirs = sys.argv[3:]
    repl = build_replacements(pkg_dirs)
    pkg_names = set(repl.keys())
    print("injecting external packages:", sorted(pkg_names))
    if not pkg_names:
        print("nothing to inject")
        return

    with lzma.open(src, "rb") as f:
        raw = f.read()
    outbuf = io.BytesIO()
    replaced = 0
    seen_pkgs = set()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:*") as tin, \
            tarfile.open(fileobj=outbuf, mode="w", format=tarfile.PAX_FORMAT) as tout:
        for member in tin:
            matched = is_injectable(member.name, pkg_names)
            if member.isfile() and matched is not None:
                pkg, rel = matched
                seen_pkgs.add(pkg)
                data = repl[pkg].get(rel)
                if data is None:
                    tout.addfile(member, tin.extractfile(member))
                    continue
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
        # 追加模式：快照内不存在的全新包（node_modules/<pkg>/ 无任何条目）→ 全部文件追加。
        # 目录项一并生成（tar 无需显式目录项，但保留 package.json/lib 等完整路径）。
        for pkg in sorted(repl.keys()):
            if pkg in seen_pkgs:
                continue
            for rel, data in sorted(repl[pkg].items()):
                name = f"home/.dsh/profiles/web/node_modules/{pkg}/{rel}"
                newm = tarfile.TarInfo(name)
                newm.size = len(data)
                newm.mtime = int(__import__("time").time())
                newm.mode = 0o755 if rel.endswith(".sh") or rel.startswith("lib/") and data[:2] == b"#!" else 0o644
                tout.addfile(newm, io.BytesIO(data))
                replaced += 1
            print(f"  added package tree: {pkg} ({sum(1 for r in repl[pkg])} files)")
    with lzma.open(dst, "wb", preset=9) as f:
        f.write(outbuf.getvalue())
    print("replaced/added entries:", replaced)
    print("written:", dst, os.path.getsize(dst), "bytes")


if __name__ == "__main__":
    main()
