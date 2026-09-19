#!/usr/bin/env node
// check-manifest-hardening.mjs — manifest / 备份规则 / NSC 加固门禁（0.13.8 PR-B3 apk #183；
// 0.13.8-b 批 B2 FX-208.4 / FX-208.E1：从「字面量在场」改为「解析 XML 语义」）
//
// 旧实现的假绿：只断言三个 xml **被引用**、只查 `isTrustedSender` 字面量。于是
//   NSC 改全域明文 / 删空 exclude / 加第二个 <application> / 删来源校验 四种改动全 PASS。
// 现按 XML 结构断言（自建轻量解析器，非行级字面量匹配）：
//   1. manifest 恰好一个 <application>；allowBackup="false"；无 usesCleartextTraffic="true"；
//      networkSecurityConfig / dataExtractionRules / fullBackupContent 三处引用在场。
//   2. exported 语义：每个带 <intent-filter> 的组件显式声明 android:exported；
//      exported="true" 的组件集合 == 显式白名单（新增未登记的公开口即拒）；
//      exported="true" 的组件必须有 android:permission，或只用受保护系统广播 + 源码来源校验。
//   3. NSC 语义（0.14.1 块K 起：姿态由「默认禁明文」改为「撑开明文」）：
//      base-config 显式声明 cleartextTrafficPermitted="true"；回环保留面（127.0.0.1 / localhost /
//      10.0.2.2）逐字在场且不多不少；无第二个 base-config、无「无 <domain> 的明文 domain-config」。
//      跨层同向（准入面放行 http ⇔ NSC 撑开明文）由 JVM 测试 BrowserHostCleartextConsistencyTest
//      守，本文件只断言该测试仍被接线。
//   4. exclude 语义：backup_rules 与 data_extraction_rules（cloud-backup + device-transfer）
//      必须逐条覆盖 REQUIRED_EXCLUDES（删任意一条即拒，空 exclude 即拒）。
//
// 用法：node scripts/check-manifest-hardening.mjs [--root <apk 仓根或协调仓根>]
//   --root 仅用于反向验证（合成夹具树）；缺省自动探测。也可用环境变量 DSH_APK_ROOT。
// 退出码：0 = 通过；1 = 失败（拒打包/拒合）或树定位失败。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const OVERRIDE = rootIdx >= 0 ? argv[rootIdx + 1] : process.env.DSH_APK_ROOT

const hasApkTree = (dir) => existsSync(join(dir, 'app', 'src', 'main'))
const CANDIDATES = OVERRIDE
  ? [resolve(OVERRIDE)]
  : [ROOT, join(ROOT, 'dsh-mobile-apk'), resolve(join(ROOT, '..'))]
const APK_ROOT = CANDIDATES.find(hasApkTree)
if (!APK_ROOT) {
  console.error('MANIFEST-HARDENING FAILED：找不到含 app/src/main 的树（协调仓布局应为 <根>/dsh-mobile-apk，'
    + 'apk 仓自包含布局应为 <根> 本身）')
  console.error('  候选：' + CANDIDATES.join('、'))
  process.exit(1)
}
const MAIN = join(APK_ROOT, 'app', 'src', 'main')
console.log('APK 树: ' + (relative(ROOT, APK_ROOT) || APK_ROOT))

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

// ── 轻量 XML 解析（结构感知，非字面量 grep）──────────────────────────────────
/** 解析为 { name, attrs, children, parent, selfClosing } 节点树；注释/CDATA/声明按类型跳过。 */
function parseXml(text) {
  const doc = { name: '#document', attrs: {}, children: [], parent: null, text: '' }
  const stack = [doc]
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  let m
  let last = 0
  while ((m = re.exec(text)) !== null) {
    const chunk = text.slice(last, m.index)
    const top = stack[stack.length - 1]
    if (/[^\s]/.test(chunk)) top.text = (top.text ?? '') + chunk
    last = re.lastIndex
    const [, close, name, rawAttrs, slash] = m
    if (name === undefined) {
      // 注释 / CDATA / 声明：CDATA 内容按文本计入宿主节点
      if (m[0].startsWith('<![CDATA[')) top.text = (top.text ?? '') + m[0].slice(9, -3)
      continue
    }
    if (close === '/') {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) { stack.length = i; break }
      }
      continue
    }
    const attrs = {}
    const attrRe = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let a
    while ((a = attrRe.exec(rawAttrs)) !== null) attrs[a[1]] = a[2] ?? a[3]
    const node = { name, attrs, children: [], parent: stack[stack.length - 1], selfClosing: slash === '/' }
    node.parent.children.push(node)
    if (slash !== '/') stack.push(node)
  }
  const tail = text.slice(last)
  if (/[^\s]/.test(tail)) {
    const top = stack[stack.length - 1]
    top.text = (top.text ?? '') + tail
  }
  return doc
}
const childrenNamed = (node, name) => node.children.filter((c) => c.name === name)
const descendants = (node, name) => {
  const out = []
  const walk = (n) => { for (const c of n.children) { if (c.name === name) out.push(c); walk(c) } }
  walk(node)
  return out
}
const texts = (node) => descendants(node, 'domain').map((d) => (d.text ?? '').trim())

const read = (p) => {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

// ── 1/2. manifest ────────────────────────────────────────────────────────────
const manifestPath = join(MAIN, 'AndroidManifest.xml')
const manifestText = read(manifestPath)
if (manifestText === null) check('AndroidManifest.xml 在场', false, manifestPath)
const manifest = manifestText === null ? null : parseXml(manifestText)

// exported="true" 白名单（新增公开发面必须显式登记并在此处说明理由）。
// name -> { reason, guard: 'permission' | 'user-facing' | 'source-check' }
const EXPORTED_ALLOW = new Map([
  ['.MainActivity', { reason: '启动器 + ACTION_VIEW/SEND 分享入口（用户可见入口，无特权面）', guard: 'user-facing' }],
  ['.AdbKeyboardService', { reason: 'IME 服务，android:permission=BIND_INPUT_METHOD', guard: 'permission' }],
  ['.DeviceControlService', { reason: '无障碍服务，android:permission=BIND_ACCESSIBILITY_SERVICE', guard: 'permission' }],
  ['.AdbKeyboardReceiver', { reason: 'ADB 输入广播，源码 isTrustedSender 校验', guard: 'source-check' }],
  ['.BootReceiver', { reason: 'BOOT_COMPLETED（受保护系统广播）', guard: 'permission' }],
  ['rikka.shizuku.ShizukuProvider', { reason: 'Shizuku 官方 Binder bootstrap；INTERACT_ACROSS_USERS_FULL 保护 provider', guard: 'permission' }],
])
const PROTECTED_SYSTEM_ACTIONS = new Set([
  'android.intent.action.BOOT_COMPLETED',
  'android.intent.action.LOCKED_BOOT_COMPLETED',
  'android.intent.action.MY_PACKAGE_REPLACED',
  'android.intent.action.TIME_SET',
  'android.intent.action.TIMEZONE_CHANGED',
])
const COMPONENTS = ['activity', 'service', 'receiver', 'provider', 'activity-alias']

/** 源码级来源校验（review §2.3）：去注释后要求**调用形态** isTrustedSender( —— 旧实现只查子串，
 * 注释里提一句就能假绿。字符串字面量近似不计（该标识符不出现在 UI 文案）。 */
const stripKotlinComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
const hasTrustedSenderCall = (src) => /isTrustedSender\s*\(/.test(stripKotlinComments(src))

const REQUIRED_EXCLUDES = [
  ['file', 'home/.dsh/.credentials.yaml'],
  ['file', 'home/.dsh/sessions/'],
  ['file', 'home/.dsh/storages/'],
  ['file', 'home/.dsh/attachments/'],
  ['file', 'home/.dsh/workspaces/'],
  ['file', 'home/.dsh/undo-snapshots/'],
  ['file', 'home/.dsh/models-store.json'],
  ['file', 'deepseek-key.txt'],
  ['file', 'dashscope-key.txt'],
  ['sharedpref', 'dsh_engine_auth.xml'],
  ['sharedpref', 'dsh-adb.xml'],
]

if (manifest) {
  const apps = descendants(manifest, 'application')
  check('恰好一个 <application>（重复声明即拒）', apps.length === 1, 'count=' + apps.length)
  const app = apps[0]
  const allow = app?.attrs['android:allowBackup']
  check('allowBackup="false"', allow === 'false', 'value=' + JSON.stringify(allow))
  check('无 usesCleartextTraffic="true"（NSC 接管）', app?.attrs['android:usesCleartextTraffic'] !== 'true')
  check('networkSecurityConfig 已配置',
    app?.attrs['android:networkSecurityConfig'] === '@xml/network_security_config',
    'value=' + JSON.stringify(app?.attrs['android:networkSecurityConfig']))
  check('dataExtractionRules 已配置',
    app?.attrs['android:dataExtractionRules'] === '@xml/data_extraction_rules')
  check('fullBackupContent 已配置',
    app?.attrs['android:fullBackupContent'] === '@xml/backup_rules')

  const components = apps.flatMap((a) => COMPONENTS.flatMap((kind) => childrenNamed(a, kind).map((c) => ({ kind, node: c }))))
  const noFilter = []
  const exportedTrue = []
  for (const { kind, node } of components) {
    const name = node.attrs['android:name'] ?? '(无名)'
    const hasFilter = childrenNamed(node, 'intent-filter').length > 0
    if (hasFilter && node.attrs['android:exported'] === undefined) noFilter.push(kind + ' ' + name)
    if (node.attrs['android:exported'] === 'true') exportedTrue.push({ kind, node, name })
  }
  check('带 <intent-filter> 的组件都显式声明 android:exported', noFilter.length === 0, noFilter.join('、'))

  const names = new Set(components.map(({ node }) => node.attrs['android:name']))
  const unexpected = exportedTrue.filter(({ name }) => !EXPORTED_ALLOW.has(name)).map(({ name }) => name)
  const missing = [...EXPORTED_ALLOW.keys()].filter((n) => !names.has(n))
  check('exported="true" 组件集合 == 白名单（新增公开面须登记）',
    unexpected.length === 0 && missing.length === 0,
    '未登记=' + unexpected.join('、') + ' 白名单缺席=' + missing.join('、'))

  const unguarded = []
  for (const { kind, node, name } of exportedTrue) {
    if (node.attrs['android:permission']) continue
    const entry = EXPORTED_ALLOW.get(name)
    if (entry?.guard === 'user-facing') continue
    const actions = descendants(node, 'action').map((a) => a.attrs['android:name'])
    const protectedOnly = actions.length > 0 && actions.every((a) => PROTECTED_SYSTEM_ACTIONS.has(a))
    if (protectedOnly && entry?.guard !== 'source-check') continue
    if (kind === 'receiver') {
      const cls = join(MAIN, 'java', 'com', 'dsharnessmobile', 'shell', name.replace(/^\./, '') + '.kt')
      const src = read(cls)
      if (src !== null && hasTrustedSenderCall(src)) continue
      unguarded.push(name + '（无 android:permission，且源码无 isTrustedSender 调用）')
      continue
    }
    unguarded.push(name + '（无 android:permission）')
  }
  check('exported="true" 组件有权限或来源校验', unguarded.length === 0, unguarded.join('、'))
}

// ── 3. network security config（0.14.1 块K：姿态由「默认禁明文」改为「撑开明文」）─────────
//
// 变更与理由：issue #232 确证「准入面放行 http、平台 NSC 禁非本机明文」是自相矛盾的一对，
// 用户的裁定方向是**撑开 NSC**（详见 res/xml/network_security_config.xml 头注释与
// docs/0.14.1-preview-ISSUE232-BROWSER-RECEIPT.md §3.2）。旧断言把「base 禁明文」锁死，
// 与新姿态直接冲突，故本段按新形态重写。
//
// 新形态断言的是**真正要守的东西**（而不是换一个方向的字面量）：
//   ① base-config 必须**显式**声明 cleartextTrafficPermitted（缺省=false 是平台默认，漏写即静默收紧）；
//   ② 其值必须是 "true"（本轮拍板姿态）——一旦有人回退成 false，本门禁判红；
//   ③ **不得与任何 per-domain 明文配置共存**（0.14.1 装机实测的致命项，见下）；
//   ④ 不得出现**第二个** base-config；
//   ⑤ 跨层同向由 JVM 测试 BrowserHostCleartextConsistencyTest 守（真实调用准入面函数 + 解析本文件），
//      本段只断言该测试仍被接线（删掉它即红）——避免「改了 NSC 却没人守准入面」的单边演进。
//
// ③ 为什么是**冲突检查**而不是「回环三项逐字在场」（0.14.1 装机实测实锤，必读）：
//   Android 源码 `ApplicationConfig.handleNewApplication()` 的规则是
//     `if (defaultConfig.isCleartextTrafficPermitted() != config.isCleartextTrafficPermitted())`
//     `  { if (defaultConfig.hasPerDomainConfigs() || config.hasPerDomainConfigs())`
//     `      throw new RuntimeException("Found multiple conflicting per-domain rules"); }`
//   —— 即「base 与 per-domain 的明文判定不一致 + 存在 per-domain 配置」就**抛异常**。
//   本应用是**多进程**（主进程 + Shizuku UserService 进程等），各进程读到的配置实例不同，
//   一旦 base 放开 + 又留 per-domain 明文声明，UserService 进程 **起不来**
//   （实测：`ShizukuServiceStarter: unable to start service … Found multiple conflicting per-domain rules`），
//   导致虚拟屏全线 `shizuku-user-service-connecting`（块G/F6 能力整体不可用）。
//   旧值 `base=false` + 回环 domain=true 时各进程判定一致，故历史上没暴露——**这正是它危险的地方**。
//   因此本段把判据从「回环三项在不在」改为「**base 放开明文时不得存在 per-domain 配置**」：
//   守恒的是**同一件事**（明文姿态），但判据对准了真正的崩溃成因。
//   注：base 允许全部明文 ⊇ 回环，故删掉回环 domain-config **不缩小**任何实际放行面。
const NSC_LOOPBACK = ['127.0.0.1', 'localhost', '10.0.2.2']
const nscText = read(join(MAIN, 'res', 'xml', 'network_security_config.xml'))
check('network_security_config.xml 在场', nscText !== null)
if (nscText !== null) {
  const nsc = parseXml(nscText)
  const base = descendants(nsc, 'base-config')
  check('恰好一个 base-config', base.length === 1, 'count=' + base.length)
  const baseValue = base.length === 1 ? base[0].attrs['cleartextTrafficPermitted'] : undefined
  check('base-config 显式声明 cleartextTrafficPermitted（漏写即平台默认 false，属静默收紧）',
    baseValue !== undefined, 'value=' + JSON.stringify(baseValue))
  check('base-config cleartextTrafficPermitted="true"（0.14.1 块K 拍板姿态；回退成 false 即判红）',
    baseValue === 'true', 'value=' + JSON.stringify(baseValue))
  // ③ 冲突检查（装机实测的崩溃成因）：base 放开明文时，任何 per-domain 配置都可能让
  //    多进程间判定分歧 → 抛 "Found multiple conflicting per-domain rules" → UserService 起不来。
  const perDomains = descendants(nsc, 'domain-config')
  check('base 放开明文时不得存在任何 domain-config（多进程会抛 multiple conflicting per-domain rules，'
    + '实测致 Shizuku UserService 起不来、虚拟屏全不可用）',
    !(baseValue === 'true' && perDomains.length > 0),
    'domain-config 数量=' + perDomains.length
    + '；若确需 per-domain 明文（如只放行回环），必须把 base 改回 false（回到 0.14.0 语义，'
    + '届时「非本机 http 一律失败」的 issue #232 会复发——两者不可兼得）')
  // 反向对照：base=false + 回环 domain=true 是**合法**形态（旧语义），不得被判红——
  // 否则门禁会挡住「回退到 0.14.0 语义」这条正当修复路径。
  const legacy = parseXml('<network-security-config>'
    + '<base-config cleartextTrafficPermitted="false" />'
    + '<domain-config cleartextTrafficPermitted="true">'
    + NSC_LOOPBACK.map((h) => '<domain includeSubdomains="false">' + h + '</domain>').join('')
    + '</domain-config></network-security-config>')
  const legacyPer = descendants(legacy, 'domain-config')
  const legacyBase = descendants(legacy, 'base-config')[0].attrs['cleartextTrafficPermitted']
  check('反向对照：base=false + 回环 domain=true（0.14.0 语义）不被本判据误伤',
    !(legacyBase === 'true' && legacyPer.length > 0))
  // 跨层不变式的接线（实现与真实函数调用在 JVM 测试里，这里只守「测试没被删」）。
  const xlayer = join(MAIN, '..', 'test', 'java', 'com', 'dsharnessmobile', 'shell', 'BrowserHostCleartextConsistencyTest.kt')
  const xlayerText = read(xlayer)
  check('跨层明文一致性测试在场（准入面放行 http ⇔ NSC 撑开明文）', xlayerText !== null)
  if (xlayerText !== null) {
    check('跨层明文一致性测试真实调用准入面函数（禁改为文本在场判据）',
      xlayerText.includes('BrowserHostNavigationPolicy.normalize('))
    check('跨层明文一致性测试解析 NSC 本体（禁硬编码放行集合）',
      xlayerText.includes('network_security_config.xml'))
  }
}

// ── 4. backup rules（exclude 语义）─────────────────────────────────────────
const excludeKey = (n) => (n.attrs['domain'] ?? '') + '|' + (n.attrs['path'] ?? '')
const REQUIRED_KEYS = REQUIRED_EXCLUDES.map(([d, p]) => d + '|' + p)
const checkExcludes = (label, file, groups) => {
  const text = read(file)
  if (text === null) { check(label + ' 在场', false, file); return }
  const doc = parseXml(text)
  for (const group of groups) {
    const holders = group === null ? [doc] : descendants(doc, group)
    if (holders.length === 0) { check(label + ' 含 <' + group + '>', false); continue }
    const present = new Set(holders.flatMap((h) => descendants(h, 'exclude')).map(excludeKey))
    const missingKeys = REQUIRED_KEYS.filter((k) => !present.has(k))
    check(label + ' / ' + (group ?? 'root') + ' 覆盖全部 exclude（' + REQUIRED_KEYS.length + ' 条）',
      missingKeys.length === 0, '缺失=' + missingKeys.join('、'))
  }
}
checkExcludes('backup_rules.xml', join(MAIN, 'res', 'xml', 'backup_rules.xml'), [null])
checkExcludes('data_extraction_rules.xml', join(MAIN, 'res', 'xml', 'data_extraction_rules.xml'), ['cloud-backup', 'device-transfer'])

if (failures.length > 0) {
  console.error('MANIFEST-HARDENING FAILED: ' + failures.join('；'))
  process.exit(1)
}
console.log('MANIFEST-HARDENING PASSED')
