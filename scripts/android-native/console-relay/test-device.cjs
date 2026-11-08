// Run inside an initialized debug APK's sandbox via run-as.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { resolve } = require('node:path')
const { createInterface } = require('node:readline')

const relayPath = resolve(process.argv[2])
const prefix = resolve('files/usr')
const home = '/data/user/0/com.dsharnessmobile.shell/files/home'
const env = {
  ...process.env, HOME: home, PREFIX: prefix,
  LD_LIBRARY_PATH: prefix + '/lib', PATH: prefix + '/bin:/system/bin',
  DSH_CONSOLE_SHELL: prefix + '/bin/bash', TERM: 'xterm-256color',
  DSH_CONSOLE_COLS: '80', DSH_CONSOLE_ROWS: '24',
}

function relay(extraEnv = {}) {
  const child = spawn(relayPath, { env: { ...env, ...extraEnv } })
  const exit = once(child, 'close')
  const frames = []
  let output = ''
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const frame = JSON.parse(line)
    frames.push(frame)
    if (frame.op === 'data') output += frame.data
  })
  const send = (value) => child.stdin.write(JSON.stringify(value) + '\n')
  const command = (data) => send({ op: 'write', data: data + '\r' })
  const wait = async (predicate) => {
    const deadline = Date.now() + 8000
    while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    assert.ok(predicate(), JSON.stringify({ frames: frames.slice(-6), output: output.slice(-500) }))
  }
  return { child, exit, frames, send, command, wait, output: () => output }
}

async function main() {
  const live = relay()
  try {
    await live.wait(() => live.frames.length > 0)
    assert.equal(live.frames[0].op, 'ready')
    assert.equal(live.frames[0].cols, 80)
    live.send({ op: 'resize', cols: 103, rows: 31 })
    live.command("test -t 0 && [[ $- == *m* && $PWD == \"$HOME\" ]] && printf 'dsh-%s中文\\n' 'tty'; stty size")
    await live.wait(() => /dsh-tty中文\r?\n31 103/.test(live.output()))
    live.command("printf 'sleep-%s\\n' 'ready'; sleep 20")
    await live.wait(() => live.output().includes('sleep-ready'))
    await new Promise(r => setTimeout(r, 150))
    live.send({ op: 'write', data: '\x03' })
    await new Promise(r => setTimeout(r, 150))
    live.command("printf 'ctrl-%s\\n' 'ok'; exit 17")
    await live.wait(() => live.frames.some(frame => frame.op === 'exit'))
    assert.match(live.output(), /ctrl-ok/)
    assert.equal(live.frames.find(frame => frame.op === 'exit').code, 17)
    assert.equal((await live.exit)[0], 0)
  } finally {
    if (live.child.exitCode === null) live.child.kill('SIGKILL')
  }

  const failed = relay({ DSH_CONSOLE_SHELL: '/does-not-exist' })
  assert.equal((await failed.exit)[0], 1)
  assert.equal(failed.frames[0]?.op, 'error')
  assert.ok(failed.frames.every(frame => frame.op !== 'ready'))

  const closed = relay()
  try {
    await closed.wait(() => closed.frames[0]?.op === 'ready')
    const pid = closed.frames[0].pid
    closed.send({ op: 'kill' })
    assert.equal((await closed.exit)[0], 0)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    if (closed.child.exitCode === null) closed.child.kill('SIGKILL')
  }

  const background = relay()
  try {
    await background.wait(() => background.frames[0]?.op === 'ready')
    background.command("trap '' HUP; sleep 15 & exit 23")
    await background.wait(() => background.frames.some(frame => frame.op === 'exit'))
    assert.equal(background.frames.find(frame => frame.op === 'exit').code, 23)
    assert.equal((await background.exit)[0], 0)
  } finally {
    if (background.child.exitCode === null) background.child.kill('SIGKILL')
  }
  console.log('ANDROID NATIVE CONSOLE RELAY PASS: tty, job control, resize, UTF-8, Ctrl-C, exit, background exit, exec failure, cleanup')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
