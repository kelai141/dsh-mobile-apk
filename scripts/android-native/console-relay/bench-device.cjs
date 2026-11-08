// Run as the debug app UID. Compare the installed relays with the same Bash and prompt.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const { createInterface } = require('node:readline')
const { setTimeout: sleep } = require('node:timers/promises')

const prefix = resolve('files/usr')
const home = resolve('files/home')
const node = prefix + '/bin/node'
const script = resolve('files/console-pty.mjs')
const native = process.argv[2]
assert.ok(native && native.startsWith('/'), 'pass the installed relay absolute path')
const env = {
  HOME: home, PREFIX: prefix, LD_LIBRARY_PATH: prefix + '/lib',
  PATH: prefix + '/bin:/system/bin', TERM: 'xterm-256color',
  DSH_CONSOLE_PREFIX: prefix, DSH_CONSOLE_SHELL: prefix + '/bin/bash',
  DSH_CONSOLE_NODE_PTY: prefix + '/lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty',
  DSH_CONSOLE_COLS: '80', DSH_CONSOLE_ROWS: '24',
}

const timeout = 12000
const idleMs = 500
const prompt = 'dsh-bench-prompt> '
const marker = 'dsh-bench-result-中文'
const roundOrder = Array.from({ length: 5 }, () => ['node', 'rust', 'rust', 'node']).flat()

function proc(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  // The command name in stat is enclosed in parentheses and may contain spaces.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const rss = Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1])
  const cpuTicks = Number(fields[11]) + Number(fields[12])
  assert.ok(rss > 0 && Number.isInteger(cpuTicks), 'relay proc counters unavailable')
  return { rssKiB: rss, cpuTicks }
}

async function sample(kind) {
  const start = performance.now()
  const child = kind === 'node' ? spawn(node, [script], { env }) : spawn(native, [], { env })
  const frames = []
  let output = ''
  let stderr = ''
  let done = false
  let problem
  let onChange = () => {}
  const lines = createInterface({ input: child.stdout })
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    done = true
    resolve({ code, signal })
    onChange()
  }))
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
  child.on('error', err => { problem = err; onChange() })
  child.stdin.on('error', err => { problem = err; onChange() })
  lines.on('line', line => {
    try {
      const frame = { ...JSON.parse(line), at: performance.now() }
      frames.push(frame)
      if (frame.op === 'error') problem = new Error(frame.message)
      if (frame.op === 'data') output += frame.data
    } catch (err) { problem = err }
    onChange()
  })
  function until(predicate) {
    return new Promise((resolve, reject) => {
      function fail() {
        reject(problem ?? new Error(`${kind} missing frame; stderr=${stderr.slice(-400)}`))
      }
      const timer = setTimeout(fail, timeout)
      onChange = () => {
        const value = predicate()
        if (value || problem || done) {
          clearTimeout(timer)
          onChange = () => {}
          if (value && !problem) resolve(value)
          else fail()
        }
      }
      onChange()
    })
  }
  function send(data) { child.stdin.write(JSON.stringify({ op: 'write', data: data + '\r' }) + '\n') }
  try {
    const ready = await until(() => frames[0]?.op === 'ready' && frames[0])
    // The assignment doesn't contain the literal marker, so local PTY echo cannot pass.
    send("PS1='dsh-bench-'\"prompt> \"; unset PROMPT_COMMAND")
    const promptFrame = await until(() => output.includes(prompt) && frames.at(-1))
    const beforeIdle = proc(child.pid)
    await sleep(idleMs)
    const afterIdle = proc(child.pid)
    const commandStart = performance.now()
    send("printf 'dsh-bench-result-%s\\n' '中文'; exit 17")
    const result = await until(() => output.includes(marker) && frames.at(-1))
    const exit = await until(() => frames.find(frame => frame.op === 'exit'))
    assert.equal(exit.code, 17)
    assert.deepEqual(await closed, { code: 0, signal: null })
    return {
      kind, readyMs: ready.at - start, promptMs: promptFrame.at - start,
      commandMs: result.at - commandStart, rssKiB: afterIdle.rssKiB,
      idleCpuTicks: afterIdle.cpuTicks - beforeIdle.cpuTicks,
      cpuTicksAtPrompt: beforeIdle.cpuTicks,
    }
  } finally {
    if (!done) child.kill('SIGKILL')
  }
}

function median(numbers) {
  const s = numbers.toSorted((a, b) => a - b)
  return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2
}

async function main() {
  // Warm common executable/page caches, with a fresh relay and shell for each recorded sample.
  for (const kind of ['node', 'rust']) await sample(kind)
  const samples = []
  for (const kind of roundOrder) samples.push(await sample(kind))
  const medians = Object.fromEntries(['node', 'rust'].map(kind => {
    const group = samples.filter(value => value.kind === kind)
    return [kind, Object.fromEntries(Object.keys(group[0]).filter(k => k !== 'kind')
      .map(k => [k, median(group.map(value => value[k]))]))]
  }))
  const sha256 = p => createHash('sha256').update(readFileSync(p)).digest('hex')
  console.log(JSON.stringify({
    schema: 1, arch: process.arch, node: process.version, idleMs,
    relaySha256: { nodeScript: sha256(script), rust: sha256(native) }, samples, medians,
  }, null, 2))
}

main().catch(err => { console.error(err); process.exitCode = 1 })
