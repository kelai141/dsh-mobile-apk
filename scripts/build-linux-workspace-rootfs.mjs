import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdtempSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MAX_SEED_BYTES = 256 * 1024 * 1024
const EXPORT_ROOTFS = String.raw`
set -euo pipefail
export LC_ALL=C TZ=UTC DEBIAN_FRONTEND=noninteractive
test "$(dpkg --print-architecture)" = amd64
. /etc/os-release
test "$ID:$VERSION_CODENAME" = debian:trixie
sed -i -e 's|^URIs: http://ftp.debian.org/debian$|URIs: https://deb.debian.org/debian|' \
  -e 's|^URIs: http://deb.debian.org/debian-security$|URIs: https://deb.debian.org/debian-security|' \
  /etc/apt/sources.list.d/debian.sources
test "$(grep -c '^URIs: https://deb.debian.org/' /etc/apt/sources.list.d/debian.sources)" = 2
apt-get -y purge --auto-remove python3 python3-venv jq less rsync
test -z "$(dpkg --audit)"
apt-get check
for tool in bash git ssh apt-get dpkg-divert tar xz; do command -v "$tool" >/dev/null; done
mkdir -p /usr/share/dsh-workspace
dpkg-query -W -f='\x24{Package}\t\x24{Version}\n' | sort > /usr/share/dsh-workspace/packages.tsv
tar --one-file-system --format=gnu --sort=name --mtime=@0 --numeric-owner --hard-dereference \
  --exclude=./.dockerenv --exclude=./etc/hostname --exclude=./etc/hosts --exclude=./etc/resolv.conf \
  --exclude='./var/log/*' --exclude='./var/cache/ldconfig/*' \
  --exclude='./var/cache/apt/*' --exclude=./var/lib/dpkg/status-old --exclude='./var/backups/*' \
  -cf - -C / . | xz -T1 -6 > /output/rootfs.tar.xz
xz --test /output/rootfs.tar.xz
`.replaceAll('\\x24', '$')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function validateDigest(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${label} must be a lowercase SHA-256 digest`)
}

function verifyDigest(bytes, expected, label) {
  validateDigest(expected, label)
  if (sha256(bytes) !== expected) throw new Error(`${label} SHA-256 mismatch`)
}

function docker(args, options) {
  const result = spawnSync('docker', args, options)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed (${result.signal || result.status})`)
  return result.stdout
}

function build(seedPath, seedDigest, outputPath) {
  validateDigest(seedDigest, 'Seed')
  if (!outputPath.endsWith('.tar.xz')) throw new Error('Output must end in .tar.xz')
  const output = resolve(outputPath)
  if (existsSync(output)) throw new Error('Output already exists')
  const seedStat = statSync(seedPath)
  if (!seedStat.isFile() || seedStat.size < 1 || seedStat.size > MAX_SEED_BYTES) throw new Error('Seed must be a regular archive of at most 256 MiB')
  const seed = readFileSync(seedPath)
  verifyDigest(seed, seedDigest, 'Seed')
  const staging = mkdtempSync(join(dirname(output), '.dsh-rootfs-'))
  const candidate = join(staging, 'rootfs.tar.xz')
  try {
    const image = docker(['import', '--platform', 'linux/amd64', '-'], { input: seed, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).trim()
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Docker did not return an image digest')
    docker(['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--hostname', 'dsh-workspace',
      '--mount', `type=bind,source=${staging},target=/output`, image, '/bin/bash', '-c', EXPORT_ROOTFS], { stdio: 'inherit' })
    const compressed = readFileSync(candidate)
    linkSync(candidate, output)
    console.log(JSON.stringify({ output, bytes: compressed.length, sha256: sha256(compressed), seedSha256: seedDigest, image }))
  } finally {
    if (existsSync(candidate)) unlinkSync(candidate)
    rmdirSync(staging)
  }
}

try {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--self-test') {
    const seed = Buffer.from('seed')
    const digest = '19b25856e1c150ca834cffc8b59b23adbd0ec0389e58eb22b3b64768098d002b'
    verifyDigest(seed, digest, 'Seed')
    assert.throws(() => verifyDigest(Buffer.from('wrong'), digest, 'Seed'), /SHA-256 mismatch/)
    assert.throws(() => validateDigest('invalid', 'Seed'), /lowercase SHA-256/)
    console.log('PASS: valid, mismatched, and malformed digests')
  } else if (args.length === 3) {
    build(...args)
  } else {
    throw new Error('Usage: node scripts/build-linux-workspace-rootfs.mjs <trusted-seed.tar.xz> <seed-sha256> <output.tar.xz>')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
