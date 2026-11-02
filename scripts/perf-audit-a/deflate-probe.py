#!/usr/bin/env python3
"""scripts/perf-audit-a/deflate-probe.py

任务 A3：量化 noCompress += "xz" 这个决定的真实代价/收益。
AGP 默认会对 assets 里的非 noCompress 条目做 DEFLATE；对已经 xz 压缩过的高熵数据，
DEFLATE 通常几乎压不动甚至变大，但同时要烧掉一次全量 CPU。
本脚本用 zlib level 6（zip 默认档）与 level 9 各压一遍，报输出字节数、耗时、压缩比。

用法：python scripts/perf-audit-a/deflate-probe.py <file> [--levels 6,9]
"""
import os
import sys
import time
import zlib


def main():
    path = sys.argv[1]
    levels = [6, 9]
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--levels":
            levels = [int(x) for x in sys.argv[i + 1].split(",")]
            i += 2
        else:
            i += 1
    orig = os.path.getsize(path)
    print("input=%s bytes=%d" % (path, orig))
    data = open(path, "rb").read()
    for lvl in levels:
        t0 = time.time()
        co = zlib.compressobj(lvl, zlib.DEFLATED, -15)
        n = 0
        step = 1 << 20
        for off in range(0, len(data), step):
            n += len(co.compress(data[off:off + step]))
        n += len(co.flush())
        print("deflate level=%d -> %d bytes (%.4f%% of input, delta %+d) %.2fs"
              % (lvl, n, 100.0 * n / orig, n - orig, time.time() - t0))


if __name__ == "__main__":
    main()
