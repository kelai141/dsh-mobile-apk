/**
 * 虚拟屏（Shizuku 特权通道）宿主半 — 0.14.0 迭代「虚拟屏」线 S1。
 *
 * 职责边界（与源文档 §6.2 架构 A 对齐）：
 *  - **本插件不承载像素**。画面唯一路径是壳侧原生 `SurfaceView` 的 Surface 直接作虚拟屏输出
 *    （源文档 §9.2：禁止把像素经引擎编码→传输→WebView 解码）；右侧栏 Tab 只承载开关/状态/控制。
 *  - 宿主半做两件事：① 注册只读状态端点 `GET /api/android/vdisplay/status`（右侧栏面板的数据源）；
 *    ② 注册 `android_vdisplay_status` 工具（模型面）；两者与桥面同源（`readVdSnapshot`）。
 *
 * `vd*` 的登记是本迭代**独立批次**，不得在本文件落地：新增 op 必须一次改齐六处
 * （壳侧 `DeviceControlService.handle` / `ControlProtocolV2.SUPPORTED_OPS` / 引擎 `ControlOp` /
 * `A11Y_OPS` / `ROUTE_OPS` / manage 工具面），并通过 `scripts/check-control-ops.mjs`（差集 = 0）。
 * 两条硬约束：① `vd*` 是特权面操作，**不得**进 `A11Y_OPS`（无障碍承载不了跨屏建屏/拉应用，
 * 与源文档 §8.2「browser* 不进 A11Y_OPS」同一条推理）；② 登记同批必须跑门禁，漏一处即工具不可达（坑 52）。
 *
 * 端点鉴权口径（坑 78）：上游路由是「exact 表先于 prefix 表」，exact 路由挂在 `/api/...` 下会
 * **绕过**该前缀的 cookie 鉴权——本端点与 ADB 授权块的 `/api/android/privilege/status` 同口径
 * （均为 exact、无令牌），前提是**载荷不含机密**：只有能力状态、错误码、引导文案、op 表与虚屏 id。
 * 一旦将来要返回任何敏感值（路径、包名清单、像素），必须自带令牌或改走受鉴权的前缀路由。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readVdSnapshot, VD_STATUS_PATH, type VdisplayFace } from './status.js'

export { VD_OPS, VD_STATUS_PATH, mapStatusPayload, readVdSnapshot } from './status.js'
export type { VdOp, VdPanelState, VdSnapshot, VdState, VdStatusPayload, VdisplayFace } from './status.js'

export const name = '@dsh-android/dsh-android-vdisplay'

/**
 * 必需服务：`tools`（`ctx.tools.register` 是属性访问——坑 82 同形态：未声明 inject 时 cordis
 * 取属性直接抛 "cannot get property ... without inject"，整条 loader entry 失败 → 引擎启动即死）。
 * 可选服务（`webServer` / `androidPrivilege`）一律走 `ctx.get(...)`，缺失即降级（不阻塞 fiber）。
 */
export const inject = ['tools'] as const

/** 浏览端面用的最小 res 契约（与 bridge 的 exact 路由同口径，不 import 跨包类型）。 */
interface WsReq {
  method?: string
  url?: string
}
interface WsRes {
  statusCode?: number
  setHeader?(name: string, value: string): void
  end(body: string): void
}

/** 只读 JSON 响应。 */
function sendJson(res: WsRes, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * 宿主半入口：注册只读状态端点与状态工具。开关未接通前不注册任何特权 op、不改任何默认路径。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  const faceOf = (): VdisplayFace | undefined => ctx.get('androidPrivilege') as VdisplayFace | undefined

  ctx.tools.register(defineTool({
    name: 'android_vdisplay_status',
    description:
      '查询虚拟屏（Shizuku 特权通道）的能力与运行状态：开关、fail-closed 探测结果、可用 op 表、'
      + '错误码与补救指引。本工具只读、不改设备状态；返回 ok=false 时表示当前不可用（看 code/guidance），'
      + '此时仍可用真实屏控制。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          enabled: { type: 'boolean', required: true },
          state: { type: 'string', required: true },
          code: { type: 'string', required: true },
          guidance: { type: 'string', required: true },
          ops: { type: 'array', required: true, items: { type: 'string' } },
          transports: { type: 'array', items: { type: 'string' } },
          displayId: { type: 'integer' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: String(v.guidance ?? '') }],
    },
    execute: async () => {
      const snap = readVdSnapshot(faceOf())
      return { ...snap, text: snap.ok ? snap.guidance : '虚拟屏不可用：' + snap.code + '。' + snap.guidance }
    },
  }))

  // 右侧栏面板的数据源（只读；与工具面同源）。webServer 服务缺席时只告警：面板会走
  // "状态源不可达 → blocked"，不影响引擎启动，也不假装可用。
  // 可选服务一律走 ctx.get（不 inject）：属性访问 ctx.webServer 在未声明 inject 时会抛
  // cannot get property "webServer" without inject——与 tools 同一条 cordis 规则（坑 82）。
  const wsvc = ctx.get('webServer') as { register(r: unknown): void } | undefined
  if (!wsvc) {
    ctx.logger?.('dsh-android-vdisplay')?.warn?.('webServer 服务缺席——状态端点未注册（面板将显示 blocked）')
    return
  }
  wsvc.register({
    kind: 'exact',
    path: VD_STATUS_PATH,
    handler: async (req: WsReq, res: WsRes) => {
      if (req.method !== undefined && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, code: 'vdisplay-method-not-allowed' })
        return
      }
      sendJson(res, 200, readVdSnapshot(faceOf()))
    },
  })
}
