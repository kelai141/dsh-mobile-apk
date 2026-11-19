#!/usr/bin/env python3
"""Assemble the verified Android x86-64 Linux workspace development fixture."""

import argparse
import hashlib
import io
import json
import lzma
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


MANIFEST_SHA256 = '306d84439d7520d90587d109d1e3edfe40c886bf68b47a345b0c250bcd191248'
ROOTFS_SHA256 = 'b6d7bf1024006658107d41a9b6baf6fcca5029716e2534ebb8a7c139c13cb3fa'
LIBC_SHA256 = '19f4c66b4ea8e012a7c3ceadf94c860d49c3a3392757a53d10d6674bc12af35e'
NODE_SHA256 = '7d54320366c6df7b7149802fb11bab3e669de84f2da9ce0721e678b007ff79ea'
PROFILE = Path(__file__).resolve().with_name('android-x86_64-runtime-assets.patch')
ROOTFS_HANDOFF = PROFILE.with_name('android-rootfs-handoff.patch')
SHARED_NODE_REUSE = PROFILE.with_name('android-shared-node-reuse.patch')
SESSION_COMMAND = PROFILE.with_name('android-session-command.patch')
SESSION = 'modules/session.js'
PREPARE = 'scripts/prepare-android-rootfs.sh'
LDCONFIG = 'scripts/ldconfig-android.sh'
MANAGER = 'modules/manager.js'
PLUGIN_ENTRY = 'lib/index.js'


def sha256(path: Path) -> str:
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def verify(path: Path, digest: str, size: int | None = None) -> Path:
    if (size is not None and path.stat().st_size != size) or sha256(path) != digest:
        raise ValueError(f'Unexpected input bytes: {path.name}')
    return path


def read_verified(path: Path, digest: str) -> bytes:
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != digest:
        raise ValueError(f'Unexpected input bytes: {path.name}')
    return content


def stage_asset(base: Path, directory: Path, asset: dict) -> Path:
    name = asset['url'].rsplit('/', 1)[-1]
    staged = directory / name
    shutil.copyfile(base / name, staged)
    return verify(staged, asset['sha256'], asset['size'])


def patched_sources(work: Path, backend: Path, plugin: Path) -> dict[str, bytes]:
    for source, names in ((backend, (PREPARE, LDCONFIG)), (plugin, (MANAGER, PLUGIN_ENTRY, SESSION))):
        with tarfile.open(source, 'r:xz') as archive:
            for member in archive:
                name = member.name.removeprefix('./')
                if name in names:
                    target = work / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.extractfile(member).read())
    for profile in (PROFILE, ROOTFS_HANDOFF, SHARED_NODE_REUSE, SESSION_COMMAND):
        with profile.open('rb') as patch:
            subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-d', str(work), '-p1'],
                           stdin=patch, check=True)
    sources = {name: (work / name).read_bytes() for name in (PREPARE, LDCONFIG, MANAGER, PLUGIN_ENTRY, SESSION)}
    token = b'@COMPAT_LIBC_SHA256@'
    if sources[MANAGER].count(token) != 1:
        raise ValueError('Missing or ambiguous compatibility libc digest in runtime manager')
    sources[MANAGER] = sources[MANAGER].replace(token, LIBC_SHA256.encode())
    return sources


def repack(source: Path, output: Path, replacements: dict[str, bytes], additions: dict[str, bytes] | None = None) -> int:
    unpacked = 0
    with tarfile.open(source, 'r:xz') as base, tarfile.open(output, 'x:xz', format=tarfile.USTAR_FORMAT) as archive:
        for member in base:
            member.pax_headers = {}
            name = member.name.removeprefix('./')
            if name in replacements:
                if not member.isfile():
                    raise ValueError(f'Cannot replace non-regular archive member: {name}')
                data = replacements.pop(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            else:
                archive.addfile(member, base.extractfile(member) if member.isfile() else None)
            unpacked += member.size
        if replacements:
            raise ValueError(f'Archive members missing from {source.name}: {", ".join(replacements)}')
        for name, data in (additions or {}).items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))
            unpacked += member.size
    return unpacked


def descriptor(path: Path, template: dict, unpacked: int) -> dict:
    return {**template, 'url': template['url'].rsplit('/', 1)[0] + '/' + path.name,
            'size': path.stat().st_size, 'unpackedSize': unpacked, 'sha256': sha256(path)}


def split_node_debug(node: bytes, work: Path, symbols: Path) -> bytes:
    original = work / 'node-original'
    stripped = work / 'node-stripped'
    runtime = work / 'node-runtime'
    original.write_bytes(node)
    symbols.mkdir()
    debug = symbols / 'node.debug'
    subprocess.run(['objcopy', '--only-keep-debug', original, debug], check=True)
    subprocess.run(['objcopy', '--strip-unneeded', original, stripped], check=True)
    subprocess.run(['objcopy', '--add-gnu-debuglink=node.debug', stripped, runtime], cwd=symbols, check=True)
    return runtime.read_bytes()


def pack_rootfs_blocks(archive: Path, work: Path, planner: Path) -> None:
    raw = work / 'rootfs-source.tar'
    with lzma.open(archive, 'rb') as source, raw.open('xb') as output:
        shutil.copyfileobj(source, output, length=256 * 1024)
    with raw.open('rb') as source:
        lengths = subprocess.run([str(planner.resolve(strict=True))], stdin=source, stdout=subprocess.PIPE,
                                 text=True, check=True).stdout.splitlines()
    sizes = [int(value) for value in lengths]
    if not 2 <= len(sizes) <= 512 or any(n <= 0 or n > (8 << 20) for n in sizes) or sum(sizes) != raw.stat().st_size:
        raise ValueError('Invalid rootfs block boundaries')
    packed = work / 'rootfs-blocks.tar.xz'
    block_list = ','.join(map(str, sizes))
    environment = {key: value for key, value in os.environ.items() if key not in ('XZ_DEFAULTS', 'XZ_OPT')}
    with packed.open('xb') as output:
        subprocess.run(['xz', '-T2', '--check=crc64', f'--block-list={block_list}', '--lzma2=dict=4MiB',
                        '-c', '--', str(raw)], stdout=output, env=environment, check=True)
    with lzma.open(packed, 'rb') as decoded:
        if hashlib.file_digest(decoded, 'sha256').hexdigest() != sha256(raw):
            raise ValueError('Blocked rootfs differs from the original tar stream')
    packed.replace(archive)


def assemble(base: Path, rootfs: Path, libc: Path, node: Path, output: Path, block_planner: Path | None = None,
             split_symbols: bool = False) -> None:
    if output.exists() or output.is_symlink():
        raise ValueError(f'Asset destination already exists: {output}')
    destination = output.parent.resolve(strict=True) / output.name
    manifest = json.loads(read_verified(base / 'linux-release.json', MANIFEST_SHA256))
    baseline = next(runtime for runtime in manifest['runtimes'] if runtime['id'] == 'debian-minimal-x64')
    compatible_libc = read_verified(libc, LIBC_SHA256)
    compatible_node = read_verified(node, NODE_SHA256)

    with tempfile.TemporaryDirectory(prefix='.workspace-assets-', dir=destination.parent) as temporary:
        work = Path(temporary)
        inputs = work / 'inputs'
        inputs.mkdir()
        backend, plugin, stock_node = (
            stage_asset(base, inputs, asset) for asset in
            (baseline['backendAsset'], manifest['plugins']['runtime'], baseline['nodeAsset'])
        )
        sources = patched_sources(work, backend, plugin)
        result = work / 'assets'
        result.mkdir()
        stage_asset(base, result, baseline['rootfsAsset'])
        stage_asset(base, result, manifest['plugins']['bootstrap'])

        backend_target = result / backend.name
        unpacked = repack(backend, backend_target, {name: sources[name] for name in (PREPARE, LDCONFIG)},
                          {'android-x86_64/libc.so.6': compatible_libc})
        baseline['backendAsset'] = descriptor(backend_target, baseline['backendAsset'], unpacked)
        plugin_target = result / plugin.name
        unpacked = repack(plugin, plugin_target, {name: sources[name] for name in (MANAGER, PLUGIN_ENTRY, SESSION)})
        manifest['plugins']['runtime'] = descriptor(plugin_target, manifest['plugins']['runtime'], unpacked)
        node_target = result / stock_node.name
        if split_symbols:
            compatible_node = split_node_debug(compatible_node, work, result / 'symbols')
        unpacked = repack(stock_node, node_target, {'bin/node': compatible_node})
        baseline['nodeAsset'] = descriptor(node_target, baseline['nodeAsset'], unpacked)
        rootfs_target = result / 'debian-workspace-lite-x86_64-diagnostic.tar.xz'
        shutil.copyfile(rootfs, rootfs_target)
        verify(rootfs_target, ROOTFS_SHA256)
        if block_planner is not None:
            pack_rootfs_blocks(rootfs_target, work, block_planner)
        with tarfile.open(rootfs_target, 'r:xz') as archive:
            unpacked = sum(member.size for member in archive)
        manifest['runtimes'].append({**baseline, 'id': 'debian-workspace-lite-x64',
                                     'label': 'Debian workspace lite (diagnostic)',
                                     'rootfsCandidateHandoff': True,
                                     'sharedNodeReuse': True,
                                     'rootfsAsset': descriptor(rootfs_target, baseline['rootfsAsset'], unpacked)})
        (result / 'linux-release.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        subprocess.run(['mv', '-T', '--no-clobber', '--', str(result), str(destination)], check=True)
        if result.exists():
            raise ValueError(f'Asset destination was created concurrently: {destination}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base', type=Path, help='pinned v0.10.7 manifest and upstream x86-64 assets')
    parser.add_argument('rootfs', type=Path, help='verified lightweight Debian rootfs archive')
    parser.add_argument('libc', type=Path, help='verified Android compatibility libc build')
    parser.add_argument('node', type=Path, help='verified Android guest Node.js executable')
    parser.add_argument('output', type=Path, help='new directory for fixture assets')
    parser.add_argument('--rootfs-block-planner', type=Path, metavar='BINARY',
                        help='build content-defined XZ blocks with the compiled dsh-rootfs-blocks planner')
    parser.add_argument('--split-node-debug', action='store_true',
                        help='package a stripped guest Node and save its detached GNU symbols under symbols/')
    args = parser.parse_args()
    try:
        assemble(args.base, args.rootfs, args.libc, args.node, args.output, args.rootfs_block_planner, args.split_node_debug)
    except (OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'{parser.prog}: {error}\n')


if __name__ == '__main__':
    main()
