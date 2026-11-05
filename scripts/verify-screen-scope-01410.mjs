#!/usr/bin/env node
// verify-screen-scope-01410.mjs —— 五个 screen-scope 修复的三层验收执行器。
//
// 为什么单独一个脚本：
//   #803 #802 #799 #790 #786 五个 PR 都改 screen-scope 判据，属 L2 安全面，按 AGENTS.md §2
//   必须有代码层 + CDP 层 + ADB 用户层三层证据才能进 main。把 A/B 两组命令与判定放在
//   PR 正文里既不能被执行、也不能在 main 上做负控，所以抽成脚本 + fixture。
//
// 三层怎么分工（重要）：
//   judge  离线：直接 import 本仓 src/screen-scope.ts 的 screenCommandVerdict，断言 41 条判定。
//                这是**判别力自证**——在 main 上跑必须出现 FAIL，否则脚本本身是假绿。
//   bridge 在线：把 A/B 两组命令**经 android_shell 工具下发**，读回执。
//                工具是模型侧的，脚本无法自行调用，故由模型执行后把回执写进 --receipts 文件，
//                本脚本 --layer=bridge 负责校验回执与期望一致。
//   device 真机：--phase=before / --phase=after 两段采集设备事实
//                （截图 sha256 + dumpsys SurfaceFlinger 的虚拟屏 token），
//                after 与 before 比对，证明 A 组跑完真实屏**没有被改**。
//
// 用法：
//   node scripts/verify-screen-scope-01410.mjs --layer=judge
//   node scripts/verify-screen-scope-01410.mjs --layer=bridge --receipts=<json>
//   node scripts/verify-screen-scope-01410.mjs --layer=device --phase=before --serial=<serial>
//   node scripts/verify-screen-scope-01410.mjs --layer=device --phase=after  --serial=<serial>
//
// 公共参数：--fixture= --json= --evidence-dir= --verbose
//
// 退出码（与 verify-screen-scope-matrix.mjs 同约定）：
//   0 全部通过 / 1 有判红（真缺陷）/ 2 前置不满足或证据不足（**不得当作通过**）

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const argv = process.argv.slice(2)
// 同时支持 --key=value 与 --key value 两种写法。
// 实测教训：只支持空格形式时 `--layer=device` 被忽略、静默落回默认 judge 层，
// 输出看起来是绿的那套 41 条，其实根本没采设备证据（2026-10-29 实机踩到）。
const argOf = (n) => {
  const eq = argv.find((a) => a.startsWith('--' + n + '='))
  if (eq !== undefined) return eq.slice(n.length + 3)
  const i = argv.indexOf('--' + n)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (n) => argv.includes('--' + n)

const LAYER = argOf('layer') ?? 'judge'
const PHASE = argOf('phase')
const SERIAL = argOf('serial')
const RECEIPTS = argOf('receipts')
const FIXTURE = argOf('fixture') ?? join(ROOT, 'scripts/fixtures/screen-scope-acceptance-20261029.json')
const VERBOSE = has('verbose')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
// device 层的 before/after 必须落在**同一个**证据目录，否则 after 找不到基线
// （实测：用时间戳目录时 after 报「找不到 before 基线」而退出 2）。
// 故设备层固定为 device-<serial>，其余层仍用时间戳归档。
const SERIAL_SLUG = (argOf('serial') ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_')
const EVID = argOf('evidence-dir')
  ?? (argOf('layer') === 'device'
    ? join(ROOT, '.deploy-tmp', 'screen-scope-01410', 'device-' + SERIAL_SLUG)
    : join(ROOT, '.deploy-tmp', 'screen-scope-01410', STAMP))
const JSON_OUT = argOf('json') ?? join(EVID, 'result-' + LAYER + (PHASE ? '-' + PHASE : '') + '.json')

const SRC_JUDGE = join(ROOT, 'plugins/dsh-android-bridge/src/screen-scope.ts')

function die(code, msg) { console.error('BLOCKED: ' + msg); process.exit(code) }

function loadFixture() {
  if (!existsSync(FIXTURE)) die(2, 'fixture 不存在: ' + FIXTURE)
  const j = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  if (!j.groups?.A?.length || !j.groups?.B?.length) die(2, 'fixture 结构不对：缺 groups.A / groups.B')
  return j
}

// ───────────────────────── judge 层 ─────────────────────────
async function runJudge() {
  if (!existsSync(SRC_JUDGE)) die(2, '判据源不存在: ' + SRC_JUDGE
    + '（judge 层要求仓库内有未编译的 TS 源；Node >= 22.6 的类型剥离可直读）')
  let mod
  try {
    mod = await import(pathToFileURL(SRC_JUDGE).href)
  } catch (e) {
    die(2, '导入判据源失败（需要 Node 支持 .ts 类型剥离）: ' + e.message)
  }
  if (typeof mod.screenCommandVerdict !== 'function') {
    die(2, '判据源未导出 screenCommandVerdict')
  }
  const verdict = mod.screenCommandVerdict
  const fx = loadFixture()
  const rows = []
  for (const [group, cases] of Object.entries(fx.groups)) {
    for (const c of cases) {
      const owned = new Set(c.ownedTargets ?? [])
      const got = verdict(c.command, (raw) => owned.has(String(raw)))
      const exact = got === c.expect
      const clsOk = (c.expectClass === 'allow') === (got === 'allow')
      const pass = exact && clsOk
      rows.push({
        group, caseId: c.caseId, name: c.name, command: c.command,
        expect: c.expect, expectClass: c.expectClass, got, pass,
        baselineVerdictOnMain: c.baselineVerdictOnMain,
        failReason: pass ? null : (exact ? '类别不符' : '期望 ' + c.expect + ' 实得 ' + got),
      })
    }
  }
  return summarize(rows, { layer: 'judge', judgeSource: SRC_JUDGE })
}

// ───────────────────────── bridge 层 ─────────────────────────
// 工具是模型侧的，脚本不能自己下发。约定回执文件格式：
//   { "receipts": [ { "caseId": "S-23a", "verdict": "deny-unparsed", "raw": "..." } ] }
function runBridge() {
  if (!RECEIPTS) die(2, '--layer=bridge 需要 --receipts=<json>：由模型经 android_shell 下发后写入回执')
  if (!existsSync(RECEIPTS)) die(2, '回执文件不存在: ' + RECEIPTS)
  const rec = JSON.parse(readFileSync(RECEIPTS, 'utf8'))
  const byId = new Map((rec.receipts ?? []).map((r) => [r.caseId, r]))
  const fx = loadFixture()
  const rows = []
  for (const [group, cases] of Object.entries(fx.groups)) {
    for (const c of cases) {
      const r = byId.get(c.caseId)
      if (!r) {
        rows.push({
          group, caseId: c.caseId, name: c.name, command: c.command,
          expect: c.expect, expectClass: c.expectClass, got: null, pass: false,
          baselineVerdictOnMain: c.baselineVerdictOnMain,
          failReason: '回执缺失（该条未真正下发）',
        })
        continue
      }
      const got = String(r.verdict ?? '')
      const exact = got === c.expect
      const clsOk = (c.expectClass === 'allow') === (got === 'allow')
      const pass = exact && clsOk
      rows.push({
        group, caseId: c.caseId, name: c.name, command: c.command,
        expect: c.expect, expectClass: c.expectClass, got, pass, raw: r.raw ?? null,
        baselineVerdictOnMain: c.baselineVerdictOnMain,
        failReason: pass ? null : (exact ? '类别不符' : '期望 ' + c.expect + ' 实得 ' + got),
      })
    }
  }
  return summarize(rows, { layer: 'bridge', receipts: RECEIPTS })
}

// ───────────────────────── device 层 ─────────────────────────
function adb(args, serial) {
  const full = serial ? ['-s', serial, ...args] : args
  const p = spawnSync('adb', full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (p.error) return { ok: false, stderr: String(p.error.message) }
  return { ok: p.status === 0, stdout: p.stdout ?? '', stderr: p.stderr ?? '', status: p.status }
}

async function captureDeviceEvidence(serial) {
  mkdirSync(EVID, { recursive: true })
  const probe = adb(['shell', 'echo dsh-adb-ok'], serial)
  if (!probe.ok) die(2, 'adb 不可用（serial=' + (serial ?? '默认') + '）: ' + (probe.stderr || probe.stdout || '').trim())

  // 1) dumpsys SurfaceFlinger：抽虚拟屏 token（复用门禁同源解析器）
  const sf = adb(['shell', 'dumpsys SurfaceFlinger'], serial)
  if (!sf.ok) die(2, 'dumpsys SurfaceFlinger 失败: ' + (sf.stderr || '').trim())
  const sfPath = join(EVID, 'sf-' + (PHASE ?? 'x') + '.txt')
  writeFileSync(sfPath, sf.stdout, 'utf8')

  let tokens = null
  if (existsSync(SRC_JUDGE)) {
    try {
      const mod = await import(pathToFileURL(SRC_JUDGE).href)
      if (typeof mod.screenTokensFromSfDump === 'function') tokens = mod.screenTokensFromSfDump(sf.stdout)
    } catch { /* 解析器不可用时降级为正则兜底 */ }
  }
  if (tokens === null) {
    tokens = [...sf.stdout.matchAll(/name="([^"]+)"[^\n]*?(\d{15,})/g)].map((m) => ({ alias: m[1], token: m[2] }))
  }

  // 2) 截图 sha256（真实屏像素指纹）
  const shot = adb(['exec-out', 'screencap', '-p'], serial)
  let shotSha = null
  if (shot.ok && shot.stdout) {
    // exec-out 在 Windows 上可能被换行改写，故用 base64 走一遍再解码算哈希，避免误报
    const b64 = adb(['exec-out', 'screencap -p | base64'], serial)
    if (b64.ok && b64.stdout) {
      const buf = Buffer.from(b64.stdout.replace(/\s+/g, ''), 'base64')
      shotSha = createHash('sha256').update(buf).digest('hex')
      writeFileSync(join(EVID, 'screencap-' + (PHASE ?? 'x') + '.b64'), b64.stdout, 'utf8')
    }
  }
  if (shotSha === null) die(2, '截图采集失败，无法作为证据')

  const snap = { phase: PHASE ?? 'x', serial: serial ?? null, sfPath, tokens, screencapSha256: shotSha }
  const snapPath = join(EVID, 'snapshot-' + (PHASE ?? 'x') + '.json')
  writeFileSync(snapPath, JSON.stringify(snap, null, 2) + '\n', 'utf8')
  return { snap, snapPath }
}

async function runDevice() {
  if (!PHASE) die(2, '--layer=device 需要 --phase=before|after')
  if (!['before', 'after'].includes(PHASE)) die(2, '--phase 只能是 before 或 after')
  const { snap, snapPath } = await captureDeviceEvidence(SERIAL)

  if (PHASE === 'before') {
    writeFileSync(JSON_OUT, JSON.stringify({
      layer: 'device', phase: 'before', ok: true,
      snapshot: snap, evidence: [snapPath, snap.sfPath],
      note: '基线已采集。现在由模型经 android_shell 下发 A 组 25 条（期望全 deny），再跑 --phase=after。',
    }, null, 2) + '\n', 'utf8')
    console.log('device/before 基线: ' + snapPath)
    console.log('  虚拟屏 token 数: ' + snap.tokens.length)
    console.log('  截图 sha256: ' + snap.screencapSha256)
    return 0
  }

  // after：与 before 比对
  const beforePath = join(EVID, 'snapshot-before.json')
  if (!existsSync(beforePath)) die(2, '找不到 before 基线（' + beforePath + '）：after 必须与同一次验收的 before 比对')
  const before = JSON.parse(readFileSync(beforePath, 'utf8'))
  const tokKey = (t) => t.alias + '|' + t.token
  const bSet = new Set((before.tokens ?? []).map(tokKey))
  const aSet = new Set((snap.tokens ?? []).map(tokKey))
  const lost = [...bSet].filter((x) => !aSet.has(x))
  const gained = [...aSet].filter((x) => !bSet.has(x))
  const shotSame = before.screencapSha256 === snap.screencapSha256

  const checks = [
    {
      id: 'D1', name: '验收期间真实屏像素未变（截图 sha256 相同）',
      pass: shotSame,
      evidence: [before.sfPath, snap.sfPath, join(EVID, 'screencap-before.b64'), join(EVID, 'screencap-after.b64')],
      detail: shotSame ? '一致' : 'before=' + before.screencapSha256 + ' after=' + snap.screencapSha256,
    },
    {
      id: 'D2', name: '验收期间虚拟屏 token 集合未变（未新增/未丢失）',
      pass: lost.length === 0 && gained.length === 0,
      evidence: [before.sfPath, snap.sfPath],
      detail: lost.length === 0 && gained.length === 0
        ? 'token 集合一致（' + aSet.size + ' 个）'
        : '丢失 ' + lost.length + ' / 新增 ' + gained.length,
    },
  ]
  const ok = checks.every((c) => c.pass)
  writeFileSync(JSON_OUT, JSON.stringify({
    layer: 'device', phase: 'after', ok,
    before: beforePath, after: snapPath, checks,
    tokenDelta: { lost, gained },
    betweenPhases: argOf('between') ?? '未声明（用 --between 记录两次采样之间实际执行了什么）',
  }, null, 2) + '\n', 'utf8')
  for (const c of checks) console.log((c.pass ? '  PASS  ' : '  FAIL  ') + c.id + ' ' + c.name + ' :: ' + c.detail)
  return ok ? 0 : 1
}

// ───────────────────────── 汇总 ─────────────────────────
function summarize(rows, meta) {
  const total = rows.length
  const pass = rows.filter((r) => r.pass).length
  const fail = total - pass
  const groupOf = (g) => {
    const rs = rows.filter((r) => r.group === g)
    return { total: rs.length, pass: rs.filter((r) => r.pass).length, fail: rs.filter((r) => !r.pass).length }
  }
  const result = {
    layer: meta.layer,
    ...meta,
    stamp: STAMP,
    ok: fail === 0,
    summary: { total, pass, fail, A: groupOf('A'), B: groupOf('B') },
    rows,
  }
  mkdirSync(dirname(JSON_OUT), { recursive: true })
  writeFileSync(JSON_OUT, JSON.stringify(result, null, 2) + '\n', 'utf8')

  console.log('== verify-screen-scope-01410 / layer=' + meta.layer + ' ==')
  console.log('  A 组（必须拦下）: ' + result.summary.A.pass + '/' + result.summary.A.total + ' 通过')
  console.log('  B 组（必须放行）: ' + result.summary.B.pass + '/' + result.summary.B.total + ' 通过')
  console.log('  合计: ' + pass + '/' + total + ' 通过, ' + fail + ' 未通过')

  // 判别力自证：A 组里「修前判定 !== 期望」的条数就是这套用例真正在验的东西。
  // 为 0 说明用例没在验任何新行为，脚本本身是假绿。
  const disc = rows.filter((r) => r.group === 'A' && r.baselineVerdictOnMain !== undefined
    && r.baselineVerdictOnMain !== r.expect)
  const discFail = disc.filter((r) => !r.pass)
  const ctrl = rows.filter((r) => r.group === 'A' && r.baselineVerdictOnMain === r.expect)
  result.discrimination = {
    discriminatingCases: disc.length,
    failingOnThisTree: discFail.length,
    controlCases: ctrl.length,
    note: discFail.length > 0
      ? '本树 A 组有 ' + discFail.length + ' 条未拦下 => 说明修复未生效（在 main 上这是预期结果）'
      : '本树 A 组 ' + disc.length + ' 条判别性用例全部拦下',
  }
  writeFileSync(JSON_OUT, JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log('  判别力: A 组 ' + disc.length + ' 条为「修前≠期望」的判别性用例，本树上未拦下 ' + discFail.length + ' 条'
    + '（另有 ' + ctrl.length + ' 条修前修后都拒的对照）')
  if (fail > 0) {
    console.log('')
    console.log('  --- 未通过明细 ---')
    for (const r of rows.filter((x) => !x.pass)) {
      console.log('  ' + r.group + ' ' + r.caseId + ' :: ' + r.failReason)
      console.log('      cmd: ' + JSON.stringify(r.command))
    }
  }
  if (VERBOSE) {
    console.log('')
    for (const r of rows) console.log('  ' + (r.pass ? 'PASS' : 'FAIL') + '  ' + r.group + ' ' + r.caseId + ' -> ' + r.got)
  }
  console.log('')
  console.log('  机器可读结果: ' + JSON_OUT)
  return fail === 0 ? 0 : 1
}

// ───────────────────────── 入口 ─────────────────────────
let code
if (LAYER === 'judge') code = await runJudge()
else if (LAYER === 'bridge') code = runBridge()
else if (LAYER === 'device') code = await runDevice()
else die(2, '--layer 只能是 judge | bridge | device')
process.exit(code)
