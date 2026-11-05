/**
 * 通知设置行（0.14.1 块J FIX-4 的页面半）。
 *
 * 背景（J-1「FIX-4 名义落地、实际不可达」）：壳侧 `NotifyCenter.settingsSnapshot` /
 * `applySetting` / `onSuppressForegroundChanged` 三个入口在 `app/src/main` 全仓**零外部调用点**
 * （只有定义处互调），`AndroidBridge.kt` 的 35 个 `@JavascriptInterface` 无一涉及 notify/suppress，
 * 本目录亦 0 命中——能力在、入口无，与它要修的缺陷同形复发。本组件补上页面侧入口。
 *
 * 通道选择：桥方法（`window.androidBridge.getNotifySetting` / `setNotifySetting`）而不是 `/api` 路由。
 * 理由是**真源位置**：这些设置落在 Android 侧 `SharedPreferences("dsh-notify")`，引擎侧插件进程
 * 读不到它；桥是同一宿主内的唯一可达通道，与 `setImmersiveMode` / `setDevLogEnabled` /
 * `setOverlayEnabled` / `setVdisplayScale` 等既有设置面完全同构。因此不新增 `/api` 路由，
 * `scripts/api-route-auth-policy.json` 无需登记（该门禁只约束 `/api` 注册）。
 *
 * 数据面纪律（与 `GeneralSettings` / `DevSection` 同款）：
 *  - 全部状态经 `useShellState` 订阅（挂载读 + 可见/回前台重读），不在 `useState` 初值器里裸读桥；
 *  - **写后回读**：`setNotifySetting` 的返回带 `applied`，只有 `applied=true` 才展示为新值，
 *    否则保留壳侧回读值并如实显示失败原因（拒绝乐观置位）。
 */
import { useCallback, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useShellState } from '../mobile/use-shell-state.ts'
import { describeImportance, describeNotifyWriteFailure, noticeDataAttrs, type Notice } from '../user-copy.ts'
import { tr } from '../i18n.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '../android-bridge.ts'

/** 通知设置快照（壳侧 `NotifyCenter.settingsSnapshot` 的 JSON 形态）。 */
interface NotifySnapshot {
  ok?: boolean
  /** 前台也投递系统通知时为空；true = 前台抑制开启（工作汇报延后到后台补投）。 */
  suppressForeground?: boolean
  /** 本版默认值（false = 前台真发）。展示它让「当前值 vs 默认值」可区分。 */
  suppressForegroundDefault?: boolean
  /** 五类分类开关：report / question / approval / todo / silent。 */
  categories?: Record<string, boolean>
  /** 写入口附带的判定字段。 */
  applied?: boolean
  reason?: string
  key?: string
}

/**
 * 分类展示名 + **关掉会怎样**（与 `NotifyCenter.Face` 的五类一一对应；顺序即 UI 顺序）。
 *
 * 为什么每行必须带后果（0.14.1 批 4 / P0-5）：旧界面是五个纯标签开关，一行解释都没有。
 * 而关掉「提问 / 授权请求」的实际后果远重于其它三类——引擎侧 `ask_user_question` 与授权请求
 * **没有超时**，用户以为「少点打扰」，实际是任务永久挂起（现象是「AI 不动了」）。
 * 壳侧已把这类的关闭语义改成「不弹窗、不响铃，但仍投递到通知栏可作答」；文案必须如实说明这一点，
 * 否则用户仍在按旧语义做决定。
 */
const CATEGORY_LABELS: ReadonlyArray<readonly [string, string, string]> = [
  ['report', tr('工作汇报', 'Reports'), tr('关闭后不再提醒；任务本身不受影响', 'Off stops the alert; the task itself keeps running')],
  ['question', tr('提问', 'Questions'), tr('关闭 = 不弹窗、不响铃；提问仍会出现在通知栏、可直接作答（AI 在等你的回答）', 'Off stops pop-ups and sound; the question still appears in the shade and the model waits')],
  ['approval', tr('授权请求', 'Approvals'), tr('关闭 = 不弹窗、不响铃；仍需你在通知栏或应用内批准，工具不会自动放行', 'Off stops pop-ups and sound; you still have to approve, tools never auto-approve')],
  ['todo', tr('待办进度', 'Progress'), tr('关闭后不再显示步骤进度；任务本身不受影响', 'Off hides step progress; the task keeps running')],
  ['silent', tr('后台动态', 'Background'), tr('关闭后不再显示看门狗与引擎状态；只影响提示，不影响引擎', 'Off hides watchdog and engine status; the engine is unaffected')],
]

/**
 * 自检结果（壳侧 `NotifyCenter.selfCheck` 的 JSON 形态）。
 *
 * 为什么必须有这块 UI：`selfCheck` 与两个系统设置深链在页面侧**零调用点**——系统把渠道降级、
 * 或用户误关掉通知时，应用看得见、用户看不见，「系统已降级，应用无法调回」这句永远到不了眼前。
 *
 * 0.14.1 批 3（P3-1）：字段名按壳侧 `selfCheck` 的**真实形状**对齐。旧页面读的是
 * `degraded: string[]` 顶层数组，以及 `channelId`/`enabled` 两个壳侧从不发送的字段——
 * 于是 `degraded` 恒为 undefined ⇒ 界面**永远显示「系统通知状态正常」**（即使系统已把渠道降级）。
 * 这是「界面说的与事实相反」的典型形态，与本组件的存在理由正相反；两侧字段级契约现在由
 * `notify-settings.spec.tsx` 的断言钉住。
 */
interface NotifyChannelRow {
  category?: string
  label?: string
  /** 实际选中的渠道 id；空串 = 该语义已降级为静默。 */
  selected?: string
  /** 渠道在系统里是否存在。 */
  exists?: boolean
  importance?: number
  /** 壳侧给的人话档位（**优先于**页面侧的数值兜底）。 */
  importanceLabel?: string
  userSetImportance?: boolean
  /** 系统把该渠道降级了（应用无法调回）。 */
  degraded?: boolean
  guidance?: string
}

interface NotifySelfCheck {
  ok?: boolean
  notificationsEnabled?: boolean
  permissionGranted?: boolean
  permissionLabel?: string
  channels?: ReadonlyArray<NotifyChannelRow>
}

/** 读自检；桥缺席/不可解析返回 null（页面显示「不可用」，不伪造）。 */
function readSelfCheck(): NotifySelfCheck | null {
  try {
    const raw = window.androidBridge?.notifySelfCheck?.()
    if (raw === undefined || raw === '') return null
    const value = JSON.parse(raw) as NotifySelfCheck
    if (value === null || typeof value !== 'object') return null
    if (value.ok === false) return null
    return value
  } catch {
    return null
  }
}

/** 解析桥返回；不可解析/桥缺席一律返回 null（调用方据此显示「不可用」，不伪造状态）。 */
function parseSnapshot(raw: string | undefined): NotifySnapshot | null {
  if (raw === undefined || raw === '') return null
  try {
    const value = JSON.parse(raw) as unknown
    if (value === null || typeof value !== 'object') return null
    const snapshot = value as NotifySnapshot
    // `{ok:false}` = 壳侧明确拒绝（未绑定上下文等）：当作不可用，而不是当作「全部默认值」。
    if (snapshot.ok === false) return null
    return snapshot
  } catch {
    return null
  }
}

/** 读壳侧真源（每次调用现读；桥缺席返回 undefined）。 */
function readSettings(): string | undefined {
  try {
    return window.androidBridge?.getNotifySetting?.('')
  } catch {
    return undefined
  }
}

/**
 * 「通知」设置块：前台抑制开关 + 五类分类开关。
 * @returns 该设置分区内的一个功能块；桥不可用时只显示一行不可用说明。
 */
export function NotifySettingsRow() {
  const [raw, refresh] = useShellState<string | undefined>(readSettings, { pollMs: 0 })
  // 回执 = 人话正文 + 机器码；码只进 `data-code`（P3-1/P3-6）。
  const [message, setMessage] = useState<Notice | null>(null)
  // 自检按需拉取（用户点「通知自检」才读）：它是诊断面，不该在每次渲染都问壳侧。
  const [selfCheck, setSelfCheck] = useState<NotifySelfCheck | null>(null)
  const [selfCheckTried, setSelfCheckTried] = useState(false)

  const snapshot = parseSnapshot(raw)

  /** 写一项并**按返回读回**（applied=false 即未生效，不乐观置位）。 */
  const write = useCallback((key: string, value: boolean): void => {
    let reply: NotifySnapshot | null = null
    try {
      reply = parseSnapshot(window.androidBridge?.setNotifySetting?.(key, value))
    } catch {
      reply = null
    }
    if (reply === null) {
      setMessage({ text: tr('写入失败：应用内连接不可用（仅安卓应用内可用）——请重新打开应用后重试', 'Write failed: the app bridge is unavailable. Reopen the app and try again.') })
      refresh()
      return
    }
    if (reply.applied !== true) {
      // 壳侧如实回了 applied=false（未知 key / 读回不一致）：显示人话真因，不改展示值。
      // P3-1/P3-6：旧文案把码与内部 key 一起上屏（「未生效（readback-mismatch）：cat.question」），
      // 码与 key 现在只进 data-* 与日志。
      setMessage({ text: describeNotifyWriteFailure(reply.reason), ...(reply.reason === undefined ? {} : { code: reply.reason }) })
      refresh()
      return
    }
    setMessage(null)
    // 展示值只认壳侧回读：refresh() 重新从真源读，而不是把入参写进本地 state。
    refresh()
  }, [refresh])

  if (snapshot === null) {
    return (
      <div className="dsh-dev-notify" data-plugin="dev-notify-settings">
        <p className="dsh-dev-hint">{tr('通知设置不可用（桥未装配或壳侧上下文未绑定）。', 'Notification settings are unavailable (bridge missing or not bound).')}</p>
      </div>
    )
  }

  const suppress = snapshot.suppressForeground === true
  const isDefault = suppress === (snapshot.suppressForegroundDefault === true)
  const categories = snapshot.categories ?? {}
  const channelRows: ReadonlyArray<NotifyChannelRow> = selfCheck?.channels ?? []
  const degradedRows = channelRows.filter((row) => row.degraded === true)
  /** 渠道档位文本：壳侧人话优先，缺失才回退到页面侧的数值翻译（快照可能比 APK 新）。 */
  const importanceTextOf = (row: NotifyChannelRow): string =>
    row.importanceLabel !== undefined && row.importanceLabel !== ''
      ? row.importanceLabel
      : describeImportance(row.importance)

  return (
    <div className="dsh-dev-notify" data-plugin="dev-notify-settings">
      <div className="dsh-gs-row">
        <div className="dsh-gs-text">
          <div className="dsh-gs-title">{tr('前台抑制通知', 'Suppress while in front')}</div>
          <div className="dsh-gs-desc">
            {tr('应用在前台时不弹工作汇报（改为延后，回后台补投）', 'No report pop-ups while the app is in front; they are queued and delivered later')}
          </div>
        </div>
        <div className="dsh-gs-control">
          <Switch
            checked={suppress}
            onChange={(next) => { write('suppressForeground', next) }}
            label={tr('前台抑制通知', 'Suppress while in front')}
          />
        </div>
      </div>
      {/* 精简（0.14.7-B D5）：两段合成一段——开关行已经说明「开启 = 前台不弹」，这里只补
          「延后到哪、什么时候补投、哪些分类永不受影响」。 */}
      <p className="dsh-dev-hint">
        {tr('当前：', 'Now: ')}{suppress ? tr('前台抑制开启（工作汇报延后）', 'suppressed in front (reports queued)') : tr('前台照常推送', 'delivered in front too')}
        {isDefault ? tr('；等于本版默认值', '; this is the default') : tr('；已偏离本版默认值', '; changed from the default')}
        {tr('。开启后命中的工作汇报进入待投队列，回后台或再次关闭抑制时补投（队列有 TTL 与容量上限）；提问与授权请求永不受此项影响。', '. Queued reports are delivered when the app goes back or suppression is turned off (the queue is bounded). Questions and approvals are never suppressed.')}
      </p>

      {CATEGORY_LABELS.map(([key, label, consequence]) => (
        <div key={key} className="dsh-gs-row">
          <div className="dsh-gs-text">
            <div className="dsh-gs-title">{label}</div>
            <div className="dsh-gs-desc">{consequence}</div>
          </div>
          <div className="dsh-gs-control">
            <Switch
              checked={categories[key] === true}
              onChange={(next) => { write('cat.' + key, next) }}
              label={label}
            />
          </div>
        </div>
      ))}
      <div className="dsh-dev-row dsh-dev-actions">
        <Button
          size="sm"
          onClick={() => {
            setSelfCheckTried(true)
            setSelfCheck(readSelfCheck())
          }}
        >
          {tr('通知自检', 'Check notifications')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            let ok = false
            try {
              ok = window.androidBridge?.openNotifyAppSettings?.() === true
            } catch {
              ok = false
            }
            if (!ok) setMessage({ text: tr('该系统没有「应用通知设置」页——请在系统设置里手动找到本应用的通知项', 'This system has no app notification page. Find this app in system settings instead.') })
          }}
        >
          {tr('系统通知设置', 'System notification settings')}
        </Button>
        {/* S3-26：自证「哪几类真的能到达」。渠道状态看上面的自检，这里看**实际到达效果**——
            「我把提问提醒关了 / 系统降级了渠道之后，任务完成还会不会提醒我」是这一族最实际的疑问。 */}
        <Button
          size="sm"
          onClick={() => {
            let posted = 0
            try {
              posted = window.androidBridge?.notifySendTest?.() ?? 0
            } catch {
              posted = 0
            }
            setMessage(
              posted > 0
                ? { text: tr('已发送 ', 'Sent ') + String(posted) + tr(' 条测试通知（五类各一条）——请到通知栏看哪几条真的到了、哪几条是静默的', ' test notifications (one per category). Check the shade to see which arrived.') }
                : { text: tr('一条也没发出去：通知权限未授予或渠道不可用——请先在上面的自检里看渠道状态，并到系统设置里允许通知', 'Nothing was sent: notification permission is missing or the channel is unavailable. Check the status above and allow notifications in system settings.') },
            )
          }}
        >
          {tr('发送测试通知', 'Send a test notification')}
        </Button>
      </div>
      {selfCheckTried && selfCheck === null && (
        <p className="dsh-dev-warn">{tr('自检不可用（桥未装配或壳侧上下文未绑定）。', 'The self-check is unavailable (bridge missing or not bound).')}</p>
      )}
      {selfCheck !== null && (
        <div className="dsh-dev-notify-check">
          {/* 总开关与权限：任务完成却不提醒时，用户至少能在这里看到是哪一层被关了。 */}
          <p className="dsh-dev-hint">
            {tr('应用通知总开关：', 'App notifications: ')}{selfCheck.notificationsEnabled === false ? tr('系统已关闭', 'off in system') : tr('已开启', 'on')}
            {tr('；', '; ')}{tr('通知权限：', 'permission: ')}{selfCheck.permissionLabel ?? (selfCheck.permissionGranted === true ? tr('已授予', 'granted') : tr('未授予（任务完成不会提醒）', 'not granted (no alerts)'))}
          </p>
          {degradedRows.length > 0 ? (
            <p className="dsh-dev-warn">
              {tr('系统已降级以下通知：', 'The system muted these channels: ')}{degradedRows.map((row) => row.label ?? row.category ?? tr('未知渠道', 'unknown channel')).join(tr('、', ', '))}{tr('。应用无法调回，需在系统设置里恢复（可从右侧按钮进入）。', '. The app cannot undo this; restore it in system settings (use the button on the right).')}
            </p>
          ) : (
            <p className="dsh-dev-hint">{tr('系统未降级任何通知渠道。', 'No notification channel is muted by the system.')}</p>
          )}
          {channelRows.map((c) => (
            <div key={String(c.selected ?? c.category)} className="dsh-dev-row dsh-dev-check-row">
              <span>
                {(c.label ?? c.category ?? tr('未知渠道', 'unknown channel'))}
                {'：'}
                {c.degraded === true
                  ? tr('系统已降级', 'muted by system')
                  : (c.exists === false ? tr('渠道不存在', 'channel missing') : tr('正常', 'normal'))}
                {/* 档位口径优先取壳侧人话（P3-1：两侧同源，不各自翻译一遍）。 */}
                {importanceTextOf(c) === '' ? '' : '（' + importanceTextOf(c) + '）'}
              </span>
              <button
                type="button"
                className="dsh-dev-link"
                onClick={() => {
                  const channelId = String(c.selected ?? '')
                  let ok = false
                  try {
                    ok = channelId !== '' && window.androidBridge?.openNotifyChannelSettings?.(channelId) === true
                  } catch {
                    ok = false
                  }
                  if (!ok) setMessage({ text: tr('无法打开该渠道的系统设置页——请在系统设置里手动查找', 'The channel settings page did not open. Find it in system settings.') })
                }}
              >
                {tr('打开该渠道设置', 'Open channel settings')}
              </button>
            </div>
          ))}
        </div>
      )}
      {message !== null && (
        <p className="dsh-dev-warn" {...noticeDataAttrs(message)}>{message.text}</p>
      )}
    </div>
  )
}

/**
 * 「通知」设置分区（0.14.1 批 3 / P3-5）。
 *
 * 真因：本块此前的**唯一入口**在「开发者选项」里（`index.ts` 的 `settings.section` id
 * `android-dev`）。而「关掉提问提醒 = 引擎的提问被静默丢弃、任务永久挂起」这类后果，
 * 是**每个用户**都要面对的决定，把它埋在开发者选项等于对普通用户不可达
 * （审查档 §3.3 第 14 行：入口埋在开发者选项）。
 *
 * 现在的层级：设置页一级分区「通知」（`android-notify`，order 97），与「手机控制」（98）并列；
 * 开发者选项里保留一行**指路**文案，不重复渲染同一组开关（同功能双实现是审查档 §5 的结构性根因）。
 *
 * @returns 该设置分区的内容列。
 */
export function NotifySettingsSection(_props: PropsRuntime<'settings.section'>) {
  return (
    <section className="dsh-screen-control-card" aria-labelledby="dsh-notify-title">
      <header className="dsh-screen-control-header">
        <span>
          <strong id="dsh-notify-title">{tr('通知', 'Notifications')}</strong>
          <small>{tr('任务汇报、提问与授权请求的提醒方式；模型改不了这里的设置。', 'How reports, questions, and approvals alert you. The model cannot change this.')}</small>
        </span>
      </header>
      <NotifySettingsRow />
    </section>
  )
}
