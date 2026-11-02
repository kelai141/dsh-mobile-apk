#!/usr/bin/env python3
"""scripts/perf-audit-a/extract-paths.py

任务 A2 判据工具：从 tar.xz 里**只取指定成员**（按子串/正则匹配），写到临时目录或直接
打印。用途是回答「这个包在不在装配面里」——需要读 cordis.patch.yml / package.json /
settings 等小文件，而不是整包解压 200MB。

用法：
  python scripts/perf-audit-a/extract-paths.py <tar.xz> <outdir> --match <substr> [--match ...] [--max-bytes N]
  python scripts/perf-audit-a/extract-paths.py <tar.xz> --list --match <substr>
"""
import os
import sys
import tarfile


def main():
    args = sys.argv[1:]
    path = args[0]
    rest = args[1:]
    outdir = ""
    matches = []
    list_only = False
    max_bytes = 512 * 1024
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--match":
            matches.append(rest[i + 1]); i += 2
        elif a == "--max-bytes":
            max_bytes = int(rest[i + 1]); i += 2
        elif a == "--list":
            list_only = True; i += 1
        elif a.startswith("--"):
            i += 1
        else:
            outdir = a; i += 1
    if not matches:
        print("need --match", file=sys.stderr)
        return 2
    hits = 0
    with tarfile.open(path, "r:*") as tf:
        for m in tf:
            if not m.isfile() or m.size > max_bytes:
                continue
            if not any(s in m.name for s in matches):
                continue
            hits += 1
            if list_only:
                print("%10d\t%s" % (m.size, m.name))
                continue
            dst = os.path.join(outdir, m.name.replace("/", os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            f = tf.extractfile(m)
            if f is None:
                continue
            with open(dst, "wb") as out:
                out.write(f.read())
            print("%10d\t%s" % (m.size, dst))
    print("# hits=%d" % hits, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
