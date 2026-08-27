#!/usr/bin/env python3
"""update-snapshot-patch.py — 用主仓库权威 profile patch 覆盖快照内 profiles/web/cordis.patch.yml。

快照内 patch 是基座旧版（0.12.5-fx-1 装配），0.13.0 装配（undo/market/shell-termux v2 写面配置）
以主仓库 scripts/profile-web.cordis.patch.yml 为权威（make-snapshot.sh 既有原则：权威副本覆盖防漂移）。
2026-08-23（审核 M1）：0.13.0 装配只对 web profile 有意义——非 web profile（headless 等保留形态）
默认跳过，除非传 --all-profiles 显式覆盖。
路径表单为内嵌包路径（/data/data/com.dsharnessmobile.shell/files/... = /data/user/0/... 同一物理目录）。
用法：python update-snapshot-patch.py <snapshot.tar.xz> <out.tar.xz> <authoritative.patch.yml> [--all-profiles]
"""
import io
import lzma
import os
import sys
import tarfile


def main():
    src, dst, patch_src = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(patch_src, 'rb') as f:
        patch_bytes = f.read()
    with lzma.open(src, 'rb') as f:
        raw = f.read()
    outbuf = io.BytesIO()
    replaced = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:*') as tin, \
            tarfile.open(fileobj=outbuf, mode='w', format=tarfile.PAX_FORMAT) as tout:
        for member in tin:
            if member.isfile() and member.name.startswith('home/.dsh/profiles/') \
                    and member.name.endswith('/cordis.patch.yml') and '/node_modules/' not in member.name:
                # 2026-08-23（审核 M1）：0.13.0 装配（undo/market/attachment-formats/android-*）
                # 只对 web profile 有意义；headless 是保留形态，覆盖为 web patch 会造成 headless
                # 挂载缺失/异形。除非显式传入 <profile> 目录名，否则跳过非 web。
                prof = member.name.split('/')[3]
                if prof != 'web' and '--all-profiles' not in sys.argv:
                    print('  skip (non-web profile):', member.name)
                    continue
                newm = tarfile.TarInfo(member.name)
                newm.size = len(patch_bytes)
                newm.mtime = int(member.mtime)
                newm.mode = member.mode
                tout.addfile(newm, io.BytesIO(patch_bytes))
                replaced += 1
                print('  patch replaced:', member.name)
            elif member.isfile():
                fobj = tin.extractfile(member)
                tout.addfile(member, fobj)
            else:
                tout.addfile(member)
    with lzma.open(dst, 'wb', preset=9) as f:
        f.write(outbuf.getvalue())
    print('replaced patches:', replaced, '| written:', dst, os.path.getsize(dst))


if __name__ == '__main__':
    main()
