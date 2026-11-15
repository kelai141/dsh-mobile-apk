"""Behavioral archive test: inherited retired code/links/dependencies cannot survive injection."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("inject-all.py")
spec = importlib.util.spec_from_file_location("inject_all", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RetirementTests(unittest.TestCase):
    def test_archive_drops_retired_files_links_and_profile_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, target = root / "base.tar.xz", root / "new.tar.xz"
            patch = root / "profile.yml"
            patch.write_text("# native-only fixture\n", encoding="utf-8")
            retained = "home/.dsh/profiles/web/node_modules/@dsh-android/dsh-android-browser/lib/index.js"
            with tarfile.open(source, "w:xz") as archive:
                for profile in ("web", "headless"):
                    base = "home/.dsh/profiles/" + profile
                    data = json.dumps({"dependencies": {
                        "@dsh-android/dsh-android-manage": "0.3.0",
                        "@dsh-android/dsh-android-browser": "0.1.0"}}).encode()
                    entry = tarfile.TarInfo(base + "/package.json")
                    entry.size = len(data)
                    archive.addfile(entry, io.BytesIO(data))
                    for package in ("dsh-android-manage", "dsh-android-vdisplay"):
                        prefix = base + "/node_modules/@dsh-android/" + package
                        entry = tarfile.TarInfo(prefix + "/lib/index.js")
                        entry.size = 3
                        archive.addfile(entry, io.BytesIO(b"old"))
                        link = tarfile.TarInfo(prefix + "/alias")
                        link.type = tarfile.SYMTYPE
                        link.linkname = "lib/index.js"
                        archive.addfile(link)
                entry = tarfile.TarInfo(retained)
                entry.size = 6
                archive.addfile(entry, io.BytesIO(b"shared"))
            result = subprocess.run([sys.executable, str(SCRIPT), str(source), str(target), str(patch)],
                env=dict(os.environ, DSH_INJECT_PRESET="0"), text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with tarfile.open(target) as archive:
                self.assertEqual(archive.extractfile(retained).read(), b"shared")
                self.assertFalse(any("/dsh-android-manage/" in x.name or "/dsh-android-vdisplay/" in x.name
                    for x in archive))
                manifest = json.load(archive.extractfile("home/.dsh/profiles/web/package.json"))
                self.assertNotIn("@dsh-android/dsh-android-manage", manifest["dependencies"])
                self.assertIn("@dsh-android/dsh-android-browser", manifest["dependencies"])

    def test_negative_control_rejects_active_retired_overlap(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = Path(temporary) / "plugins.json"
            manifest.write_text(json.dumps({"dirs": ["plugins/dsh-android-manage"],
                "retiredDirs": ["plugins/dsh-android-manage"]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "remains in active"):
                module.retired_packages(manifest)


if __name__ == "__main__":
    unittest.main()
