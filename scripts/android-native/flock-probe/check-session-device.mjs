// Mount the installed persistence package in each process. The test hook swaps
// only its flock import in native mode and never edits the installed package.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [node, packages, mode, binding, childRoot] = process.argv.slice(2)
assert.ok(node && packages && binding && ['stub', 'native'].includes(mode))
if (mode === 'native') {
  const file = resolve(binding)
  const source = `
    import { createRequire } from 'node:module'
    import { getSystemErrorName } from 'node:util'
    const path = ${JSON.stringify(file)}
    const { tryLock } = createRequire(path)(path)
    export async function tryLockExclusive(fd) {
      const errno = await new Promise(resolve => tryLock(fd, resolve))
      if (!errno) return
      const code = getSystemErrorName(-errno)
      throw Object.assign(new Error(code), { code, errno, syscall: 'flock' })
    }
  `
  const url = 'data:text/javascript,' + encodeURIComponent(source)
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/node-addon-system/flock') return { url, shortCircuit: true }
    return next(specifier, context)
  } })
}

const installed = name => import(pathToFileURL(resolve(packages, name, 'lib/index.js')).href)
const { Context } = await installed('cordis')
const { SESSION_FORMAT_VERSION, SessionId, SessionSeq } = await installed('dsh-session')
const backend = await installed('dsh-session-persistence-jsonl')
const id = SessionId('android-flock-probe')
const root = childRoot || await mkdtemp(resolve('cache/dsh-session-flock-'))
const ctx = new Context()
const fiber = await ctx.plugin(backend, { root: join(root, 'sessions'), compression: 'zstd' })
try {
  if (childRoot) {
    let handle
    try {
      handle = await ctx.sessionPersistence.open(id, 'write')
      console.log(JSON.stringify({ acquired: true }))
    } catch (error) {
      console.log(JSON.stringify({ acquired: false, name: error.constructor.name }))
    } finally {
      await handle?.close()
    }
  } else {
    const callChild = () => {
      const result = spawnSync('/system/bin/linker64', [resolve(node), import.meta.filename,
        resolve(node), resolve(packages), mode, resolve(binding), root], { encoding: 'utf8', timeout: 30000 })
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      return JSON.parse(result.stdout)
    }
    const holder = await ctx.sessionPersistence.create({ id, version: SESSION_FORMAT_VERSION,
      isSeeded: false, createdAt: 1000, cwd: join(root, 'workspace') })
    let contending
    try {
      await holder.append([{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }])
      contending = callChild()
    } finally {
      await holder.close()
    }
    const afterClose = callChild()
    assert.deepEqual(afterClose, { acquired: true })
    assert.deepEqual(contending, mode === 'stub' ? { acquired: true }
      : { acquired: false, name: 'SessionAlreadyOwnedError' })
    console.log(JSON.stringify({ mode, contending, afterClose }, null, 2))
  }
} finally {
  try {
    await fiber.dispose()
  } finally {
    if (!childRoot) await rm(root, { recursive: true, force: true })
  }
}
