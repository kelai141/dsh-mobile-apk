#!/usr/bin/env python3
"""scripts/perf-audit-a/scan-tarstream.py

任务 A2/A3：**逐 512 字节头**扫描 tar 流（解压后不落盘），统计各类头部开销：
  - 普通条目头（512B）
  - 数据块（ceil(size/512)*512）
  - PAX 扩展头（typeflag x/g）：Python tarfile 的 PAX_FORMAT 会给长路径/非 ASCII 路径
    **每条**写一个扩展头，单条 >=1KB 量级
  - GNU 长名头（typeflag L/K）
  - 尾块（两个全零块）+ 记录填充

答案要回答的是：inject-all.py 用 PAX_FORMAT 重打包后，同一棵树的 tar 流里有多少字节
是「头开销」，以及它是否足以解释压缩率劣化。

用法：python scripts/perf-audit-a/scan-tarstream.py <tar.xz>
"""
import lzma
import sys


def main():
    path = sys.argv[1]
    BLK = 512
    counts = {"header": 0, "pax_x": 0, "pax_g": 0, "gnu_L": 0, "gnu_K": 0,
              "other": 0, "total_blocks_consumed": 0}
    data_blocks = 0
    header_blocks = 0
    pax_bytes = 0
    total_bytes = 0
    with lzma.open(path, "rb") as f:
        while True:
            hdr = f.read(BLK)
            if len(hdr) < BLK:
                break
            total_bytes += BLK
            if hdr == b"\0" * BLK:
                # 尾块：继续读完即可
                rest = f.read()
                total_bytes += len(rest)
                break
            typeflag = hdr[156:157]
            try:
                size = int(hdr[124:136].split(b"\0")[0].strip() or b"0", 8)
            except ValueError:
                size = 0
            nblk = (size + BLK - 1) // BLK
            f.read(nblk * BLK)
            total_bytes += nblk * BLK
            data_blocks += nblk
            header_blocks += 1
            if typeflag == b"x":
                counts["pax_x"] += 1
                pax_bytes += size
            elif typeflag == b"g":
                counts["pax_g"] += 1
                pax_bytes += size
            elif typeflag == b"L":
                counts["gnu_L"] += 1
            elif typeflag == b"K":
                counts["gnu_K"] += 1
            elif typeflag in (b"0", b"\0", b"5", b"2", b"1", b"7"):
                counts["header"] += 1
            else:
                counts["other"] += 1
    print("stream_bytes      = %d" % total_bytes)
    print("data_blocks_bytes = %d" % (data_blocks * BLK))
    print("header_blocks     = %d  (bytes %d)" % (header_blocks, header_blocks * BLK))
    print("pax_x entries     = %d  (payload bytes %d)" % (counts["pax_x"], pax_bytes))
    print("pax_g entries     = %d" % counts["pax_g"])
    print("gnu_L / gnu_K     = %d / %d" % (counts["gnu_L"], counts["gnu_K"]))
    print("regular-ish hdrs  = %d" % counts["header"])
    print("other hdrs        = %d" % counts["other"])
    print("overhead_bytes    = %d  (%.2f%% of stream)" % (
        total_bytes - data_blocks * BLK,
        100.0 * (total_bytes - data_blocks * BLK) / total_bytes if total_bytes else 0))


if __name__ == "__main__":
    main()
