#!/usr/bin/env python3
"""Prepare signed Node.js source for the Linux guest on Android x86-64."""

import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile


SOURCE = 'node-v24.22.0.tar.xz'
CHECKSUMS = 'SHASUMS256.txt'
SIGNATURE = 'SHASUMS256.txt.sig'
SOURCE_SHA256 = '41f97cff2c666f1f8293dc5f85c65e8dd605c16b43fd9febd49ede32ee1e0329'
SIGNER = 'C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C'
PROFILE = Path(__file__).resolve().with_name('node-v24.22.0-android-x86_64.patch')


def prepare(source_dir: Path, keyring: Path, output: Path) -> None:
    if output.exists() or output.is_symlink():
        raise ValueError(f'Source destination already exists: {output}')
    output_parent = output.parent.resolve(strict=True)
    keyring = keyring.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='.bionilux-node-', dir=output_parent) as temporary:
        work = Path(temporary)
        for name in (SOURCE, CHECKSUMS, SIGNATURE):
            shutil.copyfile(source_dir / name, work / name)

        signature = subprocess.run(
            ['gpgv', '--keyring', str(keyring), '--status-fd', '1', str(work / SIGNATURE), str(work / CHECKSUMS)],
            stdout=subprocess.PIPE, text=True, check=True,
        )
        if not any(line.startswith(f'[GNUPG:] VALIDSIG {SIGNER} ') for line in signature.stdout.splitlines()):
            raise ValueError('Unexpected Node.js source signer')

        entries = [line.split() for line in (work / CHECKSUMS).read_text(encoding='utf-8').splitlines()]
        source_digests = [entry[0] for entry in entries if len(entry) == 2 and entry[1] == SOURCE]
        if source_digests != [SOURCE_SHA256] or hashlib.sha256((work / SOURCE).read_bytes()).hexdigest() != SOURCE_SHA256:
            raise ValueError(f'Invalid Node.js source checksum: {SOURCE}')

        source_tree = work / 'node'
        source_tree.mkdir()
        subprocess.run(['tar', '-xJf', str(work / SOURCE), '--strip-components=1', '--no-same-owner', '-C', str(source_tree)], check=True)
        with PROFILE.open('rb') as patch:
            subprocess.run(
                ['patch', '--batch', '--forward', '--fuzz=0', '-d', str(source_tree), '-p1'],
                stdin=patch, check=True,
            )

        destination = output_parent / output.name
        subprocess.run(['mv', '-T', '--no-clobber', '--', str(source_tree), str(destination)], check=True)
        if source_tree.exists():
            raise ValueError(f'Source destination was created concurrently: {destination}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_dir', type=Path, help='directory containing the Node.js archive and signed checksum files')
    parser.add_argument('keyring', type=Path, help='trusted binary OpenPGP keyring for the Node.js release signer')
    parser.add_argument('output', type=Path, help='new directory for the patched source')
    args = parser.parse_args()
    try:
        prepare(args.source_dir, args.keyring, args.output)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'{parser.prog}: {error}\n')


if __name__ == '__main__':
    main()
