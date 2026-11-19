import hashlib
import lzma
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch


builder = Path(__file__).resolve().parent / 'bionilux' / 'assemble-debug-workspace-assets.py'
assembler = runpy.run_path(str(builder))
pack_rootfs_blocks = assembler['pack_rootfs_blocks']


class RootfsBlocksTest(unittest.TestCase):
    def fixture(self, boundaries):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        work = Path(temporary.name)
        raw = bytes(range(256)) * 32
        archive = work / 'rootfs.tar.xz'
        archive.write_bytes(lzma.compress(raw))
        planner = work / 'planner'
        planner.write_text("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' " + boundaries + "\n", encoding='ascii')
        planner.chmod(0o700)
        return work, raw, archive, planner

    def test_round_trip_ignores_ambient_xz_options(self):
        work, raw, archive, planner = self.fixture('4096 4096')
        original = archive.read_bytes()
        with patch.dict(os.environ, {'XZ_OPT': '--invalid-option', 'XZ_DEFAULTS': '--format=raw'}):
            pack_rootfs_blocks(archive, work, planner)
        self.assertNotEqual(original, archive.read_bytes())
        self.assertEqual(lzma.decompress(archive.read_bytes()), raw)

    def test_invalid_boundaries_preserve_the_input_archive(self):
        for boundaries in ('8192', '4096 0 4096', '4096 4095', '8388609 32', '4096 invalid'):
            with self.subTest(boundaries=boundaries):
                work, _, archive, planner = self.fixture(boundaries)
                original = archive.read_bytes()
                with self.assertRaises(ValueError):
                    pack_rootfs_blocks(archive, work, planner)
                self.assertEqual(original, archive.read_bytes())

    def test_compact_profile_preserves_a_small_stream(self):
        work, raw, archive, planner = self.fixture('4096 4096')
        pack_rootfs_blocks(archive, work, planner, compact=True)
        self.assertEqual(lzma.decompress(archive.read_bytes()), raw)

    def test_compact_groups_regain_the_same_boundaries_after_an_edit(self):
        unit = 1 << 20
        # Choose fixed-size chunks that either trigger or defer a boundary.
        chunks = {}
        for byte in range(256):
            chunk = bytes([byte]) * (4 * unit)
            chunks[hashlib.sha256(chunk).digest()[3] & 1] = chunk
            if len(chunks) == 2:
                break
        work, _, _, _ = self.fixture('4096 4096')
        raw = work / 'group-input'
        for keys, expected in [([1, 1, 1, 1, 1, 0, 1, 0], [16, 8, 8]),
                               ([0, 1, 1, 1, 1, 1, 0, 1, 0], [4, 16, 8, 8])]:
            with raw.open('wb') as output:
                for key in keys:
                    output.write(chunks[key])
            result = assembler['compact_block_sizes'](raw, [4 * unit] * len(keys))
            self.assertEqual(result, [size * unit for size in expected])


if __name__ == '__main__':
    unittest.main()
