#!/usr/bin/env python3
"""scripts/perf-audit-a/tarls.py

用途（任务 A2）：对 tar.xz / tar 做「不解包到磁盘」的成员级统计，输出 JSON。

为什么不用 tar -tvJf 解析（原始做法，已废弃）：Windows 自带的 bsdtar 用 locale
日期格式（如 1月 01  2024），列的个数与顺序也随平台变化；GNU tar（Git 自带）又把
D 盘路径当远端主机名。用 Python 标准库 tarfile 流式读成员头，天然跨平台、不受
locale 影响，且不落盘（只读 tar 头，跳过数据段）。

输出：
  - 顶层目录 / node_modules 包名（含嵌套 node_modules 深度）/ 扩展名 的字节 Top-N
  - 「垃圾类目」：sourcemap、.d.ts/.ts、.md/.txt/LICENSE、测试夹具、locale、docs、.git 等
  - deletableUnion：**去重后**的可删集合（一个文件只按优先级归入首个命中类目），
    因此各类目字节数相加 == union 总量，可直接当成「能砍多少」的上界估计
  - 总字节、文件数、目录数、符号链接数

用法：
  python scripts/perf-audit-a/tarls.py <tar.xz> [--json out.json] [--top 25]
"""
import json
import os
import sys
import tarfile
import time
from collections import defaultdict

# 类目优先级：前面的先命中先归属，保证各条相加 == union（不重复计数）。
# 刻意不把 usr/share/man、usr/share/doc（Termux 基座的手册/文档）算进「可删」——
# 它们是基座的一部分、不是我们注入的包，砍它们属于另一个决策面（见报告 §A3）。
CATEGORIES = [
    ("sourcemap (*.map)", lambda p, b: b.endswith(".map")),
    ("TypeScript 源码/声明 (*.ts/*.mts/*.cts，含 .d.ts)",
     lambda p, b: b.endswith((".ts", ".mts", ".cts"))),
    ("测试文件 (*.test.* / *.spec.*)",
     lambda p, b: b.endswith((".test.js", ".test.mjs", ".test.cjs", ".spec.js",
                              ".spec.mjs", ".spec.cjs", ".test.ts", ".spec.ts",
                              ".test.jsx", ".test.tsx", ".test.mjsx"))),
    ("测试/夹具/示例目录 (/test/ /tests/ /__tests__/ /fixtures/ /examples/ ...)",
     lambda p, b: any(("/%s/" % d) in p for d in
                      ("test", "tests", "__tests__", "spec", "specs", "fixtures",
                       "__fixtures__", "__mocks__", "benchmark", "benchmarks",
                       "example", "examples"))),
    ("文档 (*.md/*.markdown)", lambda p, b: b.endswith((".md", ".markdown"))),
    ("LICENSE/COPYING 文件", lambda p, b: b.startswith(("license", "licence", "copying"))),
    ("调试/中间产物 (*.pdb/*.o/*.a)", lambda p, b: b.endswith((".pdb", ".o", ".a"))),
    (".git 残留", lambda p, b: "/.git/" in p or p.startswith(".git/")),
]

LOCALE_DIRS = ("locale", "locales", "i18n", "l10n", "translations", "lang", "langs")


def norm(p):
    p = p.replace("\\", "/")
    return p[2:] if p.startswith("./") else p


def classify(p, b, low):
    """返回 (类目名, 是否可删)。仅 node_modules 内命中才判可删，基座（usr/share 等）单列。"""
    in_nm = "/node_modules/" in p
    for name, pred in CATEGORIES:
        if pred(low, b):
            return name, in_nm
    if any(("/%s/" % d) in low for d in LOCALE_DIRS):
        return "locale/i18n 目录（全部语言）", in_nm
    return None, False


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: python scripts/perf-audit-a/tarls.py <tar[.xz]> [--json out.json] [--top N]",
              file=sys.stderr)
        return 2
    path = args[0]
    jout = ""
    top_n = 25
    entries_out = ""
    i = 1
    while i < len(args):
        if args[i] == "--json":
            jout = args[i + 1]; i += 2
        elif args[i] == "--top":
            top_n = int(args[i + 1]); i += 2
        elif args[i] == "--entries":
            entries_out = args[i + 1]; i += 2
        else:
            i += 1

    t0 = time.time()
    files = []
    n_entries = n_dirs = n_links = 0
    with tarfile.open(path, "r:*") as tf:
        for m in tf:
            n_entries += 1
            name = norm(m.name)
            if m.isdir():
                n_dirs += 1
                continue
            if m.issym() or m.islnk():
                n_links += 1
            files.append((name, int(m.size)))

    total = sum(s for _, s in files)

    top_dir = defaultdict(lambda: [0, 0])
    pkg = defaultdict(lambda: [0, 0])
    ext = defaultdict(lambda: [0, 0])
    junk_all = defaultdict(lambda: [0, 0])       # 全部命中（会重复计数，仅作参考）
    deletable = defaultdict(lambda: [0, 0])      # 去重后的可删集合（node_modules 内）
    deletable_scope = defaultdict(lambda: [0, 0])  # 可删集合按 usr/home 拆分

    def add(mp, key, size, weight=1):
        v = mp[key]
        v[0] += size
        v[1] += weight

    union_bytes = union_files = 0
    for p, s in files:
        low = p.lower()
        b = low.rsplit("/", 1)[-1]
        seg0 = p.split("/")[0] if "/" in p else p
        add(top_dir, seg0, s)

        marker = "/node_modules/"
        idx = p.rfind(marker)
        if idx >= 0:
            rest = p[idx + len(marker):]
            parts = rest.split("/")
            name = parts[0]
            if name.startswith("@") and len(parts) > 1:
                name = name + "/" + parts[1]
            depth = p.count("/node_modules/")
            add(pkg, ("[nested x%d] %s" % (depth, name)) if depth > 1 else name, s)

        dot = b.rfind(".")
        add(ext, b[dot:] if dot > 0 else "(no ext)", s)

        cat, is_del = classify(p, b, low)
        if cat:
            add(junk_all, cat, s)
            if is_del:
                add(deletable, cat, s)
                add(deletable_scope, seg0, s)
                union_bytes += s
                union_files += 1

    def top(mp, n, base):
        rows = sorted(mp.items(), key=lambda kv: -kv[1][0])[:n]
        return [{"key": k, "bytes": v[0], "files": v[1],
                 "pct": round(100.0 * v[0] / base, 2) if base else 0} for k, v in rows]

    summary = {
        "input": os.path.abspath(path),
        "inputBytes": os.path.getsize(path),
        "elapsedMs": int((time.time() - t0) * 1000),
        "entries": n_entries,
        "files": len(files),
        "dirs": n_dirs,
        "symlinks": n_links,
        "totalBytes": total,
        "totalMiB": round(total / 1048576.0, 2),
        "compressRatio": round(total / os.path.getsize(path), 3),
        "topDirs": top(top_dir, top_n, total),
        "topPackages": top(pkg, top_n, total),
        "packageCount": len(pkg),
        "deletableUnion": {
            "bytes": union_bytes,
            "files": union_files,
            "pctOfUncompressed": round(100.0 * union_bytes / total, 2) if total else 0,
            "byCategory": top(deletable, 60, union_bytes),
            "byScope": top(deletable_scope, 10, union_bytes),
        },
        "rawCategoryHitsOverlapping": top(junk_all, 60, total),
        "topExt": top(ext, top_n, total),
    }
    if entries_out:
        with open(entries_out, "w", encoding="utf-8", newline="") as f:
            f.write("size\ttype\tpath\n")
            for (pp, ss) in files:
                f.write("%d\tF\t%s\n" % (ss, pp))
    if jout:
        with open(jout, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())