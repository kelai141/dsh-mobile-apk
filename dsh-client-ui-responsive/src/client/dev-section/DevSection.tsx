/**
 * Developer-options settings page (Android shell facilities): restart / shut down (both with a
 * custom confirm) / refresh UI / open console / dev debug-log toggle. Registered at the upstream
 * settings.section extension point (auto-projected by ui-settings-general's nav, zero upstream
 * changes). Bridge calls go through window.androidBridge (injected by MainActivity's
 * addJavascriptInterface).
 *
 * Restart and shut down draw a custom frontend confirm because WebView's window.confirm is
 * unreliable under the shell's auto-approving onJsAlert; "Shut down" stops the engine and falls
 * back to the init screen (shell shutdownToGuide bridge).
 */
import { useCallback, useEffect, useState } from 'react'
import { useShellState } from '../mobile/use-shell-state.ts'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls in the settings.section owner share (erased at build time, types only).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Single source of truth for the bridge types (incl. the Window.androidBridge global).
import type {} from '../android-bridge.ts'

/** Full section props: the settings shell supplies only `close`, plus the
 *  developer-options child seat (adb authorization panel et al) this section declares. */
export type DevSectionProps = PropsRuntime<'settings.section'> & Partial<PropsRenderSlots<'settings.dev.item'>>

/** 壳侧悬浮球开关真值回读（桥不可用/抛错 → false）。
 *  ST-02（页侧半边）：壳侧 getOverlayEnabled() = 偏好 && 悬浮窗权限 && 服务实例在场，
 *  权限缺失时偏好已回落 false —— 展示值只能以该回读为准，不得沿用上次的 UI 值。 */
function readOverlayEnabled(): boolean {
  try {
    return window.androidBridge?.getOverlayEnabled?.() ?? false
  } catch {
    return false
  }
}

const CONFIRM_TEXT: Record<'restart' | 'close', { title: string; desc: string; ok: string }> = {
  restart: {
    title: '重启 DeepSeek Harness？',
    desc: '将终止并自动重新启动本地引擎与页面（约数秒）。未发送的内容会保留在输入框。',
    ok: '重启',
  },
  close: {
    title: '关闭并回退到初始化界面？',
    desc: '将停止本地引擎并退出到初始化界面；引擎不会自动重启，需手动再次启动。',
    ok: '关闭',
  },
}

/**
 * Render the developer-options section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function DevSection({ renderSlot }: DevSectionProps) {
  // ST-09：四处壳侧状态全部经 useShellState 订阅（挂载 + 可见/回前台重读 + 写后回读），
  // 不再裸写一次性桥读 —— 组件内不得在 useState 初值器里直读 window.androidBridge。
  const [devLog, refreshDevLog] = useShellState<boolean>(() => {
    try {
      return window.androidBridge?.getDevLogEnabled?.() ?? false
    } catch {
      return false
    }
  })
  // 0.13.2 W7：悬浮球开关（壳侧持久化 + overlay 权限引导；未授权返回 false 并自动跳系统设置）。
  // ST-02：展示值一律以桥回读为准（壳侧 = 偏好 && 权限 && 服务在场），不做乐观置位。
  const [overlayOn, refreshOverlay] = useShellState<boolean>(readOverlayEnabled)
  const [overlayMsg, setOverlayMsg] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [allFiles] = useShellState<boolean>(() => {
    try {
      return window.androidBridge?.hasAllFilesAccess?.() ?? false
    } catch {
      return false
    }
  })
  const [confirm, setConfirm] = useState<'restart' | 'close' | null>(null)
  // F5.1/D15（2026-08-23 补齐）：文件直达临时工作区占用 + 一键清理（R16 手动清理 + 占用展示）
  const [incomingBytes, setIncomingBytes] = useState<number | null>(null)
  const [incomingMsg, setIncomingMsg] = useState<string | null>(null)
  const [cleaning, setCleaning] = useState(false)

  const refreshIncoming = useCallback(async () => {
    try {
      // FX-205.6：端点带插件侧鉴权——浏览器面凭据是 same-origin 会话 cookie，必须显式声明。
      const r = await fetch('/api/android/file-incoming', { credentials: 'same-origin', cache: 'no-store' })
      if (r.status === 401 || r.status === 403) {
        setIncomingMsg('未获授权（HTTP ' + r.status + '）——来件状态不可读')
        return
      }
      if (r.ok) {
        const j = (await r.json()) as { bytes?: number }
        setIncomingBytes(typeof j.bytes === 'number' ? j.bytes : null)
      }
    } catch {
      /* 非安卓宿主：静默 */
    }
  }, [])

  useEffect(() => {
    void refreshIncoming()
  }, [refreshIncoming])

  // 来件占用的可见/回前台刷新（F5 消费端同款路径）。壳侧状态的同类重读由 useShellState 负责。
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      void refreshIncoming()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refreshIncoming])

  const cleanIncoming = useCallback(async () => {
    setCleaning(true)
    setIncomingMsg(null)
    try {
      const r = await fetch('/api/android/file-incoming/clean', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
      if (r.status === 401 || r.status === 403 || r.status === 405) {
        setIncomingMsg('清理未获授权（HTTP ' + r.status + '）——仅限本机壳侧/已授权页面')
        return
      }
      const j = (await r.json().catch(() => null)) as { ok?: boolean; removed?: number } | null
      // FX-205.5：清理范围收敛为「本工具自有临时项」，用户放入工作区的文件不再被删。
      setIncomingMsg(j?.ok ? `已清理本工具临时项（${j.removed ?? 0} 项）——相关会话中的文件引用将失效` : '清理失败')
    } catch {
      setIncomingMsg('清理请求失败（仅安卓宿主可用）')
    } finally {
      setCleaning(false)
      void refreshIncoming()
    }
  }, [refreshIncoming])

  const fmtBytes = (n: number): string => {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
    return n + ' B'
  }

  const askRestart = useCallback(() => setConfirm('restart'), [])
  const askClose = useCallback(() => setConfirm('close'), [])
  const cancelConfirm = useCallback(() => setConfirm(null), [])

  const doRestart = useCallback(() => {
    setConfirm(null)
    setRestarting(true)
    try {
      window.androidBridge?.restartEngine?.()
    } catch {
      /* bridge absent: nothing to do */
    }
    window.setTimeout(() => setRestarting(false), 2000)
  }, [])

  const doClose = useCallback(() => {
    setConfirm(null)
    try {
      window.androidBridge?.shutdownToGuide?.()
    } catch {
      /* bridge absent: nothing to do */
    }
  }, [])

  const reload = useCallback(() => {
    try {
      window.androidBridge?.reloadWebUI?.()
    } catch {
      /* bridge absent: nothing to do */
    }
  }, [])

  const openConsole = useCallback(() => {
    try {
      window.androidBridge?.openConsole?.()
    } catch {
      /* bridge absent: nothing to do */
    }
  }, [])

  const toggleLog = useCallback((enabled: boolean) => {
    try {
      window.androidBridge?.setDevLogEnabled?.(enabled)
    } catch {
      /* bridge absent: nothing to do */
    }
    // 写后回读（§4.5 七模式之五）：展示值 = 壳侧真值，不做乐观置位
    // （ST-11 落地后 getDevLogEnabled = 偏好 && 采集器在跑，回读即真实采集状态）。
    refreshDevLog()
  }, [refreshDevLog])

  // 0.13.2 W7：悬浮球开关（实时查看 AI 工具调用 + 停止）。
  const toggleOverlay = useCallback((enabled: boolean) => {
    setOverlayMsg(null)
    try {
      const started = window.androidBridge?.setOverlayEnabled?.(enabled) ?? false
      // ST-02：开关以桥回读为准（权限缺失时壳侧偏好已回落 false），不再乐观置位；
      // 「返回后自动生效」因此不再成立——必须回前台重读 + 用户重新打开开关。
      refreshOverlay()
      if (enabled && !started) {
        setOverlayMsg('已打开系统授权页；授予后请重新打开本开关')
      } else if (enabled) {
        setOverlayMsg('悬浮球已开启：任意界面可拖拽；点开面板实时查看工具调用，可一键停止')
      } else {
        setOverlayMsg('悬浮球已关闭')
      }
    } catch {
      setOverlayMsg('桥不可用（仅安卓宿主支持悬浮球）')
    }
  }, [refreshOverlay])

  // 0.13.1 W4：配置导入/导出（安全手改通道——引擎读私有目录，外部改共享副本无效）。
  const [configMsg, setConfigMsg] = useState<string | null>(null)

  const exportConfig = useCallback(() => {
    try {
      const raw = window.androidBridge?.exportConfig?.()
      const j = JSON.parse(raw ?? '{}') as { ok?: boolean; path?: string; error?: string }
      setConfigMsg(j.ok ? `已导出到 ${j.path ?? 'exports/config/settings.yaml'}` : `导出失败：${j.error ?? '未知错误'}`)
    } catch {
      setConfigMsg('导出失败：桥不可用（仅安卓宿主可用）')
    }
  }, [])

  const importConfig = useCallback(() => {
    try {
      const raw = window.androidBridge?.importConfig?.()
      const j = JSON.parse(raw ?? '{}') as { ok?: boolean; hint?: string; error?: string }
      setConfigMsg(j.ok ? `已导入并生效（原配置备份为 settings.yaml.import-backup）。${j.hint ?? ''}` : `导入失败：${j.error ?? '未知错误'}`)
    } catch {
      setConfigMsg('导入失败：桥不可用（仅安卓宿主可用）')
    }
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') cancelConfirm()
    },
    [cancelConfirm],
  )

  const logPathHint = allFiles === false
    ? '未授予「所有文件访问」：日志将写入应用私有目录，授权后自动切换公共目录。'
    : '开启后按天写入 Documents/dshdata/log/dsh-<日期>.log。'

  return (
    <div data-plugin="dev-section" onKeyDown={onKeyDown}>
      <p className="dsh-dev-note">
        Android 壳调试设施：控制台为快照内嵌 Termux bash；日志默认关闭。
      </p>

      {/* 开发者选项子区（2026-08-23）：ADB 授权面板等设施经 settings.dev.item 挂载 */}
      {renderSlot?.('settings.dev.item', {})}

      <div className="dsh-dev-row">
        <button type="button" className="dsh-dev-btn" onClick={askRestart} disabled={restarting}>
          {restarting ? '重启中…' : '重启'}
        </button>
        <button type="button" className="dsh-dev-btn dsh-dev-danger" onClick={askClose}>关闭</button>
        <button type="button" className="dsh-dev-btn" onClick={reload}>刷新界面</button>
        <button type="button" className="dsh-dev-btn" onClick={openConsole}>打开控制台</button>
      </div>

      <label className="dsh-dev-row dsh-dev-switch">
        <input
          type="checkbox"
          checked={devLog}
          onChange={(e) => toggleLog(e.target.checked)}
        />
        <span>开发者调试日志</span>
      </label>

      {/* 0.13.2 W7：悬浮球（实时工具流 + 停止） */}
      <label className="dsh-dev-row dsh-dev-switch">
        <input
          type="checkbox"
          checked={overlayOn}
          onChange={(e) => toggleOverlay(e.target.checked)}
        />
        <span>悬浮球（实时查看 AI 工作，可一键停止）</span>
      </label>
      {overlayMsg !== null && <p className="dsh-dev-hint">{overlayMsg}</p>}

      {/* 0.13.1 W4：配置导入/导出（安全手改通道；引擎读私有目录，改共享目录副本无效） */}
      <div className="dsh-dev-row">
        <button type="button" className="dsh-dev-btn" onClick={exportConfig}>导出配置</button>
        <button type="button" className="dsh-dev-btn" onClick={importConfig}>导入配置</button>
      </div>
      {configMsg !== null && <p className="dsh-dev-hint">{configMsg}</p>}
      <p className="dsh-dev-hint">
        导出位置 Documents/dshdata/exports/config/settings.yaml；用文件管理器修改后点「导入配置」即可生效。
        配置不含 API 密钥（密钥在应用私有目录，不随导出泄漏）。
      </p>

      {/* F5.1/D15：文件直达临时工作区（占用展示 + 一键清理；PRD R16 手动清理 + 占用展示） */}
      {incomingBytes !== null && (
        <div className="dsh-dev-row">
          <span>
            文件直达临时工作区占用：{fmtBytes(incomingBytes)}
          </span>
          <button type="button" className="dsh-dev-btn dsh-dev-danger" disabled={cleaning || incomingBytes === 0} onClick={() => void cleanIncoming()}>
            {cleaning ? '清理中…' : '一键清理'}
          </button>
        </div>
      )}
      {incomingMsg !== null && <p className="dsh-dev-hint">{incomingMsg}</p>}
      <p className="dsh-dev-hint">清理会删除临时工作区内的外部文件；相关会话中的文件引用将失效（D15：纯手动清理，无自动清理）。</p>
      <p className="dsh-dev-hint">{logPathHint}</p>
      <p className="dsh-dev-warn">日志包含命令与模型内容，仅用于排查，请及时清理。</p>

      {confirm !== null && (
        <div
          className="dsh-dev-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={CONFIRM_TEXT[confirm].title}
          onClick={cancelConfirm}
        >
          <div
            className="dsh-dev-modal"
            role="document"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="dsh-dev-modal-title">{CONFIRM_TEXT[confirm].title}</p>
            <p className="dsh-dev-modal-desc">{CONFIRM_TEXT[confirm].desc}</p>
            <div className="dsh-dev-modal-actions">
              <button
                type="button"
                className="dsh-dev-btn"
                autoFocus
                onClick={cancelConfirm}
              >取消</button>
              <button
                type="button"
                className={confirm === 'close' ? 'dsh-dev-btn dsh-dev-danger' : 'dsh-dev-btn'}
                onClick={confirm === 'restart' ? doRestart : doClose}
              >{CONFIRM_TEXT[confirm].ok}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
