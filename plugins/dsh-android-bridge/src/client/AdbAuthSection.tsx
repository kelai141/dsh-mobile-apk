/**
 * 「安卓调试授权」设置分区：三道人门状态 + 授权操作。
 *
 * 状态源：GET /api/android/privilege/status（宿主端只读 live 壳侧 SharedPreferences，
 * 3 秒轮询 + 每次变更后强制刷新）。
 * **授权变更例外——不设引擎 POST 端点**（Shizuku 对照：被提权方不得自改授权）：
 * 全部经 window.androidBridge 原生桥（setAdbAllow / setAdbPair / revokeAdbPair），
 * 由壳侧 AdbState 持久化 + 原生审计；桥不存在（桌面）时动作按钮禁用并提示。
 *
 * 安全边界（PRD F1.7）：
 *  - 门1 完全访问档位：应用不可程序化授予 → 按钮跳系统设置（androidBridge），授予后重启引擎生效；
 *  - 门2 允许访问开关：默认关闭；开启前危险明示 + 二次确认（确认后调原生桥）；
 *  - 门3 配对码：六位数字；码值绝不上审计（壳侧只记长度）；真实握手随通道接入；
 *  - 自动审批模式不构成开放条件（宿主端判定）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
// 壳注入 JS 桥（授权变更唯一通道 = 原生 AdbState；门1跳系统设置同样走它）。
interface AndroidShellBridge {
  setAdbAllow?: (enable: boolean) => void
  /** 0.14 真实配对：6 位码 + 系统「无线调试」弹窗的配对端口/连接端口（码值只进壳侧 adb argv）。 */
  setAdbPair?: (code: string, pairPort: number, connectPort: number) => boolean | void
  revokeAdbPair?: () => void
  requestAllFilesAccess?: () => void
  hasAllFilesAccess?: () => boolean
  /** 自动扫描系统无线调试端口（issue #80）：返回配对端口候选 JSON 数组文本（端序）。 */
  discoverAdbPorts?: () => string
}

/** 宿主端点状态面（AdbStatus 的页面投影）。 */
interface AdbStatusView {
  tier: 'T0' | 'T1'
  fullAccess: boolean
  writeMode?: string
  wirelessDebugOn?: boolean
  allowSwitchOn?: boolean
  paired?: boolean
  connected?: boolean
  message?: string
}

/** DevSection 子槽 entry props（框架注入；本块不使用 owner share → unknown 即可）。 */
export type AdbAuthSectionProps = unknown

const STATUS_REFRESH_MS = 3000
const CONFIRM_ALLOW_TEXT = {
  on: {
    title: '开启「允许访问」？',
    desc: '开启后，安卓调试桥（ADB）授权通道由完全访问档位进入可授权状态：手机管理工具可执行输入事件、截图、包管理等 shell 级操作，且通行三段式授权门。此开关默认关闭，关闭即通道失败关闭（立即失效）。',
    ok: '开启',
  },
  off: {
    title: '关闭「允许访问」？',
    desc: '关闭后 ADB 授权通道立即失败关闭：所有需授权的手机管理操作会被拒绝，直到你再次开启并完成授权。',
    ok: '关闭',
  },
  revoke: {
    title: '回收配对？',
    desc: '断开调试连接并删除本机配对密钥，通道立即失败关闭。注：系统侧授权（adb 已配对名单）需在「无线调试」开关重新打开后才彻底清除。重启后配对本就需要重新进行（安全特性）。',
    ok: '回收',
  },
} as const

type ConfirmKind = keyof typeof CONFIRM_ALLOW_TEXT | null

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init)
  const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; status?: AdbStatusView } | null
  if (!r.ok || j === null || j.ok === false) {
    throw new Error(j?.error ?? `HTTP ${r.status}`)
  }
  return j as T
}

function statusFetch(): Promise<AdbStatusView> {
  return api<AdbStatusView>('/api/android/privilege/status')
}

/** 原生桥取用（壳 WebView 注入；桌面/非壳宿主为 undefined → 控件禁用）。 */
function nativeBridge(): AndroidShellBridge | undefined {
  try {
    return (window as unknown as { androidBridge?: AndroidShellBridge }).androidBridge
  } catch {
    return undefined
  }
}

/**
 * Render the ADB authorization block (DevSection child seat).
 * @param _props - composed slot props (contract: settings.dev.item entry share).
 * @returns the block element tree.
 */
export function AdbAuthSection(_props: AdbAuthSectionProps) {
  const [status, setStatus] = useState<AdbStatusView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [pairCode, setPairCode] = useState('')
  const [pairPort, setPairPort] = useState('')
  const [connectPort, setConnectPort] = useState('')
  const [confirm, setConfirm] = useState<ConfirmKind>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const st = await statusFetch()
      if (mounted.current) {
        setStatus(st)
        setError(null)
      }
    } catch (e) {
      if (mounted.current) setError('状态查询失败：' + String((e as Error).message))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => void refresh(), STATUS_REFRESH_MS)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const runMutation = useCallback(async (okMsgText: string, action: () => void) => {
    setBusy(true)
    setError(null)
    setOkMsg(null)
    const bridge = nativeBridge()
    if (!bridge) {
      setError('授权变更需在安卓壳应用内进行（原生桥不可用）')
      setBusy(false)
      return
    }
    try {
      action()
      setOkMsg(okMsgText)
      await refresh()
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const askAllow = useCallback((enabled: boolean) => setConfirm(enabled ? 'on' : 'off'), [])
  const askRevoke = useCallback(() => setConfirm('revoke'), [])
  const cancelConfirm = useCallback(() => setConfirm(null), [])

  const doConfirm = useCallback(async () => {
    if (confirm === null) return
    const kind = confirm
    setConfirm(null)
    const bridge = () => nativeBridge()
    if (kind === 'revoke') {
      await runMutation('已回收配对，请重新输入配对码', () => bridge()?.revokeAdbPair?.())
    } else {
      await runMutation(
        kind === 'on' ? '已开启「允许访问」' : '已关闭「允许访问」',
        () => bridge()?.setAdbAllow?.(kind === 'on'),
      )
    }
  }, [confirm, runMutation])

  const scanPorts = useCallback(async () => {
    const b = nativeBridge()
    if (!b || typeof b.discoverAdbPorts !== 'function') {
      setError('自动扫描需在安卓壳应用内进行（原生桥不可用）')
      return
    }
    setScanning(true)
    setError(null)
    setOkMsg(null)
    try {
      const text = b.discoverAdbPorts() ?? '{}'
      const j = JSON.parse(text) as { pair?: number | null; connect?: number | null; candidates?: unknown }
      const pair = typeof j.pair === 'number' ? j.pair : null
      const conn = typeof j.connect === 'number' ? j.connect : null
      const cands = Array.isArray(j.candidates)
        ? j.candidates.filter((x): x is number => typeof x === 'number' && x > 0)
        : []
      // 精确属性优先；缺失时用候选第一个（同簇配对/连接相邻）。
      const p1 = pair ?? cands[0] ?? null
      const c1 = conn ?? cands[1] ?? p1
      if (p1 === null || c1 === null) {
        setError('未发现无线调试端口：请确认「开发者选项 → 无线调试」已开启')
        return
      }
      setPairPort(String(p1))
      setConnectPort(String(c1))
      const extra = cands.length > 0 ? `（候选 ${cands.join('/')}）` : ''
      setOkMsg(`已自动填入端口：配对 ${String(p1)} / 连接 ${String(c1)}${extra}`)
    } catch (e) {
      setError('端口扫描失败：' + String((e as Error).message))
    } finally {
      setScanning(false)
    }
  }, [])

  const submitPair = useCallback(async () => {
    if (!/^\d{6}$/.test(pairCode)) {
      setError('配对码需为系统「无线调试」弹窗中的 6 位数字')
      return
    }
    const p = Number(pairPort)
    const c = Number(connectPort)
    if (pairPort === '' || connectPort === '') {
      setError('请先「自动扫描端口」，或手动填写系统「无线调试」弹窗中的配对端口与连接端口')
      return
    }
    if (!Number.isInteger(p) || !Number.isInteger(c) || p < 1 || p > 65535 || c < 1 || c > 65535) {
      setError('端口无效：请抄录「无线调试」弹窗中的配对端口与连接端口（1-65535）')
      return
    }
    await runMutation('配对请求已提交（真实握手；结果以状态区为准）', () => {
      const b = nativeBridge()
      // 防御（2026-08-24 真机实锤「输什么都显示配对成功」）：桥缺失或未提供 setAdbPair 时
      // 可选链会静默返回 undefined —— `ok === false` 恒 false → 前端误报「配对完成」。
      // 必须在调用前显式失败，绝不静默当成功。
      if (!b || typeof b.setAdbPair !== 'function') {
        throw new Error('配对需在安卓壳应用内进行（原生桥不可用）')
      }
      const ok = b.setAdbPair(pairCode, p, c)
      if (ok === false) throw new Error('配对失败：请核对 6 位码与端口（无线调试弹窗）')
    })
    setPairCode('')
    setPairPort('')
    setConnectPort('')
  }, [pairCode, pairPort, connectPort, runMutation])

  const requestAllFiles = useCallback(() => {
    try {
      ;(window as unknown as { androidBridge?: AndroidShellBridge }).androidBridge?.requestAllFilesAccess?.()
    } catch {
      /* bridge absent: desktop fallback no-op */
    }
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') cancelConfirm()
    },
    [cancelConfirm],
  )

  const granted = status?.tier?.startsWith('T1') === true
  const confirmText = confirm !== null ? CONFIRM_ALLOW_TEXT[confirm] : null

  return (
    <div className="adb-auth" data-plugin="adb-auth" onKeyDown={onKeyDown}>
      <p className="adb-auth-note">
        安卓调试授权三道门：完全访问档位（前置）→ 系统无线调试开启 → 应用内「允许访问」开关 → 输入配对码。
        配对为真实握手（adb pair）：码值与端口取自系统「无线调试」弹窗（IP 固定 127.0.0.1），
        配对码只在壳侧使用、绝不出壳。自动审批不构成开放条件；重启后需重新配对（安全特性）。
      </p>

      <div className={granted ? 'adb-auth-tier adb-auth-tier-ok' : 'adb-auth-tier adb-auth-tier-bad'}>
        <span>{granted ? '已授权（T1）' : '未授权（T0）'}</span>
        {status?.message ? <span className="adb-auth-tier-sub">{status.message}</span> : <span className="adb-auth-tier-sub">通道可用</span>}
      </div>

      <div className="adb-auth-gate">
        <div className="adb-auth-gate-main">
          <span className="adb-auth-gate-title">门1 · 完全访问档位（All Files Access）</span>
          <span className="adb-auth-gate-desc">在系统设置授予「所有文件访问」；授予后重启引擎生效</span>
        </div>
        {status?.fullAccess
          ? <span className="adb-auth-chip adb-auth-chip-ok">已授予</span>
          : (
            <>
              <span className="adb-auth-chip adb-auth-chip-bad">未授予</span>
              <button type="button" className="adb-auth-btn" onClick={requestAllFiles}>去授权</button>
            </>
          )}
      </div>

      <div className="adb-auth-gate">
        <div className="adb-auth-gate-main">
          <span className="adb-auth-gate-title">会话档位（ADB 能力开关 · 实时）</span>
          <span className="adb-auth-gate-desc">ADB 能力（**含观察类**：截图/界面树/设备信息——隐私敏感面）只在会话档位 danger-full-access 下开放；会话内 /permission 实时切换（切回 read-only 立即关闭）；自动审批不构成开放条件</span>
        </div>
        {status?.writeMode === 'danger-full-access'
          ? <span className="adb-auth-chip adb-auth-chip-ok">danger-full-access</span>
          : <span className="adb-auth-chip adb-auth-chip-bad">{status?.writeMode ?? '未知'}</span>}
      </div>

      <div className="adb-auth-gate">
        <div className="adb-auth-gate-main">
          <span className="adb-auth-gate-title">门2 · 系统无线调试</span>
          <span className="adb-auth-gate-desc">开发者选项 → 无线调试（配对成功即视为已开启）</span>
        </div>
        {status?.wirelessDebugOn
          ? <span className="adb-auth-chip adb-auth-chip-ok">已开启</span>
          : <span className="adb-auth-chip adb-auth-chip-bad">未开启</span>}
      </div>

      <label className="adb-auth-switch-row">
        <input
          type="checkbox"
          checked={status?.allowSwitchOn ?? false}
          disabled={busy}
          onChange={(e) => askAllow(e.target.checked)}
        />
        <span>门3 · 应用内「允许访问」开关（关闭即失败关闭）</span>
      </label>

      {status?.paired ? (
        <div className="adb-auth-pair">
          <span className="adb-auth-chip adb-auth-chip-ok">已配对</span>
          {status.connected === true
            ? <span className="adb-auth-chip adb-auth-chip-ok">已连接</span>
            : status.connected === false
              ? <span className="adb-auth-chip adb-auth-chip-bad">连接待确认</span>
              : null}
          <button type="button" className="adb-auth-btn adb-auth-btn-danger" disabled={busy} onClick={askRevoke}>
            回收配对
          </button>
        </div>
      ) : (
        <div className="adb-auth-pair">
          <input
            className="adb-auth-input"
            inputMode="numeric"
            maxLength={6}
            placeholder="输入 6 位配对码"
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <input
            className="adb-auth-input adb-auth-input-port"
            inputMode="numeric"
            placeholder="配对端口"
            value={pairPort}
            onChange={(e) => setPairPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
          />
          <input
            className="adb-auth-input adb-auth-input-port"
            inputMode="numeric"
            placeholder="连接端口"
            value={connectPort}
            onChange={(e) => setConnectPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
          />
          <button
            type="button"
            className="adb-auth-btn"
            disabled={busy || scanning}
            onClick={() => void scanPorts()}
            title="自动扫描系统无线调试的配对/连接端口（无需手动抄录）"
          >
            {scanning ? '扫描中…' : '自动扫描端口'}
          </button>
          <button
            type="button"
            className="adb-auth-btn"
            disabled={busy || scanning || pairCode.length !== 6}
            onClick={() => void submitPair()}
            title={pairCode.length !== 6 ? '先输入 6 位配对码' : '发起配对（可先自动扫描端口，或手动填写）'}
          >
            配对
          </button>
        </div>
      )}

      {error !== null && <p className="adb-auth-error">{error}</p>}
      {okMsg !== null && <p className="adb-auth-ok">{okMsg}</p>}

      <div className="adb-auth-actions">
        <button type="button" className="adb-auth-btn" disabled={busy} onClick={() => void refresh()}>刷新状态</button>
      </div>

      {confirmText !== null && (
        <div
          className="adb-auth-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={confirmText.title}
          onClick={cancelConfirm}
        >
          <div
            className="adb-auth-modal"
            role="document"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="adb-auth-modal-title">{confirmText.title}</p>
            <p className="adb-auth-modal-desc">{confirmText.desc}</p>
            <div className="adb-auth-modal-actions">
              <button type="button" className="adb-auth-btn" autoFocus onClick={cancelConfirm}>取消</button>
              <button
                type="button"
                className={confirm === 'revoke' ? 'adb-auth-btn adb-auth-btn-danger' : 'adb-auth-btn'}
                onClick={() => void doConfirm()}
              >{confirmText.ok}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
