# make-synthetic-snapshot.py — 为 SNAPSHOT 门禁造一个最小合成快照（正例证据用）。
#
# 为什么需要它：ci-verify-snapshot.py 是纯 Python 标准库实现（hashlib / io / lzma / os / re /
# struct / sys / tarfile），可以直接在 Windows 原生 python 下跑。本机没有与当前 profile 同代的
# 真实快照，跑完整构建成本太高，因此用合成快照证明「路径推导修好之后，判据能跑出 PASS」。
#
# 合成快照只包含门禁真正读取的几类条目：
#   1. usr/bin/node —— 前 64 字节是合法 ELF64 头，且 e_machine（偏移 18）匹配目标 ABI；
#   2. 每个装配 profile（web / headless）的 cordis.patch.yml —— 与权威文件逐字节相同；
#   3. 每个 profile 下注入的 @dsh-android/* 插件的 package.json 与 lib/*（跳过 .map）。
#
# 用法：
#   python make-synthetic-snapshot.py <输出.tar.xz> <aarch64|x86_64> <权威patch> <插件目录>...
#
# 例（在 apk 仓根执行）：
#   python make-synthetic-snapshot.py .deploy-tmp/tb-synth/synth.tar.xz x86_64 \
#     scripts/profile-web.cordis.patch.yml \
#     plugins/dsh-android-bridge plugins/dsh-android-browser ...
#
# 负控做法：把权威 patch 里的包名改错一处再重造快照，门禁必须输出 SNAPSHOT_GATE_FAILED 且 exit=1。
import io
import lzma
import os
import sys
import tarfile

MACHINES = {'x86_64': 0x3E, 'aarch64': 0xB7}


def build_elf_header(machine: int) -> bytes:
    """Return a 64-byte ELF64 header the gate accepts (it only reads the first 64 bytes)."""
    elf = bytearray(64)
    elf[0:4] = b'\x7fELF'
    elf[4] = 2      # EI_CLASS = ELFCLASS64
    elf[5] = 1      # EI_DATA = little endian
    elf[6] = 1      # EI_VERSION
    elf[16:18] = (2).to_bytes(2, 'little')       # e_type = ET_EXEC
    elf[18:20] = machine.to_bytes(2, 'little')   # e_machine  <- the gate reads this
    elf[20:24] = (1).to_bytes(4, 'little')       # e_version
    return bytes(elf)


def build(out_path: str, abi: str, authoritative_patch: str, plugin_dirs) -> None:
    machine = MACHINES[abi]
    elf = build_elf_header(machine)
    with open(authoritative_patch, 'rb') as f:
        patch_bytes = f.read()

    members = [('usr/bin/node', elf, 0o755)]
    for profile in ('web', 'headless'):
        members.append((f'home/.dsh/profiles/{profile}/cordis.patch.yml', patch_bytes, 0o644))
        for d in plugin_dirs:
            name = os.path.basename(os.path.normpath(d))
            base = f'home/.dsh/profiles/{profile}/node_modules/@dsh-android/{name}'
            with open(os.path.join(d, 'package.json'), 'rb') as f:
                members.append((base + '/package.json', f.read(), 0o644))
            lib = os.path.join(d, 'lib')
            for root, _dirs, fnames in os.walk(lib):
                for fn in fnames:
                    if fn.endswith('.map'):
                        continue
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, lib).replace('\\', '/')
                    with open(full, 'rb') as f:
                        members.append((base + '/lib/' + rel, f.read(), 0o644))

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tf:
        for name, data, mode in members:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            tf.addfile(info, io.BytesIO(data))
    raw = buf.getvalue()
    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with lzma.open(out_path, 'wb') as f:
        f.write(raw)
    print(f'synthetic snapshot written: {out_path} ({len(raw)} bytes raw, {len(members)} entries)')


if __name__ == '__main__':
    if len(sys.argv) < 5:
        print(__doc__)
        sys.exit(2)
    build(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:])
