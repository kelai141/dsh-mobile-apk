// Mount the installed persistence package in each process. The test hook swaps
// only its flock import in native mode. Packaged mode uses the APK as installed.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const [node, packages, mode, binding, childRoot, action] = process.argv.slice(2)
assert.ok(node && packages && binding && ['stub', 'native', 'packaged'].includes(mode))
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
      // In the crash control the parent terminates this process while the
      // handle is still open, so application cleanup cannot release the lock.
      if (action === 'hold') await new Promise(() => setInterval(() => {}, 1000))
    } catch (error) {
      console.log(JSON.stringify({ acquired: false, name: error.constructor.name }))
    } finally {
      await handle?.close()
    }
  } else {
    const childArgs = () => [resolve(node), import.meta.filename,
      resolve(node), resolve(packages), mode, resolve(binding), root]
    const callChild = () => {
      const result = spawnSync('/system/bin/linker64', childArgs(), { encoding: 'utf8', timeout: 30000 })
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
    let crash
    if (mode === 'packaged') {
      const writer = spawn('/system/bin/linker64', [...childArgs(), 'hold'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      const output = createInterface({ input: writer.stdout })
      const exited = once(writer, 'exit')
      try {
        const [line] = await Promise.race([
          once(output, 'line', { signal: AbortSignal.timeout(30000) }),
          exited.then(([code, signal]) => { throw new Error(`holder exited early: ${code ?? signal}`) }),
        ])
        assert.deepEqual(JSON.parse(line), { acquired: true })
        const blocked = callChild()
        assert.deepEqual(blocked, { acquired: false, name: 'SessionAlreadyOwnedError' })
        assert.equal(writer.kill('SIGKILL'), true)
        const [, signal] = await exited
        assert.equal(signal, 'SIGKILL')
        const afterKill = callChild()
        assert.deepEqual(afterKill, { acquired: true })
        crash = { blocked, signal, afterKill }
      } finally {
        output.close()
        if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL')
        await exited.catch(() => {})
      }
    }
    console.log(JSON.stringify({ mode, contending, afterClose, crash }, null, 2))
  }
} finally {
  try {
    await fiber.dispose()
  } finally {
    if (!childRoot) await rm(root, { recursive: true, force: true })
  }
}
