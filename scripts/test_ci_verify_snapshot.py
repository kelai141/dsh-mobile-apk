import contextlib
import importlib.util
import io
import json
import lzma
from pathlib import Path
import struct
import sys
import tarfile
import tempfile
import unittest

# 本文件在镜像面内（check-patch-mirror.mjs 的 MIRROR_TOP），协调仓只有一份镜像副本，
# 那里没有 app/build.gradle.kts。门禁的 applicationId 读取因此必须可注入（issue #736）：
# 不注入就要读宿主真实文件，宿主一换这套自测必红，而两侧又必须逐字节相同 —— 无法本地绕过。
TEST_APP_ID = 'com.dsharnessmobile.shell'

SCRIPT = Path(__file__).with_name('ci-verify-snapshot.py')
SPEC = importlib.util.spec_from_file_location('ci_verify_snapshot_gate', SCRIPT)
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


def elf_header(machine=0x3E):
    data = bytearray(64)
    data[:4] = b'\x7fELF'
    data[18:20] = struct.pack('<H', machine)
    return bytes(data)


class SnapshotGateNegativeControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.plugin = self.root / 'dsh-shell-termux'
        (self.plugin / 'lib').mkdir(parents=True)
        (self.plugin / 'package.json').write_text(
            json.dumps({'name': '@dsh-android/dsh-shell-termux', 'version': 'current'}),
            encoding='utf-8',
        )
        (self.plugin / 'lib' / 'index.js').write_text('export const current = true\n', encoding='utf-8')
        with open(GATE.authoritative_patch_path(), 'rb') as source:
            self.authoritative_patch = source.read()

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self, *, bad_profile_patch=None, assembly_payload_override=None, extra_members=None):
        members = {
            'usr/bin/node': elf_header(),
            'home/.dsh/profiles/web/cordis.patch.yml': self.authoritative_patch,
            'home/.dsh/profiles/headless/cordis.patch.yml': self.authoritative_patch,
            'home/.dsh/profiles/headless-bad/cordis.patch.yml': (
                b'negative-control patch' if bad_profile_patch is None else bad_profile_patch
            ),
        }
        for profile in GATE.ASSEMBLY_PROFILES:
            base = f'home/.dsh/profiles/{profile}/node_modules/@dsh-android/dsh-shell-termux'
            members[base + '/package.json'] = (self.plugin / 'package.json').read_bytes()
            members[base + '/lib/index.js'] = (self.plugin / 'lib' / 'index.js').read_bytes()
        bad_base = 'home/.dsh/profiles/headless-bad/node_modules/@dsh-android/dsh-shell-termux'
        members[bad_base + '/package.json'] = b'{"name":"stale-negative-control"}'
        members[bad_base + '/lib/index.js'] = b'export const stale = true\n'
        members.update(extra_members or {})
        if assembly_payload_override is not None:
            members[assembly_payload_override[0]] = assembly_payload_override[1]

        archive = self.root / 'snapshot.tar.xz'
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as output:
            for name, data in members.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                output.addfile(entry, io.BytesIO(data))
        with lzma.open(archive, 'wb') as output:
            output.write(buffer.getvalue())
        return archive

    def run_gate(self, archive, app_id=TEST_APP_ID):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try:
                GATE.scan(str(archive), 'x86_64', [str(self.plugin)], gradle_reader=lambda: app_id)
            except SystemExit as error:
                return output.getvalue(), error.code
        return output.getvalue(), 0

    def test_stale_negative_control_package_does_not_reject_assembly(self):
        archive = self.snapshot()
        result, status = self.run_gate(archive)
        self.assertEqual(status, 0)
        self.assertIn('SNAPSHOT_GATE_PASSED', result)

    def test_assembly_profile_package_mismatch_still_rejects(self):
        archive = self.snapshot(assembly_payload_override=(
            'home/.dsh/profiles/headless/node_modules/@dsh-android/dsh-shell-termux/lib/index.js',
            b'wrong production payload',
        ))
        result, status = self.run_gate(archive)
        self.assertEqual(status, 1)
        self.assertIn('plugin mismatch (headless) dsh-shell-termux: lib/index.js', result)

    def test_negative_control_patch_overwrite_still_rejects(self):
        archive = self.snapshot(bad_profile_patch=self.authoritative_patch)
        result, status = self.run_gate(archive)
        self.assertEqual(status, 1)
        self.assertIn('negative-control profile "headless-bad" was overwritten', result)

    def test_missing_application_id_still_rejects(self):
        # 注入化之后必须仍然守得住「读不到 applicationId 就判红」这条判据：
        # 若把 scan() 里的 None 分支删掉，这条会变绿并暴露回归。
        archive = self.snapshot()
        result, status = self.run_gate(archive, app_id=None)
        self.assertEqual(status, 1)
        self.assertIn('applicationId not found in app/build.gradle.kts', result)

    def test_negative_control_private_sourcemap_still_rejects(self):
        archive = self.snapshot(extra_members={
            'home/.dsh/profiles/headless-bad/node_modules/@dsh-android/dsh-shell-termux/lib/index.js.map': b'{}',
        })
        result, status = self.run_gate(archive)
        self.assertEqual(status, 1)
        self.assertIn('private sourcemap (headless-bad)', result)


class ExpectArchAliasTests(unittest.TestCase):
    """ABI 命名对齐（2026-11-01 实锤的确定性缺陷）。

    两条构建链传的是打包口径 ABI 名（arm64 / x86_64），门禁比的是 ELF 机器名
    （aarch64 / x86_64）。x86_64 两边同名所以没暴露，arm64 每一轮都被拒 ——
    双 ABI 链在 arm64 上恒断。这里锁三件事：
      1. 别名与规范名**结论完全相同**（同一份输出，不是「也能过」）；
      2. 别名没有放宽判据：拿反的别名仍然判红；
      3. 未知值仍然 exit 2，不被别名表吞成默认值。
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.plugin = self.root / 'dsh-shell-termux'
        (self.plugin / 'lib').mkdir(parents=True)
        (self.plugin / 'package.json').write_text(
            json.dumps({'name': '@dsh-android/dsh-shell-termux', 'version': 'current'}),
            encoding='utf-8',
        )
        (self.plugin / 'lib' / 'index.js').write_text('export const current = true\n', encoding='utf-8')
        with open(GATE.authoritative_patch_path(), 'rb') as source:
            self.authoritative_patch = source.read()

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self, machine):
        members = {
            'usr/bin/node': elf_header(machine),
            'home/.dsh/profiles/web/cordis.patch.yml': self.authoritative_patch,
            'home/.dsh/profiles/headless/cordis.patch.yml': self.authoritative_patch,
            'home/.dsh/profiles/headless-bad/cordis.patch.yml': b'negative-control patch',
        }
        for profile in GATE.ASSEMBLY_PROFILES:
            base = f'home/.dsh/profiles/{profile}/node_modules/@dsh-android/dsh-shell-termux'
            members[base + '/package.json'] = (self.plugin / 'package.json').read_bytes()
            members[base + '/lib/index.js'] = (self.plugin / 'lib' / 'index.js').read_bytes()
        bad_base = 'home/.dsh/profiles/headless-bad/node_modules/@dsh-android/dsh-shell-termux'
        members[bad_base + '/package.json'] = b'{"name":"stale-negative-control"}'
        members[bad_base + '/lib/index.js'] = b'export const stale = true\n'

        archive = self.root / 'snapshot.tar.xz'
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as output:
            for name, data in members.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                output.addfile(entry, io.BytesIO(data))
        with lzma.open(archive, 'wb') as output:
            output.write(buffer.getvalue())
        return archive

    def run_gate(self, archive, expect):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try:
                GATE.scan(str(archive), expect, [str(self.plugin)], gradle_reader=lambda: TEST_APP_ID)
            except SystemExit as error:
                return output.getvalue(), error.code
        return output.getvalue(), 0

    def test_arm64_alias_produces_identical_passed_output(self):
        archive = self.snapshot(0xB7)
        canonical, canonical_status = self.run_gate(archive, 'aarch64')
        alias, alias_status = self.run_gate(archive, 'arm64')
        self.assertEqual(canonical_status, 0)
        self.assertEqual(alias_status, 0)
        self.assertIn('SNAPSHOT_GATE_PASSED', alias)
        # 「结论相同」升级为「输出逐字节相同」：别名不得改变任何判定细节（含 ELF= 字段）。
        self.assertEqual(alias, canonical)
        self.assertIn('ELF=aarch64', alias)

    def test_x86_64_alias_produces_identical_passed_output(self):
        archive = self.snapshot(0x3E)
        canonical, canonical_status = self.run_gate(archive, 'x86_64')
        alias, alias_status = self.run_gate(archive, 'x86-64')
        self.assertEqual(canonical_status, 0)
        self.assertEqual(alias_status, 0)
        self.assertEqual(alias, canonical)
        self.assertIn('ELF=x86_64', alias)

    def test_alias_does_not_weaken_the_arch_check(self):
        # 别名只改名字：拿 x86_64 快照去比 arm64，仍然必须判红（否则就是放宽判据）。
        archive = self.snapshot(0x3E)
        result, status = self.run_gate(archive, 'arm64')
        self.assertEqual(status, 1)
        self.assertIn('ELF arch: usr/bin/node = x86_64, expect aarch64', result)

    def test_unknown_abi_still_exits_2(self):
        archive = self.snapshot(0xB7)
        for unknown in ('riscv64', 'arm', 'aarch64-', ''):
            with self.subTest(unknown=unknown):
                result, status = self.run_gate(archive, unknown)
                self.assertEqual(status, 2)
                self.assertIn('SNAPSHOT_GATE_ERROR: 未知 ABI', result)

    def test_normalize_expect_arch_table(self):
        self.assertEqual(GATE.normalize_expect_arch('arm64'), 'aarch64')
        self.assertEqual(GATE.normalize_expect_arch('aarch64'), 'aarch64')
        self.assertEqual(GATE.normalize_expect_arch('x86_64'), 'x86_64')
        self.assertEqual(GATE.normalize_expect_arch('x86-64'), 'x86_64')
        self.assertEqual(GATE.normalize_expect_arch('ARM64'), 'aarch64')
        self.assertIsNone(GATE.normalize_expect_arch('riscv64'))


if __name__ == '__main__':
    unittest.main()
