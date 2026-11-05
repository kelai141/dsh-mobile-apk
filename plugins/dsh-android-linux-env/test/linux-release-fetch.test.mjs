import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, readlink, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLinuxReleaseFetch, createLinuxBootstrapConfig, createHostAssetIO } from '../lib/linux-host-asset-io.js'

test('only debug builds replay official Linux release requests on explicit loopback', async () => {
  const filesDir = await mkdtemp(join(tmpdir(), 'linux-release-fetch-'))
  try {
    await mkdir(join(filesDir, 'linux-environment'))
    await writeFile(join(filesDir, 'linux-environment/debug-download-origin'), 'http://127.0.0.1:18791\n')
    const calls = []
    const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"ok":true}') }
    const official = 'https://api.github.com/repos/kelai141/dsh-bionilux/releases/latest'
    const releaseFetch = createLinuxReleaseFetch({ filesDir, debug: false, fetchImpl })
    await releaseFetch(official)
    assert.equal(calls[0].url, official)
    const debugFetch = createLinuxReleaseFetch({ filesDir, debug: true, fetchImpl })
    const response = await debugFetch(official)
    assert.equal(response.url, official)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(calls[1].url, 'http://127.0.0.1:18791/repos/kelai141/dsh-bionilux/releases/latest')
    assert.equal(calls[1].init.redirect, 'error')
    await assert.rejects(debugFetch('https://github.com/other/repo/releases/download/v1/asset'), /unsupported official/)
    await writeFile(join(filesDir, 'linux-environment/debug-download-origin'), 'http://192.168.1.2:18791')
    await assert.rejects(debugFetch(official), /loopback/)
    assert.equal(calls.length, 2)
    const config = createLinuxBootstrapConfig({ filesDir, appVersion: '0.15.0' })
    assert.equal(config.stagingDirectory, join(filesDir, 'linux-environment/plugins/runtime'))
    assert.equal(config.runtimePluginConfig.downloadAsset, config.linuxAssetIO.downloadAsset)
    assert.equal(config.runtimePluginConfig.extractArchive, config.linuxAssetIO.extractArchive)
  } finally { await rm(filesDir, { recursive: true, force: true }) }
})

test('runtime downloader writes the requested file and guest links are copied without dereferencing', async t => {
  const filesDir = await mkdtemp(join(tmpdir(), 'linux-host-runtime-'))
  try {
    const bytes = Buffer.from('native archive bytes')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const stage = join(filesDir, 'linux-environment/staging', digest)
    const tree = join(stage, 'unpacked')
    await mkdir(join(tree, 'usr/bin'), { recursive: true })
    await writeFile(join(stage, 'asset.tar.xz'), bytes)
    await writeFile(join(tree, 'usr/bin/bash'), 'guest-bash', { mode: 0o700 })
    const io = createHostAssetIO({ filesDir })
    const archive = join(filesDir, 'downloaded.archive')
    await io.downloadAsset({ sha256: digest }, archive)
    assert.deepEqual(await readFile(archive), bytes)
    try { await symlink('/usr/bin', join(tree, 'bin')) }
    catch (error) { if (error.code === 'EPERM') { t.diagnostic('Windows denied symlink creation; destination-write assertion passed'); return } throw error }
    const destination = join(filesDir, 'instance')
    await io.extractArchive(archive, destination, { kind: 'rootfs' })
    assert.equal((await lstat(join(destination, 'bin'))).isSymbolicLink(), true)
    assert.equal(await readlink(join(destination, 'bin')), join('usr', 'bin'))
    assert.equal(await readFile(join(destination, 'usr/bin/bash'), 'utf8'), 'guest-bash')
    await assert.rejects(io.extractArchive(archive, join(filesDir, 'plugin'), { kind: 'plugin' }), /符号链接/)
    await symlink('../../../outside', join(tree, 'usr/bin/escape'))
    await assert.rejects(io.extractArchive(archive, join(filesDir, 'escape'), { kind: 'rootfs' }), /越界/)
  } finally { await rm(filesDir, { recursive: true, force: true }) }
})
