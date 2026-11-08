// Run from the initialized APK sandbox, using the snapshot's Node and node-pty.
const { resolve } = require('node:path')
const pty = require(resolve('files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty'))

const start = process.hrtime.bigint()
const term = pty.spawn('/system/bin/sh', [
  '-c',
  "test -t 0 && test -t 1 || exit 3; printf 'dsh-%s\\n' 'ready'; IFS= read -r line || exit 4; printf 'recv:%s\\n' \"$line\"; stty size; exit 17",
], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { PATH: '/system/bin', TERM: 'xterm-256color' },
})
const elapsed = () => Number((process.hrtime.bigint() - start) / 1000n)
const timer = setTimeout(() => {
  term.kill()
  process.exitCode = 1
}, 5000)
let buffer = ''
let ready = null
term.onData((chunk) => {
  buffer += chunk
  if (ready === null && buffer.includes('dsh-ready')) {
    ready = elapsed()
    term.resize(103, 31)
    term.write('中文 PTY\r')
  }
})
term.onExit(({ exitCode }) => {
  clearTimeout(timer)
  if (exitCode !== 17 || ready === null || !buffer.includes('recv:中文 PTY\r\n31 103')) {
    console.error({ exitCode, buffer })
    process.exitCode = 1
  } else {
    console.log(`node_pty_ok ready_us=${ready} total_us=${elapsed()}`)
  }
})
