#!/usr/bin/env node
// check-browser-syntax-floor.mjs — 浏览器语法下限门禁（0.14.1 块C / 详档 G-1，docs/0.14.1-preview-LEGACY-AND-PERF.md §2.2、§5.2）
//
// 背景（A 档产物级实证）：已发布快照的浏览器面产物里，dsh-web-frontend 入口 chunk 含 ES2022 的
// 「类静态初始化块」static{}（Chromium 94+ 才有），WebView < 94 解析期抛 SyntaxError → 入口模块一行不执行
// → 纯白无线索。此前 27 个 check-*.mjs 没有任何一条校验「发往浏览器的 bundle 语法下限」。
//
// 本门禁两条正交判据（缺一即假绿）：
//   判据 1（结构断言，真实解析器）：TypeScript AST（ScriptTarget.ESNext + ScriptKind.JS）断言
//     ClassStaticBlockDeclaration 计数 == 0 且 parseDiagnostics.length === 0。AST 天然免疫
//     字符串/模板/注释载荷（词法阶段即区分），并给出 行:列 + 字节偏移 定位。
//   判据 2（真实降级差分）：对同一份原始字节跑两个 arm：--target=esnext（A）与 --target=chrome87（B）。
//     A != B ⇒ 该产物携带「esbuild 的 chrome87 口径需要降级、但当前构建未降级」的语法。
//   清单（两条判据共用，防口径分裂）：dsh-web-frontend/dist/**/*.js 的全部 + 每一个 lib/client.js
//     （含 home/.dsh/profiles/** 下的镜像副本），不是只有入口 chunk，也不是只有 dsh-client-ui-* 前缀。
//
// 严格禁止（详档 §2.2 / §5.2，已实测证伪）：
//   - 任何 grep / readFileSync().includes() 形式的语法判断：对 4 类载荷全部误报，且在真实产物上
//     把 documentpreview 的 1 处真语法多报成 2 处（另一处落在 StringLiteral 内）。
//   - 用「二次降级逐字节相同」当 anti-no-op 判据：该不变量**不成立**（实测 documentpreview 二遍输出
//     差 144 B，来自 /* @__PURE__ */ 注解重排）。判绿一律用「降级后双 arm 差分归零」+ AST 复扫。
//   本文件全篇不含任何文本在场式语法判断；载荷对照在 --self-test 里用 4 用例自证。
//
// 口径边界（必须如实标注，不得声称已满足 Chromium 87）：判据 2 的效力完全取决于 esbuild 的兼容表，
// 该表**不是 MDN 支持表**——实测 esbuild 在 chrome87 下降 optional-chain / class-static-blocks /
// 若干 RegExp 特性，但**不降** nullish-coalescing（Chromium 80）/ logical-assignment（85）/ 类字段 /
// 私有成员 / 对象展开。因此「差分归零」只证明「不低于 esbuild 的 chrome87 口径」。
//
// 依赖（非协调仓已声明依赖，必须显式定位并固定版本，不得依赖偶然在场）：
//   - typescript：从固定的候选路径解析（plugins/*/node_modules 先于 node_modules），缺席即报错退出 2。
//   - esbuild：同上；且版本必须等于 ESBUILD_PIN（兼容表决定判据口径，漂移即口径漂移）→ 不等退出 2。
//
// 用法：
//   node scripts/check-browser-syntax-floor.mjs --scan <stageRoot|tar.xz>   # 门禁主模式（构建后/发布前）
//   node scripts/check-browser-syntax-floor.mjs --degrade --stage <dir>     # 构建期降级（原地，chrome87）
//   node scripts/check-browser-syntax-floor.mjs --degrade <file> --out <file>  # 单文件降级（实验/对照）
//   node scripts/check-browser-syntax-floor.mjs --self-test                 # 自包含四向自证（可离线跑）
//   node scripts/check-browser-syntax-floor.mjs --self-test --as-shipped <stageRoot|tar.xz>
//                                                                          # 追加「对真实出厂产物」的反向对照
//   node scripts/check-browser-syntax-floor.mjs --scan <path> --json        # 机器可读输出
// 退出码：0 = 通过；1 = 判红（存在违规）；2 = 用法/工具链/清单口径错误（无法判定，绝不静默跳过）。
//
// 已实测的预期读数（详档 §1.4 / §5.2，可复算）：
//   对 release/v0.14.0-preview/snapshot/snapshot-arm64.tar.xz 的 96 个浏览器面文件：
//     反向对照 → 判红：AST 报 2 个违规文件（index-DuF6ti6g.js 2 处、sidebar-documentpreview/lib/client.js 1 处），
//                      双 arm 差分报 64 个命中文件；
//     正向对照 → 全绿：96/96 用 --target=chrome87 降级后，AST 0 违规、双 arm 差分逐字节归零；
//     载荷对照 → 字符串/模板串/注释内的同类文本一律不触发（4 用例，判据 1 天然满足，判据 2 实测无差）。
//
// ⚠️ 双份构建脚本（协调仓 + apk 仓云端副本）必须同改，禁止单边演进（AGENTS.md 雷点 10）。
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SELF = fileURLToPath(import.meta.url)
const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const argOf = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? (argv[i + 1] ?? d) : d }

// ── 语法下限（口径 = Android 10 / Chromium 87，唯一在案老内核 87.0.4280.101）──────────
//
// 目标取 `chrome87`，不是 `es2021`。曾有一版改成 es2021，理由是「esbuild 在 chrome87 下不降类字段，
// 而类字段是 ES2022 ⇒ 87 会 SyntaxError」。**那个推论是错的**：esbuild 不降类字段，是因为
// Chromium 87 本来就支持类字段（public 自 Chrome 72、private 自 Chrome 74），不是因为漏降。
// 真正会让老内核白屏的只有 `ClassStaticBlockDeclaration`（Chrome 94 起），而 chrome87 目标会降它。
// 改成 es2021 的结果是把 87 原生支持的语法也降了，白付体积（实测 +1,390,213 B）。
//
// 但纯 `chrome87` 也不对：esbuild 的兼容表认为可选链 `?.` 需要 **Chrome 92**，实测阈值就在 92
// （chrome91 降、chrome92 不降）——而 `?.` 自 **Chrome 80** 起就支持（与 `??` 同批）。
// 于是纯 chrome87 会把满地的 `?.` 展开成 `(_a = x) == null ? void 0 : _a.cursor`，实测反而比 es2021
// 还大 6,817 B（+1,397,030 vs +1,390,213）。这是 esbuild 表偏保守，不是 87 缺能力。
//
// 故：target 仍钉 chrome87，只把 esbuild 判错的那一项按真实支持面声明回去。
// **覆盖面严格限定为「esbuild 说 87 不支持、但 87 确实支持」的特性**；凡是 87 真不支持的
// （如 class-static-block / Chrome 94）一律不许出现在这张表里——那会把判据整体放宽。
const TARGET_LOW = 'chrome87'
const TARGET_HIGH = 'esnext'    // 对照臂（当前出厂口径）
/**
 * 对 esbuild 兼容表的**逐项纠偏**：只登记「esbuild 认为 TARGET_LOW 不支持、但真实 Chromium 87 支持」
 * 的特性。三个入口（--degrade / --scan / --self-test）**必须共用这一份**——只改降级不改扫描，
 * 门禁会把自己降完的产物判成「携带未降级语法」，两边互相打架。
 *
 * 每一条都必须给出可复核的依据（真机起始版本 + 实测阈值），不接受「实测如此」这种不可核的说法。
 */
const TARGET_SUPPORTED = Object.freeze({
  // 可选链 `?.`：Chrome 80 起支持（与 `??` 同批发布）。
  //   复核方式：`echo 'const a = o?.x' | esbuild --target=chrome<N>`，看输出里有没有 `void 0`。
  //   实测 esbuild 0.25.12 的阈值：chrome91 降（出现 `void 0`）、chrome92 不降 ⇒ 表里记的是 92。
  //   真实支持版本是 80，故 92 > 87 > 80，对 87 这一档属于表偏保守，纠偏不降低判据强度。
  'optional-chain': true,
})
/** 把 supported 纠偏并进任意 esbuild transform 选项——**唯一**允许的构造方式。 */
const withTarget = (target, extra = {}) => ({ ...extra, loader: extra.loader ?? 'js', logLevel: 'silent', target, supported: TARGET_SUPPORTED })
const ESBUILD_PIN = '0.25.12'   // 判据 2 的口径锁：兼容表随版本变，故显式钉住
/**
 * 供应器（provisionEsbuild）**只认这里钉住的字节**（issue #1581）。
 *
 * 真因：旧实现拿 npm registry 响应里的 `dist.sha512`（或 `dist.integrity`）去校验**同一次响应**
 * 指过来的 tgz——哈希与产物同源，投毒/被劫持的镜像可以同时伪造两者，这条校验等于自证。
 * 更糟的是 `if (sha && …)`：两个字段都缺席时连这条自证都跳过，直接解包并**执行**
 * （esbuildUsable 里 spawnSync 一个 require(下载来的包) 的子进程），而 ESBUILD_PIN 只钉版本字符串。
 * 本门禁的产物决定「浏览器语法下限」的判据口径 ⇒ 投毒者既能让坏 bundle 过门禁，也能让好 bundle 判红。
 *
 * 修法：sha512（base64，与 npm `dist.integrity` 的 `sha512-` 后缀同格式）作为常量进仓，
 * 只认这里的值；表里没有的包名或摘要不匹配一律 die，registry 说什么都不作数。
 * 追版 esbuild 时必须**同批**改 ESBUILD_PIN 与本表（改法：`npm view <pkg>@<ver> dist.integrity`）。
 */
const ESBUILD_TARBALL_SHA512 = {
  esbuild: 'bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg==',
  '@esbuild/darwin-arm64': 'N3zl+lxHCifgIlcMUP5016ESkeQjLj/959RxxNYIthIg+CQHInujFuXeWbWMgnTo4cp5XVHqFPmpyu9J65C1Yg==',
  '@esbuild/darwin-x64': 'HQ9ka4Kx21qHXwtlTUVbKJOAnmG1ipXhdWTmNXiPzPfWKpXqASVcWdnf2bnL73wgjNrFXAa3yYvBSd9pzfEIpA==',
  '@esbuild/linux-arm': 'lPDGyC1JPDou8kGcywY0YILzWlhhnRjdof3UlcoqYmS9El818LLfJJc3PXXgZHrHCAKs/Z2SeZtDJr5MrkxtOw==',
  '@esbuild/linux-arm64': '8bwX7a8FghIgrupcxb4aUmYDLp8pX06rGh5HqDT7bB+8Rdells6mHvrFHHW2JAOPZUbnjUpKTLg6ECyzvas2AQ==',
  '@esbuild/linux-ia32': '0y9KrdVnbMM2/vG8KfU0byhUN+EFCny9+8g202gYqSSVMonbsCfLjUO+rCci7pM0WBEtz+oK/PIwHkzxkyharA==',
  '@esbuild/linux-x64': 'uqZMTLr/zR/ed4jIGnwSLkaHmPjOjJvnm6TVVitAa08SLS9Z0VM8wIRx7gWbJB5/J54YuIMInDquWyYvQLZkgw==',
  '@esbuild/win32-arm64': 'rMmLrur64A7+DKlnSuwqUdRKyd3UE7oPJZmnljqEptesKM8wx9J8gx5u0+9Pq0fQQW8vqeKebwNXdfOyP+8Bsg==',
  '@esbuild/win32-ia32': 'HkqnmmBoCbCwxUKKNPBixiWDGCpQGVsrQfJoVGYLPT41XWF8lHuE5N6WhVia2n4o5QK5M4tYr21827fNhi4byQ==',
  '@esbuild/win32-x64': 'alJC0uCZpTFrSL0CCDjcgleBXPnCrEAhTBILpeAp7M/OFgoqtAetfBzX0xM00MUsVVPpVjlPuMbREqnZCXaTnA==',
}
/**
 * 供应器字节绑定的判据本体（纯函数，便于 --self-test 直接喂合成输入）。
 *
 * @param name npm 包名。
 * @param buf  下载到的 tgz 字节。
 * @param pins 钉住的摘要表（自检可传合成表，正式链恒为 ESBUILD_TARBALL_SHA512）。
 * @returns null = 与钉住的字节一致；否则为判红理由（缺钉 / 摘要不符）。
 */
const tarballPinProblem = (name, buf, pins = ESBUILD_TARBALL_SHA512) => {
  const pinned = pins[name]
  if (typeof pinned !== 'string' || pinned.length === 0) {
    return 'esbuild 供应器：' + name + '@' + ESBUILD_PIN + ' 没有钉住的 sha512 —— 拒绝解包未锚定的第三方字节'
      + '（registry 给的 dist.sha512/integrity 与 tarball 同源，不能自证）'
  }
  const actual = createHash('sha512').update(buf).digest('base64')
  if (actual !== pinned) {
    return 'esbuild 供应器：' + name + '@' + ESBUILD_PIN + ' 的 sha512 与钉住值不符（实际 ' + actual
      + '，钉住 ' + pinned + '）——镜像被投毒或版本漂移，拒绝解包与执行'
  }
  return null
}

/* ── esbuild 字节锚（issue #1581）────────────────────────────────────────────────
 * 缺陷形态：provisionEsbuild() 从 npm 镜像链拉元数据与 tgz，用 dist.sha512（或 dist.integrity）
 * 校验刚下下来的 tarball。**那个 sha512 来自同一个 registry 响应** —— 被投毒/被劫持的镜像可以
 * 同时伪造 tarball 与哈希，这条「自证」对镜像投毒零判别力；而 `if (sha && …)` 还意味着两个字段
 * 都缺席时连这条自证也跳过，直接解包。随后 esbuildUsable() 直接 spawnSync 执行它，而 ESBUILD_PIN
 * 只钉版本字符串、不钉字节。
 *
 * 修法：把 esbuild 与各平台包的 sha512 作为常量钉进仓库（与 scripts/vendor-provenance.json 同型：
 * 能换，但必须显式、可见）。哈希缺席即 die()，不再回落到「响应里给什么就信什么」。
 * 钉住值取自 npm 官方 registry 的 dist.integrity（SRI 形态 sha512-<base64>，此处只存 base64 段），
 * 与仓内 package-lock.json 里 plugins/dsh-android-bridge 的 node_modules/esbuild 条目一致。
 */
const ESBUILD_SHA512 = {
  'esbuild': 'bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg==',
  '@esbuild/win32-x64': 'alJC0uCZpTFrSL0CCDjcgleBXPnCrEAhTBILpeAp7M/OFgoqtAetfBzX0xM00MUsVVPpVjlPuMbREqnZCXaTnA==',
  '@esbuild/win32-arm64': 'rMmLrur64A7+DKlnSuwqUdRKyd3UE7oPJZmnljqEptesKM8wx9J8gx5u0+9Pq0fQQW8vqeKebwNXdfOyP+8Bsg==',
  '@esbuild/linux-x64': 'uqZMTLr/zR/ed4jIGnwSLkaHmPjOjJvnm6TVVitAa08SLS9Z0VM8wIRx7gWbJB5/J54YuIMInDquWyYvQLZkgw==',
  '@esbuild/linux-arm64': '8bwX7a8FghIgrupcxb4aUmYDLp8pX06rGh5HqDT7bB+8Rdells6mHvrFHHW2JAOPZUbnjUpKTLg6ECyzvas2AQ==',
  '@esbuild/darwin-x64': 'HQ9ka4Kx21qHXwtlTUVbKJOAnmG1ipXhdWTmNXiPzPfWKpXqASVcWdnf2bnL73wgjNrFXAa3yYvBSd9pzfEIpA==',
  '@esbuild/darwin-arm64': 'N3zl+lxHCifgIlcMUP5016ESkeQjLj/959RxxNYIthIg+CQHInujFuXeWbWMgnTo4cp5XVHqFPmpyu9J65C1Yg==',
}
/**
 * 远端字节的**唯一**接受条件：与钉住值逐字节相符（issue #1581）。
 * 响应里的 dist.sha512 / dist.integrity 一律不再作为接受依据 —— 它们与 tarball 同源，投毒方可同时伪造。
 * 钉住值缺席（未登记的平台包）→ 判红并给出补登记指引，不得回落到「响应里给什么就信什么」。
 * @param {string} name 包名（含 scope）。
 * @param {Buffer} bytes 下载到的 tarball 字节。
 * @returns {string|null} 判红文案；相符返回 null。
 */
const pinnedDigestProblem = (name, bytes) => {
  const want = ESBUILD_SHA512[name]
  if (typeof want !== 'string' || want.length === 0) {
    return 'esbuild 包 ' + name + ' 没有钉住的 sha512（scripts/check-browser-syntax-floor.mjs 的 ESBUILD_SHA512）'
      + ' —— 拒绝接受未锚定的远端字节；请先在 PR 里登记该平台包的 dist.integrity'
  }
  const got = createHash('sha512').update(bytes).digest('base64')
  if (got !== want) return 'esbuild 包 ' + name + ' 的 sha512 与钉住值不符（got ' + got.slice(0, 16) + '… want ' + want.slice(0, 16) + '…）'
  return null
}

// 显式、固定顺序的依赖候选（不依赖偶然在场；缺席时给出可诊断错误）
const TS_CANDIDATES = [
  'plugins/dsh-android-bridge/node_modules/typescript',
  'plugins/dsh-android-browser/node_modules/typescript',
  'plugins/dsh-android-vdisplay/node_modules/typescript',
  'dsh-client-ui-responsive/node_modules/typescript',
  'dsh-shell-termux/node_modules/typescript',
  'node_modules/typescript',
]
const ESBUILD_CANDIDATES = [
  'plugins/dsh-android-bridge/node_modules/esbuild',
  'plugins/dsh-android-vdisplay/node_modules/esbuild',
  'dsh-client-ui-responsive/node_modules/esbuild',
  'node_modules/esbuild',
]

const failures = []
const notes = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
const die = (msg, code = 2) => { console.error('CHECK-BROWSER-SYNTAX-FLOOR 无法判定（exit ' + code + '）：' + msg); process.exit(code) }

// ── 工具链显式定位 ──────────────────────────────────────────────────────────
const resolveTypeScript = () => {
  for (const rel of TS_CANDIDATES) {
    const dir = join(ROOT, rel)
    const main = join(dir, 'lib', 'typescript.js')
    const pkg = join(dir, 'package.json')
    if (existsSync(main) && existsSync(pkg)) {
      return { rel, dir, main, version: JSON.parse(readFileSync(pkg, 'utf8')).version }
    }
  }
  return null
}
const resolveEsbuild = () => {
  for (const rel of ESBUILD_CANDIDATES) {
    const dir = join(ROOT, rel)
    const main = join(dir, 'lib', 'main.js')
    const pkg = join(dir, 'package.json')
    if (existsSync(main) && existsSync(pkg)) {
      const version = JSON.parse(readFileSync(pkg, 'utf8')).version
      // 平台可用的那一个才算命中：快照构建在 WSL/Linux 内跑（build-snapshot-013.mjs:30-44 自执行进 WSL），
      // 而仓内 node_modules 只有 @esbuild/win32-x64 时，直接 import 会抛
      // 「You installed esbuild for another platform」——必须在选择阶段就按平台过滤，否则是踩坑而不是命中。
      // A usable but stale parser must not mask the fixed-version provisioner below.
      if (version === ESBUILD_PIN && esbuildUsable(main, version)) return { rel, dir, main, version }
    }
  }
  return null
}
/** 按**固定版本 + 本平台**准备 esbuild（npm 拉取到缓存放，显式、可复现、不入仓）。 */
const provisionDest = () => {
  const key = `esbuild-${ESBUILD_PIN}-${process.platform}-${process.arch}`
  // WSL/Linux 侧落到 Linux 原生缓存（HOME 在 ext4），避免把 node_modules 装到 /mnt/d（9p 小文件极慢）。
  if (process.platform === 'linux' && process.env.HOME) {
    const base = process.env.XDG_CACHE_HOME || join(process.env.HOME, '.cache')
    return join(base, 'dsh-browser-syntax-floor', key)
  }
  return join(ROOT, '.deploy-tmp', 'browser-syntax-floor', key)
}
const provisionEsbuild = async () => {
  const dest = provisionDest()
  const main = join(dest, 'node_modules', 'esbuild', 'lib', 'main.js')
  const pkg = join(dest, 'node_modules', 'esbuild', 'package.json')
  if (existsSync(main) && existsSync(pkg)) {
    const version = JSON.parse(readFileSync(pkg, 'utf8')).version
    if (version === ESBUILD_PIN && esbuildUsable(main, version)) return { rel: 'provisioned/' + process.platform + '-' + process.arch, dir: join(dest, 'node_modules', 'esbuild'), main, version }
    rmSync(dest, { recursive: true, force: true })
  }
  const platformPkg = process.platform === 'win32' ? '@esbuild/win32-' + process.arch
    : process.platform === 'linux' ? '@esbuild/linux-' + process.arch
      : process.platform === 'darwin' ? '@esbuild/darwin-' + process.arch : null
  if (!platformPkg) die('无 esbuild 平台包映射：' + process.platform + '/' + process.arch
    + '。请用 --esbuild <node_modules/esbuild/lib/main.js> 显式指定一个本平台可用的 esbuild@' + ESBUILD_PIN + '。')
  let mirrors = ['https://registry.npmjs.org']
  try { mirrors = JSON.parse(readFileSync(join(ROOT, 'scripts', 'snapshot-config', 'preinstall.json'), 'utf8')).npmMirrors ?? mirrors } catch { /* 用默认镜像 */ }
  mkdirSync(dest, { recursive: true })
  console.log('  准备 esbuild@' + ESBUILD_PIN + '（' + process.platform + '/' + process.arch + '，镜像链 ' + mirrors.length + ' 个）…')
  for (const m of mirrors) {
    try {
      await extractNpmTgz(m, 'esbuild', ESBUILD_PIN, join(dest, 'node_modules', 'esbuild'))
      await extractNpmTgz(m, platformPkg, ESBUILD_PIN, join(dest, 'node_modules', ...platformPkg.split('/')))
      if (process.platform !== 'win32') {
        spawnSync('chmod', ['+x', join(dest, 'node_modules', ...platformPkg.split('/'), 'bin', 'esbuild')], { encoding: 'utf8' })
      }
      const version = JSON.parse(readFileSync(pkg, 'utf8')).version
      if (version === ESBUILD_PIN && esbuildUsable(main, version)) return { rel: 'provisioned/' + process.platform + '-' + process.arch, dir: join(dest, 'node_modules', 'esbuild'), main, version }
      console.log('    装好了但本平台不可用，换下一个镜像')
    } catch (e) {
      console.log('    镜像 ' + m + ' 不可用（' + String(e.message).split('\n')[0] + '）')
    }
  }
  return null
}
/**
 * tar 可执行文件的**显式定位**（0.14.1 W1 补：不靠 PATH 里先碰见哪个）。
 *
 * 真因（本轮实锤，Git Bash 复现）：Windows 上 PATH 里的 `tar` 可能是 Git 自带的 **GNU tar**，它把
 * `-tf D:\...\snapshot.tar.xz` 里的 `D:` 当**远端主机名**解析，报
 * 「tar: Cannot connect to D: resolve failed」→ 本门禁 `die()` 退 2 → 聚合链在倒数第三条中止
 * （同一条链在 PowerShell 下正常，因为那边解析到的是 System32 的 bsdtar）。判据本身与调用 shell 无关，
 * 就不该由「哪个 tar 先被 PATH 命中」决定它能不能跑完。
 *
 * win32 优先系统 bsdtar（绝对路径），Linux/CI 仍用 PATH 里的 tar。两者都支持 `-T` 成员清单与 xz。
 */
const resolveTar = () => {
  if (process.platform === 'win32') {
    const sys = 'C:\\Windows\\System32\\tar.exe'
    if (existsSync(sys)) return sys
  }
  return 'tar'
}
const TAR = resolveTar()

/** 从 npm registry 取 metadata → 下 tgz → **按仓内钉住的 sha512** 校验 → 解包（不依赖 npm CLI）。
 *
 * issue #1581：旧实现用 dist.sha512 / dist.integrity 校验刚下下来的 tarball —— 哈希与 tarball 同源，
 * 投毒镜像可同时伪造两者；且 `if (sha && …)` 在两者都缺席时整段短路，未校验的字节直接解包并被执行。
 * 现在只认 ESBUILD_SHA512 里的钉住值（钉住值缺席同样判红），响应里的 dist 字段**不参与接受判定**。 */
const extractNpmTgz = async (registry, name, version, targetDir, fetchImpl = fetch) => {
  const res = await fetchImpl(registry + '/' + name, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error('metadata HTTP ' + res.status)
  const meta = await res.json()
  const dist = meta?.versions?.[version]?.dist
  if (!dist?.tarball) throw new Error('版本 ' + version + ' 的 dist 不可得')
  const buf = Buffer.from(await (await fetchImpl(dist.tarball, { signal: AbortSignal.timeout(300000) })).arrayBuffer())
  const digestProblem = pinnedDigestProblem(name, buf)
  if (digestProblem !== null) throw new Error(digestProblem)
  const tgzDir = dirname(targetDir)
  mkdirSync(tgzDir, { recursive: true })
  const tgz = join(tgzDir, '.__' + name.replace(/[@/]/g, '_') + '.tgz')
  writeFileSync(tgz, buf)
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  const r = spawnSync(TAR, ['-xzf', tgz, '-C', targetDir, '--strip-components=1'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('解包失败: ' + (r.stderr ?? '').trim().split('\n')[0])
  rmSync(tgz, { force: true })
}
/** 该 esbuild 安装是否能被**本进程**真正加载并跑完一次最小 transform（只查 transform 存在会漏掉平台二进制不匹配）。 */
function esbuildUsable(main, version) {
  const probe = 'try{const m=require(' + JSON.stringify(main) + ');'
    + 'if(m.version!==' + JSON.stringify(version) + ')process.exit(3);'
    + 'const r=m.transformSync("export const a = 1",{loader:"js"});'
    + 'process.exit(r&&typeof r.code==="string"?0:4)}catch(e){process.exit(5)}'
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' })
  return r.status === 0
}
let TS = resolveTypeScript()
let ESB = resolveEsbuild()
if (!TS) die('typescript 缺席（候选路径全未命中：' + TS_CANDIDATES.join(' / ') + '）。'
  + '本门禁的判据 1 依赖真实解析器，不得以文本判据替代；请先安装插件依赖（npm ci）。')
if (!ESB) {
  ESB = await provisionEsbuild()
  if (ESB) notes.push('esbuild 不在仓内可用副本中，已按固定版本 ' + ESBUILD_PIN + ' 准备到 ' + ESB.main)
}
if (!ESB) {
  const h = ESBUILD_CANDIDATES.map((rel) => {
    const pkg = join(ROOT, rel, 'package.json')
    return existsSync(pkg) ? rel + '（版本 ' + JSON.parse(readFileSync(pkg, 'utf8')).version + '，平台不可用）' : rel + '（缺席）'
  })
  die('esbuild@' + ESBUILD_PIN + ' 对本平台 ' + process.platform + '/' + process.arch + ' 不可用：'
    + h.join(' / ') + '。仓内 node_modules 通常只装本机平台二进制，而快照构建在 WSL/Linux 内跑；'
    + '请显式声明并固定 esbuild@' + ESBUILD_PIN + '（两条构建链），或用 --esbuild <node_modules/esbuild/lib/main.js> 指定。'
    + '绝不静默跳过——跳过等于把这条门禁变成永绿。')
}
if (has('esbuild')) {
  const p = argOf('esbuild')
  if (!existsSync(p)) die('--esbuild 指定的路径不存在: ' + p)
  const pkgPath = join(dirname(dirname(p)), 'package.json')
  if (!existsSync(pkgPath)) die('--esbuild 路径旁无 package.json，无法确认版本: ' + p)
  ESB = { rel: p, dir: dirname(dirname(p)), main: p, version: JSON.parse(readFileSync(pkgPath, 'utf8')).version }
  if (!esbuildUsable(ESB.main, ESB.version)) die('--esbuild 指定的安装对本平台不可用（平台二进制不匹配）: ' + p)
}
if (ESB.version !== ESBUILD_PIN) {
  die('esbuild 版本漂移：解析到 ' + ESB.version + '（' + ESB.rel + '），本门禁固定 ' + ESBUILD_PIN
    + '。判据 2 的口径完全由 esbuild 兼容表决定，版本漂移即口径漂移（详档 §6 未确证第 5 项）。'
    + '修法：在构建链里显式声明 esbuild@' + ESBUILD_PIN + '，或用 --esbuild <node_modules/esbuild/lib/main.js> 显式指定。')
}

const tsMod = await import(pathToFileURL(TS.main).href)
const ts = tsMod.default ?? tsMod
if (typeof ts.createSourceFile !== 'function') die('typescript 解析器不可用（' + TS.main + '：createSourceFile 缺席）')
const esbMod = await import(pathToFileURL(ESB.main).href)
const esbuild = esbMod.default ?? esbMod
if (typeof esbuild.transform !== 'function') die('esbuild transform API 不可用（' + ESB.main + '）')
notes.push('工具: typescript@' + TS.version + ' (' + TS.rel + ') ; esbuild@' + ESB.version + ' (' + ESB.rel + ')')
if (!has('json')) console.log(notes[notes.length - 1])

// ── 清单口径（两条判据共用，防口径分裂）────────────────────────────────────
// dist/**/*.js 全部 + 每一个 lib/client.js（含 home/.dsh/profiles/** 镜像副本）。
const classify = (rel) => {
  if (/(^|\/)dsh-web-frontend\/dist\/.*\.js$/.test(rel)) return 'frontend-dist'
  if (/(^|\/)lib\/client\.js$/.test(rel)) return 'client-bundle'
  return null
}
const walkDir = (base, rel, out) => {
  let entries
  try { entries = readdirSync(rel ? join(base, rel) : base, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const childRel = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) walkDir(base, childRel, out)
    else if (e.isFile() && classify(childRel)) out.push(childRel)
  }
}
const tarMembers = (tar) => {
  try {
    return execFileSync(TAR, ['-tf', tar], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (e) { die('tar 不可读（' + tar + '）：' + e.message) }
}
/** 把输入（stage 目录 / tar.xz）物化成 {root, rels, cleanup}。tar 只解清单成员，避免整包解压。 */
const materialize = (input) => {
  const isTar = /\.(tar\.xz|txz|tar)$/i.test(input)
  if (!isTar) {
    if (!existsSync(input)) die('--scan 输入不存在: ' + input)
    const rels = []
    walkDir(input, '', rels)
    return { root: input, rels, cleanup: () => {} }
  }
  if (!existsSync(input)) die('--scan 输入不存在: ' + input)
  const all = tarMembers(input)
  const rels = all.filter((m) => classify(m))
  const tmp = mkdtempSync(join(tmpdir(), 'syntax-floor-'))
  if (rels.length > 0) {
    const listFile = join(tmp, '__members.txt')
    writeFileSync(listFile, rels.join('\n') + '\n')
    try {
      execFileSync(TAR, ['-xf', input, '-C', tmp, '-T', listFile], { stdio: ['ignore', 'inherit', 'inherit'] })
    } catch (e) { die('tar 解清单成员失败（' + input + '）：' + e.message) }
  }
  return { root: tmp, rels, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}
const absOf = (root, rel) => join(root, rel.split('/').join(sep))

// ── 判据 1：TypeScript AST 结构断言 ─────────────────────────────────────────
const astJudgment = (rel, text) => {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS)
  let staticBlocks = 0
  let privates = 0
  const hits = []
  const visit = (n) => {
    if (n.kind === ts.SyntaxKind.ClassStaticBlockDeclaration) {
      staticBlocks++
      const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf))
      hits.push({ line: lc.line + 1, col: lc.character + 1, byteOffset: Buffer.byteLength(text.slice(0, n.getStart(sf)), 'utf8') })
    }
    if (n.kind === ts.SyntaxKind.PrivateIdentifier) privates++
    ts.forEachChild(n, visit)
  }
  visit(sf)
  const diags = sf.parseDiagnostics ?? []
  return {
    staticBlocks,
    privates,
    diagnostics: diags.length,
    diagSample: diags.slice(0, 3).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    hits,
    bad: staticBlocks > 0 || diags.length > 0,
  }
}

// ── 判据 2：esbuild 双 arm 差分（两臂都对**原始字节**做；绝不对已降级产物做第二遍）────
// 不传 format：两臂做**完全相同**的管线，唯一变量就是 target —— 这正是差分要隔离的东西；
// 且与我方 client.js（CJS 风格闭包工厂）及上游 ESM dist 都保持原格式语义（详见 --degrade 处注释）。
const diffJudgment = async (text) => {
  // 两臂**必须**共用同一份 supported 纠偏：差分要隔离的唯一变量是 target。
  // 若只给 B 臂（TARGET_LOW）加纠偏而 A 臂不加，两臂就多出一个变量，差分读数失去意义。
  const [a, b] = await Promise.all([
    esbuild.transform(text, withTarget(TARGET_HIGH)),
    esbuild.transform(text, withTarget(TARGET_LOW)),
  ])
  return { a: Buffer.from(a.code, 'utf8'), b: Buffer.from(b.code, 'utf8'), differs: a.code !== b.code }
}

/** 对一份物化输入跑两条判据，返回结构化读数。 */
const runScan = async (root, rels, { stopAfterFirst = false } = {}) => {
  const rows = []
  let astBad = 0
  let staticTotal = 0
  let diagBad = 0
  let diffHits = 0
  let bytesA = 0
  let bytesB = 0
  let privatesTotal = 0
  const kinds = { 'frontend-dist': 0, 'client-bundle': 0 }
  const scopes = { usr: 0, home: 0, other: 0 }
  const concurrency = 4
  let cursor = 0
  const worker = async () => {
    while (cursor < rels.length) {
      const rel = rels[cursor++]
      kinds[classify(rel)]++
      if (rel.startsWith('usr/')) scopes.usr++
      else if (rel.startsWith('home/')) scopes.home++
      else scopes.other++
      const abs = absOf(root, rel)
      const text = readFileSync(abs, 'utf8')
      const ast = astJudgment(rel, text)
      let diff = null
      // 已判红的文件在快速模式下不必再跑差分；门禁主模式全跑（两条判据互证）
      if (!(stopAfterFirst && ast.bad)) diff = await diffJudgment(text)
      else diff = { a: Buffer.alloc(0), b: Buffer.alloc(0), differs: true }
      staticTotal += ast.staticBlocks
      privatesTotal += ast.privates
      if (ast.staticBlocks > 0) astBad++
      if (ast.diagnostics > 0) diagBad++
      if (diff.differs) { diffHits++; bytesA += diff.a.length; bytesB += diff.b.length }
      rows.push({ rel, kind: classify(rel), ...ast, a: diff.a.length, b: diff.b.length, differs: diff.differs })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rels.length || 1) }, worker))
  return { rows, astBad, staticTotal, diagBad, diffHits, privatesTotal, kinds, scopes, bytesA, bytesB, total: rels.length }
}

/** 门禁判定：判红条件（两条判据任一命中）。 */
const decide = (r) => {
  const detailFailures = []
  if (r.total === 0) detailFailures.push('清单为空——口径漂移（路径前缀/布局变更？）')
  if (r.kinds['frontend-dist'] === 0) detailFailures.push('清单里 dsh-web-frontend/dist/**/*.js 为 0——前端产出口径失效')
  if (r.kinds['client-bundle'] === 0) detailFailures.push('清单里 lib/client.js 为 0——插件 bundle 口径失效')
  if (r.astBad > 0) detailFailures.push('判据1：' + r.astBad + ' 个文件含 ClassStaticBlockDeclaration（Chromium 94+ 语法，老内核解析即整模块不执行）')
  if (r.diagBad > 0) detailFailures.push('判据1：' + r.diagBad + ' 个文件存在解析诊断——产物必须能被 ESNext 解析器无错解析')
  if (r.diffHits > 0) detailFailures.push('判据2：' + r.diffHits + ' 个文件在 esnext 与 chrome87 之间产生字节差——携带未降级的需降级语法')
  return detailFailures
}

const report = (r, out = console.log) => {
  const fails = decide(r)
  out('BROWSER-SYNTAX-FLOOR ' + (fails.length === 0 ? 'PASS' : 'FAIL'))
  out('  清单: ' + r.total + ' 个文件（dist/**/*.js = ' + r.kinds['frontend-dist'] + '，lib/client.js = ' + r.kinds['client-bundle']
    + '；usr/ = ' + r.scopes.usr + '，home/ = ' + r.scopes.home + '，其他 = ' + r.scopes.other + '）')
  out('  判据1 AST: ClassStaticBlockDeclaration 违规文件 ' + r.astBad + ' 个（共 ' + r.staticTotal + ' 处）；'
    + '解析诊断>0 的文件 ' + r.diagBad + ' 个；PrivateIdentifier 共 ' + r.privatesTotal + ' 处（Chromium 74+，不作判据）')
  out('  判据2 差分: ' + r.diffHits + '/' + r.total + ' 个文件 ' + TARGET_HIGH + ' != ' + TARGET_LOW
    + (r.diffHits > 0 ? '（其中 ' + TARGET_LOW + ' 侧合计 ' + r.bytesA + ' -> ' + r.bytesB + ' B，+' + (r.bytesB - r.bytesA) + ' B）' : ''))
  for (const row of r.rows) {
    if (row.staticBlocks > 0) {
      out('    VIOLATION-STATIC ' + row.rel + ' staticBlocks=' + row.staticBlocks + ' diagnostics=' + row.diagnostics
        + ' hits=' + row.hits.map((h) => h.line + ':' + h.col + '(byte ' + h.byteOffset + ')').join(','))
    } else if (row.diagnostics > 0) {
      out('    VIOLATION-PARSE ' + row.rel + ' diagnostics=' + row.diagnostics + ' :: ' + row.diagSample.join(' | '))
    }
    if (row.differs && row.staticBlocks === 0) out('    DIFF ' + row.rel + ' ' + TARGET_HIGH + '=' + row.a + ' B vs ' + TARGET_LOW + '=' + row.b + ' B')
  }
  if (fails.length > 0) for (const f of fails) out('  FAIL ' + f)
  out('  口径边界: 「差分归零」只证明不低于 esbuild 的 ' + TARGET_LOW + ' 口径，不等价于 MDN 意义的 Chromium 87（详档 §6 未确证第 5 项，未做逐特性 --supported 断言）')
  return fails
}

// ── 模式：--degrade（构建期降级；本脚本同时充当构建链的唯一降级原语）──────────
// 生产降级**不传 format**：我方 client.js 是「CJS 风格 + window.__ModuleLoader__ 闭包工厂」，
// 传 format:'esm' 会把工厂形参 require 重命名成 require2（实测 vdisplay 89 字节处分歧）——
// 判据 2 的差分只比较两臂，format 无所谓；但**落到产物的字节**必须保持原格式语义，否则是改行为不是降级。
/**
 * 引擎树补丁的 marker 清单（来自 registry.json，数据驱动，不硬编码）。
 *
 * 为什么降级必须照顾它们（0.14.1 实测踩到的真缺陷）：esbuild 的 transform **会剥掉注释**，
 * 而其中三个补丁的 marker 正是**注释**——`arkweb-resource-protocol-H1` /
 * `reference-drill-F6` / `external-draft-conversation-seam-J1`（目标是 `lib/client.js`）。
 * 构建器顺序是「overlay → 引擎树补丁 → 0f-1b 降级」，于是降级会把「补丁已施加」的**唯一证据**
 * 洗掉，`check-engine-overlay` 随即判红（实测 H1 与 F6 两项缺席）。
 *
 * 保留是**合法**的，不是把判据改松：降级（target=chrome87）是**语义保持**变换，补丁插入的**代码**
 * 仍在（实测降级后 H1 的 authority 回退逻辑在场），丢的只是注释文本。故此处只对**原文确实含有**
 * 的 marker 做补回——不凭空造标记，也不掩盖「补丁真的没打」。
 */
const PATCH_MARKERS = (() => {
  try {
    const reg = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))
    return (reg.patches ?? [])
      .map((p) => p.marker)
      .filter((m) => typeof m === 'string' && m.trim() !== '')
  } catch { return [] }
})()

const degradeText = async (text) => {
  const out = (await esbuild.transform(text, withTarget(TARGET_LOW))).code
  const missing = PATCH_MARKERS.filter((m) => text.includes(m) && !out.includes(m))
  if (missing.length === 0) return out
  // 以行注释补回（注释对运行时无影响）；仅当降级确实丢失时才补。
  return missing.map((m) => '// ' + m).join('\n') + '\n' + out
}

if (has('degrade')) {
  const file = argOf('file') ?? argv[argv.indexOf('--degrade') + 1]
  const stage = argOf('stage')
  const out = argOf('out')
  if (stage) {
    if (!existsSync(stage)) die('--degrade --stage 输入不存在: ' + stage)
    const rels = []
    walkDir(stage, '', rels)
    if (rels.length === 0) die('--degrade --stage 清单为空（' + stage + '）——拒绝 no-op 降级')
    let before = 0
    let after = 0
    let changed = 0
    let skipped = 0
    for (const rel of rels) {
      const abs = absOf(stage, rel)
      const src = readFileSync(abs, 'utf8')
      // **幂等短路**（唯一正确的「要不要改写」判据）：判据 2 的两臂对同一份原始字节各跑一次，
      // 若 esnext 臂与 TARGET_LOW 臂输出**逐字节相同**，说明这份代码在 esbuild 眼里没有需要降级的
      // 语法 —— 此时改写它语义上等于原文件，只是换了排版，纯浪费体积。实测 0.2.2-rc.1 的真实闭包：
      // 81 个浏览器面文件里只有 2 个真的需要降，全量改写白付 855,417 B（1,263,372 vs 407,955）。
      //
      // 为什么不能用 `dst !== src` 当判据：esbuild 会重排 `@__PURE__` 注解与缩进，几乎任何文件都
      // 「变了」，那个判据恒真、等于没有短路。也不能用「含 static{} 文本」——本文件全篇禁用文本判据。
      // 两臂比对与判据 2 是**同一个判据**（同一份 withTarget 选项），所以跳过的一定是判据 2 本来就
      // 判绿的文件，不可能把该降的漏掉。
      const high = (await esbuild.transform(src, withTarget(TARGET_HIGH))).code
      const dst = await degradeText(src)
      before += Buffer.byteLength(src, 'utf8')
      if (dst === high) {
        // 无需降级：保留原始字节（不写盘），体积按原样计入
        after += Buffer.byteLength(src, 'utf8')
        skipped++
        continue
      }
      after += Buffer.byteLength(dst, 'utf8')
      if (dst !== src) { writeFileSync(abs, dst); changed++ }
    }
    // 输出字段是两个消费方共用的契约，改名字会打断解析方：
    //   · `files=` / `changed=` 被 build-snapshot-013.mjs 用 `/files=(\d+) changed=(\d+)/` 解析，
    //     用来做「清单非空 + 真的改写了文件」的反 no-op 断言；
    //   · `lowered=` / `skipped=` 是本轮新增的语义字段（跳过 = 两臂输出相同、无需改写）。
    // 故 `changed=` 必须保留（它等于 lowered），新字段追加在后面。曾经把 changed 改名成 lowered，
    // 快照构建当场报「无法从 --degrade 输出解析文件数」并 exit 1 —— 契约字段不许静默改名。
    console.log('BROWSER-SYNTAX-FLOOR DEGRADE stage=' + stage + ' target=' + TARGET_LOW
      + ' files=' + rels.length + ' changed=' + changed
      + ' lowered=' + changed + ' skipped=' + skipped
      + ' bytes ' + before + ' -> ' + after + ' (+' + (after - before) + ')')
    console.log('  ⚠️ 二次降级不保证逐字节相同（@__PURE__ 注解重排，详档 §5.2 步骤 4）；判绿请用 --scan 的「双 arm 差分归零」。')
    process.exit(0)
  }
  if (!file || !existsSync(file)) die('--degrade 需要 <file>（或 --stage <dir>）：' + String(file))
  const src = readFileSync(file, 'utf8')
  const dst = await degradeText(src)
  if (!out) { process.stdout.write(dst); process.exit(0) }
  writeFileSync(out, dst)
  console.log('BROWSER-SYNTAX-FLOOR DEGRADE ' + file + ' -> ' + out + ' (' + Buffer.byteLength(src, 'utf8') + ' -> ' + Buffer.byteLength(dst, 'utf8') + ' B)')
  process.exit(0)
}

// ── 接线反回归（task-9 判据 3）：构建链里「降级步骤存在且被调用」────────────────
// 为什么单独一条：check-release-gates 只断言「门禁集合被两条链调用」（31/31），它比不出
// **构建链里少了降级步骤** —— 门禁照样被调用、照样判红，但没有任何步骤把产物改成合规形态，
// 于是云端自包含构建必然判红而本地不可见（task-9 的真因）。
// 判据是结构性的（不是文本在场）：
//   · 两条链各自源码里都必须有一次「调用本脚本 + --degrade」（而不是只 import / 只注释提到）；
//   · 该调用的**行号必须早于** combo 预计算调用（顺序硬约束：combo 键 = sha256(client.js)）；
//   · 降级目标必须是**暂存副本**（原地降级会把入库跟踪的 vendor/lib 写脏 / 制造镜像漂移）。
//
// 布局无关：协调仓根下是 `scripts/...`；apk 仓自包含根下同名，`dsh-mobile-apk/scripts/...` 是其镜像。
// 两条链都必须查——**镜像面单边缺失就是 task-9 的真因**（本地有降级、云端没有）。
const WIRED_CHAINS = ['scripts/build-apk-013.ps1', 'scripts/build-apk.mjs']
const mirrorRel = (rel) => (existsSync(join(ROOT, rel)) ? rel : rel.replace(/^/, 'dsh-mobile-apk/'))
/** 去掉注释后的代码行（判据只看真正会执行的调用；两种链的注释形态不同）。 */
const codeLines = (text) => text
  .replace(/\r\n/g, '\n')
  .split('\n')
  .map((l, i) => ({ n: i + 1, l }))
  .filter(({ l }) => {
    const t = l.trim()
    return t.length > 0 && !t.startsWith('#') && !t.startsWith('//')
  })
const checkChainWiring = () => {
  const problems = []
  const evidence = []
  for (const rel of WIRED_CHAINS) {
    for (const base of [ROOT, join(ROOT, 'dsh-mobile-apk')]) {
      const p = join(base, rel)
      const tag = (base === ROOT ? '本仓' : '镜像仓') + '/' + rel
      if (!existsSync(p)) { if (base === ROOT) problems.push(rel + ' 缺席'); continue }
      const lines = codeLines(readFileSync(p, 'utf8'))
      // ① 「调用」：同一行同时出现脚本名与 --degrade（是调用，不是别处的说明）
      const degradeLine = lines.find(({ l }) => l.includes('check-browser-syntax-floor.mjs') && l.includes('--degrade'))
      const consumeLine = lines.find(({ l }) => l.includes('inject-all.py'))
      if (!degradeLine) {
        problems.push(tag + ' 没有任何一行同时含 check-browser-syntax-floor.mjs 与 --degrade（降级步骤缺失）')
        continue
      }
      if (!consumeLine) { problems.push(tag + ' 找不到 inject-all.py 调用（无法验证降级在被注入消费之前）'); continue }
      if (degradeLine.n >= consumeLine.n) {
        problems.push(tag + ' 降级(L' + degradeLine.n + ')不在注入消费(L' + consumeLine.n + ')之前'
          + '——注入进快照的就是降级后的字节，顺序反了老内核仍会拿到未降级的 bundle（0.14.2 前这里查的是 combo 预计算顺序）')
      }
      // ② 暂存副本（**绑定判据**，不是「文件里提到过这个词」）：取降级调用的实际 --stage 实参，
      //    它必须是一个由**暂存路径**赋值的变量。否则就是原地降级 —— `vendor/**/lib/` 是入库跟踪的
      //    （.gitignore 显式 !vendor 例外），原地降级会写脏工作树并制造与 apk 仓镜像的漂移。
      const tgt = /--stage['"\s,]+([A-Za-z_$][\w$]*)/.exec(degradeLine.l)?.[1]
      if (!tgt) {
        problems.push(tag + ' 无法从降级调用行解析出 --stage 实参（判据失效，拒绝假绿）：' + degradeLine.l.trim())
      } else {
        // 找到 tgt 的赋值行；该赋值必须源自暂存路径（degradeStaged / degrade-src）。
        // 变量名可能带 PS 前缀 `$`（如 `$dst`）——必须转义后建正则，且不用 \b（`$` 左侧无词边界
        // → `\b\$dst` 恒不匹配，会把合法链误判成「原地降级」，首版实测踩到）。
        const esc = tgt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const assign = lines.find(({ l }) => new RegExp('(?:^|[\\s(])' + esc + '\\s*=').test(l))
        const fromStaging = assign !== undefined
          && /degradeStaged|degrade-src/.test(assign.l)
          && !/--stage/.test(assign.l)   // 赋值行本身不能又是调用行（自指假绿）
        if (!fromStaging) {
          problems.push(tag + ' 降级目标是 ' + tgt + ' 且其赋值不来自暂存路径（禁止原地降级；'
            + 'vendor/**/lib 入库跟踪，原地降级会写脏工作树 + 制造镜像漂移）')
        }
        evidence.push(tag + ': degrade@L' + degradeLine.n + ' < consume@L' + consumeLine.n + ' stage=' + tgt + ' staged=' + fromStaging)
      }
    }
  }
  return { ok: problems.length === 0, detail: problems.join('；'), evidence: evidence.join(' | ') }
}

// ── 模式：--self-test（自包含四向自证；可离线跑，不碰仓库产物）──────────────
if (has('self-test')) {
  const spawnSelf = (extra) => {
    try {
      const stdout = execFileSync(process.execPath, [SELF, ...extra], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      return { status: 0, stdout }
    } catch (e) {
      return { status: e.status ?? -1, stdout: (e.stdout ?? '') + (e.stderr ?? '') }
    }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'syntax-floor-self-'))
  const root = join(tmp, 'root')
  const FE = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets'
  const CB = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-fixture/lib'
  const HOME_CB = 'home/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-fixture/lib'
  for (const rel of [FE, CB, HOME_CB]) mkdirSync(join(root, rel.split('/').join(sep)), { recursive: true })

  // 用例 1：真代码 —— 两条判据都必须报。
  // 夹具必须含**在 TARGET_LOW 下真的会被降级**的语法，否则判据 2 空转。这里踩过两次坑，都记在下面：
  //   · 用 `?.` 承重 → 在 es2021 档位下 `?.` 是 ES2020、不降，判据 2 空转；
  //   · 用类字段承重 → 在 chrome87 档位下类字段是 Chrome 72/74 特性、不降，判据 2 又空转。
  // 唯一在两种档位下都会被降级的只有类静态块（Chrome 94 起），故夹具以它承重；
  // 类字段/私有字段保留在夹具里是**故意**的：它们必须同时满足「判据 1 静默」且「不产生差分」，
  // 这正是「87 原生支持的语法不许被降」的反向证据（体积就是从这里省下来的）。
  const realCode = 'export class A {\n  static { this.x = 1 }\n  rows = new Map()\n  static EMPTY = 0\n  #secret = 1\n  static is(v) { return v?.y }\n}\nexport const z = A.is?.length\n'
  writeFileSync(absOf(root, FE + '/index-fixture.js'), realCode)
  // 用例 2/3/4：字符串 / 模板串 / 注释内的同类文本，且**不含任何现代语法**——两条判据都不得触发（载荷对照）。
  // 关键：文档里 grep 会把这三种载荷全部误报成语法；本门禁必须一个都不报。
  const payload = 'export const a = "class A { static { this.x = 1 } }"\n'
    + 'export const b = `class B { static { this.y = 2 } }`\n'
    + '// class C { static { this.z = 3 } }\nexport const c = a.length\n'
  writeFileSync(absOf(root, CB + '/client.js'), payload)
  // 对照件（HOME 面）：只含**类字段 + 可选链**，不含类静态块 —— 判据 1 必须静默、判据 2 必须不命中。
  // 这条是 TARGET_SUPPORTED 纠偏的承重反证：类字段（Chrome 72/74）与 `?.`（Chrome 80）在 87 上都支持，
  // 若它们触发了差分，就说明纠偏没生效、白付了体积。原来的夹具反过来用它们「必须命中」，
  // 那是 es2021 口径下的写法；换成 chrome87 + supported 后判据正好相反。
  writeFileSync(absOf(root, HOME_CB + '/client.js'), 'export class Opt {\n  rows = new Map()\n  m(o) { return o?.a?.b }\n}\nexport const n = Opt.length\n')

  const t0 = Date.now()
  const reverse = spawnSelf(['--scan', root])                 // 反向对照：未降级必须判红
  const reverseReported = reverse.status === 1
    && /VIOLATION-STATIC .*index-fixture\.js/.test(reverse.stdout)
    && !/VIOLATION-STATIC .*client\.js/.test(reverse.stdout)
    && reverse.stdout.includes('ClassStaticBlockDeclaration 违规文件 1 个')
    && reverse.stdout.includes('解析诊断>0 的文件 0 个')
  // 载荷对照（文件级）：CB/client.js 只含载荷文本 → 判据 1 不得出现该路径、判据 2 不得对该路径出 DIFF；
  // 同时 HOME 对照件（只有 87 原生支持的类字段 + ?.）必须**不**被判据 2 命中 —— 这是纠偏生效的反证。
  // 于是全树只有 index-fixture.js 一个文件产生差分（它含 static{}）。
  const payloadClean = !/VIOLATION-STATIC [^\n]*client\.js staticBlocks=/.test(reverse.stdout)
    && !/DIFF usr\/[^\n]*dsh-client-ui-fixture/.test(reverse.stdout)
    && !/DIFF home\/[^\n]*dsh-client-ui-fixture/.test(reverse.stdout)
    && reverse.stdout.includes('判据2 差分: 1/3 个文件')

  // 正向对照：同一棵树原地降到 chrome87 后必须全绿
  const degraded = spawnSelf(['--degrade', '--stage', root])
  const forward = spawnSelf(['--scan', root])                  // 正向对照：降级后必须全绿
  const forwardOk = degraded.status === 0 && forward.status === 0
    && /BROWSER-SYNTAX-FLOOR PASS/.test(forward.stdout)
    && /判据2 差分: 0\//.test(forward.stdout)

  // 解析器可用性：AST 必须能把真代码与载荷区分开（4 用例级）
  const astReal = astJudgment('real.js', realCode)
  const astPayload = astJudgment('payload.js', payload)
  const parserDiscriminates = astReal.staticBlocks === 1 && astPayload.staticBlocks === 0 && astPayload.diagnostics === 0
  const [dHighReal, dLowReal] = await Promise.all([
    esbuild.transform(realCode, withTarget(TARGET_HIGH, { format: 'esm' })),
    esbuild.transform(realCode, withTarget(TARGET_LOW, { format: 'esm' })),
  ])
  const [dHighPay, dLowPay] = await Promise.all([
    esbuild.transform(payload, withTarget(TARGET_HIGH, { format: 'esm' })),
    esbuild.transform(payload, withTarget(TARGET_LOW, { format: 'esm' })),
  ])
  const diffDiscriminates = dHighReal.code !== dLowReal.code && dHighPay.code === dLowPay.code

  // 用例 5（0.14.1 实测缺陷回归）：带**引擎树补丁 marker 注释**的文件降级后，marker 必须仍在。
  // 真因：esbuild 剥注释，而 H1/F6/J1 三个补丁的 marker 正是注释、目标是 lib/client.js；构建器
  // 顺序是「打补丁 → 降级」，于是降级把「补丁已施加」的唯一证据洗掉，check-engine-overlay 判红。
  // 这条自证让本门禁的降级原语**自带**该回归防线——不必等 check-engine-overlay 来发现。
  //
  // **不能用单个 marker 做夹具**：registry 里多数 marker 是**代码片段**（如 `function tt(){...}`），
  // esbuild 不会剥，用它则用例**空转通过**（首版实测踩到：禁用保全逻辑后该用例照样绿）。故夹具含
  // **全部** marker 且都以行注释形式给出——注释必被剥，判据才有承重。
  let markerKept = true
  let markerDetail = '（registry 无 marker，跳过）'
  const markerLost = []
  if (PATCH_MARKERS.length > 0) {
    const mroot = mkdtempSync(join(tmpdir(), 'bsf-marker-'))
    const mdir = join(mroot, 'lib')
    mkdirSync(mdir, { recursive: true })
    writeFileSync(join(mdir, 'client.js'),
      PATCH_MARKERS.map((m) => '// ' + m).join('\n') + '\nexport const opt = (o) => o?.x?.y\nexport const n = opt.length\n')
    spawnSelf(['--degrade', '--stage', mroot])
    const after = readFileSync(join(mdir, 'client.js'), 'utf8')
    for (const m of PATCH_MARKERS) if (!after.includes(m)) markerLost.push(m)
    markerKept = markerLost.length === 0
    markerDetail = 'registry marker 共 ' + PATCH_MARKERS.length + ' 个；降级后缺失 ' + markerLost.length
      + (markerLost.length > 0 ? '（例：' + JSON.stringify(markerLost[0]) + '）' : '')
      + '；降级仍生效=' + !after.includes('o?.x?.y')
    rmSync(mroot, { recursive: true, force: true })
  }

  console.log('BROWSER-SYNTAX-FLOOR --self-test（六向自证 + 接线反回归，用时 ' + (Date.now() - t0) + ' ms）')
  // ① 解析器可用性：**真判据**（此前是 `check(..., true)` 硬编码 —— 文件缺席/版本错也照样绿，
  //    等于把「环境是否可用」写成常量。现断言：解析器真能把真代码与载荷区分开，且 esbuild 版本 == 钉住值。
  const parserUsable = typeof ts.createSourceFile === 'function'
    && parserDiscriminates
    && astPayload.diagnostics === 0
    && TS.version.length > 0
    && ESB.version === ESBUILD_PIN
  check('① 解析器可用性：typescript@' + TS.version + ' 真解析且能区分真语法/载荷；esbuild@' + ESB.version + ' == 钉住值 ' + ESBUILD_PIN,
    parserUsable,
    'createSourceFile=' + (typeof ts.createSourceFile === 'function')
    + ' ast real=' + astReal.staticBlocks + ' payload=' + astPayload.staticBlocks
    + ' payloadDiag=' + astPayload.diagnostics + ' esbuild=' + ESB.version)
  check('② 反向对照：未降级 fixture（真 static{} + ?.）必须判红，且载荷文件不被误报', reverseReported,
    'exit=' + reverse.status + '（期望 1）')
  check('③ 正向对照：同一棵树 --degrade 到 ' + TARGET_LOW + ' 后必须全绿（判据1 0 违规 + 判据2 差分归零）', forwardOk,
    'degrade exit=' + degraded.status + ' scan exit=' + forward.status + '（期望 0/0）')
  check('④ 载荷对照：字符串/模板串/注释内同类文本不得触发（AST 3 用例 + 双 arm 差分 3 用例）', payloadClean && diffDiscriminates,
    'ast real=' + astReal.staticBlocks + ' payload=' + astPayload.staticBlocks
    + '；esbuild real differs=' + (dHighReal.code !== dLowReal.code) + ' payload differs=' + (dHighPay.code !== dLowPay.code))
  // ④b/④c 纠偏覆盖面负控（TARGET_SUPPORTED 的承重条）：必须**分别**证明「87 真不支持的仍判红」
  // 与「87 真支持的已放行」——把两者混在一条 fixture 里（如 ② 的 static{} + ?.）证不出覆盖面，
  // 因为只要任一条判据还红着，整棵树就是红的，看不出「放开了哪一项」。
  //
  // 判据取向：这两条不是「跑一遍看结果」，而是**同一条扫描路径**对两份只差一个特性的产物各跑一次，
  // 结论必须一红一绿。若 TARGET_SUPPORTED 被误加进 87 真不支持的特性（如 class-static-block），
  // ④b 立刻变绿 ⇒ 判据整体放宽被抓到；若纠偏失效（supported 没生效），④c 立刻变红 ⇒ 白付体积被抓到。
  const probeRoot = mkdtempSync(join(tmpdir(), 'bsf-cover-'))
  let coverStatic = null
  let coverOptChain = null
  try {
    const rel = FE + '/cover-probe.js'
    const abs = absOf(probeRoot, rel)
    mkdirSync(dirname(abs), { recursive: true })
    // 夹具必须同时含 dist/**/*.js 与 lib/client.js：清单口径要求两类都在场，
    // 缺 lib/client.js 会先撞「插件 bundle 口径失效」而掩盖掉真正要看的判据 2 读数。
    const clientAbs = absOf(probeRoot, CB + '/client.js')
    mkdirSync(dirname(clientAbs), { recursive: true })
    writeFileSync(clientAbs, 'export const plain = 1\n')
    // ④b：只放 static{}（87 真不支持，必须判红）
    writeFileSync(abs, 'export class OnlyStatic { static { this.x = 1 } }\n')
    const rStatic = spawnSelf(['--scan', probeRoot])
    coverStatic = { status: rStatic.status, out: rStatic.stdout }
    // ④c：只放 ?.（87 真支持，必须判绿）
    writeFileSync(abs, 'export const opt = (o) => o?.a?.b\nexport const n = opt.length\n')
    const rOpt = spawnSelf(['--scan', probeRoot])
    coverOptChain = { status: rOpt.status, out: rOpt.stdout }
  } finally { rmSync(probeRoot, { recursive: true, force: true }) }
  // ④b 期望：exit 1，且判据 1 报出 staticBlocks（而不是只靠判据 2 命中）
  const staticStillRed = coverStatic !== null && coverStatic.status === 1
    && /VIOLATION-STATIC .*cover-probe\.js/.test(coverStatic.out)
  check('④b 覆盖面负控：87 真不支持的 static{} 单独出现时必须判红（纠偏不得放宽这一项）', staticStillRed,
    coverStatic === null ? '（未执行）' : 'exit=' + coverStatic.status + '（期望 1）'
    + (coverStatic && !/VIOLATION-STATIC .*cover-probe\.js/.test(coverStatic.out) ? '；但判据1 未报出 staticBlocks' : ''))
  // ④c 期望：exit 0，且该文件不出现在任何违规/差分行里
  const optChainGreen = coverOptChain !== null && coverOptChain.status === 0
    && /判据2 差分: 0\//.test(coverOptChain.out)
  check('④c 覆盖面负控：87 真支持的 ?. 单独出现时必须判绿（纠偏只放开这一项，不是整体放宽）', optChainGreen,
    coverOptChain === null ? '（未执行）' : 'exit=' + coverOptChain.status + '（期望 0）'
    + (coverOptChain && !/判据2 差分: 0\//.test(coverOptChain.out) ? '；差分未归零 ⇒ supported 未生效' : ''))
  // ⑤ 降级不得洗掉引擎树补丁 marker（esbuild 剥注释；0.14.1 实测缺陷）
  check('⑤ 补丁 marker 保全：降级（剥注释）后 registry 的 marker 必须仍在原文件里', markerKept, markerDetail)
  /* ⑧ esbuild 字节锚（issue #1581）：判据必须是「钉住值决定接受与否」，不是「代码里有这一行」。
   * 四向自证，全部离线（不联网）：
   *   a) 钉住值在场：本平台包与主包都有条目（缺一个 = 该平台永远准备不出来，且是静默失效）；
   *   b) 正控：与钉住值逐字节相符的字节必须放行（不得把正规镜像也拒了）；
   *   c) 负控：改一个字节必须判红（钉住值真的在比字节，不是在比长度/在场）；
   *   d) 负控：**未登记**的包名必须判红（这正是旧实现「响应里给什么就信什么」的入口）。
   * 旧实现下 b/c 用的是响应里的哈希：c 的负控仍会红，但「投毒镜像同时改 tarball 与哈希」时不红 ——
   * 所以 d 是这条判据的判别力所在，必须单独钉住。 */
  const pinnedNames = Object.keys(ESBUILD_SHA512)
  const platformName = process.platform === 'win32' ? '@esbuild/win32-' + process.arch
    : process.platform === 'linux' ? '@esbuild/linux-' + process.arch
      : process.platform === 'darwin' ? '@esbuild/darwin-' + process.arch : null
  const anchorCovered = pinnedNames.includes('esbuild')
    && (platformName === null || pinnedNames.includes(platformName))
    && pinnedNames.length >= 7
  const goodBytes = Buffer.from('pinned-bytes-fixture', 'utf8')
  const goodSha = createHash('sha512').update(goodBytes).digest('base64')
  const savedSha = ESBUILD_SHA512['esbuild']
  ESBUILD_SHA512['esbuild'] = goodSha
  const anchorAccepts = pinnedDigestProblem('esbuild', goodBytes) === null
  const anchorRejects = String(pinnedDigestProblem('esbuild', Buffer.from('pinned-bytes-fixturE', 'utf8')) ?? '').includes('与钉住值不符')
  ESBUILD_SHA512['esbuild'] = savedSha
  const anchorRejectsUnpinned = String(pinnedDigestProblem('@esbuild/zzz-selftest-unpinned', goodBytes) ?? '').includes('没有钉住的 sha512')
  /* **端到端**负控（判据 ⑧ 的承重面，不是纯函数自证）：
   * 起一个本地假 registry，它对**投毒 tarball** 返回**自洽的** dist.sha512（这正是被劫持镜像的能力）。
   *   · 旧实现（用响应里的哈希校验）→ 接受并解包 ⇒ 本例必须判红；
   *   · 修好之后（只认仓内钉住值）→ 拒绝 ⇒ 本例判绿。
   * 反向再证一次「不是恒红」：把钉住值临时改成投毒字节的哈希，同一响应必须被接受。
   * 没有这一段，判据 ⑧ 就只是「有个纯函数」——把实现改回旧写法它照样绿（实测踩到过）。 */
  const { gzipSync } = await import('node:zlib')
  /** 造一个**合法**的最小 .tgz（一个成员）——投毒夹具必须是真归档，
   *  否则「被拒」可能只是因为解包失败，而不是因为字节锚（假绿方向）。 */
  const makeTgz = (name, body) => {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'utf8')
    header.write('0000000\0', 108, 8, 'utf8')
    header.write('0000000\0', 116, 8, 'utf8')
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8')
    header.write('00000000000\0', 136, 12, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    header.write('0', 156, 1, 'utf8')
    header.write('ustar\0', 257, 6, 'utf8')
    header.write('00', 263, 2, 'utf8')
    let sum = 0
    for (const b of header) sum += b
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8')
    const padded = Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)])
    return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]))
  }
  const poison = makeTgz('package/package.json', Buffer.from('{"name":"esbuild","version":"' + ESBUILD_PIN + '"}', 'utf8'))
  const poisonSha = createHash('sha512').update(poison).digest('base64')
  /* 假 registry：不建 HTTP 服务（keep-alive 套接字会让 Windows 的 process.exit 撞 libuv 断言），
   * 直接把「元数据 + tarball」注入 extractNpmTgz 的取件口。被测的仍然是**同一条**接受判定路径。 */
  const fakeRegistry = (sha512) => async (url) => {
    if (String(url).endsWith('/esbuild')) {
      return {
        ok: true,
        json: async () => ({ versions: { [ESBUILD_PIN]: { dist: { tarball: 'https://mirror.invalid/esbuild.tgz', sha512 } } } }),
      }
    }
    if (String(url) === 'https://mirror.invalid/esbuild.tgz') {
      return { ok: true, arrayBuffer: async () => poison.buffer.slice(poison.byteOffset, poison.byteOffset + poison.byteLength) }
    }
    return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
  }
  const tryExtract = async (sha512) => {
    const target = join(tmp, 'poison-target-' + Math.random().toString(36).slice(2))
    try {
      await extractNpmTgz('https://mirror.invalid', 'esbuild', ESBUILD_PIN, target, fakeRegistry(sha512))
      return { accepted: true, message: '' }
    } catch (e) {
      return { accepted: false, message: String(e.message) }
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  }
  // 镜像自洽地伪造 tarball 与哈希：旧实现（用响应里的哈希校验）会**接受并解包**它。
  const poisonedRun = await tryExtract(poisonSha)
  const anchorRejectsPoisonedMirror = !poisonedRun.accepted && /与钉住值不符/.test(poisonedRun.message)
  // 反向对照：把钉住值换成投毒字节的哈希，同一响应必须被接受（证明这条判据不是「一律拒绝」）。
  ESBUILD_SHA512['esbuild'] = poisonSha
  const pinnedRun = await tryExtract(poisonSha)
  ESBUILD_SHA512['esbuild'] = savedSha
  const anchorAcceptsPinnedBytes = pinnedRun.accepted
  check('⑧ esbuild 字节锚：钉住值在场 + 相符放行 + 改一字节判红 + 未登记包判红 + 自洽投毒镜像被拒（issue #1581）',
    anchorCovered && anchorAccepts && anchorRejects && anchorRejectsUnpinned && anchorRejectsPoisonedMirror && anchorAcceptsPinnedBytes,
    'covered=' + anchorCovered + '（' + pinnedNames.length + ' 条，平台包 ' + platformName + '）'
    + ' accepts=' + anchorAccepts + ' rejectsTamper=' + anchorRejects + ' rejectsUnpinned=' + anchorRejectsUnpinned
    + ' rejectsPoisonedMirror=' + anchorRejectsPoisonedMirror + '（' + poisonedRun.message.slice(0, 90) + '）'
    + ' acceptsPinnedBytes=' + anchorAcceptsPinnedBytes)
  // ⑥ 接线反回归（task-9）：降级步骤必须真的被两条构建链调用——「脚本存在」不等于「有步骤在用它」。
  //    真因：check-release-gates 只比门禁集合（31/31 全绿），比不出「构建链里少了降级步骤」，
  //    于是 PowerShell 链有降级、Node 链没有，云端自包含构建必判红而无人知。
  const wiring = checkChainWiring()
  check('⑥ 接线反回归：两条构建链都必须在注入消费（inject-all.py）之前调用 --degrade（暂存副本，不原地）',
    wiring.ok, wiring.detail)
  console.log('  接线取证: ' + wiring.evidence)

  /* ⑧ 供应器字节绑定（issue #1581）：provisionEsbuild 拉下来的 tgz 只认**仓内钉住**的 sha512。
   *    旧判据用 registry 响应自带的 dist.sha512 校验同一次响应指过来的 tarball（同源自证），
   *    且两个字段都缺席时整条校验跳过 —— 于是「镜像投毒」与「哈希缺席」两个方向都判绿。
   *    这里的负控刻意分成三条，分别钉住三个失效方向（改坏字节 / 缺钉 / 默认表被换成空表）。 */
  // 平台包全集 = esbuild 实际发布的组合（darwin 无 arm/ia32，linux 与 win32 各有四个）。
  // 用显式清单而不是「平台 × 架构」的笛卡尔积：后者会要求 esbuild 根本不存在的包，
  // 把「钉住表不完整」这条判据变成永远红的假红。
  const pinPlatforms = ['win32', 'linux', 'darwin']
  const pinArches = { win32: ['x64', 'arm64', 'ia32'], linux: ['x64', 'arm64', 'arm', 'ia32'], darwin: ['x64', 'arm64'] }
  const pinRequired = ['esbuild', ...pinPlatforms.flatMap((p) => pinArches[p].map((a) => '@esbuild/' + p + '-' + a))]
  const pinMissing = pinRequired.filter((n) => typeof ESBUILD_TARBALL_SHA512[n] !== 'string' || ESBUILD_TARBALL_SHA512[n].length === 0)
  const pinBuf = Buffer.from('syntax-floor-pin-fixture-bytes', 'utf8')
  const pinBufHash = createHash('sha512').update(pinBuf).digest('base64')
  const pinTable = { esbuild: pinBufHash }
  const pinCases = [
    ['正控：与钉住值一致的字节放行', tarballPinProblem('esbuild', pinBuf, pinTable) === null],
    ['负控：字节被改坏必须判红（旧实现只在 registry 自己给的哈希上比）',
      /不符/.test(String(tarballPinProblem('esbuild', Buffer.from('tampered', 'utf8'), pinTable)))],
    ['负控：钉住表里没有该包必须判红（旧实现在哈希缺席时直接解包执行）',
      /没有钉住/.test(String(tarballPinProblem('@esbuild/nowhere', pinBuf, pinTable)))],
    /* 默认实参必须是**真表**：若有人把默认值改成空表（或忘了传），下面两条会同时错向 ——
     * 真包名会报「没有钉住」而不是「不符」，未登记包名也会报「没有钉住」但第一条就红了。 */
    ['默认表生效：真包名 + 改坏字节报「不符」而非「没有钉住」',
      /不符/.test(String(tarballPinProblem('esbuild', Buffer.from('tampered', 'utf8'))))],
    ['默认表生效：真包名 + 任意字节都不会被放行',
      tarballPinProblem('esbuild', Buffer.from('tampered', 'utf8')) !== null],
  ]
  const pinJudgeOk = pinCases.every(([, ok]) => ok)
  check('⑧ 供应器字节绑定：esbuild tgz 只认仓内钉住的 sha512（缺钉/不符一律拒绝解包与执行）',
    pinJudgeOk && pinMissing.length === 0,
    '判定用例 ' + pinCases.filter(([, ok]) => !ok).map(([l]) => l).join(' / ')
    + (pinMissing.length > 0 ? '；钉住表缺 ' + pinMissing.join(',') + '（' + pinRequired.length + ' 个平台包必须全覆盖）' : ''))

  // ── 真实产物反向对照（C-2）：默认**自动启用**，不再是 opt-in ──
  // 真因：`--as-shipped <path>` 是 opt-in 且**没有任何调用方传它**（两条构建链调的是 `--scan`），
  // 于是「对真实出厂产物必须判红」这条最有力的反假绿证据**从未在本仓被执行过** —— 只有人工跑过一次。
  //
  // 判据取向（关键，别写成永红或永绿）：反向对照要的是**未降级的**出厂产物 ——
  //   · 已发布快照（release/**，降级步骤落地前构建的）→ 必须**判红**（AST 违规 > 0）；
  //   · 本机新建快照（.deploy-tmp/**，降级步骤落地后构建的）→ 应当**判绿**（这本身就是降级生效的反向证据）。
  // 故候选按「未降级优先」排序，取第一个在场的判红；若只找到已降级产物，则如实报告它绿（不假红）。
  const shippedCandidates = [
    argOf('as-shipped'),
    'release/v0.14.0-preview/snapshot/snapshot-arm64.tar.xz',
    'release/v0.14.0-preview/snapshot/snapshot-x86_64.tar.xz',
    '.deploy-tmp/snapshot-013/x86_64/snapshot.tar.xz',
    '.deploy-tmp/snapshot-013/arm64/snapshot.tar.xz',
  ].filter((p) => typeof p === 'string' && p.length > 0)
  const present = shippedCandidates.map((p) => (existsSync(join(ROOT, p)) ? join(ROOT, p) : (existsSync(p) ? p : null))).filter(Boolean)
  if (process.env.DSH_SYNTAX_FLOOR_SKIP_SHIPPED === '1') {
    console.log('  真实产物反向对照: SKIP（DSH_SYNTAX_FLOOR_SKIP_SHIPPED=1，显式跳过，未计数）')
  } else if (present.length === 0) {
    console.log('  真实产物反向对照: SKIP(#1)（已知出厂产物均不在场——裸 clone；候选: ' + shippedCandidates.join(', ') + '）')
  } else {
    // 优先挑「未降级」的那个做反向对照（判红）；降级后的读数作为正向证据一并打印。
    let redDemonstrated = null
    const readings = []
    for (const p of present.slice(0, 2)) {
      const mat = materialize(p)
      const r = await runScan(mat.root, mat.rels)
      mat.cleanup()
      const rel = p.startsWith(ROOT) ? p.slice(ROOT.length + 1).replace(/\\/g, '/') : p
      readings.push({ rel, astBad: r.astBad, staticTotal: r.staticTotal, diffHits: r.diffHits, total: r.total })
      if (r.astBad > 0 && r.diffHits > 0 && redDemonstrated === null) redDemonstrated = readings[readings.length - 1]
    }
    for (const x of readings) {
      console.log('  真实产物读数: ' + x.rel + ' → AST 违规文件 ' + x.astBad + '（staticBlocks ' + x.staticTotal
        + '）/ 差分命中 ' + x.diffHits + '/' + x.total)
    }
    // ── 产物全绿时的补充反向对照（0.2.2-rc.1 适配补）──────────────────────
    // 背景：降级步骤一旦真的生效，本机所有产物都会判绿，于是「未降级产物必须判红」这条
    // 就再也演示不出来了——但**判据本身仍然有效**，缺的只是「一份未降级输入」。
    // 早先的处置是让自检判红并要求外部提供 release/** 产物，结果是：本地永远红、
    // CI 因裸 clone 没有产物而 SKIP —— 两头都拿不到证据，这条判据实际处于失效状态。
    // 改法：从在场产物里取一个真实浏览器面文件，**注入一段真 static{}**（模拟降级前形态），
    // 再跑同一套判据，必须判红。这比依赖外部历史产物更可靠：它不依赖任何人记得留档，
    // 而且注入点是真实产物字节，不是合成 fixture（合成 fixture 已在 ② 里覆盖）。
    let injectedDemonstrated = null
    if (redDemonstrated === null && present.length > 0) {
      const source = present[0]
      const mat = materialize(source)
      try {
        const target = mat.rels.find((rel) => /lib\/client\.js$/.test(rel)) ?? mat.rels[0]
        if (target !== undefined) {
          const abs = join(mat.root, target.split('/').join(sep))
          const original = readFileSync(abs, 'utf8')
          // 注入点选在文件末尾之前，保证语法完整：一个带 static 块的类声明。
          writeFileSync(abs, original + '\nclass __SyntaxFloorReverseProbe { static { this.x = 1 } }\n')
          const r = await runScan(mat.root, mat.rels)
          const rel = (source.startsWith(ROOT) ? source.slice(ROOT.length + 1).replace(/\\/g, '/') : source)
          console.log('  注入式反向对照: ' + rel + ' 的 ' + target + ' 注入真 static{} → AST 违规文件 '
            + r.astBad + '（staticBlocks ' + r.staticTotal + '）/ 差分命中 ' + r.diffHits + '/' + r.total)
          if (r.astBad > 0 && r.diffHits > 0) {
            injectedDemonstrated = { rel, target, astBad: r.astBad, diffHits: r.diffHits }
          }
        }
      } finally {
        mat.cleanup()
      }
    }
    check('⑦ 真实出厂产物反向对照（默认启用，未降级产物必须判红）',
      redDemonstrated !== null || injectedDemonstrated !== null,
      redDemonstrated
        ? '未降级产物=' + redDemonstrated.rel + '（astBad=' + redDemonstrated.astBad + ' diffHits=' + redDemonstrated.diffHits + '）'
        : injectedDemonstrated
          ? '注入式=' + injectedDemonstrated.rel + ' / ' + injectedDemonstrated.target
            + '（astBad=' + injectedDemonstrated.astBad + ' diffHits=' + injectedDemonstrated.diffHits + '）'
          : '在场的 ' + readings.length + ' 个产物全部判绿（都已降级），且注入式对照也没能判红——本判据失效')
  }

  rmSync(tmp, { recursive: true, force: true })
  if (failures.length > 0) {
    console.error('CHECK-BROWSER-SYNTAX-FLOOR SELF-TEST FAILED（' + failures.length + ' 项）：' + failures.join('；'))
    process.exit(1)
  }
  console.log('CHECK-BROWSER-SYNTAX-FLOOR SELF-TEST PASSED（六向自证全绿 + 真实产物反向对照）')
  process.exit(0)
}

// ── 模式：--scan（门禁主模式）──────────────────────────────────────────────
const scanInput = argOf('scan') ?? argv.find((a) => !a.startsWith('--'))
if (!scanInput) {
  die('用法: node scripts/check-browser-syntax-floor.mjs --scan <stageRoot|tar.xz>'
    + ' | --degrade --stage <dir> | --self-test [--as-shipped <path>]')
}
const mat = materialize(scanInput)
const r = await runScan(mat.root, mat.rels)
mat.cleanup()
if (has('json')) {
  console.log(JSON.stringify({
    input: scanInput, total: r.total, kinds: r.kinds, scopes: r.scopes,
    astViolations: r.astBad, staticBlocks: r.staticTotal, parseDiagnostics: r.diagBad,
    diffHits: r.diffHits, targetHigh: TARGET_HIGH, targetLow: TARGET_LOW,
    esbuild: ESB.version, typescript: TS.version,
    failures: decide(r),
    files: r.rows.map((x) => ({ rel: x.rel, staticBlocks: x.staticBlocks, diagnostics: x.diagnostics, differs: x.differs })),
  }, null, 2))
  process.exit(decide(r).length === 0 ? 0 : 1)
}
const fails = report(r)
if (fails.length > 0) {
  console.error('CHECK-BROWSER-SYNTAX-FLOOR FAILED（' + fails.length + ' 项）：' + fails.slice(0, 3).join('；'))
  process.exit(1)
}
console.log('CHECK-BROWSER-SYNTAX-FLOOR PASSED（' + r.total + ' 个浏览器面文件：判据1 0 违规 + 判据2 差分归零）')
