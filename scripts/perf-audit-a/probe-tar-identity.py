#!/usr/bin/env python3
"""scripts/perf-audit-a/probe-tar-identity.py

任务 A2：不整包解压，从 tar.xz 里只读少数成员的字节，判定每份快照的
  - ABI（读 usr/bin/node 的 ELF e_machine：183=x86_64, 183? -> 0x3E=62 x86_64, 0xB7=183 aarch64）
  - 引擎版本（读 usr/lib/node_modules/@deepseek-ai/dsh/package.json 的 version）
  - node 版本（读 usr/bin/node 同目录的 version 文件若存在）
用 tarfile 流式迭代，命中即停（不落盘）。

用法：python scripts/perf-audit-a/probe-tar-identity.py <tar.xz> [more.tar.xz ...]
"""
import io
import json
import sys
import tarfile

MACHINES = {62: "x86_64", 183: "aarch64", 3: "i386", 40: "arm"}


def probe(path):
    out = {"tar": path}
    want = {
        "usr/bin/node": "elf",
        "usr/lib/node_modules/@deepseek-ai/dsh/package.json": "engine",
        "home/.dsh/profiles/web/node_modules/@deepseek-ai/dsh/package.json": "engine2",
    }
    with tarfile.open(path, "r:*") as tf:
        for m in tf:
            key = want.get(m.name)
            if not key or not m.isfile():
                continue
            f = tf.extractfile(m)
            if f is None:
                continue
            head = f.read(64 * 1024)
            if key == "elf":
                if head[:4] == b"\x7fELF":
                    ei_class = head[4]
                    e_machine = int.from_bytes(head[18:20], "little")
                    out["nodeAbi"] = MACHINES.get(e_machine, "e_machine=%d" % e_machine)
                    out["nodeElfClass"] = "ELF64" if ei_class == 2 else "ELF32"
                    out["nodeSize"] = m.size
                else:
                    out["nodeAbi"] = "not-ELF"
            else:
                try:
                    j = json.loads(head.decode("utf-8", "replace"))
                    out[key + "Version"] = j.get("version")
                    out[key + "Name"] = j.get("name")
                except Exception as exc:  # noqa: BLE001
                    out[key] = "unparsable: %s" % exc
            if len([k for k in out if k.endswith("Version") or k == "nodeAbi"]) >= 2:
                break
    return out


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(json.dumps(probe(p), ensure_ascii=False))
