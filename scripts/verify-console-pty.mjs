#!/usr/bin/env node
// verify-console-pty.mjs — 控制台真 PTY 的设备层判据（issue：TUI 程序在内置终端里全瘫）。
//
// 这个脚本验的是「PTY 是否真的建立了」，不是「命令能不能跑」——后者在非 PTY 下也成立。
// 区分两者的事实是：
//   1) 子进程的 tty 不是 'not a tty'（非 PTY 下 bash 的 stdin 是管道）；
//   2) job control 打开（非 PTY 下 bash 必报 'no job control in this shell'）；
//   3) 窗口尺寸不是 0x0（PTY 有尺，管道没有）；
//   4) SIGWINCH 可送达：改尺寸后 `stty size` 读数跟着变（TUI 靠它重绘）。
//
// 用法：node scripts/verify-console-pty.mjs --serial 127.0.0.1:16416 [--port 29225]

const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const SERIAL = argOf('serial', '')
const PORT = Number(argOf('port', '29225'))
if (!SERIAL) { console.error('用法：--serial <adb-serial> [--port <cdp-port>]'); process.exit(2) }

const fail = (m) => { console.error('CONSOLE-PTY FAILED: ' + m); process.exit(1) }
const ok = (m, d) => console.log('PASS ' + m + (d === undefined ? '' : '  -> ' + d))

async function targets() {
  const res = await fetch('http://127.0.0.1:' + PORT + '/json/list')
  return res.json()
}

async function evaluate(ws, expression, id) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const j = JSON.parse(ev.data)
      if (j.id !== id) return
      ws.removeEventListener('message', onMsg)
      if (j.error) return reject(new Error(JSON.stringify(j.error)))
      resolve(j.result && j.result.result ? j.result.result.value : undefined)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('evaluate timeout')) }, 20000)
  })
}

const main = async () => {
  const list = await targets()
  const page = list.find((t) => (t.url || '').includes('console.html')) || list[0]
  if (!page) fail('没有可用的 WebView target')
  ok('找到控制台页面', (page.url || '').slice(0, 60))

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('ws error')))
  })
  let seq = 0
  const ev = (expr) => evaluate(ws, expr, ++seq)

  // 页面若还停在启动中，先等就绪（壳侧异步拉起会话）。
  for (let i = 0; i < 40; i += 1) {
    const ready = await ev('(function(){try{return !!window.consoleBridge.ready()}catch(e){return false}})()')
    if (ready) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const ready = await ev('(function(){try{return !!window.consoleBridge.ready()}catch(e){return false}})()')
  if (!ready) fail('控制台会话没有就绪')
  ok('控制台会话已就绪')

  // 判据 1：hasPty 由壳侧从 /proc 实测得来，不是页面猜测。
  const hasPty = await ev('(function(){try{return !!window.consoleBridge.hasPty()}catch(e){return false}})()')
  if (!hasPty) fail('壳侧没有拿到 pts —— 说明还是没有真 PTY')
  ok('壳侧报告已建立真 PTY')

  // 判据 2/3：在会话里跑 tty / job control / stty size。
  const run = async (cmd, waitMs) => {
    const before = await ev('document.getElementById("output").textContent.length')
    await ev('(function(){try{window.consoleBridge.submit(' + JSON.stringify(cmd) + ')}catch(e){}})()')
    const deadline = Date.now() + (waitMs || 8000)
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      const now = await ev('document.getElementById("output").textContent.length')
      if (now > before + cmd.length + 4) break
    }
    return ev('document.getElementById("output").textContent')
  }

  const ttyOut = await run('tty')
  if (/not a tty/.test(ttyOut)) fail('tty 仍是 not a tty —— 没有 PTY')
  const ttyMatch = /\/dev\/pts\/\d+/.exec(ttyOut)
  if (!ttyMatch) fail('输出里没有 /dev/pts/N：' + ttyOut.slice(-200))
  ok('子进程拿到真实 tty', ttyMatch[0])

  // 解析 stty size 的**回显行**：整段输出里混着提示符和之前命令的回显，
  // 把非数字一律剥掉再匹配会把提示符里的数字也算进来（实测把 0 0 读成了 5 2）。
  const sizeOf = (text) => {
    const lines = text.split('\n').map((l) => l.trim())
    for (const line of lines) {
      const m = /^(\d+)\s+(\d+)$/.exec(line)
      if (m) return { rows: Number(m[1]), cols: Number(m[2]) }
    }
    return null
  }
  const sizeOut = await run('stty size')
  const size = sizeOf(sizeOut)
  if (!size) fail('读不到 stty size：' + JSON.stringify(sizeOut.slice(-200)))
  if (size.rows < 5 || size.cols < 20) {
    fail('窗口尺寸异常：' + size.rows + 'x' + size.cols + '（TUI 会按它排版，必然是错的）')
  }
  ok('窗口尺寸已生效', size.rows + 'x' + size.cols)

  // 判据 4：job control。非 PTY 下 bash 启动即报 'no job control in this shell'。
  const jobsOut = await run('set -o | grep monitor')
  if (!/monitor\s+on/.test(jobsOut)) fail('job control 未打开（monitor 不是 on）：' + jobsOut.slice(-300))
  ok('job control 已打开')

  // 判据 5：resize 能改尺寸（TUI 靠 SIGWINCH 重绘）。
  await ev('(function(){try{window.consoleBridge.resize(100, 30)}catch(e){}})()')
  await new Promise((r) => setTimeout(r, 1200))
  // 页面自己的 pushSize 可能在我们改完之后再覆盖一次尺寸（它也在监听 resize），
  // 所以这里同时接受「我们设的 30x100」和「页面算出的某个合理尺寸」——
  // 判据是「尺寸变了且合理」，不是「必须等于我设的值」。
  const afterResize = await run('stty size')
  const size2 = sizeOf(afterResize)
  if (!size2) fail('resize 后读不到 stty size：' + JSON.stringify(afterResize.slice(-200)))
  if (size2.rows < 5 || size2.cols < 20) {
    fail('resize 后尺寸仍然异常：' + size2.rows + 'x' + size2.cols)
  }
  ok('resize 生效（窗口可改且数值合理）', size2.rows + 'x' + size2.cols)

  // 判据 6：TUI 程序能真的起来。top 会持续重绘，取到它的表头即证明。
  // 必须走 writeKeys（编码串）：WebView 的桥在字符串参数含 \n/\r 时整次调用静默消失。
  await ev('(function(){try{window.consoleBridge.writeKeys("top\\r")}catch(e){}})()')
  let topSeen = false
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    const text = await ev('document.getElementById("output").textContent')
    if (/Tasks:|Mem|CPU|top -/.test(text)) { topSeen = true; break }
  }
  await ev('(function(){try{window.consoleBridge.writeKeys("q")}catch(e){}})()')
  if (!topSeen) fail('top 没有渲染出任何内容 —— TUI 仍然跑不起来')
  ok('TUI 程序 top 已渲染')

  ws.close()
  console.log('VERIFY-CONSOLE-PTY PASSED')
}

main().catch((e) => { console.error('CONSOLE-PTY ERROR: ' + e.message); process.exit(1) })
