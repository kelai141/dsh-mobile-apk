import hashlib
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest


builder = Path(__file__).resolve().parent / 'bionilux' / 'assemble-debug-workspace-assets.py'
split_node_debug = runpy.run_path(str(builder))['split_node_debug']


class NodeSymbolsTest(unittest.TestCase):
    def test_runtime_preserves_build_id_and_resolves_detached_function_names(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            src = work / 'sample.c'
            src.write_text('static int private_function(int n) { return n + 1; }\n'
                           'int main(void) { return private_function(2) == 3 ? 0 : 1; }\n', encoding='ascii')
            original = work / 'fixture'
            subprocess.run(['cc', '-g', '-O0', '-Wl,--build-id', src, '-o', original], check=True)
            before = hashlib.sha256(original.read_bytes()).digest()
            symbols = work / 'symbols'
            runtime = work / 'runtime'
            runtime.write_bytes(split_node_debug(original.read_bytes(), work, symbols))
            runtime.chmod(0o700)
            subprocess.run([runtime], check=True)
            self.assertEqual(before, hashlib.sha256(original.read_bytes()).digest())
            def build_id(binary):
                notes = subprocess.check_output(['readelf', '-n', binary], text=True)
                return next(line.split('Build ID: ')[1] for line in notes.splitlines() if 'Build ID: ' in line)
            self.assertEqual(build_id(original), build_id(runtime))
            self.assertEqual(build_id(runtime), build_id(symbols / 'node.debug'))
            names = subprocess.check_output(['nm', '-n', original], text=True)
            address = next(row.split()[0] for row in names.splitlines() if row.endswith(' private_function'))
            answer = subprocess.check_output(['addr2line', '-f', '-e', symbols / 'node.debug', address], text=True)
            self.assertIn('private_function', answer)
            section = subprocess.check_output(['readelf', '-p', '.gnu_debuglink', runtime], errors='replace')
            self.assertIn('node.debug', section)


if __name__ == '__main__':
    unittest.main()
