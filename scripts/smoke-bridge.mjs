#!/usr/bin/env node
/**
 * smoke-bridge.mjs — dsh-android-bridge 宿主端冒烟（桌面，无需设备；两维模型 C6/C7 后）。
 *
 * 模型：引擎级授权（用户是否授权：门1 All Files Access + 门2 开关 + 门3 配对 + 无线调试）
 * × 会话级档位（AI 能否获取：sandboxPolicy.resolve({session}) 实时）。
 * 覆盖：只读 live prefs、GET status、通道工具 session 级 gate、
 *       **无自授信写面**（授权写面唯一在壳侧原生 AdbState）、env 兜底。
 * 运行：node scripts/smoke-bridge.mjs（先构建：cd plugins/dsh-android-bridge && npm run build）
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const work = join(root, '.deploy-tmp', 'smoke-bridge')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const PREFS = join(work, 'dsh-adb.xml')

// 引擎启动快照（模拟壳注入）：门2 关、未配对、门1 未授——live prefs 优先于这些值。
process.env.DSH_WRITE_MODE = 'danger-full-access' // 仅测试回退（引擎进程实际不注入）
process.env.DSH_ADB_ALLOW = '0'
process.env.DSH_ADB_PAIRED = '0'
process.env.DSH_ADB_WIRELESS = '0'
process.env.DSH_ADB_FULLACCESS = '0'
process.env.DSH_ADB_PREFS_PATH = PREFS
process.env.DSH_ADB_AUDIT_PATH = join(work, 'audit')

// 壳侧已写入的 prefs（模拟：用户此前经原生 AdbState 开过门2）
writeFileSync(PREFS, `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name="allowSwitch" value="true" />\n    <boolean name="paired" value="false" />\n</map>\n`)

const { apply } = await import(pathToFileURL(join(root, 'plugins', 'dsh-android-bridge', 'lib', 'index.js')).href)
const manageMod = await import(pathToFileURL(join(root, 'plugins', 'dsh-android-manage', 'lib', 'index.js')).href)

/**
 * runApply：fake cordis ctx；sandboxPolicy 提供 defaultMode + resolve（会话→模式映射）。
 * @returns { regs, tools, svc } tools = 注册的工具（channel 工具 execute 走真实 gate 链）；
 *   svc = bridge 的 androidPrivilege 服务（供 manage 集成断言）。
 */
function runApply({ defaultMode, sessionMode } = {}) {
  const regs = []
  const tools = []
  let svc
  const ctx = {
    provide(name, s) { if (name === 'androidPrivilege') svc = s },
    logger: () => ({ debug: () => {} }),
    tools: { register: (t) => tools.push(t) },
    webServer: { register: (r) => regs.push(r) },
    // 无 sandboxPolicy（非 androidPrivilege 场景）时 shell 仅提供档位回退面
    ...(defaultMode === undefined ? { shell: { sandboxMode: 'danger-full-access' } } : {}),
  }
  if (defaultMode !== undefined) {
    // sandboxPolicy 场景：shell = 可执行执行器（channel 走通时用）+ 档位回退面
    ctx.shell = {
      sandboxMode: defaultMode,
      resolve: (s) => s,
      run: async () => ({ stdout: 'ok-out', stderr: '' }),
    }
    ctx.sandboxPolicy = {
      defaultMode,
      resolve: ({ session } = {}) => ({
        mode: session === undefined ? defaultMode : (sessionMode?.get(session) ?? defaultMode),
      }),
    }
  }
  apply(ctx)
  return { regs, tools, svc }
}

/** manage 插件注册（并到同一 tools 数组，观察类工具经真实 androidPrivilege 门）。 */
function applyManage(svc, tools) {
  const ctx = {
    logger: () => ({ warn: () => {} }),
    tools: { register: (t) => tools.push(t) },
    androidPrivilege: svc,
  }
  manageMod.apply(ctx)
}

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else console.log('ok:', msg)
}

const statusOf = (regs) => Object.fromEntries(regs.map((r) => [r.path, r]))['/api/android/privilege/status']
const channelOf = (tools) => tools.find((t) => t.name === 'android_termux_channel_exec')

function callStatus(entry) {
  return new Promise((resolve) => {
    const req = { method: 'GET', on() {}, destroy() {} }
    const res = { writeHead(c) { this.code = c }, end(t) { resolve({ code: this.code, json: JSON.parse(t) }) } }
    entry.handler(req, res)
  })
}

async function callChannel(tool, command, session) {
  return tool.execute({ command }, { agent: session === undefined ? undefined : { session } })
}

// ── P1 初始：门1 未授予 → 引擎级不齐 → T0（FullAccess 引导）；通道拒绝 ──
{
  process.env.DSH_ADB_FULLACCESS = '0'
  const { regs, tools } = runApply({ defaultMode: 'workspace-write' })
  const st = (await callStatus(statusOf(regs))).json
  assert(st.tier === 'T0' && st.allowSwitchOn === true && st.paired === false, 'P1 T0（门2 live=true, 未配对）')
  assert(st.fullAccess === false && st.message.includes('所有文件访问'), 'P1 门1 未授予引导')
  const r = await callChannel(channelOf(tools), 'echo hi', 'sess-a')
  assert(r.ok === false && r.text.includes('未授权'), 'P1 通道拒绝（引擎级未授权）')
}

// ── P2 门1 授予 + 默认档位 workspace-write：引擎级就绪（差 pairing）→ T0；通道会话级拒绝 ──
{
  process.env.DSH_ADB_FULLACCESS = '1'
  const { regs, tools } = runApply({ defaultMode: 'workspace-write' })
  const st = (await callStatus(statusOf(regs))).json
  assert(st.fullAccess === true && st.writeMode === 'workspace-write' && st.tier === 'T0', 'P2 门1 授予；默认档位非 danger → T0')
  assert(st.message.includes('无线调试'), 'P2 未配对引导')
  const r = await callChannel(channelOf(tools), 'echo hi', 'sess-a')
  assert(r.ok === false && r.text.includes('未授权'), 'P2 通道拒绝（未配对，引擎级不齐）')
}

// ── P3 引擎级全齐（paired=true）+ 默认档位 danger：status T1；会话档位实时 gate ──
{
  writeFileSync(PREFS, `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name="allowSwitch" value="true" />\n    <boolean name="paired" value="true" />\n</map>\n`)
  process.env.DSH_ADB_FULLACCESS = '1'
  const { regs, tools, svc } = runApply({
    defaultMode: 'danger-full-access',
    sessionMode: new Map([['sess-danger', 'danger-full-access'], ['sess-ro', 'read-only'], ['sess-ws', 'workspace-write']]),
  })
  const st = (await callStatus(statusOf(regs))).json
  assert(st.tier === 'T1' && st.fullAccess === true && st.writeMode === 'danger-full-access', 'P3 引擎级全齐 + danger 默认档 → T1')

  // 会话级：danger → 通过（Termux run 被调用）
  const ok = await callChannel(channelOf(tools), 'echo hi', 'sess-danger')
  assert(ok.ok === true && ok.stdout === 'ok-out', 'P3 会话档位 danger → 通道执行成功')

  // 会话级：read-only / workspace-write → 实时拒绝
  const ro = await callChannel(channelOf(tools), 'echo hi', 'sess-ro')
  assert(ro.ok === false && ro.text.includes('会话级档位 read-only'), 'P3 会话切回 read-only → 实时拒绝')
  const ws = await callChannel(channelOf(tools), 'echo hi', 'sess-ws')
  assert(ws.ok === false && ws.text.includes('workspace-write'), 'P3 会话 ws → 实时拒绝')

  // 危险命令黑名单（授权后仍拦）
  const danger = await callChannel(channelOf(tools), 'rm -rf /', 'sess-danger')
  assert(danger.ok === false && danger.text.includes('危险命令'), 'P3 危险命令拦截（授权不豁免）')

  // 观察类工具（manage）同样是隐私敏感面：会话档位 read-only → 拒绝；danger → 通过
  applyManage(svc, tools)
  const screenshot = tools.find((t) => t.name === 'android_screenshot')
  const roShot = await screenshot.execute({}, { agent: { session: 'sess-ro' } })
  assert(roShot.denied === true && roShot.text.includes('会话级档位 read-only'), 'P3b 观察类：会话 read-only → 拒绝（隐私敏感面 danger-only）')
  const dangerShot = await screenshot.execute({}, { agent: { session: 'sess-danger' } })
  assert(dangerShot.denied === false, 'P3b 观察类：会话 danger → 放行')
}

// ── P4 自动审批不构成开放条件：approval 相关 env 不参与（无任何读取）——引擎级缺门时仍拒 ──
{
  process.env.DSH_ADB_FULLACCESS = '0'
  const { tools } = runApply({
    defaultMode: 'danger-full-access',
    sessionMode: new Map([['sess-danger', 'danger-full-access']]),
  })
  const r = await callChannel(channelOf(tools), 'echo hi', 'sess-danger')
  assert(r.ok === false && r.text.includes('所有文件访问'), 'P4 会话 danger + 门1 未授予 → 仍拒（自动审批无关）')
  process.env.DSH_ADB_FULLACCESS = '1'
}

// ── P5 无自授信写面 + prefs 未被引擎改写 ──
{
  const { regs } = runApply({ defaultMode: 'workspace-write' })
  assert(statusOf(regs) !== undefined, 'P5 status 端点存在')
  assert(regs.every((r) => r.path !== '/api/android/privilege/allow' && r.path !== '/api/android/privilege/pair' && r.path !== '/api/android/privilege/pair/revoke'), 'P5 无 allow/pair/revoke 写端点')
  const xml = readFileSync(PREFS, 'utf8')
  assert(xml.includes('<boolean name="allowSwitch" value="true" />') && xml.includes('<boolean name="paired" value="true" />'), 'P5 prefs 值未被引擎改写')
}

// ── P6 env 兜底：无 prefs 文件 → env 启动快照 ──
{
  rmSync(PREFS, { force: true })
  const { regs } = runApply({ defaultMode: 'workspace-write' })
  const st = (await callStatus(statusOf(regs))).json
  assert(st.allowSwitchOn === false && st.paired === false, 'P6 env 兜底（0/0）')
}

console.log(process.exitCode === 1 ? '=== SMOKE FAIL ===' : '=== SMOKE PASS ===')
