#!/usr/bin/env python3
"""Prepare the signed Debian glibc source for the Android x86-64 guest build."""

import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile


SOURCE_CONTROL = 'glibc_2.41-12+deb13u4.dsc'
SOURCE_SHA256 = {
    SOURCE_CONTROL: '0915324aa646bb99abfaa9aa6ecb734b30babd28454a3e51f3152912370fbd3e',
    'glibc_2.41.orig.tar.xz': 'f24aa441021121a79266f0d75242706cab8843a47901fefe74527491807f1998',
    'glibc_2.41-12+deb13u4.debian.tar.xz': 'dda4153511bfd543502d18e5bc9323110996fe9c531f14ae3fad6eb17f027c7d',
}
SIGNER = '52BC8695BE34F90AD7D40CB81388C0F899E8336B'
PROFILE = Path(__file__).resolve().with_name('glibc-2.41-android-x86_64.patch')


def prepare(source_dir: Path, keyring: Path, output: Path) -> None:
    if output.exists() or output.is_symlink():
        raise ValueError(f'Source destination already exists: {output}')
    output_parent = output.parent.resolve(strict=True)
    keyring = keyring.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='.bionilux-glibc-', dir=output_parent) as temporary:
        work = Path(temporary)
        for filename, digest in SOURCE_SHA256.items():
            source = work / filename
            shutil.copyfile(source_dir / filename, source)
            if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                raise ValueError(f'Invalid Debian source checksum: {filename}')

        signature = subprocess.run(
            ['gpgv', '--keyring', str(keyring), '--status-fd', '1', str(work / SOURCE_CONTROL)],
            stdout=subprocess.PIPE, text=True, check=True,
        )
        if not any(line.startswith(f'[GNUPG:] VALIDSIG {SIGNER} ') for line in signature.stdout.splitlines()):
            raise ValueError('Unexpected Debian source signer')

        source_tree = work / 'glibc'
        subprocess.run(['dpkg-source', '-x', str(work / SOURCE_CONTROL), str(source_tree)], check=True)
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
    parser.add_argument('source_dir', type=Path, help='directory containing the pinned Debian source files')
    parser.add_argument('keyring', type=Path, help='trusted Debian developer keyring')
    parser.add_argument('output', type=Path, help='new directory for the patched source')
    args = parser.parse_args()
    try:
        prepare(args.source_dir, args.keyring, args.output)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'{parser.prog}: {error}\n')


if __name__ == '__main__':
    main()
