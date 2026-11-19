import lzma
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch


builder = Path(__file__).resolve().parent / 'bionilux' / 'assemble-debug-workspace-assets.py'
pack_rootfs_blocks = runpy.run_path(str(builder))['pack_rootfs_blocks']


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


if __name__ == '__main__':
    unittest.main()
