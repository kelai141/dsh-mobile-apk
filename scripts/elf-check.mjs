// elf-check.mjs — 校验快照内 node 的 ELF 架构（防雷点 6：错 ABI 快照装到真机崩溃）
//
// 背景：原实现只接受单个 ELF 文件路径；build-apk 传入 .tar.xz 时读到归档头 → "NOT ELF" 且 exit 0，
// 等于门禁不校验架构（实锤空操作）。改为：读快照内 usr/bin/node 的 ELF e_machine 比对期望 ABI。
//
// 注意（2026-08-26 实锤）：WSL 的 localhost 代理会把噪音行写进 wsl 的 stdout（already-ok / up-to-date），
// execFileSync 捕获 stdout 时这些噪音会污染前导字节。因此把下 20 字节写到 Windows 可见的临时文件，
// 再用 fs.readFileSync 读取——噪音留在 wsl stdout 不入文件。路径换算同 check-third-party.mjs
// （Windows -> /mnt/<drive>/...，build-\13-<abi> 归一化成 build-/13-<abi> 两段）。
//
// 用法：node scripts/elf-check.mjs <snapshot.tar.xz> <arm64|x86_64>
// 退出 0 = 架构匹配；1 = 架构不匹配/缺失/非 ELF（拒绝打包）；2 = 参数错误。
import { readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { wslPath, sh } from './lib/shell.mjs'

const arc = process.argv[2]
const abi = process.argv[3]
if (!arc || !abi) {
  console.error('用法: node scripts/elf-check.mjs <snapshot.tar.xz> <arm64|x86_64>')
  process.exit(2)
}
const expected = { arm64: 0xb7, x86_64: 0x3e }
const want = expected[abi]
if (want === undefined) {
  console.error('  未知 ABI: ' + abi + '（仅支持 arm64/x86_64）')
  process.exit(2)
}

// Windows -> WSL / Linux -> native 路径；临时文件放 .deploy-tmp（可写、可清理），ABI 后缀防并发冲突
const wslArc = wslPath(arc)
const tmpWin = join(dirname(arc), '.elfnode-tmp-' + abi + '-' + process.pid)
const tmpWsl = wslPath(tmpWin)

try {
  // 取 node 头部 20 字节（ELF 头 + e_machine），写文件而非捕获 stdout（Windows 下避开 WSL 噪音；
  //   Linux 下原生 bash 也走同一文件路径，保证两分支一致、结果干净）
  sh(`tar -xOf "${wslArc}" usr/bin/node 2>/dev/null | head -c 20 > "${tmpWsl}"`, { maxBuffer: 96 * 1024 * 1024 })
} catch (e) {
  console.error('  usr/bin/node 提取失败: ' + e.message)
  process.exit(1)
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
const name = machine === 0xb7 ? 'aarch64' : machine === 0x3e ? 'x86_64' : machine === 0x28 ? 'arm' : machine === 0x03 ? 'i386' : '0x' + machine.toString(16)
console.log(`  machine: ${name} | node ELF 校验：期望 ${abi} (0x${want.toString(16)})`)
if (machine !== want) {
  console.error(`  ABI 不匹配：快照 node 实际 0x${machine.toString(16)}（${name}）≠ ${abi}（雷点6：错 ABI 快照）`)
  process.exit(1)
}
