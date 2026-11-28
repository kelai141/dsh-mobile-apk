import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBioniluxDebugNative } from '../lib/bionilux-debug-native.mjs'

const loader = 'libbionilux-loader.so'
const helper = 'libbionilux-ldconfig.so'

function elf(machine) {
  const bytes = Buffer.alloc(64)
  bytes.writeUInt32LE(0x464c457f)
  bytes[4] = 2
  bytes[5] = 1
  bytes.writeUInt16LE(machine, 18)
  return bytes
}

function nativeDirectory(t, helperMachine = 0x3e) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bionilux-native-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const records = [[loader, elf(0x3e)], [helper, elf(helperMachine)]].map(([name, bytes]) => {
    writeFileSync(join(directory, name), bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    return `${digest}  ${name}\n`
  })
  writeFileSync(join(directory, 'SHA256SUMS'), records.join(''))
  return directory
}

test('reads the x86_64 loader and helper pair with matching hashes', (t) => {
  const assets = readBioniluxDebugNative(nativeDirectory(t), 'x86_64')
  assert.deepEqual(assets.map(({ name }) => name), [loader, helper])
  assert.deepEqual(assets[1].bytes, elf(0x3e))
})

test('rejects a changed helper even if its architecture is correct', (t) => {
  const directory = nativeDirectory(t)
  const bytes = elf(0x3e)
  bytes[63] = 1
  writeFileSync(join(directory, helper), bytes)
  assert.throws(() => readBioniluxDebugNative(directory, 'x86_64'), /source digest mismatch/)
})

test('rejects an ARM64 helper even when its hash matches the manifest', (t) => {
  assert.throws(() => readBioniluxDebugNative(nativeDirectory(t, 0xb7), 'x86_64'), /must be an x86_64/)
})

test('rejects compatibility inputs for a non-x86_64 snapshot', (t) => {
  assert.throws(() => readBioniluxDebugNative(nativeDirectory(t), 'aarch64'), /require an x86_64 snapshot/)
})
