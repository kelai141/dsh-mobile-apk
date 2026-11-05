#!/usr/bin/env python3
"""Fail-closed tests for the shared Harness identity reader."""
from __future__ import annotations

import json
import pathlib
import shutil
import tempfile
import unittest

from harness_pin import read_harness_identity

BASE = {
    "baseline": "9.9.9-rc.9",
    "upstream": {
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "rootVersion": "9.9.9-rc.9",
        "packageManager": "pnpm@9.9.9",
        "enginesNode": "^22.19.0 || >=24.0.0",
    },
}


class HarnessPinTest(unittest.TestCase):
    def write(self, overrides: dict[str, object] | None = None) -> pathlib.Path:
        contract = json.loads(json.dumps(BASE))
        for key, value in (overrides or {}).items():
            if key == "baseline":
                contract["baseline"] = value
            else:
                contract["upstream"][key] = value
        directory = pathlib.Path(tempfile.mkdtemp(prefix="harness-pin-"))
        self.addCleanup(shutil.rmtree, directory, True)
        path = directory / "contract.json"
        path.write_text(json.dumps(contract), encoding="utf-8")
        return path

    def test_returns_exact_identity(self) -> None:
        identity = read_harness_identity(self.write())
        self.assertEqual(identity.commit, BASE["upstream"]["commit"])
        self.assertEqual(identity.version, BASE["baseline"])
        self.assertEqual(identity.package_manager, "pnpm@9.9.9")

    def test_rejects_abbreviated_commit(self) -> None:
        with self.assertRaisesRegex(ValueError, "full lowercase Git commit"):
            read_harness_identity(self.write({"commit": "0123456"}))

    def test_rejects_moving_or_mismatched_version(self) -> None:
        with self.assertRaisesRegex(ValueError, "exact -rc release version"):
            read_harness_identity(self.write({"baseline": "9.9.9"}))
        with self.assertRaisesRegex(ValueError, "disagrees with upstream.rootVersion"):
            read_harness_identity(self.write({"rootVersion": "9.9.9-rc.8"}))

    def test_rejects_unpinned_toolchain(self) -> None:
        with self.assertRaisesRegex(ValueError, "exact pnpm version"):
            read_harness_identity(self.write({"packageManager": "pnpm"}))
        with self.assertRaisesRegex(ValueError, "enginesNode"):
            read_harness_identity(self.write({"enginesNode": ""}))


if __name__ == "__main__":
    unittest.main()
