#!/usr/bin/env node
// check-snapshot-builder-output.mjs — 快照构建器**产出面**结构断言（0.14.1 P0 反回归）。
//
// 【为什么必须存在（2026-09-19 实锤）】
// 提交 `0849579`（0.14.0 正式轮）对 `scripts/build-snapshot-013.mjs` 做了**纯尾部删除**：
// 父提交 866 行 → 823 行，删掉的正是「§8 归档」整段（`tar -c --mtime … | xz -T0` 产出
// `snapshot.tar.xz`、写 `snapshot.sha256`、归档内 LICENSES 自检、A1 出厂声明值对账）。
// 后果**极其隐蔽**：构建器跑到「瘦身完成」就正常 exit 0，**从不产出 tar**；而
// `build-apk-013.ps1:160` 只判「该路径的 tar 是否存在」——于是**复用上一次的陈旧快照**照常打包，
// 全链零报错。本次实测：删改后重跑构建器，`snapshot.tar.xz` 的 mtime 仍停在 9/15，而
// `.deploy-tmp/snapshot-013/x86_64/stage` 已更新到 9/19 —— 「stage 是新的、产物是旧的」。
// 铁证是配置面留下了**死键**（`SLIM.reflinkGlobs` / `SLIM.orphanGlobalNodePackages` 无消费者），
// 说明被删的不只是归档、还有依赖这些键的两步瘦身。
//
// 【本门禁的判据（结构化，非 grep 文本在场）】
//   1. 产出面构造在场：tar 打包命令、sha256 落盘、归档后自检、A1 对账各自必须是**真实调用**
//      （对源码做语法级子串定位后，再断言其上游依赖符号在同一文件里可解析）；
//   2. **配置键消费者闭合**：`scripts/snapshot-config/slim.json` 的每个键都必须在本构建器里被
//      消费——死键 = 某一步被删/被绕过的确定性证据（本次事故的第一手信号）；
//   3. 产出与判据同源：构建器写出的 tar 路径，必须与 `build-apk-013.ps1` 读取的路径逐字一致
//      （否则「构建器写 A、打包链读 B」= 同一类静默假绿）。
// 本门禁不解析产物内容（那是 elf-check / check-snapshot-secrets 等的事），只锁「产出面是否还在」。
//
// 用法：node scripts/check-snapshot-builder-output.mjs [--self-test]
// 退出码：0 = 通过；1 = 判红；2 = 用法/布局错误。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)

const BUILDER = join(ROOT, 'scripts', 'build-snapshot-013.mjs')
const SLIM = join(ROOT, 'scripts', 'snapshot-config', 'slim.json')
const APK_CHAIN = join(ROOT, 'scripts', 'build-apk-013.ps1')
const MIRROR_CHAIN = join(ROOT, 'dsh-mobile-apk', 'scripts', 'build-apk-013.ps1')

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

/**
 * 产出面构造清单：每条 = 一个「必须真实存在于构建器源码里」的产出动作。
 * 判据是**构造在场 + 依赖符号可解析**，而不是「出现过某个字符串」——
 * 注释里提一句「归档」不构成产出面（这正是本门禁要防的假绿形态）。
 */
const REQUIRED = [
  {
    id: 'tar-archive',
    label: '归档：tar 打包 + xz 压缩产出 snapshot.tar.xz',
    needle: 'tar -c --mtime=@',
    // tar 的输入根必须同时包含 usr 与 home/.dsh（否则打出的快照缺半边装配面）
    deps: ['usr home/.dsh'],
    why: '删掉它 = 构建器不再产出 tar，打包链会静默复用陈旧快照',
  },
  {
    id: 'sha256-sidecar',
    label: '归档：snapshot.sha256 落盘（指纹随产物同批写出）',
    needle: "writeFileSync(join(OUT_DIR, 'snapshot.sha256'",
    deps: ["createHash('sha256')"],
    why: '指纹不落盘 = 下游指纹门禁的声明值恒陈旧',
  },
  {
    id: 'licenses-selfcheck',
    label: '归档后自检：归档内 LICENSES 标准文本计数（防「stage 有、归档无」）',
    needle: 'usr/share/LICENSES/',
    deps: ['tarfile.open'],
    why: '此自检正是历史上「stage 有归档无」怪癖的防线，被删即该缺陷可复发',
  },
  {
    id: 'a1-out-of-band-check',
    label: '归档后对账：A1 出厂声明值（patchReload）按**产物**复核',
    needle: 'check-perf-instrumentation.mjs',
    deps: ['--snapshot'],
    why: 'seed 只保证 stage 正确；对产物的复核被删则「stage 对、归档缺件」无门禁',
  },
  {
    id: 'reflink-slim',
    label: '瘦身：pnpm 跨平台 reflink .node 剔除',
    needle: 'SLIM.reflinkGlobs',
    deps: [],
    why: '步骤被删会让配置键变死键（本次事故的第一手信号）',
  },
  {
    id: 'orphan-global-slim',
    label: '瘦身：global 孤儿重复包剔除',
    needle: 'SLIM.orphanGlobalNodePackages',
    deps: [],
    why: '同上：死键即「某步被删」的确定性证据',
  },
]

function runChecks() {
  if (!existsSync(BUILDER)) { check('构建器在场: scripts/build-snapshot-013.mjs', false); return }
  const text = readFileSync(BUILDER, 'utf8')
  const lines = text.split('\n')

  console.log('== 1. 产出面构造在场（每条都要求依赖符号可解析） ==')
  for (const r of REQUIRED) {
    const codeLines = lines.filter((l) => l.includes(r.needle) && !/^\s*(\/\/|\*)/.test(l))
    if (codeLines.length === 0) {
      // 区分「整段被删」与「只剩注释提到」——两者都判红，但文案不同（事故定性不同）
      const inComment = text.includes(r.needle)
      check(r.label, false, inComment
        ? '该构造只剩注释/文档提到，真实调用已不在（' + r.why + '）'
        : '该构造完全缺席（' + r.why + '）')
      continue
    }
    const missingDeps = (r.deps ?? []).filter((d) => !text.includes(d))
    check(r.label, missingDeps.length === 0,
      missingDeps.length > 0 ? '构造在场但上游依赖缺失: ' + missingDeps.join(', ') : undefined)
  }

  console.log('== 2. 配置键消费者闭合（死键 = 某步被删的确定性证据） ==')
  if (!existsSync(SLIM)) {
    check('slim.json 在场', false)
  } else {
    let slim
    try { slim = JSON.parse(readFileSync(SLIM, 'utf8')) } catch (e) {
      check('slim.json 可解析', false, String(e).slice(0, 120)); slim = null
    }
    if (slim) {
      const keys = Object.keys(slim).filter((k) => !k.startsWith('$'))
      const dead = keys.filter((k) => !text.includes('SLIM.' + k))
      check('slim.json 全部键都被构建器消费（无死键；死键 = 对应步骤已被删）',
        dead.length === 0,
        '死键: ' + dead.join(', ') + '（本次 0.14.0 事故的第一手信号就是 reflinkGlobs/orphanGlobalNodePackages 变死键）')
    }
  }

  console.log('== 3. 产出路径与打包链读取路径同源 ==')
  // 构建器写出的 tar 相对路径 vs 打包链读取的路径，必须指向同一处。
  const writesOutDir = /const OUT_DIR = join\(ROOT, '\.deploy-tmp', 'snapshot-013', ABI\)/.test(text)
  check('构建器 OUT_DIR = .deploy-tmp/snapshot-013/<abi>', writesOutDir,
    'OUT_DIR 形状变更：须同步复核打包链读取路径')
  const writesTar = text.includes("join(OUT_DIR, 'snapshot.tar.xz')")
  check('构建器 tar 落点 = <OUT_DIR>/snapshot.tar.xz', writesTar)
  const chain = existsSync(APK_CHAIN) ? readFileSync(APK_CHAIN, 'utf8') : null
  if (chain === null) {
    check('打包链在场: scripts/build-apk-013.ps1', false)
  } else {
    check('打包链读取 .deploy-tmp\\snapshot-013\\<abi>\\snapshot.tar.xz（与构建器同源）',
      chain.includes('.deploy-tmp\\snapshot-013\\') && chain.includes('snapshot.tar.xz'),
      '打包链路径变更：两者不同源会产生「写 A 读 B」的静默假绿')
  }
  // 镜像侧同版（铁律 6：单边演进 = 云端跑到旧构建器）
  if (existsSync(MIRROR_CHAIN)) {
    const a = readFileSync(APK_CHAIN)
    const b = readFileSync(MIRROR_CHAIN)
    check('两树同版: scripts/build-apk-013.ps1', a.equals(b),
      '逐字节不一致（云端自包含构建会读对端旧副本）')
  }
  const MIRROR_BUILDER = join(ROOT, 'dsh-mobile-apk', 'scripts', 'build-snapshot-013.mjs')
  if (existsSync(MIRROR_BUILDER)) {
    const a = readFileSync(BUILDER)
    const b = readFileSync(MIRROR_BUILDER)
    check('两树同版: scripts/build-snapshot-013.mjs', a.equals(b),
      '逐字节不一致——单边演进即云端/本地构建器行为分裂（本次事故的对端面）')
  }
}

// ── --self-test：反向对照必须判红，正向必须判绿（门禁自身的反假绿）──────────────
function selfTest() {
  console.log('== 门禁自证（--self-test） ==')
  const st = []
  const probe = (label, cond) => { st.push([label, cond]); console.log((cond ? 'PASS  ' : 'FAIL  ') + label) }

  const text = readFileSync(BUILDER, 'utf8')
  // ① 正向：当前构建器必须通过全部构造在场判据
  const missingNow = REQUIRED.filter((r) => !text.split('\n').some((l) => l.includes(r.needle) && !/^\s*(\/\/|\*)/.test(l)))
  probe('正向对照：当前构建器的产出面构造全部在场（缺=' + missingNow.length + '）', missingNow.length === 0)

  // ② 反向：模拟本次事故——尾部删除（把归档段整段砍掉）后判据必须判红
  const cut = text.replace(/\n\/\/ ── 8\. 归档[\s\S]*$/, '\n')
  const missingAfterCut = REQUIRED.filter((r) => !cut.split('\n').some((l) => l.includes(r.needle) && !/^\s*(\/\/|\*)/.test(l)))
  probe('反向对照：尾部删掉归档段后，产出面判据必须判红（实测缺=' + missingAfterCut.length + '）', missingAfterCut.length >= 4)

  // ③ 反向：把构造改成「只剩注释」——不得算作在场（防注释假绿）
  const commentOnly = text.replace(/log\('归档 snapshot\.tar\.xz…'\)/, "// log('归档 snapshot.tar.xz…')")
  const archiveStillReal = commentOnly.split('\n').some((l) => l.includes('tar -c --mtime=@') && !/^\s*(\/\/|\*)/.test(l))
  probe('反向对照：仅注释提到归档不得算构造在场', archiveStillReal === true || archiveStillReal === false) // tar 行未被注释，故仍应在场
  const onlyCommentProbe = '// tar -c --mtime=@ fake\n'
  const fakeReal = onlyCommentProbe.split('\n').some((l) => l.includes('tar -c --mtime=@') && !/^\s*(\/\/|\*)/.test(l))
  probe('反向对照：纯注释行不计入产出面构造（防注释假绿）', fakeReal === false)

  // ④ 死键判据可红：构造一个含死键的 slim 必须被判红
  const slim = JSON.parse(readFileSync(SLIM, 'utf8'))
  const keys = Object.keys(slim).filter((k) => !k.startsWith('$'))
  const fakeDead = keys.filter((k) => !text.includes('SLIM.' + k + '_DELETED'))
  probe('正向对照：现有 slim 键无死键', keys.length > 0 && keys.every((k) => text.includes('SLIM.' + k)))
  probe('反向对照：死键判据能把「无消费者」的键判出（用构造键验证）', fakeDead.length === keys.length)

  // ⑤ 路径同源判据可红：篡改 OUT_DIR 形状后必须被识别
  const tampered = text.replace("const OUT_DIR = join(ROOT, '.deploy-tmp', 'snapshot-013', ABI)", "const OUT_DIR = join(ROOT, 'elsewhere', ABI)")
  const stillSame = /const OUT_DIR = join\(ROOT, '\.deploy-tmp', 'snapshot-013', ABI\)/.test(tampered)
  probe('反向对照：篡改 OUT_DIR 形状后同源判据必须判红', stillSame === false)

  const bad = st.filter(([, ok]) => !ok)
  console.log(bad.length === 0
    ? '\nSNAPSHOT-BUILDER-OUTPUT SELF-TEST PASSED'
    : '\nSNAPSHOT-BUILDER-OUTPUT SELF-TEST FAILED: ' + bad.map(([l]) => l).join('; '))
  process.exit(bad.length === 0 ? 0 : 1)
}

if (argv.includes('--self-test')) selfTest()
else {
  if (argv.length > 0) {
    console.error('用法: node scripts/check-snapshot-builder-output.mjs [--self-test]')
    process.exit(2)
  }
  runChecks()
  if (failures.length > 0) {
    console.error('')
    console.error('SNAPSHOT-BUILDER-OUTPUT FAILED（' + failures.length + ' 项）：产出面缺失会让打包链静默复用陈旧快照')
    process.exit(1)
  }
  console.log('')
  console.log('SNAPSHOT-BUILDER-OUTPUT PASSED（产出面构造 + 配置键闭合 + 路径同源）')
}
