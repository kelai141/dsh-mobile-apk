#!/usr/bin/env node
// verify-console-terminal-env.mjs — 内置控制台的终端环境判据（issue：内置终端跑不了 TUI）。
//
// 契约（见 ConsoleTerminalEnv / ConsoleAnsiStripper 注释）：
//   控制台子进程必须拿到 TERM + TERMINFO + VIMRUNTIME 三件套。「只补 TERM」不够：
//   设备实测里只给 TERM 会把报错从 "TERM environment variable not set." 换成
//   "terminals database is inaccessible"，TUI 仍然进不去。
//
// 判定的是**设备事实**（不读 UI、不信壳侧自述）：
//   1) 快照里 terminfo 目录存在且 xterm 系条目齐全；
//   2) 三件套的取值指向真实存在的路径（不是造出来的）；
//   3) 反证：去掉 TERMINFO 后 termux-change-repo 必须重新报 inaccessible ——
//      若这一条不成立，说明判据测的不是 TERMINFO 的作用，整份结论作废。
//
// 为什么探测代码写成「推脚本再执行」而不是 adb shell sh -c ...：
//   adb shell 把命令拼成一个字符串交给设备端 shell，sh -c 的引号在拼接中丢失，
//   管道与重定向会跑到 run-as 外面（实测：裸 find 扫了整个应用目录、计数虚高；
//   反证段则什么都没执行，于是「反证失败」是脚本缺陷而不是产品事实）。
//   推脚本文件是唯一不依赖引号转义的写法。
//
// 用法：node scripts/verify-console-terminal-env.mjs --serial 127.0.0.1:16416

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] ?? def) : def }
const SERIAL = argOf('serial', '')
const PKG = argOf('pkg', 'com.dsharnessmobile.shell')
if (!SERIAL) { console.error('用法：--serial <adb-serial>'); process.exit(2) }

const fail = (m) => { console.error('CONSOLE-TERMINAL-ENV FAILED: ' + m); process.exit(1) }
const ok = (m, d) => console.log('PASS ' + m + (d === undefined ? '' : '  -> ' + d))

const adb = (args) => spawnSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8' })
const runas = (args) => spawnSync('adb', ['-s', SERIAL, 'shell', 'run-as', PKG, ...args], { encoding: 'utf8' })

// 快照刷新期间禁跑设备判据：此时文件树正在被换掉，读到的都是过渡态（假失败源头）。
const marker = runas(['cat', 'files/.snapshot-transaction'])
if ((marker.status ?? 1) === 0 && (marker.stdout || '').trim() !== '') {
  fail('快照事务仍在进行（.snapshot-transaction 存在），此刻不可做设备判据；等刷新完成后重跑')
}

const probeLines = [
  '#!/system/bin/sh',
  'PREFIX="$(pwd)/files/usr"',
  // run-as 起的是裸 sh，没有 Termux 的登录环境。缺 LD_LIBRARY_PATH 时快照里的 ELF
  // 直接 CANNOT LINK EXECUTABLE（libandroid-support.so not found），bash 根本没起来——
  // 那样「三件套齐备时不报错」是假通过（实测踩到：它其实连 bash 都没跑）。
  // 这三个变量与 EngineManager.shellEnv 同源，探测必须带上才有判据意义。
  'export LD_LIBRARY_PATH="$PREFIX/lib"',
  'export PATH="$PREFIX/bin:/system/bin"',
  'export TMPDIR="$(pwd)/files/home/tmp"; mkdir -p "$TMPDIR"',
  'export LD_PRELOAD="$PREFIX/lib/libtermux-exec-ld-preload.so"',
  'echo "PREFIX=$PREFIX"',
  'echo "== terminfo =="',
  'if [ -f "$PREFIX/share/terminfo/x/xterm-256color" ]; then echo "terminfo_xterm=present"; else echo "terminfo_xterm=MISSING"; fi',
  'n=$(find "$PREFIX/share/terminfo" -type f 2>/dev/null | wc -l)',
  'echo "terminfo_files=$n"',
  'echo "== vim =="',
  'VIMRUN=""',
  'for d in "$PREFIX"/share/vim/vim[0-9]*; do [ -d "$d" ] && VIMRUN="$d"; done',
  'echo "vimruntime=${VIMRUN:-MISSING}"',
  'echo "== A: 三件套齐备 =="',
  'TERM=xterm-256color TERMINFO="$PREFIX/share/terminfo" VIMRUNTIME="$VIMRUN" "$PREFIX/bin/termux-change-repo" </dev/null 2>&1 | head -c 300',
  'echo ""',
  'echo "== B: 反证：去掉 TERMINFO =="',
  'TERM=xterm-256color env -u TERMINFO "$PREFIX/bin/termux-change-repo" </dev/null 2>&1 | head -c 300',
  'echo ""',
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'dsh-console-env-'))
const local = join(dir, 'probe.sh')
writeFileSync(local, probeLines, 'utf8')
const remote = '/data/local/tmp/dsh-console-env-probe.sh'
const push = adb(['push', local, remote])
if ((push.status ?? 1) !== 0) fail('无法推送探测脚本：' + (push.stderr || ''))
adb(['shell', 'chmod', '644', remote])

const out = runas(['/system/bin/sh', remote])
const text = (out.stdout || '') + (out.stderr || '')
adb(['shell', 'rm', '-f', remote])
if (!text.includes('PREFIX=')) fail('探测脚本没有产出（run-as 执行失败）：' + JSON.stringify(text.slice(0, 300)))

if (!text.includes('terminfo_xterm=present')) fail('快照里缺 share/terminfo/x/xterm-256color；没有它 TUI 一律起不来')
ok('terminfo 条目存在', 'x/xterm-256color')

const files = /terminfo_files=(\d+)/.exec(text)
const count = files ? parseInt(files[1], 10) : NaN
if (!Number.isFinite(count) || count <= 0) fail('terminfo 目录为空或不可读：' + JSON.stringify(text.slice(0, 300)))
ok('terminfo 条目可枚举', count + ' 条')

const vim = /vimruntime=(.*)/.exec(text)
const vimPath = vim && vim[1] ? vim[1].trim() : ''
if (!/\/vim[0-9]+$/.test(vimPath)) {
  fail('share/vim 下没有 vim<NN> 目录（拿到 ' + JSON.stringify(vimPath) + '）；vim 会报 E1187: Failed to source defaults.vim')
}
ok('终端环境取值可解析', 'TERM=xterm-256color VIMRUNTIME=' + vimPath)

const sectionA = text.split('== A: 三件套齐备 ==')[1] || ''
const aBody = sectionA.split('== B: 反证')[0] || ''
// 假通过防线：链接失败 / 命令不存在都会让输出为空或只剩加载器报错，那不是"能跑"。
if (aBody.includes('CANNOT LINK EXECUTABLE')) fail('探测环境缺 LD_LIBRARY_PATH，bash 没起来；这次的 PASS 不作数')
if (aBody.includes('not found')) fail('探测环境里命令没找到；输出不是 TUI 程序的真实反应')
if (aBody.includes('terminals database is inaccessible')) fail('三件套齐备时仍报 inaccessible；判据与设备事实不符')
if (aBody.includes('TERM environment variable not set')) fail('三件套齐备时仍报 TERM 未设；判据与设备事实不符')
if (aBody.trim() === '') fail('三件套齐备时没有任何输出；探测没有真正执行')
ok('三件套齐备时不再报缺 TERM / inaccessible')

const sectionB = text.split('== B: 反证：去掉 TERMINFO ==')[1] || ''
if (process.env.DSH_VERIFY_DEBUG) console.log('--- RAW ---\n' + text + '\n--- B ---\n' + JSON.stringify(sectionB))
if (!sectionB.includes('terminals database is inaccessible')) {
  fail('反证失败：去掉 TERMINFO 后没有重新报 inaccessible，说明 TERMINFO 不是本判据的关键')
}
ok('反证成立：去掉 TERMINFO 立刻回到 inaccessible')

console.log('VERIFY-CONSOLE-TERMINAL-ENV PASSED')
