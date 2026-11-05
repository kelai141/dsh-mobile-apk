// console-pty.mjs — 内置控制台的 PTY 中继（由壳侧以子进程方式拉起）。
//
// 为什么需要这个中继：
//   快照里的 script(1) 在 stdin 是管道时只回显、不执行。设备实测三种调用形式
//   （-c / -- / 默认 shell）表现一致：写进去的 "echo X\n" 只会被回显成文本，
//   bash 从不执行它。原因在 util-linux 的 script 对非 tty stdin 的处理——它按 cooked
//   语义收字节，行结束符不构成一次提交。于是「用 script 给 shell 套一个 PTY」这条路
//   在壳侧（ProcessBuilder，stdin 必是管道）根本走不通。
//
//   node-pty 不同：它自己 forkpty，主端由它持有并以字节流方式读写，不依赖 stdin 是 tty。
//   快照已随引擎附带 node-pty（pty.node 为 Android NDK 构建），无需新增依赖。
//
// 协议：本进程的 stdin/stdout 是壳侧的管道，语义是「换行分隔的单行 JSON」。
//   壳侧 -> 中继：{"op":"write","data":"..."}  {"op":"resize","cols":N,"rows":M}  {"op":"kill"}
//   中继 -> 壳侧：{"op":"data","data":"..."}    {"op":"ready","cols":N,"rows":M}  {"op":"exit","code":N}
// 用 JSON 而不是裸字节：控制台的输出里本来就有换行和任意控制字符，裸字节没有帧边界。

import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)

const writeJson = (obj) => {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch {
    // 壳侧已关闭管道：本进程该退了。
    process.exit(0)
  }
}

const main = () => {
  const usr = process.env.DSH_CONSOLE_PREFIX
  const shell = process.env.DSH_CONSOLE_SHELL || (usr ? path.join(usr, 'bin/bash') : null)
  const ptyModule = process.env.DSH_CONSOLE_NODE_PTY
  if (!usr || !shell || !ptyModule) {
    writeJson({ op: 'error', message: 'console-pty: 缺少 DSH_CONSOLE_PREFIX / DSH_CONSOLE_SHELL / DSH_CONSOLE_NODE_PTY' })
    process.exit(2)
  }

  let pty
  try {
    pty = require(ptyModule)
  } catch (e) {
    writeJson({ op: 'error', message: 'console-pty: node-pty 加载失败: ' + (e && e.message) })
    process.exit(3)
  }

  const cols = Number(process.env.DSH_CONSOLE_COLS || 80)
  const rows = Number(process.env.DSH_CONSOLE_ROWS || 24)

  let term
  try {
    term = pty.spawn(shell, ['-i'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME || usr,
      env: process.env,
    })
  } catch (e) {
    writeJson({ op: 'error', message: 'console-pty: spawn 失败: ' + (e && e.message) })
    process.exit(4)
  }

  writeJson({ op: 'ready', pid: term.pid, cols, rows })

  // PTY 输出 -> 壳侧。这里不做任何编码转换：字节原样转成字符串下发，
  // 控制序列由壳侧决定怎么处理（当前是剥离，将来换渲染器时只改壳侧）。
  term.onData((data) => writeJson({ op: 'data', data }))
  term.onExit(({ exitCode }) => {
    writeJson({ op: 'exit', code: Number.isInteger(exitCode) ? exitCode : -1 })
    process.exit(0)
  })

  // 壳侧 -> PTY：按行读，一行一个 JSON。
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.op === 'write') {
        term.write(String(msg.data ?? ''))
      } else if (msg.op === 'resize') {
        const c = Number(msg.cols) || cols
        const r = Number(msg.rows) || rows
        try {
          term.resize(c, r)
        } catch (e) {
          writeJson({ op: 'error', message: 'console-pty: resize 失败: ' + (e && e.message) })
        }
      } else if (msg.op === 'kill') {
        try {
          term.kill()
        } catch {
          // 已经退出的进程再 kill 会抛，忽略即可。
        }
        process.exit(0)
      }
    }
  })

  process.stdin.on('end', () => {
    try {
      term.kill()
    } catch {}
    process.exit(0)
  })
}

main()
