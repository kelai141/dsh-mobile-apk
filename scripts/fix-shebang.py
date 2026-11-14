#! /usr/bin/env python3
"""fix-shebang.py — 快照脚本头修正（PRD F1.1：脚本头修正工具，等价 termux-fix-shebang）。

扫描 usr/bin、usr/libexec 与 usr/lib 下的文本脚本，做两类重写：
A. 编译期残留的 /data/data/com.termux/files/usr 前缀 → 内嵌应用前缀
   /data/user/0/com.dsharnessmobile.shell/files/usr（Termux 官方包按旧前缀编译）。
B. 裸 `#!/usr/bin/env <cmd>` 形式（issue apk#83：node 包 bin 脚本的标准头）→
   `#!<new_prefix>/usr/bin/env <cmd>`——Android 内核在根文件系统解析 `/usr/bin/env`,
   应用沙箱内不存在该路径,凡经 execve 直启的脚本（如 dsh plugin add → pnpm 拉起
   bin.js）都会因 shebang 解释器缺失报 bad ELF magic;重写后解释器指向快照内的 env。

只处理 64 字节头含 '#!' 的小文件；二进制与现有脚本零触碰。

用法：python fix-shebang.py <usr_root> [<new_prefix>] [<manifest_path>] [--manifest-only]

--manifest-only：只重扫并写出脚本清单，不改任何文件。构建链在**归档前**用它刷新一次，
使清单反映最终树（第 6 步之后还会写 usr/bin 下的 shim、并做清单驱动的裁剪）。
"""
import os
import sys


def main():
    args = [a for a in sys.argv[1:] if a != '--manifest-only']
    manifest_only = '--manifest-only' in sys.argv
    usr = args[0]
    new_prefix = args[1] if len(args) > 1 else '/data/user/0/com.dsharnessmobile.shell/files/usr'
    # 第三个参数（可选）：把「确实是文本脚本」的相对路径清单写到这个文件。
    #
    # 为什么要有清单：设备侧的首启前缀重写必须扫全树才能判断哪些文件是脚本，
    # 而慢文件系统上每次 lstat 要几毫秒，4.2 万条目就是十几分钟（实测见
    # docs/NATIVE-PREFIX-REWRITE-COST-2026-11-11.md）。构建期这里本来就要逐个打开
    # 这些文件读头，顺手记下清单，运行时就能只按清单校验，不必再遍历整棵树。
    manifest_path = args[2] if len(args) > 2 else None
    manifest = []
    old_prefix = '/data/data/com.termux/files/usr'
    dirs = [os.path.join(usr, 'bin'), os.path.join(usr, 'libexec'), os.path.join(usr, 'lib')]
    fixed = 0
    skipped = 0
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for root, _dirs, files in os.walk(d):
            for name in files:
                p = os.path.join(root, name)
                try:
                    st = os.stat(p)
                    # 注意：从 WSL（DrvFs）视角经 Windows 访问时文件权限位不保真
                    # （执行位可能不可见），故不以执行位筛选——仅按大小与头内容判定。
                    if st.st_size > 4 * 1024 * 1024:
                        continue
                    with open(p, 'rb') as f:
                        head = f.read(256)
                    if not head.startswith(b'#!'):
                        continue
                    if manifest_path is not None:
                        manifest.append(os.path.relpath(p, usr).replace(os.sep, '/'))
                    if manifest_only:
                        continue
                    with open(p, 'r', encoding='utf-8', errors='replace') as f:
                        text = f.read()
                    rewritten = text
                    # A 类：编译期 baked 的 com.termux 前缀。
                    had_termux = b'com.termux' in head and old_prefix in rewritten
                    if had_termux:
                        rewritten = rewritten.replace(old_prefix, new_prefix)
                    # B 类：裸 `#!/usr/bin/env `（无 com.termux、非绝对解释器路径）。
                    # 仅当场验证 shebang 行确实以 /usr/bin/env 开头,避免误伤
                    # `#!/bin/sh`/`#!/system/bin/sh` 等合法非 env 形式。
                    # 目标解释器 = <prefix>/bin/env（new_prefix 已含 .../files/usr，
                    # 直接拼 /usr/bin/env 会双写 usr——见 0.13.0 真机回归）。
                    # **双重应用防御**：A 类已把 com.termux 前缀重写成 new_prefix 的行，
                    # 其 head 里 new_prefix 已出现，B 类若再跑会把 <prefix>/bin/env 再当
                    # 裸 /usr/bin/env 替换一次 → <prefix><prefix>/bin/env（本机演算实锤，
                    # scan-build/avbtool 等经 A 类后又被 B 类双写）。故 B 类仅处理
                    # 既无 com.termux、又无 new_prefix 的原始裸 env 行。
                    first = rewritten.split('\n', 1)[0]
                    if (not had_termux) and (new_prefix not in first) \
                            and first.startswith('#!') and '/usr/bin/env' in first:
                        rewritten = first.replace('/usr/bin/env', f'{new_prefix}/bin/env') \
                            + rewritten[len(first):]
                    if rewritten != text:
                        with open(p, 'w', encoding='utf-8', newline='') as f:
                            f.write(rewritten)
                        fixed += 1
                        print(f'  fixed: {os.path.relpath(p, usr)}: {first}')
                except Exception:
                    skipped += 1
                    continue
    if manifest_path is not None:
        with open(manifest_path, 'w', encoding='utf-8', newline='') as f:
            for rel in sorted(manifest):
                f.write(rel + '\n')
        print(f'shebang manifest: {len(manifest)} scripts -> {manifest_path}')
    print(f'shebang fix done: {fixed} fixed, {skipped} skipped')


if __name__ == '__main__':
    main()
