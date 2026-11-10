// Uses only two disposable processes and a lock in the debug APK's cache.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getSystemErrorName } from 'node:util'

const [nodePath, modulePath, mode, childPath] = process.argv.slice(2)
assert.ok(nodePath && modulePath && (mode === 'stub' || mode === 'native'))
let tryLockExclusive
if (mode === 'stub') {
  ;({ tryLockExclusive } = await import(pathToFileURL(resolve(modulePath)).href))
} else {
  const { tryLock } = createRequire(import.meta.url)(resolve(modulePath))
  tryLockExclusive = async fd => {
    const errno = await new Promise(resolveErrno => tryLock(fd, resolveErrno))
    if (errno === 0) return
    const code = getSystemErrorName(-errno)
    throw Object.assign(new Error(code), { code, errno, syscall: 'flock' })
  }
}

async function attempt(fd) {
  try {
    await tryLockExclusive(fd)
    return { acquired: true }
  } catch (error) {
    return { acquired: false, code: error.code, errno: error.errno, syscall: error.syscall }
  }
}

if (childPath) {
  const handle = await open(childPath, 'a+')
  try {
    console.log(JSON.stringify(await attempt(handle.fd)))
  } finally {
    await handle.close()
  }
} else {
  const root = await mkdtemp(resolve('cache/dsh-flock-probe-'))
  const path = join(root, 'session.lock')
  const child = () => {
    const result = spawnSync('/system/bin/linker64',
      [resolve(nodePath), import.meta.filename, resolve(nodePath), resolve(modulePath), mode, path],
      { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    return JSON.parse(result.stdout)
  }
  try {
    const holder = await open(path, 'a+')
    let first
    let contending
    try {
      first = await attempt(holder.fd)
      assert.equal(first.acquired, true)
      contending = child()
    } finally {
      await holder.close()
    }
    const afterClose = child()
    assert.equal(afterClose.acquired, true)
    const invalidFd = await attempt(-1)
    if (mode === 'stub') {
      assert.equal(contending.acquired, true, 'installed stub unexpectedly excludes a second process')
      assert.equal(invalidFd.acquired, true)
    } else {
      assert.equal(contending.acquired, false, 'two processes acquired the same lock')
      assert.ok(['EAGAIN', 'EWOULDBLOCK'].includes(contending.code))
      assert.equal(contending.syscall, 'flock')
      assert.equal(invalidFd.code, 'EBADF')
      assert.equal(invalidFd.syscall, 'flock')
    }
    console.log(JSON.stringify({ mode, first, contending, afterClose, invalidFd }, null, 2))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
