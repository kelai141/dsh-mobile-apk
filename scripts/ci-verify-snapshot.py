#!/usr/bin/env python3
"""ci-verify-snapshot.py — CI snapshot gate: ELF arch + secrets scan + plugin consistency.
Usage:
  python3 ci-verify-snapshot.py <snapshot.tar.xz> <expect-arch> <plugins-dir>...
  expect-arch: aarch64 | x86_64
Checks:
  1. usr/bin/node ELF machine matches expect-arch (streamed from tar).
  2. Sensitive paths absent: .credentials / sessions/ / storages/ / anon-id / settings.yaml / .npmrc / private sourcemaps.
  3. Injected plugin lib/ + package.json match the pack output (hash compare per plugin).
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
    'home/.dsh/settings.yaml',
    'home/.npmrc',
)
PLUGIN_ROOT = 'home/.dsh/profiles/web/node_modules/@dsh-android/'
# The web profile patch carries the shell-termux paths (bashPath/prefix/home/cwd).
# They must point at the CURRENT applicationId's data dir — a snapshot built before
# a package rename keeps the old package path and every bash call fails with
# "not executable" (2026-08-21 incident: com.dshmobile.shell -> com.dsharnessmobile.shell).
PKG_PATCH = 'home/.dsh/profiles/web/cordis.patch.yml'
PKG_KEYS = ('bashPath', 'prefix', 'home', 'cwd')


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


def check_patch_pkg(patch_text: str, app_id: str, fail: list) -> None:
    for key in PKG_KEYS:
        m = re.search(r'^\s*' + key + r':\s*(\S+)', patch_text, re.M)
        if not m:
            fail.append(f'patch: {key} missing in {PKG_PATCH}')
            continue
        path = m.group(1)
        ok = path.startswith(f'/data/data/{app_id}/') or path.startswith(f'/data/user/0/{app_id}/')
        if not ok:
            fail.append(f'patch: {key} -> {path} (expect /data/(data|user/0)/{app_id}/...)')


def elf_machine(data: bytes) -> str:
    if len(data) < 20 or data[:4] != b'\x7fELF':
        return 'NOT_ELF'
    machine = struct.unpack_from('<H', data, 18)[0]
    return MACHINES.get(machine, '0x%x' % machine)


def scan(snapshot: str, expect: str, plugin_dirs):
    fail = []
    checked_elf = False
    found_pkgs = set()
    app_id = app_id_from_gradle()
    if app_id is None:
        fail.append('applicationId not found in app/build.gradle.kts')
    patch_text = None

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
            if n == PKG_PATCH:
                d = tf.extractfile(m)
                patch_text = d.read().decode('utf-8', 'replace') if d else ''
            for s in SENSITIVE:
                if n.startswith(s) or s.rstrip('/') == n:
                    fail.append(f'sensitive: {n}')
            if n.startswith(PLUGIN_ROOT):
                parts = n[len(PLUGIN_ROOT):].split('/', 1)
                if len(parts) == 2:
                    found_pkgs.add(parts[0])
                    rel = parts[1]
                    if parts[0] in expected and (rel == 'package.json' or rel.startswith('lib/')):
                        if rel.endswith('.map'):
                            fail.append(f'private sourcemap: {n}')
                            continue
                        h = hashlib.sha256(tf.extractfile(m).read()).hexdigest()
                        want = expected[parts[0]].get(rel)
                        if want is None:
                            fail.append(f'plugin extra file not in pack: {n}')
                        elif h != want:
                            fail.append(f'plugin mismatch {parts[0]}: {rel}')
    if not checked_elf:
        fail.append('usr/bin/node not found in snapshot')
    if patch_text is None:
        fail.append(f'{PKG_PATCH} not found in snapshot')
    elif app_id is not None:
        check_patch_pkg(patch_text, app_id, fail)
    for name in expected:
        if name not in found_pkgs:
            fail.append(f'plugin not in snapshot: {name}')
    if fail:
        print('SNAPSHOT_GATE_FAILED')
        for x in fail:
            print('  - ' + x)
        sys.exit(1)
    print(f'SNAPSHOT_GATE_PASSED ({len(expected)} plugins, ELF={expect})')


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)
    scan(sys.argv[1], sys.argv[2], sys.argv[3:])
