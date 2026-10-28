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

    def run_gate(self, archive):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try:
                GATE.scan(str(archive), 'x86_64', [str(self.plugin)])
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

    def test_negative_control_private_sourcemap_still_rejects(self):
        archive = self.snapshot(extra_members={
            'home/.dsh/profiles/headless-bad/node_modules/@dsh-android/dsh-shell-termux/lib/index.js.map': b'{}',
        })
        result, status = self.run_gate(archive)
        self.assertEqual(status, 1)
        self.assertIn('private sourcemap (headless-bad)', result)


if __name__ == '__main__':
    unittest.main()
