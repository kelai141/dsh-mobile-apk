#!/usr/bin/env python3
"""Regression tests for swapping pinned Harness sources after pnpm install."""
from __future__ import annotations

import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).with_name("prepare-harness-vendor-overrides.py")
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("prepare_harness_vendor_overrides", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReplaceStagedSourcesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="harness-vendor-overrides-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.stage = self.root / "stage"
        self.stage.mkdir()

    def package(self, name: str) -> tuple[pathlib.Path, pathlib.Path]:
        target = self.root / "vendor" / name
        staged = self.stage / name
        (target / "src").mkdir(parents=True)
        (staged / "src").mkdir(parents=True)
        (target / "package.json").write_text('{"version":"new"}')
        (target / "src" / "old.txt").write_text("old")
        (staged / "package.json").write_text('{"version":"pinned"}')
        (staged / "src" / "new.txt").write_text("new")
        return target, staged

    def test_preserves_cyclic_pnpm_links_and_replaces_only_source(self) -> None:
        group, staged = self.package("group")
        cordis = self.root / "vendor" / "cordis"
        loader = self.root / "vendor" / "loader"
        for package in (group, cordis, loader):
            (package / "node_modules" / "@deepseek-ai").mkdir(parents=True)
        try:
            os.symlink(cordis, group / "node_modules" / "@deepseek-ai" / "cordis", target_is_directory=True)
            os.symlink(loader, cordis / "node_modules" / "@deepseek-ai" / "cordis-plugin-loader", target_is_directory=True)
            os.symlink(cordis, loader / "node_modules" / "@deepseek-ai" / "cordis", target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")

        MODULE.replace_staged_sources([(group, staged)], self.stage)

        self.assertEqual((group / "package.json").read_text(), '{"version":"pinned"}')
        self.assertTrue((group / "src" / "new.txt").is_file())
        self.assertFalse((group / "src" / "old.txt").exists())
        self.assertEqual((group / "node_modules" / "@deepseek-ai" / "cordis").resolve(), cordis.resolve())
        self.assertFalse((self.stage / "group.original" / "node_modules").exists())

    def test_restores_all_sources_on_later_package_failure(self) -> None:
        first = self.package("group")
        second = self.package("hmr")
        (first[0] / "node_modules").mkdir()
        (first[0] / "node_modules" / "marker").write_text("keep")
        real_copytree = MODULE.shutil.copytree

        def fail_second_copy(source: pathlib.Path, destination: pathlib.Path, **kwargs: object) -> object:
            if source == second[1] / "src":
                raise OSError("injected second package failure")
            return real_copytree(source, destination, **kwargs)

        with mock.patch.object(MODULE.shutil, "copytree", side_effect=fail_second_copy):
            with self.assertRaisesRegex(OSError, "injected second package failure"):
                MODULE.replace_staged_sources([first, second], self.stage)

        for target, _ in (first, second):
            self.assertEqual((target / "package.json").read_text(), '{"version":"new"}')
            self.assertTrue((target / "src" / "old.txt").is_file())
            self.assertFalse((target / "src" / "new.txt").exists())
        self.assertEqual((first[0] / "node_modules" / "marker").read_text(), "keep")

    def test_rejects_staged_node_modules_without_touching_target(self) -> None:
        target, staged = self.package("group")
        (staged / "node_modules").mkdir()
        with self.assertRaisesRegex(ValueError, "pinned source contains node_modules"):
            MODULE.replace_staged_sources([(target, staged)], self.stage)
        self.assertEqual((target / "package.json").read_text(), '{"version":"new"}')


if __name__ == "__main__":
    unittest.main()
