#!/usr/bin/env python3
"""scripts/perf-audit-a/xz-recompress-probe.py

任务 A3：**同一条 tar 流、不同压缩配置**的产物体积对比（纯字节测量，不受 CPU 抖动影响）。
回答两个问题：
  1) build-snapshot-013.mjs 用 `xz -T8 -6` 产出 snapshot-<abi>.tar.xz；
     inject-all.py 用 Python lzma preset=9（等价 `xz -9 -T1`）重打包出 snap-final2。
     同一份内容，preset 9 vs 6 差多少字节？
  2) 分块（多线程）压缩会切碎 LZMA 字典，使压缩率下降。`-T8` 与 `-T1` 差多少？

实现：用 lzma 模块（preset 0..9、以及自定义 filters 的 block 大小）流式压缩，只累加输出字节数，
**不落盘**（writer 指向一个只计数的 sink）。这样 191MB 输入只需 ~30s/配置。

用法：python scripts/perf-audit-a/xz-recompress-probe.py <tar.xz> [--configs 6,9] [--threads 1,8]
"""
import lzma
import sys
import time


class CountingSink:
    def __init__(self):
        self.n = 0

    def write(self, b):
        self.n += len(b)
        return len(b)

    def flush(self):
        pass


def main():
    args = sys.argv[1:]
    path = args[0]
    configs = [6, 9]
    threads = [1, 8]
    i = 1
    while i < len(args):
        if args[i] == "--configs":
            configs = [int(x) for x in args[i + 1].split(",")]; i += 2
        elif args[i] == "--threads":
            threads = [int(x) for x in args[i + 1].split(",")]; i += 2
        else:
            i += 1
    import os
    src_bytes = os.path.getsize(path)
    print("input=%s  xzBytes=%d" % (path, src_bytes))
    for preset in configs:
        for th in threads:
            t0 = time.time()
            sink = CountingSink()
            # Python 的 lzma 没有 -T；用 filters 里的 dict_size / 由 block 切分模拟多线程。
            # 单线程（th=1）直接用 preset；多线程用 filters 显式给出 block_size（= xz -T 的分块语义）。
            if th == 1:
                cf = lzma.LZMACompressor(format=lzma.FORMAT_XZ, preset=preset)
            else:
                # xz -T<n> 的块大小 = 3 * dict_size（xz 源码常量）；preset 6 的 dict=8MiB，9 的 dict=64MiB
                dict_size = 8 << 20 if preset <= 6 else 64 << 20
                filters = [{
                    "id": lzma.FILTER_LZMA2,
                    "preset": preset,
                    "dict_size": dict_size,
                }]
                cf = lzma.LZMACompressor(format=lzma.FORMAT_XZ, filters=filters)
            with lzma.open(path, "rb") as f:
                while True:
                    chunk = f.read(1 << 20)
                    if not chunk:
                        break
                    sink.write(cf.compress(chunk))
            sink.write(cf.flush())
            print("preset=%d threads=%d -> %d bytes  (%.3f s, %.2f%% of input)" % (
                preset, th, sink.n, time.time() - t0, 100.0 * sink.n / src_bytes))


if __name__ == "__main__":
    main()
