#!/usr/bin/env python3
"""scripts/perf-audit-a/probe-apk-snapshot.py

任务 A2：APK 里的 assets/snapshot.tar.xz 是 stored（method=0），可以直接把该条目的
字节流喂给 lzma+tarfile，**不落盘**判定「这个 APK 实际打进去的快照是什么」：
  - tar 成员数 / 解压后字节
  - usr/bin/node 的 ELF e_machine -> ABI
  - 引擎版本（@deepseek-ai/dsh/package.json）
  - 是否含注入集（@dsh-android 包）

用法：python scripts/perf-audit-a/probe-apk-snapshot.py <apk>
"""
import io
import json
import lzma
import sys
import tarfile
import zipfile

MACHINES = {62: "x86_64", 183: "aarch64", 3: "i386", 40: "arm"}


def main():
    apk = sys.argv[1]
    out = {"apk": apk}
    with zipfile.ZipFile(apk) as z:
        info = z.getinfo("assets/snapshot.tar.xz")
        out["entryCompressed"] = info.compress_size
        out["entryMethod"] = info.compress_type
        with z.open("assets/snapshot.tar.xz") as raw:
            with lzma.LZMAFile(raw) as xz:
                with tarfile.open(fileobj=xz, mode="r|") as tf:
                    files = dirs = links = 0
                    total = 0
                    want = {
                        "usr/bin/node": "elf",
                        "usr/lib/node_modules/@deepseek-ai/dsh/package.json": "engine",
                    }
                    injected = 0
                    for m in tf:
                        if m.isdir():
                            dirs += 1
                        elif m.issym() or m.islnk():
                            links += 1
                        else:
                            files += 1
                            total += m.size
                        if "@dsh-android" in m.name:
                            injected += 1
                        key = want.get(m.name)
                        if key and m.isfile():
                            head = tf.extractfile(m).read(8192)
                            if key == "elf" and head[:4] == b"\x7fELF":
                                out["nodeAbi"] = MACHINES.get(int.from_bytes(head[18:20], "little"), "?")
                            elif key == "engine":
                                try:
                                    out["engineVersion"] = json.loads(head.decode("utf-8", "replace")).get("version")
                                except Exception:  # noqa: BLE001
                                    pass
                    out["files"] = files
                    out["dirs"] = dirs
                    out["symlinks"] = links
                    out["uncompressedBytes"] = total
                    out["uncompressedMiB"] = round(total / 1048576.0, 2)
                    out["dshAndroidEntries"] = injected
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
