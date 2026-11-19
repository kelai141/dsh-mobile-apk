#!/usr/bin/env python3
"""Prepare the Android guest launcher with lazy ordinary ELF symbol name lookup."""

import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import tomllib


BIONILUX_REVISION = '2efd57cba5c2c37f9d9eaf1b9ead204020324949'
PROFILE = Path(__file__).resolve().with_name('goblin-0.10.7-symbol-names.patch')


def prepare(checkout: Path, crate: Path, output: Path) -> None:
    if output.exists() or output.is_symlink():
        raise ValueError(f'Source destination already exists: {output}')
    parent = output.parent.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='.bionilux-launcher-', dir=parent) as temporary:
        work = Path(temporary)
        source = work / 'launcher'
        source.mkdir()
        archive = work / 'source.tar'
        subprocess.run(['git', '--no-replace-objects', '-C', checkout, 'archive', '-o', archive, BIONILUX_REVISION],
                       check=True)
        with tarfile.open(archive) as upstream:
            upstream.extractall(source, filter='data')

        lock = source / 'Cargo.lock'
        original = lock.read_text(encoding='utf-8')
        [dependency] = [p for p in tomllib.loads(original)['package'] if p['name'] == 'goblin']
        if dependency['version'] != '0.10.7' or dependency['source'] != 'registry+https://github.com/rust-lang/crates.io-index':
            raise ValueError('Unexpected Goblin dependency in launcher lockfile')
        staged_crate = work / 'goblin.crate'
        shutil.copyfile(crate, staged_crate)
        with staged_crate.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != dependency['checksum']:
                raise ValueError('Goblin crate differs from the pinned launcher lockfile')
        vendor = source / 'vendor'
        vendor.mkdir()
        with tarfile.open(staged_crate, 'r:gz') as package:
            package.extractall(vendor, filter='data')
        with PROFILE.open('rb') as patch:
            subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-d', vendor / 'goblin-0.10.7', '-p1'],
                           stdin=patch, check=True)

        with (source / 'Cargo.toml').open('a', encoding='utf-8') as manifest:
            manifest.write('\n[patch.crates-io]\ngoblin = { path = "vendor/goblin-0.10.7" }\n')
        locked = (f'name = "goblin"\nversion = "0.10.7"\nsource = "{dependency["source"]}"\n'
                  f'checksum = "{dependency["checksum"]}"\n')
        if original.count(locked) != 1:
            raise ValueError('Unexpected Goblin entry in launcher lockfile')
        lock.write_text(original.replace(locked, 'name = "goblin"\nversion = "0.10.7"\n'), encoding='utf-8')
        destination = parent / output.name
        subprocess.run(['mv', '-T', '--no-clobber', '--', source, destination], check=True)
        if source.exists():
            raise ValueError(f'Source destination was created concurrently: {destination}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkout', type=Path, help='Git checkout containing the pinned Bionilux source revision')
    parser.add_argument('crate', type=Path, help='upstream goblin-0.10.7.crate')
    parser.add_argument('output', type=Path, help='new directory for the prepared launcher source')
    args = parser.parse_args()
    try:
        prepare(args.checkout, args.crate, args.output)
    except (OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'{parser.prog}: {error}\n')


if __name__ == '__main__':
    main()
