// elf-check.mjs — ELF 架构校验（防雷点 6：错 ABI 快照装到真机崩溃），双模式：
//
// 门禁模式（主链用）：node elf-check.mjs <snapshot.tar.xz> <arm64|x86_64>
//   读快照内 usr/bin/node 的 ELF e_machine 比对期望 ABI。
//   退出 0 = 架构匹配；1 = 架构不匹配/缺失/非 ELF（拒绝打包）；2 = 参数错误。
//
// 遗留模式（build-release.ps1 用）：node elf-check.mjs <单个 ELF 文件>
//   直接读文件打印 machine 名称（输出含 aarch64/x86_64 供 -match 断言）；
//   非 ELF 打印 NOT ELF 且退出 0（与 0.13.0 原始行为一致——build-release 自行判输出）。
//
// 注意（2026-08-26 实锤）：WSL 的 localhost 代理会把噪音行写进 wsl 的 stdout（already-ok / up-to-date），
// 捕获 stdout 时噪音会污染前导字节。门禁模式因此把头 20 字节写到宿主可见临时文件再读——
// 噪音留在 wsl stdout 不入文件。路径换算统一走 lib/shell.mjs（Windows -> /mnt/<drive>/...，
// 原生 Linux 透传），同一份脚本双仓（协调仓/apk 仓）与双环境（本地/云端）通用。
import { readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { wslPath, sh } from './lib/shell.mjs'

const MACHINES = { 0xb7: 'aarch64', 0x3e: 'x86_64', 0x28: 'arm', 0x03: 'i386' }
const EXPECT = { arm64: 0xb7, x86_64: 0x3e }

// ── 遗留单文件模式：只有 1 个参数且不是 .tar.xz 归档 ──
const target = process.argv[2]
const abi = process.argv[3]
if (target && !abi && !target.endsWith('.tar.xz')) {
  let buf
  try {
    buf = readFileSync(target)
  } catch {
    console.log('  NOT ELF')
    process.exit(0)
  }
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x464c457f) {
    console.log('  NOT ELF')
    process.exit(0)
  }
  const elfClass = buf[4] // 1=32bit 2=64bit
  const machine = buf.readUInt16LE(18)
  console.log(`  machine: ${MACHINES[machine] ?? '0x' + machine.toString(16)} | elf${elfClass === 2 ? '64' : '32'}`)
  process.exit(0)
}

if (!target || !abi) {
  console.error('用法: node scripts/elf-check.mjs <snapshot.tar.xz> <arm64|x86_64>   （门禁模式）')
  console.error('      node scripts/elf-check.mjs <单个ELF文件>                      （遗留模式）')
  process.exit(2)
}
const want = EXPECT[abi]
if (want === undefined) {
  console.error('  未知 ABI: ' + abi + '（仅支持 arm64/x86_64）')
  process.exit(2)
}

// Windows -> WSL / Linux -> native 路径；临时文件放归档同目录（可写、可清理），ABI 后缀防并发冲突
const wslArc = wslPath(target)
const tmpWin = join(dirname(target), '.elfnode-tmp-' + abi + '-' + process.pid)
const tmpWsl = wslPath(tmpWin)
// 全量落盘的中间文件：见下方注释，不能用「tar | head」管道。
const fullWin = join(dirname(target), '.elfnode-full-' + abi + '-' + process.pid)
const fullWsl = wslPath(fullWin)

try {
  // 取 node 头部 20 字节（ELF 头 + e_machine），写文件而非捕获 stdout（避开 WSL 噪音）；
  //   Linux 下原生 bash 走同一文件路径，两分支一致、结果干净。
  //
  // 为什么分两步、不写成 `tar -xOf … | head -c 20`（issue #1182）：
  //   `sh()` 自 #1121 起给整行加 `set -o pipefail`（那是为 #1074 修的，必须保留）。
  //   `head -c 20` 读够 20 字节就关闭管道，上游 tar 立刻收到 SIGPIPE 并以 141 退出，
  //   pipefail 于是把「消费者提前退出」当成失败 —— 这不是归档有问题，是管道语义。
  //   改成「先全量落盘，再截断」：两步各自独立取退出码，不依赖 pipefail 的行为，
  //   也不必给这一行单独关 pipefail（那会让真正的 tar 失败重新变得不可见）。
  //   代价是一次全量解压（node 约 100MB），换来判据语义正确。
  sh(`tar -xOf "${wslArc}" usr/bin/node 2>/dev/null > "${fullWsl}"`, { maxBuffer: 96 * 1024 * 1024 })
  sh(`head -c 20 "${fullWsl}" > "${tmpWsl}"`)
} catch (e) {
  console.error('  usr/bin/node 提取失败: ' + e.message)
  process.exit(1)
} finally {
  try { rmSync(fullWin, { force: true }) } catch { /* 忽略清理失败 */ }
}

let buf
try {
  buf = readFileSync(tmpWin)
} catch (e) {
  console.error('  usr/bin/node 提取失败（读临时文件）: ' + e.message)
  process.exit(1)
} finally {
  try { rmSync(tmpWin, { force: true }) } catch { /* 忽略清理失败 */ }
}

if (!buf || buf.length < 4 || buf.readUInt32LE(0) !== 0x464c457f) {
  console.error(`  NOT ELF (usr/bin/node 缺失或非 ELF 二进制, got ${buf ? buf.length + ' bytes' : 'nothing'})`)
  process.exit(1)
}
if (buf.length < 20) {
  console.error('  NOT ELF (头不足 20 字节，无法读 e_machine)')
  process.exit(1)
}

const machine = buf.readUInt16LE(18)
const name = MACHINES[machine] ?? '0x' + machine.toString(16)
console.log(`  machine: ${name} | node ELF 校验：期望 ${abi} (0x${want.toString(16)})`)
if (machine !== want) {
  console.error(`  ABI 不匹配：快照 node 实际 0x${machine.toString(16)}（${name}）≠ ${abi}（雷点6：错 ABI 快照）`)
  process.exit(1)
}
