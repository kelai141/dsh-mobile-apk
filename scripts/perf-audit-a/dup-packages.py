#!/usr/bin/env python3
"""scripts/perf-audit-a/dup-packages.py

任务 A2：在 tar.xz 的成员清单里找**同一包名多个版本**（重复依赖），不落盘。
判据：路径形如 .../node_modules/(@scope/)?name/package.json，取其 version 字段。
只读 package.json 的小字节（tarfile 流式迭代，命中即读，不整包解压）。

用法：python scripts/perf-audit-a/dup-packages.py <tar.xz> [--top 20] [--json out.json]
"""
import json
import re
import sys
import tarfile
from collections import defaultdict

NM = "/node_modules/"
MAX_PKGJSON = 256 * 1024


def pkg_key(name):
    """从**最近的**一个 node_modules 段取包名（支持 @scope/name）。

    必须是最近的那段：形如
      usr/lib/node_modules/@deepseek-ai/dsh/node_modules/zod/package.json
    同时含两个 node_modules，第一个是「谁把 zod 装进来的」（@deepseek-ai/dsh），
    第二个才是 zod 自己。用第一个会把 700 多个包全算成 @deepseek-ai/dsh。
    .pnpm/<hash>/node_modules/<pkg> 形态同样按最近段取，正确得到 <pkg>。
    """
    parts = name.split("/")
    last = -1
    for i, seg in enumerate(parts):
        if seg == "node_modules":
            last = i
    if last < 0 or last + 1 >= len(parts):
        return None
    nxt = parts[last + 1]
    if nxt == "" or nxt.startswith("."):
        return None
    if nxt.startswith("@"):
        return nxt + "/" + parts[last + 2] if last + 2 < len(parts) else None
    return nxt


def main():
    args = sys.argv[1:]
    path = args[0]
    top = 20
    jout = ""
    i = 1
    while i < len(args):
        if args[i] == "--top":
            top = int(args[i + 1]); i += 2
        elif args[i] == "--json":
            jout = args[i + 1]; i += 2
        else:
            i += 1

    versions = defaultdict(set)       # pkg -> {version}
    copies = defaultdict(int)         # pkg -> package.json 副本数
    bytes_by_pkg_version = defaultdict(int)
    hits = []
    with tarfile.open(path, "r:*") as tf:
        for m in tf:
            if not m.isfile() or m.size > MAX_PKGJSON:
                continue
            n = m.name
            if not n.endswith("/package.json") or NM not in n:
                continue
            pkg = pkg_key(n)
            if not pkg:
                continue
            f = tf.extractfile(m)
            if f is None:
                continue
            try:
                j = json.loads(f.read().decode("utf-8", "replace"))
            except Exception:  # noqa: BLE001
                continue
            v = j.get("version")
            if isinstance(v, str):
                versions[pkg].add(v)
                copies[pkg] += 1
                hits.append((pkg, v, n))

    dups = {k: sorted(v) for k, v in versions.items() if len(v) > 1}
    multi_copies = {k: c for k, c in copies.items() if c > 1}
    rows = sorted(dups.items(), key=lambda kv: -len(kv[1]))
    out = {
        "tar": path,
        "packagesWithPackageJson": len(versions),
        "packagesWithMultipleVersions": len(dups),
        "extraCopiesTotal": sum(c - 1 for c in multi_copies.values()),
        "packagesWithMultipleCopies": len(multi_copies),
        "top": [{"pkg": k, "versions": v} for k, v in rows[:top]],
        "topMultiCopy": sorted(multi_copies.items(), key=lambda kv: -kv[1])[:top],
    }
    if jout:
        with open(jout, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()