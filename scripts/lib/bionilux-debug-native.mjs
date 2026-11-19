import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyLoaderElf,
  evaluateApkLoader,
  LOADER_FILE_NAME,
  readZipCentralDirectory,
  readZipEntry,
} from '../check-native-linux-loader.mjs'

const NAMES = [LOADER_FILE_NAME, 'libbionilux-ldconfig.so']
const ABI = 'x86_64'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function readBioniluxDebugNative(directory, snapshotAbi) {
  if (snapshotAbi !== ABI) throw new Error('Bionilux debug native inputs require an x86_64 snapshot')

  const sums = new Map()
  for (const line of readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
    const record = /^([a-f0-9]{64}) [ *]([a-zA-Z0-9_.-]+)$/.exec(line)
    if (!record || sums.has(record[2])) throw new Error('Invalid or duplicate entry in Bionilux SHA256SUMS')
    sums.set(record[2], record[1])
  }

  return NAMES.map((name) => {
    const digest = sums.get(name)
    if (!digest) throw new Error(`Missing Bionilux digest for ${name}`)
    const bytes = readFileSync(join(directory, name))
    if (sha256(bytes) !== digest) throw new Error(`Bionilux source digest mismatch for ${name}`)
    const elf = classifyLoaderElf(bytes, ABI)
    if (!elf.ok || bytes[5] !== 1) throw new Error(`Bionilux ${name} must be an x86_64 little-endian ELF`)
    return { name, digest, bytes }
  })
}

export function assertBioniluxDebugApk(apk, assets) {
  const bytes = readFileSync(apk)
  const zip = readZipCentralDirectory(bytes)
  if (!zip) throw new Error('Cannot read the Bionilux debug APK directory')

  const getEntry = (entry) => readZipEntry(bytes, entry)
  const loader = evaluateApkLoader(zip.entries, ABI, getEntry, { requireManifest: true })
  if (!loader.ok) throw new Error(`Bionilux debug APK loader validation failed: ${loader.problems.join('; ')}`)
  if (loader.evidence.extractNativeLibs !== true) {
    throw new Error('The Bionilux debug APK must extract native executables at install time')
  }

  for (const { name, digest } of assets) {
    const matches = zip.entries.filter((entry) => entry.name.startsWith('lib/') && entry.name.endsWith(`/${name}`))
    const expected = `lib/${ABI}/${name}`
    if (matches.length !== 1 || matches[0].name !== expected) {
      throw new Error(`Bionilux debug APK must contain exactly one ${expected}`)
    }
    const payload = getEntry(matches[0])
    if (!payload.ok || sha256(payload.data) !== digest) {
      throw new Error(`Bionilux APK digest mismatch for ${expected}`)
    }
  }
}
