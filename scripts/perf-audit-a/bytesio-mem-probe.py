#!/usr/bin/env python3
"""scripts/perf-audit-a/bytesio-mem-probe.py

任务 A1/A3：量化 inject-all.py / inject-snapshot.py 的内存峰值构成。
两个脚本都是「lzma.open(src).read() 读整个解压流 -> BytesIO(raw) 两份 -> BytesIO() 输出 + getvalue()」。
本探针用 tracemalloc 实测 io.BytesIO 的复制语义（CPython：BytesIO(bytes) 会**复制**初始内容），
据此给出真实峰值。

用法：python scripts/perf-audit-a/bytesio-mem-probe.py [--mib 16]
"""
import io
import sys
import tracemalloc


def main():
    mib = 16
    if "--mib" in sys.argv:
        mib = int(sys.argv[sys.argv.index("--mib") + 1])
    tracemalloc.start()
    raw = b"x" * (mib * 1024 * 1024)
    base = tracemalloc.get_traced_memory()[0]
    # inject-all.py:170 lzma.open(src).read() -> raw；:187/:188 两次 BytesIO(raw)
    scan = io.BytesIO(raw)
    inp = io.BytesIO(raw)
    out = io.BytesIO()
    out.write(raw)
    val = out.getvalue()  # inject-all.py:341 outbuf.getvalue() 再复制一份
    cur, peak = tracemalloc.get_traced_memory()
    print("raw MiB            = %.1f" % mib)
    print("tracemalloc base   = %.1f MiB" % (base / 1048576))
    print("tracemalloc cur    = %.1f MiB" % (cur / 1048576))
    print("tracemalloc peak   = %.1f MiB" % (peak / 1048576))
    print("delta over raw     = %.1f MiB  (= %.2f x raw)"
          % ((cur - base) / 1048576, (cur - base) / float(mib * 1024 * 1024)))


if __name__ == "__main__":
    main()