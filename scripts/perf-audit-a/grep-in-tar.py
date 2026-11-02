#!/usr/bin/env python3
"""scripts/perf-audit-a/grep-in-tar.py

任务 A2 判据工具：在 tar.xz 内**按内容**搜索（只读小于 max-bytes 的文本成员），用于回答
「装配面是否引用某个包」。不落盘，流式。

用法：python scripts/perf-audit-a/grep-in-tar.py <tar.xz> <needle> [--ext .yml,.json] [--max 262144] [--name-filter substr]
"""
import sys
import tarfile

TEXT_EXT = (".yml", ".yaml", ".json", ".js", ".mjs", ".cjs", ".txt", ".md", ".patch")


def main():
    args = sys.argv[1:]
    path = args[0]
    needle = args[1].lower()
    exts = TEXT_EXT
    maxb = 262144
    name_filter = ""
    i = 2
    while i < len(args):
        if args[i] == "--ext":
            exts = tuple(x.strip() for x in args[i + 1].split(",")); i += 2
        elif args[i] == "--max":
            maxb = int(args[i + 1]); i += 2
        elif args[i] == "--name-filter":
            name_filter = args[i + 1]; i += 2
        else:
            i += 1
    hits = 0
    scanned = 0
    with tarfile.open(path, "r:*") as tf:
        for m in tf:
            if not m.isfile() or m.size > maxb:
                continue
            n = m.name
            if name_filter and name_filter not in n:
                continue
            if not n.lower().endswith(exts):
                continue
            f = tf.extractfile(m)
            if f is None:
                continue
            scanned += 1
            try:
                txt = f.read().decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                continue
            low = txt.lower()
            if needle in low:
                # 打印命中所在行
                for line in txt.splitlines():
                    if needle in line.lower():
                        hits += 1
                        print("%s :: %s" % (n, line.strip()[:220]))
                        break
    print("# scanned=%d hits=%d" % (scanned, hits), file=sys.stderr)


if __name__ == "__main__":
    main()
