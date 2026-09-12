#!/usr/bin/env python3
"""ci-verify-snapshot.py — CI snapshot gate: ELF arch + secrets scan + plugin consistency + profile patch consistency.
Usage:
  python3 ci-verify-snapshot.py <snapshot.tar.xz> <expect-arch> <plugins-dir>...
  expect-arch: aarch64 | x86_64
Checks:
  1. usr/bin/node ELF machine matches expect-arch (streamed from tar).
  2. Sensitive paths absent: .credentials / sessions/ / storages/ / anon-id / settings.yaml / .npmrc / private sourcemaps.
  3. Injected plugin lib/ + package.json match the pack output (hash compare per plugin) — 对**每一个装配 profile**。
  4. 每个装配 profile 的 cordis.patch.yml 必须与权威 scripts/profile-web.cordis.patch.yml 同长同内容，
     且 shell 路径（bashPath/prefix/home/cwd）必须含 /files/ 段（ST-05 / F-ENV-02）。
     历史缺陷：旧链只写 web，headless 停在 /data/user/0/<pkg>/usr（缺 /files）也「全绿」。
Exit 0 = pass; exit 1 = fail with reasons.
"""
import hashlib
import io
import lzma
import os
import re
import struct
import sys
import tarfile

MACHINES = {0x3E: 'x86_64', 0xB7: 'aarch64', 0x28: 'arm', 0x03: 'i386'}
SENSITIVE = (
    'home/.dsh/.credentials',
    'home/.dsh/sessions/',
    'home/.dsh/storages/',
    '.anonymous-user-id',
    'home/.npmrc',
)
# 注：home/.dsh/settings.yaml **不再**按路径判红。它是首启零机密种子模板（make-snapshot.sh 写入），
# 必须随快照分发；按路径一律判红对任何真实注入后快照恒红（假红，本门禁因此在构建输出上不可用）。
# 内容级凭据形态（sk-/apiKey/私钥头）由 check-snapshot-secrets.mjs 单实现判定（两链都已接线）。
PROFILES_ROOT = 'home/.dsh/profiles/'
PROFILE_PATCH_RE = re.compile(r'^home/\.dsh/profiles/([^/]+)/cordis\.patch\.yml$')
# 装配 profile（0.13.8-b ST-05）：全部必须在场且与权威 patch 同长同内容。缺一个即不通过。
ASSEMBLY_PROFILES = ('web', 'headless')
# 负控夹具 profile：bashPath 刻意指向不存在路径，用于验证启动期「坏配置拒绝」路径。
# 构建链不得覆盖它（覆盖即负控失效）；本门禁显式白名单，并反向断言它**仍然**不是权威内容。
NEGATIVE_CONTROL_PROFILES = ('headless-bad',)
# The web profile patch carries the shell-termux paths (bashPath/prefix/home/cwd).
# They must point at the CURRENT applicationId's data dir **including the /files/ segment** —
# the old chain wrote $SNAP_PKG_ROOT=/data/user/0/<pkg> (no /files), so every bash call failed
# with "not executable" / assertBash() threw at boot while the prefix-only assertion still passed
# (2026-08-21 incident: com.dshmobile.shell -> com.dsharnessmobile.shell).
PKG_KEYS = ('bashPath', 'prefix', 'home', 'cwd')
AUTHORITATIVE_PATCH_NAME = 'profile-web.cordis.patch.yml'


def app_id_from_gradle() -> str:
    """Read applicationId from the APK repo's build.gradle.kts. Works both in
    CI (workflow root is the dsh-mobile-apk checkout, this script lives under
    <root>/dsh-mobile/scripts/) and locally (<root>/dsh-mobile-apk/)."""
    script = os.path.abspath(__file__)
    root2 = os.path.dirname(os.path.dirname(script))
    root3 = os.path.dirname(root2)
    candidates = (
        os.path.join(root3, 'app', 'build.gradle.kts'),            # CI layout: <work>/app/...
        os.path.join(root2, 'dsh-mobile-apk', 'app', 'build.gradle.kts'),  # local layout: <root>/dsh-mobile-apk/app/...
    )
    for gradle in candidates:
        try:
            text = open(gradle, 'r', encoding='utf-8').read()
        except OSError:
            continue
        m = re.search(r'applicationId\s*=\s*"([^"]+)"', text)
        if m:
            return m.group(1)
    return None


def authoritative_patch_path() -> str:
    """Locate the authoritative profile-web.cordis.patch.yml in both layouts.
    A missing authoritative file is a FAILURE (no silent SKIP): the gate must compare
    against the真源, otherwise a stale/incorrect path can pass again."""
    script = os.path.abspath(__file__)
    script_dir = os.path.dirname(script)
    root2 = os.path.dirname(script_dir)
    root3 = os.path.dirname(root2)
    candidates = (
        os.path.join(script_dir, AUTHORITATIVE_PATCH_NAME),                                # CI: <work>/dsh-mobile/scripts/
        os.path.normpath(os.path.join(root2, '..', 'scripts', AUTHORITATIVE_PATCH_NAME)),  # local: <root>/scripts/
        os.path.join(root3, 'scripts', AUTHORITATIVE_PATCH_NAME),
        os.path.join(root2, 'scripts', AUTHORITATIVE_PATCH_NAME),
        os.path.join(root3, 'dsh-mobile', 'scripts', AUTHORITATIVE_PATCH_NAME),
    )
    seen = []
    for cand in candidates:
        cand = os.path.normpath(cand)
        if cand in seen:
            continue
        seen.append(cand)
        if os.path.isfile(cand):
            return cand
    return None


def check_patch_pkg(label: str, patch_text: str, app_id: str, fail: list) -> None:
    for key in PKG_KEYS:
        m = re.search(r'^\s*' + key + r':\s*(\S+)', patch_text, re.M)
        if not m:
            fail.append(f'{label}: {key} missing')
            continue
        path = m.group(1)
        if not (path.startswith(f'/data/data/{app_id}/') or path.startswith(f'/data/user/0/{app_id}/')):
            fail.append(f'{label}: {key} -> {path} (expect /data/(data|user/0)/{app_id}/...)')
        elif '/files/' not in path:
            fail.append(f'{label}: {key} -> {path} (缺 /files/ 段：应用私有根是 <pkg>/files，'
                        f'不是 <pkg>/——旧链 $SNAP_PKG_ROOT 不含 /files 的实例)')


def elf_machine(data: bytes) -> str:
    if len(data) < 20 or data[:4] != b'\x7fELF':
        return 'NOT_ELF'
    machine = struct.unpack_from('<H', data, 18)[0]
    return MACHINES.get(machine, '0x%x' % machine)


def scan(snapshot: str, expect: str, plugin_dirs):
    fail = []
    checked_elf = False
    # profile -> set(注入包名)：插件必须在**每个**装配 profile 里在场
    found_pkgs = {}
    # profile -> cordis.patch.yml 原始字节
    profile_patches = {}
    app_id = app_id_from_gradle()
    if app_id is None:
        fail.append('applicationId not found in app/build.gradle.kts')

    expected = {}
    for d in plugin_dirs:
        name = os.path.basename(os.path.normpath(d))
        files = {}
        lib = os.path.join(d, 'lib')
        if not os.path.isdir(lib):
            fail.append(f'plugin {name}: lib/ missing in {d}')
            continue
        for root, _dirs, fnames in os.walk(lib):
            for fn in fnames:
                if fn.endswith('.map'):
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, lib).replace('\\', '/')
                files['lib/' + rel] = hashlib.sha256(open(full, 'rb').read()).hexdigest()
        with open(os.path.join(d, 'package.json'), 'rb') as f:
            files['package.json'] = hashlib.sha256(f.read()).hexdigest()
        expected[name] = files

    with lzma.open(snapshot, 'rb') as f:
        raw = f.read()
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:*') as tf:
        for m in tf:
            n = m.name
            if not m.isfile():
                continue
            if n == 'usr/bin/node' and not checked_elf:
                d = tf.extractfile(m)
                arch = elf_machine(d.read(64) if d else b'')
                if arch != expect:
                    fail.append(f'ELF arch: usr/bin/node = {arch}, expect {expect}')
                checked_elf = True
            patch_match = PROFILE_PATCH_RE.match(n)
            if patch_match:
                d = tf.extractfile(m)
                profile_patches[patch_match.group(1)] = d.read() if d else b''
            for s in SENSITIVE:
                if n.startswith(s) or s.rstrip('/') == n:
                    fail.append(f'sensitive: {n}')
            if n.startswith(PROFILES_ROOT):
                rest = n[len(PROFILES_ROOT):]
                profile, sep, tailText = rest.partition('/')
                ns = 'node_modules/@dsh-android/'
                if not sep or not tailText.startswith(ns):
                    continue
                tail = tailText[len(ns):].split('/', 1)
                if len(tail) != 2:
                    continue
                pkg, rel = tail[0], tail[1]
                found_pkgs.setdefault(profile, set()).add(pkg)
                if pkg in expected and (rel == 'package.json' or rel.startswith('lib/')):
                    if rel.endswith('.map'):
                        fail.append(f'private sourcemap ({profile}): {n}')
                        continue
                    h = hashlib.sha256(tf.extractfile(m).read()).hexdigest()
                    want = expected[pkg].get(rel)
                    if want is None:
                        fail.append(f'plugin extra file not in pack ({profile}): {n}')
                    elif h != want:
                        fail.append(f'plugin mismatch ({profile}) {pkg}: {rel}')
    if not checked_elf:
        fail.append('usr/bin/node not found in snapshot')

    # ── 3. 插件在场：每个装配 profile 都要有全部注入包 ──────────────────────────
    for profile in ASSEMBLY_PROFILES:
        have = found_pkgs.get(profile, set())
        missing = [name for name in expected if name not in have]
        if missing:
            fail.append(f'plugin not in snapshot ({profile}): {", ".join(sorted(missing))}')

    # ── 4. profile patch：遍历全部 profile；装配 profile 与权威文件同长同内容 ────────
    if not profile_patches:
        fail.append(f'{PROFILES_ROOT}<profile>/cordis.patch.yml not found in snapshot')
    for profile in ASSEMBLY_PROFILES:
        if profile not in profile_patches:
            fail.append(f'profile patch missing for assembly profile "{profile}" '
                        f'(expect {PROFILES_ROOT}{profile}/cordis.patch.yml)')

    auth_path = authoritative_patch_path()
    auth_bytes = None
    if auth_path is None:
        fail.append(f'authoritative patch not found ({AUTHORITATIVE_PATCH_NAME}) — searched next to the '
                    f'script and the coordinator scripts/ dir; 无权威真源不得放行')
    else:
        with open(auth_path, 'rb') as f:
            auth_bytes = f.read()

    for profile in sorted(profile_patches):
        data = profile_patches[profile]
        if profile in NEGATIVE_CONTROL_PROFILES:
            if auth_bytes is not None and data == auth_bytes:
                fail.append(f'negative-control profile "{profile}" was overwritten with the authoritative '
                            f'patch — the broken-bashPath fixture is gone (构建链不得覆盖负控 profile)')
            continue
        if app_id is not None:
            check_patch_pkg(f'profile {profile}', data.decode('utf-8', 'replace'), app_id, fail)
        if auth_bytes is not None:
            if len(data) != len(auth_bytes):
                fail.append(f'profile {profile}: cordis.patch.yml length {len(data)} != authoritative '
                            f'{len(auth_bytes)} ({auth_path})')
            elif data != auth_bytes:
                fail.append(f'profile {profile}: cordis.patch.yml content differs from authoritative '
                            f'({auth_path})')

    if fail:
        print('SNAPSHOT_GATE_FAILED')
        for x in fail:
            print('  - ' + x)
        sys.exit(1)
    print(f'SNAPSHOT_GATE_PASSED ({len(expected)} plugins x {len(ASSEMBLY_PROFILES)} profiles, '
          f'profiles checked={sorted(profile_patches)}, ELF={expect})')


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)
    scan(sys.argv[1], sys.argv[2], sys.argv[3:])
