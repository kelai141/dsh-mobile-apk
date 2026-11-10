#!/usr/bin/env node
// check-native-linux-loader.mjs — glibc loader 的**每 ABI 分档校验 + 产物断言**
// （issue #1705；前置链路 #1704 / dsh-bionilux#13）。
//
// 真因（不是「忘了传参数」这一层）
// ------------------------------
// targetSdk >= 29 的 app 进程处于 u:r:untrusted_app，SELinux 只对 apk_data_file 给
// execute_no_trans；app 数据目录是 app_data_file、memfd 是 appdomain_tmpfs，都只有 execute
// 没有 execute_no_trans。于是 exec rootfs 里的 glibc loader 必然 EACCES，且该拒绝被
// dontaudit（logcat 里看不到 AVC）。唯一可执行的位置是 nativeLibraryDir，也就是 APK 的
// lib/<jniAbi>/ —— 只有 jniLibs 能到那里（#1704 的 Gradle 属性 + EngineManager.shellEnv）。
//
// 本脚本补的是**最后一步**，而且这一步不能只写成「把目录传进去」：
//
// ① 两个 ABI 的 loader 是**不同的文件**（AArch64 与 x86-64 ELF）。放错目录或互相拷贝的
//    结果是 ELF 架构不匹配，运行时照样起不来，而且失败点远在设备上。
// ② 本仓的 Gradle **没有** abiFilters / splits：两次构建共用同一个 main 源集，所以
//    「一个 loader 目录里同时放 arm64-v8a/ 与 x86_64/」会让**两个 APK 都携带两种 ABI 的
//    loader**。issue #1705 明写了这条风险。故本脚本的 stage 模式按**单个 ABI**产出目录，
//    每次构建只暴露它自己的那一个子目录 —— 「另一个 ABI 出现在本包 lib/ 下」由产物断言判红。
// ③ 命名有两个维度，极易混：bionilux 资产名用 aarch64/x86_64，APK 的 jniLibs 目录用
//    arm64-v8a/x86_64。bionilux-loader-aarch64.so 必须改名进 arm64-v8a/，不是进 aarch64/。
//
// 判据（三条，都在字节上，不看日志）
// --------------------------------
//   A. 输入档（--source + --abi + --stage）：该 ABI 的 loader 必须在场，且 ELF 是 64 位、
//      e_machine 与目标 ABI 一致。缺失 / 架构不符 / 非 ELF ⇒ 判红（拒绝打包该 ABI）。
//   B. 产物档（--apk）：APK 的 lib/<jniAbi>/libbionilux-loader.so 必须在场、归档内是
//      **stored**（method 0）、ELF e_machine 与 APK 的 ABI 一致。stored 这一条不是洁癖：
//      useLegacyPackaging=true 才让它以普通文件落进 nativeLibraryDir，而 #1704 的承诺正是
//      「设备上 applicationInfo.nativeLibraryDir 里能看到它，且是普通文件」。
//   C. 混入档（--apk）：本包 lib/ 下**不得**出现另一个 ABI 的 libbionilux-loader.so
//      （issue #1705「双 ABI 构建是同一个 gradle 源集」那条警告的机器判据）。
//
// 缺席纪律（与 check-apk-form.mjs / check-snapshot-decode.mjs 同口径）
// ------------------------------------------------------------------
//   · 未给 --apk/--dir、或没有 --source ⇒ **不得当成通过**：打印 SKIP(#n) 并计数，结尾打印
//     SKIP=n，exit 0。
//   · --require（发布链严格档）⇒ 缺席即判红。发布产物必须带 loader，MIUI 上才不 EACCES。
//   · 给了目标却读不到 / 解不开 / 无该条目 ⇒ 判红（拿不到判据不等于判据通过）。
//
// 用法：
//   node scripts/check-native-linux-loader.mjs --source <dir> --abi <arm64|x86_64> --stage <dir>
//   node scripts/check-native-linux-loader.mjs --apk <file> [--abi <arm64|x86_64>]
//   node scripts/check-native-linux-loader.mjs --dir <dir>
//   node scripts/check-native-linux-loader.mjs --require
//   node scripts/check-native-linux-loader.mjs --self-test
// 退出码：0 = 通过（或已计数并打印 SKIP）；1 = 判据不满足（含严格档缺席）；2 = 用法错误。
import fs from 'node:fs'
import path from 'node:path'

/** 发布产物里 loader 的固定文件名（Gradle 只把 lib*.so 当 jniLib 处理，名字不能随便取）。 */
export const LOADER_FILE_NAME = 'libbionilux-loader.so'

/**
 * 本仓 ABI 口径 ⇄ jniLibs 目录名 ⇄ ELF e_machine ⇄ bionilux 资产名后缀。
 *
 * 一张表把 issue #1705 里「两个命名维度」钉死：任何一处写错名字都会让某一行落空，
 * 而不是靠人记得。abi 用本仓既有拼写（arm64 / x86_64，与 elf-check.mjs、快照目录一致）；
 * jni 用 APK 的 lib/ 目录名；asset 用 bionilux Release 的资产后缀。
 */
export const ABI_TABLE = Object.freeze({
  arm64: { jni: 'arm64-v8a', machine: 0xb7, machineName: 'aarch64', asset: 'aarch64' },
  x86_64: { jni: 'x86_64', machine: 0x3e, machineName: 'x86-64', asset: 'x86_64' },
})

const ELF_MAGIC = 0x464c457f
const MACHINES = { 0xb7: 'aarch64', 0x3e: 'x86-64', 0x28: 'arm', 0x03: 'i386' }
const machineNameOf = (machine) => MACHINES[machine] ?? '0x' + Number(machine).toString(16)

/**
 * 读 ELF 头（纯函数）：返回 { magic, elfClass, machine } 或 null（头不足 20 字节）。
 *
 * 只读 20 字节：ELF 头里 e_machine 在偏移 18（小端 u16），elfClass 在偏移 4。
 * 为什么不用现成库：本仓门禁全部零依赖（见 scripts/ 其他 check-*.mjs），这里只需两个字段。
 */
export function readElfHeader(buffer) {
  if (!buffer || buffer.length < 20) return null
  return {
    magic: buffer.readUInt32LE(0),
    elfClass: buffer[4],
    machine: buffer.readUInt16LE(18),
  }
}

/**
 * 纯判据：这份字节是不是 abi 这个架构的 64 位 ELF。
 * 返回 { ok, machine, machineName, why }——why 只在 !ok 时有值（判红文案的唯一来源）。
 */
export function classifyLoaderElf(buffer, abi) {
  const spec = ABI_TABLE[abi]
  if (spec === undefined) return { ok: false, machine: null, machineName: null, why: '未知 ABI: ' + abi }
  const header = readElfHeader(buffer)
  if (header === null) return { ok: false, machine: null, machineName: null, why: '不是 ELF（字节数不足 20）' }
  if (header.magic !== ELF_MAGIC) {
    return { ok: false, machine: null, machineName: null, why: '不是 ELF（magic 0x' + header.magic.toString(16) + '）' }
  }
  const machineName = machineNameOf(header.machine)
  if (header.elfClass !== 2) {
    return { ok: false, machine: header.machine, machineName, why: 'ELF 不是 64 位（class ' + header.elfClass + '）' }
  }
  if (header.machine !== spec.machine) {
    // 「拿另一个 ABI 的 loader 充数」是本脚本最要拦的形态：说清期望与实际。
    return {
      ok: false,
      machine: header.machine,
      machineName,
      why: 'ELF 架构不符：实际 ' + machineName + '（0x' + header.machine.toString(16) + '）'
        + ' ≠ ' + abi + ' 要求的 ' + spec.machineName + '（0x' + spec.machine.toString(16) + '）',
    }
  }
  return { ok: true, machine: header.machine, machineName, why: null }
}

/**
 * 在候选名集合里找该 ABI 的 loader 源文件（纯函数，只看给定名字）。
 *
 * 接受两种命名，因为两个仓的口径不同（见 ABI_TABLE.asset）：
 *   · <jniAbi>/libbionilux-loader.so（APK 侧口径，issue #1705 的「准备目录」写法）
 *   · bionilux-loader-<asset>.so（bionilux Release 资产名，直接下载后不改名也能用）
 * 返回命中的相对路径（/ 分隔）数组。命中多个算歧义：由调用方判红，避免「随便挑一个」。
 */
export function findLoaderSources(names, abi) {
  const spec = ABI_TABLE[abi]
  if (spec === undefined) return []
  const wanted = new Set([
    spec.jni + '/' + LOADER_FILE_NAME,
    'bionilux-loader-' + spec.asset + '.so',
  ])
  return names
    .map((name) => String(name).replace(/\\/g, '/'))
    .filter((name) => wanted.has(name))
}

/**
 * 从候选名集合里**推断**这份 loader 属于哪个 ABI（纯函数）—— 供「调用方没显式给 ABI」时用。
 *
 * 为什么要推断而不是直接报错：三条链的 ABI 拼写与传递点各不相同（见 build-apk-engine.mjs 的
 * LOADER_ABI_ALIASES 注释），而「忘了给 ABI」不应静默降级成「不做分档」——那正是本仓反复
 * 吃亏的「门禁被静默关掉」。但也不该在能唯一判定时硬要人再写一遍：源目录里只出现某一个 ABI
 * 的 loader 时，它属于哪个 ABI 是**字节事实**，不是猜测。
 *
 * 返回 { abi, candidates }：命中恰好一个 ABI 时 abi 有值；两个 ABI 都在场（歧义）或一个都没有
 * 时 abi 为 null，由调用方判红 —— 歧义时任何挑选都可能选错 ABI 的 ELF。
 */
export function detectLoaderAbi(names) {
  const perAbi = {}
  for (const abi of Object.keys(ABI_TABLE)) perAbi[abi] = findLoaderSources(names, abi)
  const hit = Object.keys(perAbi).filter((abi) => perAbi[abi].length > 0)
  return { abi: hit.length === 1 ? hit[0] : null, candidates: perAbi, hit }
}

/**
 * 最小 zip 中央目录解析（纯函数，供 --self-test 与产物档共用）。
 *
 * 只回答「有哪些条目、各自的压缩方法与数据偏移」。本门禁的产物断言只需要 stored 条目
 * （method 0）的原始字节，因此不实现 inflate —— 这条限制反过来**就是**判据的一部分：
 * 若 loader 被 deflate 打包（useLegacyPackaging 失效），它不会以普通文件落进
 * nativeLibraryDir，本函数会如实报出 method，由产物档判红。
 *
 * 返回 { entries: [{ name, method, compressedSize, size, localOffset }] } 或 null（不可解）。
 */
export function readZipCentralDirectory(buffer) {
  if (!buffer || buffer.length < 22) return null
  // EOCD 魔数 0x06054b50；尾部注释最长 65535，故从后往前扫同一窗口。
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const total = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  // Zip64（0xFFFF/0xFFFFFFFF 哨兵）：本仓 APK 远未到 4G，出现即结构异常，交调用方 fail-closed。
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null
  if (cdOffset + cdSize > buffer.length) return null
  const entries = []
  let p = cdOffset
  for (let i = 0; i < total; i += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) return null
    const method = buffer.readUInt16LE(p + 10)
    const compressedSize = buffer.readUInt32LE(p + 20)
    const size = buffer.readUInt32LE(p + 24)
    const nameLen = buffer.readUInt16LE(p + 28)
    const extraLen = buffer.readUInt16LE(p + 30)
    const commentLen = buffer.readUInt16LE(p + 32)
    const localOffset = buffer.readUInt32LE(p + 42)
    if (p + 46 + nameLen > buffer.length) return null
    entries.push({
      name: buffer.toString('utf8', p + 46, p + 46 + nameLen),
      method, compressedSize, size, localOffset,
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries }
}

/**
 * 从 zip 里取某个 stored 条目的原始字节（纯函数）。
 *
 * 非 stored（method !== 0）返回 { ok:false, method } —— 由调用方把它当成判据失败，
 * 而不是在这里悄悄解压：解压成功会让「useLegacyPackaging 失效」这条缺陷隐形。
 */
export function readStoredEntry(buffer, entry) {
  if (entry.method !== 0) return { ok: false, method: entry.method }
  const p = entry.localOffset
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== 0x04034b50) {
    return { ok: false, method: entry.method, why: '本地文件头魔数不符' }
  }
  const nameLen = buffer.readUInt16LE(p + 26)
  const extraLen = buffer.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const end = start + entry.size
  if (end > buffer.length) return { ok: false, method: entry.method, why: '条目数据越界（归档被截断）' }
  return { ok: true, data: buffer.subarray(start, end) }
}

/**
 * 产物断言（纯函数）：给定 APK 的 zip 中央目录 + 它自己的 ABI，回答四件事。
 *
 *   · 该 ABI 的 loader 在场；
 *   · 它是 stored（普通文件落盘的证据）；
 *   · 它的 ELF e_machine 与本 APK 的 ABI 一致；
 *   · 本包 lib/ 下**没有**另一个 ABI 的 loader（#1705 的同源集警告）。
 * entryBytes(entry) 供自测注入（避免为了测判据造一个真 APK）。
 */
export function evaluateApkLoader(entries, abi, entryBytes) {
  const spec = ABI_TABLE[abi]
  if (spec === undefined) return { ok: false, problems: ['未知 ABI: ' + abi], evidence: {} }
  const problems = []
  const evidence = { abi, jniDir: spec.jni }
  const wanted = 'lib/' + spec.jni + '/' + LOADER_FILE_NAME
  const entry = entries.find((e) => e.name === wanted)
  if (entry === undefined) {
    problems.push('APK 内缺 ' + wanted + '（Linux 环境在该设备上仍会 EACCES）')
    evidence.present = false
  } else {
    evidence.present = true
    evidence.method = entry.method
    evidence.size = entry.size
    if (entry.method !== 0) {
      // useLegacyPackaging 失效时 loader 会被压缩：安装后不是 nativeLibraryDir 里的普通文件。
      problems.push(wanted + ' 在归档里是压缩条目（method ' + entry.method
        + '），不是 stored —— useLegacyPackaging = true 未生效，安装后不会是普通文件')
    } else {
      const bytes = entryBytes(entry)
      if (!bytes || !bytes.ok) {
        problems.push(wanted + ' 的数据取不出来：' + ((bytes && bytes.why) || '未知原因'))
      } else {
        const elf = classifyLoaderElf(bytes.data, abi)
        evidence.elf = { machine: elf.machine, machineName: elf.machineName, ok: elf.ok }
        if (!elf.ok) problems.push(wanted + '：' + elf.why)
      }
    }
  }
  // 混入判据：另一个 ABI 的 loader 不得出现在本包 lib/ 下。
  const foreign = []
  for (const other of Object.keys(ABI_TABLE)) {
    if (other === abi) continue
    const otherPath = 'lib/' + ABI_TABLE[other].jni + '/' + LOADER_FILE_NAME
    if (entries.some((e) => e.name === otherPath)) foreign.push(otherPath)
  }
  evidence.foreign = foreign
  if (foreign.length > 0) {
    problems.push('本包 lib/ 下混入另一 ABI 的 loader：' + foreign.join(', ')
      + '（同源集共用 loader 目录，构建时须按 ABI 分档）')
  }
  return { ok: problems.length === 0, problems, evidence }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const USAGE = [
  'usage: node scripts/check-native-linux-loader.mjs [options]',
  '  --source <dir> --abi <arm64|x86_64> --stage <dir>   校验输入档并按单 ABI 产出 loader 目录',
  '  --apk <file> [--abi <arm64|x86_64>]                 校验最终产物的 loader（在场/架构/stored/混入）',
  '  --dir <dir>                                         递归收集目录下的 *.apk 逐个校验',
  '  --require                                           严格档：缺席即判红',
  '  --self-test                                         纯判据离线自检',
].join('\n')

const options = { requires: [] }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--require') options.require = true
  else if (arg === '--self-test') options.selfTest = true
  else if (arg === '--help' || arg === '-h') options.help = true
  else if (arg === '--source') options.source = argv[++i]
  else if (arg === '--stage') options.stage = argv[++i]
  else if (arg === '--abi') options.requires.push(argv[++i])
  else if (arg === '--apk') options.apk = argv[++i]
  else if (arg === '--dir') options.dir = argv[++i]
  else if (options.unknown === undefined) options.unknown = arg
}

let skipTotal = 0
/** 缺席纪律：计数 + 打印合计；严格档当场判红（不得以 SKIP 结案）。 */
const skip = (why) => {
  skipTotal += 1
  console.log('SKIP(#' + skipTotal + ')  ' + why + (options.require ? ' —— --require 档不得 SKIP' : ''))
  if (options.require) {
    console.log('NATIVE-LINUX-LOADER CHECK FAILED：严格档缺席未判定（SKIP=' + skipTotal + '）')
    process.exitCode = 1
    return
  }
  console.log('SKIP=' + skipTotal)
  // 判据行必须是一条**真的结论**：写成 SKIPPED 而不是「未作判定」——后者的语义在
  // check-gate-skips.mjs 里是「零判据结案」，要另外登记 ZERO_CRITERIA_REGISTER；
  // 本门禁缺席时确实声明的是「本次没判」，用 SKIPPED 如实表达，不需要借登记豁免。
  console.log('NATIVE-LINUX-LOADER CHECK SKIPPED（SKIP=' + skipTotal + '；严格档 --require 下这会是红）')
}

/**
 * stage 模式：把源目录里该 ABI 的 loader 落成**只含这一个子目录**的 loader 目录。
 *
 * 为什么必须重造而不是直接把源目录交给 Gradle：本仓 Gradle 没有 abiFilters/splits，
 * 源目录里同时存在 arm64-v8a/ 与 x86_64/ 时两个 APK 都会带上两种 ABI 的 loader。
 * 分档后每个 APK 只暴露自己的那一个（产物档的「混入」判据是这条的机器守卫）。
 */
const stageForAbi = (source, abi, stageDir) => {
  const srcAbs = path.resolve(source)
  if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isDirectory()) {
    console.log('NATIVE-LINUX-LOADER CHECK FAILED：loader 源目录不在场：' + srcAbs
      + '（issue #1705：该目录由操作者/CI 从 bionilux Release 取得，见 docs/AGENTS/LINUX-RUNTIME-CONTRACT.md §7）')
    process.exitCode = 1
    return false
  }
  // 同时认「平铺的资产名」与「jni 目录下的 loader」两种摆法（后者再扫一层）。
  const flat = fs.readdirSync(srcAbs)
  const nested = []
  for (const name of flat) {
    const full = path.join(srcAbs, name)
    if (fs.statSync(full).isDirectory()) {
      for (const inner of fs.readdirSync(full)) nested.push(name + '/' + inner)
    }
  }
  const names = [...flat, ...nested]
  // 调用方没给 ABI：从源目录**推断**。唯一命中才继续；歧义/零命中一律判红（不猜）。
  if (abi === undefined || abi === null) {
    const detected = detectLoaderAbi(names)
    if (detected.abi === null) {
      console.log('NATIVE-LINUX-LOADER CHECK FAILED：无法从源目录判定 ABI'
        + '（命中: ' + (detected.hit.length === 0 ? '无任何 loader'
          : detected.hit.join(' 与 ') + ' 两个 ABI 的 loader 同时在场') + '）：' + srcAbs
        + ' —— 明确给 --abi，或把每个 ABI 的 loader 放进各自的目录')
      process.exitCode = 1
      return false
    }
    abi = detected.abi
    console.log('NATIVE-LINUX-LOADER 推断 ABI: ' + abi + '（源目录只含该 ABI 的 loader）')
  }
  const spec = ABI_TABLE[abi]
  if (spec === undefined) {
    console.error('NATIVE-LINUX-LOADER CHECK 用法错误：未知 ABI ' + abi
      + '（支持: ' + Object.keys(ABI_TABLE).join(', ') + '）')
    process.exitCode = 2
    return false
  }
  const hits = findLoaderSources(names, abi)
  if (hits.length === 0) {
    console.log('NATIVE-LINUX-LOADER CHECK FAILED：源目录里没有 ' + abi + ' 的 loader'
      + '（期望 ' + spec.jni + '/' + LOADER_FILE_NAME + ' 或 bionilux-loader-' + spec.asset + '.so）：' + srcAbs)
    process.exitCode = 1
    return false
  }
  if (hits.length > 1) {
    // 歧义不猜：两个候选同时在场说明两个 ABI 混在一个目录里，此时任何挑选都可能选错。
    console.log('NATIVE-LINUX-LOADER CHECK FAILED：' + abi + ' 的 loader 在源目录里有多个候选（'
      + hits.join(', ') + '）——无法判定用哪一份')
    process.exitCode = 1
    return false
  }
  const hit = hits[0]
  let bytes
  try {
    bytes = fs.readFileSync(path.join(srcAbs, hit))
  } catch (error) {
    console.log('NATIVE-LINUX-LOADER CHECK FAILED：读不到 loader 源文件：' + hit + '（' + error.message + '）')
    process.exitCode = 1
    return false
  }
  const elf = classifyLoaderElf(bytes, abi)
  if (!elf.ok) {
    console.log('NATIVE-LINUX-LOADER CHECK FAILED：' + hit + ' 不是 ' + abi + ' 的 loader —— ' + elf.why)
    process.exitCode = 1
    return false
  }
  // stageDir === null：**只校验输入，不写盘**（两条构建链的独立可复跑门禁点就是这样调的）。
  // 这不是「跳过分档」：真正分档由引擎在出包前用同一份脚本 + 同一组判据完成；
  // 这里只回答「这个源目录里有没有本 ABI 的架构匹配 loader」。
  if (stageDir === null) {
    console.log('NATIVE-LINUX-LOADER 输入档通过: ' + hit + '（' + abi + ' / ' + elf.machineName
      + ' / ' + bytes.length + ' B；未落盘，分档由终端引擎完成）')
    console.log('NATIVE-LINUX-LOADER CHECK PASSED（输入档 ' + abi + '）')
    return true
  }
  const stageAbs = path.resolve(stageDir)
  const target = path.join(stageAbs, spec.jni, LOADER_FILE_NAME)
  fs.rmSync(stageAbs, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
  console.log('NATIVE-LINUX-LOADER stage: ' + hit + ' -> ' + spec.jni + '/' + LOADER_FILE_NAME
    + '（' + abi + ' / ' + elf.machineName + ' / ' + bytes.length + ' B）')
  console.log('NATIVE-LINUX-LOADER CHECK PASSED（stage ' + abi + '；loader 目录 ' + stageAbs
    + ' 仅含 ' + spec.jni + '/，双 ABI 共用源集下也不会串味）')
  return true
}

/** 产物模式：给定 APK 文件与其 ABI，断言 A/B/C 三档。 */
const checkApk = (apkFile, abiHint) => {
  const abs = path.resolve(apkFile)
  if (!fs.existsSync(abs)) {
    console.log('NATIVE-LINUX-LOADER CHECK FAILED：APK 不在场：' + abs)
    return false
  }
  let buffer
  try {
    buffer = fs.readFileSync(abs)
  } catch (error) {
    console.log('NATIVE-LINUX-LOADER CHECK FAILED：读不到 APK：' + abs + '（' + error.message + '）')
    return false
  }
  const zip = readZipCentralDirectory(buffer)
  if (zip === null) {
    console.log('NATIVE-LINUX-LOADER CHECK FAILED：无法解析 APK 的 zip 中央目录：' + abs)
    return false
  }
  const normalized = abs.replace(/\\/g, '/')
  // ABI 缺省时依次尝试：文件名（本仓产物名恒以 -<abi>.apk 结尾，与 build-apk-engine 的
  // artifactName 同源）→ 归档自身 lib/ 下出现的 loader 目录。
  //
  // 第二级是**产物事实**而不是猜测：若 APK 的 lib/ 里只有 arm64-v8a/ 的 loader，那它只能是
  // arm64 包。两级都判不出来才判红（不允许「猜一个 ABI 再判它对不对」——那会把
  // 「装载错架构」判成通过）。
  let abi = abiHint ?? Object.keys(ABI_TABLE).find((name) => normalized.endsWith('-' + name + '.apk'))
  if (abi === undefined) {
    const fromLib = Object.keys(ABI_TABLE).filter((name) => zip.entries.some(
      (e) => e.name === 'lib/' + ABI_TABLE[name].jni + '/' + LOADER_FILE_NAME))
    if (fromLib.length === 1) abi = fromLib[0]
  }
  if (abi === undefined) {
    console.log('NATIVE-LINUX-LOADER CHECK FAILED：无法从文件名或 lib/ 内容判定 ABI，请显式给 --abi：' + abs)
    return false
  }
  const verdict = evaluateApkLoader(zip.entries, abi, (entry) => readStoredEntry(buffer, entry))
  const name = path.basename(abs)
  if (!verdict.ok) {
    for (const problem of verdict.problems) console.log('  FAIL  ' + name + ' [' + abi + '] ' + problem)
    console.log('NATIVE-LINUX-LOADER CHECK FAILED（' + name + ' ' + abi + '，' + verdict.problems.length + ' 项）')
    return false
  }
  const ev = verdict.evidence
  console.log('  OK    ' + name + ' [' + abi + '] lib/' + ev.jniDir + '/' + LOADER_FILE_NAME
    + ' method=' + ev.method + ' size=' + ev.size + ' elf=' + ev.elf.machineName
    + ' foreign=[' + (ev.foreign.join(', ') || 'none') + ']')
  return true
}

/** 收集 *.apk（递归；不跟随符号链接，避免跑出交付目录）。 */
const collectApks = (dir) => {
  const out = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.apk')) out.push(full)
    }
  }
  walk(dir)
  return out.sort()
}

// ── 自测夹具：纯字节，不需要 APK / 不需要 SDK ────────────────────────────────
/** 造一个最小 ELF 头（20 字节足够本门禁的判据）。 */
const makeElf = (machine, elfClass = 2) => {
  const buf = Buffer.alloc(64)
  buf.writeUInt32LE(ELF_MAGIC, 0)
  buf[4] = elfClass
  buf.writeUInt16LE(machine, 18)
  return buf
}

/** 造一个最小 zip（stored 或指定 method），只含给定条目。 */
const makeZip = (files) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8')
    const method = file.method ?? 0
    const payload = method === 0 ? file.data : Buffer.from('deflate-placeholder')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, payload)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + payload.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}

export const SELF_TEST_CASES = [
  // ── classifyLoaderElf：2 正 / 5 负 ──
  { label: '正控：arm64 loader 是 AArch64 ELF', run: () => classifyLoaderElf(makeElf(0xb7), 'arm64').ok === true },
  { label: '正控：x86_64 loader 是 x86-64 ELF', run: () => classifyLoaderElf(makeElf(0x3e), 'x86_64').ok === true },
  {
    label: '负控：arm64 位放了 x86_64 loader 即判红（#1705 两种 ABI 是不同文件）',
    run: () => {
      const r = classifyLoaderElf(makeElf(0x3e), 'arm64')
      return r.ok === false && /架构不符/.test(r.why)
    },
  },
  {
    label: '负控：x86_64 位放了 AArch64 loader 即判红',
    run: () => {
      const r = classifyLoaderElf(makeElf(0xb7), 'x86_64')
      return r.ok === false && /架构不符/.test(r.why)
    },
  },
  { label: '负控：非 ELF 字节判红', run: () => classifyLoaderElf(Buffer.from('not an elf at all, definitely'), 'arm64').ok === false },
  { label: '负控：32 位 ELF 判红（class 1）', run: () => classifyLoaderElf(makeElf(0xb7, 1), 'arm64').ok === false },
  { label: '负控：未知 ABI 判红', run: () => classifyLoaderElf(makeElf(0xb7), 'armv7').ok === false },

  // ── findLoaderSources：两种命名口径（#1705 的「两个命名维度」）2 正 / 2 负 ──
  {
    label: '正控：APK 口径 arm64-v8a/libbionilux-loader.so 被认出',
    run: () => findLoaderSources(['arm64-v8a/libbionilux-loader.so'], 'arm64').length === 1,
  },
  {
    label: '正控：bionilux 资产名 bionilux-loader-aarch64.so 被认成 arm64',
    run: () => findLoaderSources(['bionilux-loader-aarch64.so'], 'arm64').length === 1,
  },
  {
    label: '负控：aarch64/ 不是 jni 目录，不得被认成 arm64 的 APK 口径文件',
    run: () => findLoaderSources(['aarch64/libbionilux-loader.so'], 'arm64').length === 0,
  },
  {
    label: '负控：x86_64 资产名不得被认成 arm64',
    run: () => findLoaderSources(['bionilux-loader-x86_64.so'], 'arm64').length === 0,
  },

  // ── evaluateApkLoader：1 正 / 4 负 ──
  {
    label: '正控：产物带本 ABI loader（stored + 架构正确 + 无混入）',
    run: () => {
      const buf = makeZip([{ name: 'lib/arm64-v8a/libbionilux-loader.so', data: makeElf(0xb7) }])
      const zip = readZipCentralDirectory(buf)
      const v = evaluateApkLoader(zip.entries, 'arm64', (e) => readStoredEntry(buf, e))
      return v.ok === true && v.evidence.present === true && v.evidence.foreign.length === 0
    },
  },
  {
    label: '负控：缺 loader 即判红（MIUI 上仍 EACCES 的形态）',
    run: () => {
      const buf = makeZip([{ name: 'lib/arm64-v8a/libother.so', data: makeElf(0xb7) }])
      const zip = readZipCentralDirectory(buf)
      return evaluateApkLoader(zip.entries, 'arm64', (e) => readStoredEntry(buf, e)).ok === false
    },
  },
  {
    label: '负控：loader 被压缩（useLegacyPackaging 失效）即判红',
    run: () => {
      const buf = makeZip([{ name: 'lib/arm64-v8a/libbionilux-loader.so', data: makeElf(0xb7), method: 8 }])
      const zip = readZipCentralDirectory(buf)
      const v = evaluateApkLoader(zip.entries, 'arm64', (e) => readStoredEntry(buf, e))
      return v.ok === false && v.problems.some((p) => /压缩条目/.test(p))
    },
  },
  {
    label: '负控：本包混入另一 ABI 的 loader 即判红（同源集风险）',
    run: () => {
      const buf = makeZip([
        { name: 'lib/arm64-v8a/libbionilux-loader.so', data: makeElf(0xb7) },
        { name: 'lib/x86_64/libbionilux-loader.so', data: makeElf(0x3e) },
      ])
      const zip = readZipCentralDirectory(buf)
      const v = evaluateApkLoader(zip.entries, 'arm64', (e) => readStoredEntry(buf, e))
      return v.ok === false && v.problems.some((p) => /混入另一 ABI/.test(p))
    },
  },
  {
    label: '负控：loader 的 ELF 架构与 APK 的 ABI 不符即判红',
    run: () => {
      const buf = makeZip([{ name: 'lib/arm64-v8a/libbionilux-loader.so', data: makeElf(0x3e) }])
      const zip = readZipCentralDirectory(buf)
      return evaluateApkLoader(zip.entries, 'arm64', (e) => readStoredEntry(buf, e)).ok === false
    },
  },

  // ── zip 解析器自身的反证（没有它，上面每条负控都可能只是「解析失败」）1 正 / 2 负 ──
  {
    label: '负控：非 zip 字节解析返回 null（不得静默返回空目录）',
    run: () => readZipCentralDirectory(Buffer.from('definitely not a zip archive at all')) === null,
  },
  {
    label: '正控：两个条目的 zip 能被完整枚举',
    run: () => {
      const buf = makeZip([
        { name: 'lib/arm64-v8a/libbionilux-loader.so', data: makeElf(0xb7) },
        { name: 'classes.dex', data: Buffer.from('dex') },
      ])
      const zip = readZipCentralDirectory(buf)
      return zip !== null && zip.entries.length === 2 && zip.entries[1].name === 'classes.dex'
    },
  },
  {
    label: '负控：stored 条目被截断时取字节失败（不是返回半份数据）',
    run: () => {
      const buf = makeZip([{ name: 'lib/arm64-v8a/libbionilux-loader.so', data: makeElf(0xb7) }])
      const zip = readZipCentralDirectory(buf)
      return readStoredEntry(buf.subarray(0, 40), zip.entries[0]).ok === false
    },
  },
]

const runSelfTest = () => {
  const bad = []
  for (const testCase of SELF_TEST_CASES) {
    let passed = false
    try {
      passed = testCase.run() === true
    } catch (error) {
      console.log('  ERR   ' + testCase.label + ': ' + error.message)
    }
    if (!passed) bad.push(testCase.label)
    console.log('  ' + (passed ? 'PASS' : 'FAIL') + '  ' + testCase.label)
  }
  if (bad.length > 0) {
    console.log('NATIVE-LINUX-LOADER SELF-TEST FAILED（' + bad.length + '/' + SELF_TEST_CASES.length + ' 项）')
    process.exitCode = 1
    return
  }
  console.log('NATIVE-LINUX-LOADER SELF-TEST PASSED（' + SELF_TEST_CASES.length
    + ' 项：ELF 架构 2 正 5 负 / 命名口径 2 正 2 负 / 产物判据 1 正 4 负 / zip 解析 1 正 2 负）')
}

if (options.unknown !== undefined) {
  console.error('NATIVE-LINUX-LOADER CHECK 用法错误：未知参数 ' + options.unknown)
  console.error(USAGE)
  process.exitCode = 2
} else if (options.help) {
  console.log(USAGE)
} else if (options.selfTest) {
  runSelfTest()
} else if (options.source !== undefined) {
  // 给了 --stage 才落盘；只给 --source 时是纯输入校验（两条构建链各自的独立可复跑门禁点）。
  // 「不给 --stage」不等于「跳过分档」：真正分档由终端引擎用同一份脚本 + 同一组判据完成。
  const staging = options.stage !== undefined
  const abis = options.requires.length > 0 ? options.requires : [undefined]
  let ok = true
  for (const abi of abis) {
    const stageDir = !staging ? null : (abis.length > 1 ? path.join(options.stage, abi) : options.stage)
    if (!stageForAbi(options.source, abi, stageDir)) ok = false
  }
  if (!ok) process.exitCode = 1
} else if (options.apk !== undefined || options.dir !== undefined) {
  const abiHint = options.requires[0]
  const targets = options.apk !== undefined ? [options.apk] : collectApks(path.resolve(options.dir))
  if (targets.length === 0) {
    skip('--dir ' + options.dir + ' 下没有任何 *.apk，产物 loader 无从判定')
  } else if (abiHint !== undefined && targets.length > 1) {
    console.error('NATIVE-LINUX-LOADER CHECK 用法错误：目录收集必须让每个 APK 自行判定 ABI（不要给单一 --abi）')
    process.exitCode = 2
  } else {
    let ok = true
    for (const file of targets) if (!checkApk(file, abiHint)) ok = false
    if (ok) {
      console.log('NATIVE-LINUX-LOADER CHECK PASSED（' + targets.length
        + ' 个 APK 均带本 ABI 的 stored loader，且无另一 ABI 混入）')
    } else {
      process.exitCode = 1
    }
  }
} else {
  skip('未给出 --apk/--dir，也没有 --source，产物 loader 无从判定')
}
