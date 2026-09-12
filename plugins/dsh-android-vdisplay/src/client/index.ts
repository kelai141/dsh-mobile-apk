/**
 * 浏览器半：把「虚拟屏」注册为**右侧栏的同级 tab 类型**（与「工作区文件」同级），并把状态面板
 * 接到宿主只读端点 `GET /api/android/vdisplay/status` 的**真实返回**（fail-closed 四态）。
 *
 * 依据（用户约束 U-1，见 docs/0.14.0-preview-USER-CONSTRAINTS.md）：
 * 入口必须落在该面板上，不得另起与面板无关的入口。上游「工作区文件」= 右侧栏 tab 类型
 * （dsh/packages/client/ui-sidebar-files/src/client/locales.ts:24 的 guide.title），
 * 注册面 = 两阶段（dsh/packages/client/ui-sidebar-files/src/client/index.ts:37-56）：
 *   ① ctx.sidebarRightTabs.register({ id, kind, priority, title, guide? })
 *   ② ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key }, Body))
 *      以及可选的 sidebar.right.pane.tab.title（chip 标题）。
 *
 * 类型来源说明（临时，需在引擎暴露上游客户端类型后删除）：
 * 本插件当前没有 @deepseek-ai/dsh-client-ui-sidebar-right 的编译期类型（该包不在 devDependencies 内），
 * 因此这里用结构化本地类型 + SlotMap 本地 augmentation 表达同一契约；kind/scope 取自上游声明
 * （ui-sidebar-right/src/client/index.ts:158-159：{ kind: 'keyed', scope: 'session' }）。
 * 待引擎 overlay 提供该包类型后，必须改为
 * `import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'`
 * 并删除本地 augmentation（否则与上游声明冲突）。
 *
 * 数据面纪律：状态经只读 GET（与 ADB 授权块同风格）；本 Tab **不经 window.androidBridge 写面**、
 * 不合成像素（源文档 §9.2）。状态源不可达 = blocked（fail-closed，不假装可用）。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement, useEffect, useState, type ReactElement } from 'react'
import {
  readPanelState,
  VD_OPS,
  VD_STATUS_UNAVAILABLE,
  type FetchLike,
  type VdPanelState,
} from '../status.ts'

/** SlotMap 本地 augmentation：与上游 keyed/session 语义一致（临时性见文件头注释）。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.right.pane.tab': { kind: 'keyed'; scope: 'session' }
    'sidebar.right.pane.tab.title': { kind: 'keyed'; scope: 'session' }
  }
}

/** 本 tab 类型的 id（也是 body/title 两个 keyed seat 的 key）。 */
export const VD_TAB_ID = '@dsh-android/dsh-android-vdisplay'
/** 本 tab 类型在 tab 系统里的 kind。 */
export const VD_TAB_KIND = 'android-vdisplay'
/** 状态轮询间隔（毫秒）：只读、低频；面板打开时才有请求。 */
export const VD_POLL_MS = 10_000

/** 结构化定义（上游 SidebarRightTabDefinition 的最小面）。 */
interface TabDefinition {
  id: string
  kind: string
  priority?: 'extension' | 'builtin' | 'fallback'
  title: () => string
  guide?: Array<{ order: number; title: () => string; description: () => string }>
}
/** 结构化注册面（上游 SidebarRightTabRegistry 的最小面）。 */
interface TabRegistry {
  register(definition: TabDefinition): () => void
}

/** 必需服务：slots（tab body/title 两个 seat）。sidebarRightTabs 经 ctx.get 可选读取。 */
export const inject = ['slots'] as const

/**
 * 读一次状态端点并映射为四态。任何失败（网络、非 2xx、非法 JSON）都是 blocked，
 * 且带稳定错误码 `vdisplay-status-unavailable`（面板据此显示"为什么不可用"）。
 * @param fetchImpl - 可注入的 fetch（测试用；缺省用全局 fetch）。
 * @returns 面板状态。
 */
/** 浏览器 fetch 适配（状态读取逻辑在共享模块 status.ts，可离线验证）。 */
const browserFetch: FetchLike = (path, init) => fetch(path, init)

const STATE_LABEL: Record<VdPanelState['state'], string> = {
  disabled: '已关闭',
  blocked: '不可用',
  ready: '就绪',
  active: '已激活',
}

/** 面板主体：四态状态位 + 错误码 + 引导文案 + op 表 + 手动刷新。 */
function VdPanel(): ReactElement {
  const [snap, setSnap] = useState<VdPanelState>({
    state: 'blocked', code: VD_STATUS_UNAVAILABLE, detail: '正在读取状态…', ops: [...VD_OPS],
  })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    const pull = () => { void readPanelState(browserFetch).then((s) => { if (alive) setSnap(s) }) }
    pull()
    const timer = setInterval(pull, VD_POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [tick])

  return createElement('div', { className: 'dsh-vdisplay-panel', 'data-state': snap.state },
    createElement('div', { className: 'dsh-vdisplay-row' },
      createElement('strong', null, '虚拟屏'),
      createElement('span', { className: 'dsh-vdisplay-state' }, STATE_LABEL[snap.state])),
    createElement('div', { className: 'dsh-vdisplay-code' }, snap.code),
    createElement('div', { className: 'dsh-vdisplay-detail' }, snap.detail),
    snap.displayId === undefined
      ? null
      : createElement('div', { className: 'dsh-vdisplay-display' }, '虚拟屏 displayId = ' + snap.displayId),
    createElement('div', { className: 'dsh-vdisplay-ops' },
      'op 面（未登记，仅声明）：' + (snap.ops.length > 0 ? snap.ops.join(' / ') : VD_OPS.join(' / '))),
    createElement('button', {
      type: 'button',
      className: 'dsh-vdisplay-refresh',
      onClick: () => setTick((n) => n + 1),
    }, '刷新状态'))
}

/** chip 标题：与「工作区文件」同类。 */
function VdTitle(): ReactElement {
  return createElement('span', { className: 'dsh-vdisplay-title' }, '虚拟屏')
}

/**
 * 注册 tab 类型 + body + title。三处 contribution 全部经 ctx.effect（注册即 effect，
 * 随 fiber 释放回收）。sidebarRightTabs 缺席时只告警不抛错（fail-closed，不阻断客户端启动）。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const tabs = ctx.get('sidebarRightTabs') as TabRegistry | undefined
    if (!tabs) {
      ctx.logger?.('dsh-android-vdisplay')?.warn?.('sidebarRightTabs 服务缺席——虚拟屏 Tab 未注册（fail-closed）')
      return () => {}
    }
    return tabs.register({
      id: VD_TAB_ID,
      kind: VD_TAB_KIND,
      priority: 'extension',
      title: () => '虚拟屏',
      guide: [{
        order: 40,
        title: () => '虚拟屏',
        description: () => '在独立屏幕上运行第三方 App（Shizuku 特权通道），不挤占用户前台。',
      }],
    })
  }, 'dsh-android-vdisplay: tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: VD_TAB_ID, inject: () => ({}) },
    VdPanel,
  )), 'dsh-android-vdisplay: tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: VD_TAB_ID, inject: () => ({}) },
    VdTitle,
  )), 'dsh-android-vdisplay: tab title')
}
