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
import { describeHttpFailure, noticeDataAttrs, type Notice } from '../user-copy.ts'
import { tr } from '../i18n.ts'
import { RuntimeCacheRow } from './runtime-cache.tsx'
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

/**
 * 破坏性/中断性操作的二次确认文案（0.14.1 批 9 / S3-14）。
 *
 * 为什么三处都要确认：同一页里「运行时缓存清理」原本有确认弹窗，而「一键清理临时工作区」
 * 与「关闭」一样是**单击即执行**的破坏性操作——同一个页面里同级破坏力却有两种确认强度，
 * 用户无法从外观预判哪一下会真的删东西（审查档 §3.3 第 14 行）。
 */
const confirmText = (): Record<'restart' | 'close' | 'clean', { title: string; desc: string; ok: string }> => ({
  restart: {
    title: tr('重启 DeepCode？', 'Restart DeepCode?'),
    desc: tr('将终止并自动重新启动本地引擎与页面（约数秒）。未发送的内容会保留在输入框。', 'The local engine and page restart in a few seconds. Unsent text stays in the box.'),
    ok: tr('重启', 'Restart'),
  },
  close: {
    title: tr('关闭并回退到初始化界面？', 'Close and return to the start screen?'),
    desc: tr('将停止本地引擎并退出到初始化界面；引擎不会自动重启，需手动再次启动。', 'The local engine stops and the app returns to the start screen. It will not restart by itself.'),
    ok: tr('关闭', 'Close'),
  },
  clean: {
    title: tr('清理临时工作区？', 'Clear the temporary workspace?'),
    desc: tr(
      '将删除文件直达（分享进来）的临时文件；相关会话中的文件引用会失效，无法恢复。会话本身、附件、配置与凭据不受影响。',
      'Temporary files received by sharing are deleted; references in sessions stop working and cannot be restored. Sessions, attachments, settings, and credentials are untouched.',
    ),
    ok: tr('清理', 'Clear'),
  },
})

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
  /** 重启/刷新等动作的失败回执（S3-15：旧实现在桥缺席时显示「重启中…」两秒后自己变回去）。 */
  const [actionMsg, setActionMsg] = useState<Notice | null>(null)
  const [allFiles] = useShellState<boolean>(() => {
    try {
      return window.androidBridge?.hasAllFilesAccess?.() ?? false
    } catch {
      return false
    }
  })
  const [confirm, setConfirm] = useState<'restart' | 'close' | 'clean' | null>(null)
  // F5.1/D15（2026-08-23 补齐）：文件直达临时工作区占用 + 一键清理（R16 手动清理 + 占用展示）
  const [incomingBytes, setIncomingBytes] = useState<number | null>(null)
  // 回执 = 人话正文 + 机器码；码只进 `data-http`（P3-1/P3-6）。
  const [incomingMsg, setIncomingMsg] = useState<Notice | null>(null)
  const [cleaning, setCleaning] = useState(false)

  const refreshIncoming = useCallback(async () => {
    try {
      // FX-205.6：端点带插件侧鉴权——浏览器面凭据是 same-origin 会话 cookie，必须显式声明。
      const r = await fetch('/api/android/file-incoming', { credentials: 'same-origin', cache: 'no-store' })
      if (!r.ok) {
        setIncomingMsg({ text: describeHttpFailure('读取来件占用', r.status), http: r.status })
        return
      }
      if (r.ok) {
        const j = (await r.json()) as { bytes?: number }
        setIncomingBytes(typeof j.bytes === 'number' ? j.bytes : null)
      }
    } catch {
      /* 非安卓应用内（浏览器等）：静默 */
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
      if (!r.ok) {
        setIncomingMsg({ text: describeHttpFailure('清理临时工作区', r.status), http: r.status })
        return
      }
      const j = (await r.json().catch(() => null)) as { ok?: boolean; removed?: number; reason?: string } | null
      // FX-205.5：清理范围收敛为「本工具自有临时项」，用户放入工作区的文件不再被删。
      setIncomingMsg(j?.ok
        ? { text: `已清理本工具临时项（${j.removed ?? 0} 项）——相关会话中的文件引用将失效` }
        : { text: tr('清理未完成——请重试；仍失败可复制日志反馈', 'Clearing did not finish; retry, or copy the log and report it.'), ...(j?.reason === undefined ? {} : { code: j.reason }) })
    } catch {
      setIncomingMsg({ text: tr('清理请求失败（仅安卓应用内有此能力）——请确认在本机应用内操作', 'Clearing is only available inside the Android app.') })
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
    setActionMsg(null)
    // S3-15：只有**真的发起了**重启才进入忙碌态；否则如实说没发起（旧实现无论成败都显示
    // 「重启中…」并在 2s 后自己变回——那是「看起来在工作」的假忙碌，用户会以为重启过了）。
    let started = false
    try {
      started = window.androidBridge?.restartEngine?.() === true
    } catch {
      started = false
    }
    if (!started) {
      setActionMsg({ text: tr('重启没有发起：应用与页面的连接不可用，或已在重启中——请稍等几秒；仍无效请关闭并重新打开应用', 'The restart did not start: the app and page lost their connection, or one is already running. Wait a few seconds, then reopen the app.') })
      return
    }
    setRestarting(true)
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
    setActionMsg(null)
    try {
      if (window.androidBridge?.reloadWebUI === undefined) {
        setActionMsg({ text: tr('刷新界面不可用：应用与页面的连接未装配——请关闭并重新打开应用', 'Refreshing is unavailable: the app bridge is missing. Reopen the app.') })
        return
      }
      window.androidBridge.reloadWebUI()
    } catch {
      setActionMsg({ text: tr('刷新界面失败：应用与页面的连接不可用——请关闭并重新打开应用', 'Refreshing failed: the app and page lost their connection. Reopen the app.') })
    }
  }, [])

  const openConsole = useCallback(() => {
    setActionMsg(null)
    try {
      if (window.androidBridge?.openConsole === undefined) {
        setActionMsg({ text: tr('控制台不可用：应用与页面的连接未装配——请关闭并重新打开应用', 'The console is unavailable: the app bridge is missing. Reopen the app.') })
        return
      }
      window.androidBridge.openConsole()
    } catch {
      setActionMsg({ text: tr('控制台打开失败：应用与页面的连接不可用——请关闭并重新打开应用', 'The console did not open: the app and page lost their connection. Reopen the app.') })
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
        setOverlayMsg(tr('已打开系统授权页；授予后请重新打开本开关', 'The system permission page is open; turn this switch on again after granting.'))
      } else if (enabled) {
        setOverlayMsg(tr('悬浮球已开启：任意界面可拖拽；点开面板实时查看工具调用，可一键停止', 'The floating ball is on: drag it anywhere and tap it to watch tool calls and stop them.'))
      } else {
        setOverlayMsg(tr('悬浮球已关闭', 'The floating ball is off'))
      }
    } catch {
      setOverlayMsg(tr('应用内连接不可用（悬浮球仅安卓应用内支持）——请重新打开应用后重试', 'The bridge is unavailable; the floating ball only works inside the Android app. Reopen it and try again.'))
    }
  }, [refreshOverlay])

  // 0.13.1 W4：配置导入/导出（安全手改通道——引擎读私有目录，外部改共享副本无效）。
  const [configMsg, setConfigMsg] = useState<string | null>(null)

  const exportConfig = useCallback(() => {
    try {
      const raw = window.androidBridge?.exportConfig?.()
      const j = JSON.parse(raw ?? '{}') as { ok?: boolean; path?: string; error?: string }
      setConfigMsg(j.ok
        ? tr('已导出到 ', 'Exported to ') + (j.path ?? 'exports/config/settings.yaml')
        : tr('导出失败：', 'Export failed: ') + (j.error ?? tr('未知错误', 'unknown error')))
    } catch {
      setConfigMsg(tr('导出失败：应用内连接不可用（仅安卓应用内可用）——请重新打开应用后重试', 'Export failed: the app bridge is unavailable. Reopen the app and try again.'))
    }
  }, [])

  const importConfig = useCallback(() => {
    try {
      const raw = window.androidBridge?.importConfig?.()
      const j = JSON.parse(raw ?? '{}') as { ok?: boolean; hint?: string; error?: string }
      setConfigMsg(j.ok
        ? tr('已导入并生效（原配置备份为 settings.yaml.import-backup）。', 'Imported and applied (the previous file is settings.yaml.import-backup). ') + (j.hint ?? '')
        : tr('导入失败：', 'Import failed: ') + (j.error ?? tr('未知错误', 'unknown error')))
    } catch {
      setConfigMsg(tr('导入失败：应用内连接不可用（仅安卓应用内可用）——请重新打开应用后重试', 'Import failed: the app bridge is unavailable. Reopen the app and try again.'))
    }
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') cancelConfirm()
    },
    [cancelConfirm],
  )

  const logPathHint = allFiles === false
    ? tr('未授予「所有文件访问」：日志将写入应用私有目录，授权后自动切换公共目录。', 'No all-files access: logs stay in the app private folder until you grant it.')
    : tr('开启后按天写入 Documents/dshdata/log/dsh-<日期>.log。', 'When on, one log file per day goes to Documents/dshdata/log/.')

  return (
    <div data-plugin="dev-section" onKeyDown={onKeyDown}>
      {/* 分区名已由设置中心的二级页标题条承担（竖屏 settings-nav；横屏上游 nav 行），
          这里不再重复一遍「开发者选项」，只留这一页真正独有的一句说明。 */}
      <p className="dsh-dev-note">{tr('控制台是运行时内嵌命令行；日志默认关闭。', 'The console is the runtime shell; logging is off by default.')}</p>

      {/* 0.14.0：屏幕/Shizuku/虚拟屏/浮窗/无障碍/强制销毁已迁到独立「手机控制」设置页。 */}

      {/* Legacy ADB diagnostic controls remain below the user-facing Shizuku/screen surface until
          the hard-cut migration is verified. */}
      {renderSlot?.('settings.dev.item', {})}

      <div className="dsh-dev-row">
        <button type="button" className="dsh-dev-btn" onClick={askRestart} disabled={restarting}>
        {restarting ? tr('重启中…', 'Restarting…') : tr('重启', 'Restart')}
        </button>
        <button type="button" className="dsh-dev-btn dsh-dev-danger" onClick={askClose}>{tr('关闭', 'Close')}</button>
        <button type="button" className="dsh-dev-btn" onClick={reload}>{tr('刷新界面', 'Reload page')}</button>
        <button type="button" className="dsh-dev-btn" onClick={openConsole}>{tr('打开控制台', 'Open console')}</button>
      </div>

      {actionMsg !== null && <p className="dsh-dev-warn" {...noticeDataAttrs(actionMsg)}>{actionMsg.text}</p>}

      <label className="dsh-dev-row dsh-dev-switch">
        <input
          type="checkbox"
          checked={devLog}
          onChange={(e) => toggleLog(e.target.checked)}
        />
        <span>{tr('调试日志', 'Debug log')}</span>
      </label>

      {/* 0.13.2 W7：悬浮球（实时工具流 + 停止）。
          P5-6：与「手机控制」页的虚拟屏浮窗去混淆——旧文案两处都只说「浮窗/浮球」，
          用户分不清哪个是任务面板入口、哪个是虚拟屏画面。此处点名各自是什么。 */}
      <label className="dsh-dev-row dsh-dev-switch">
        <input
          type="checkbox"
          checked={overlayOn}
          onChange={(e) => toggleOverlay(e.target.checked)}
        />
        <span>{tr('悬浮球（任务面板入口）', 'Floating ball (task panel)')}</span>
      </label>
      {/* P5-6 只要求「点名的两处不是同一个东西」，不再复述另一页的完整语义（那由该页自己说）。 */}
      <p className="dsh-dev-hint">{tr('点开可看工具调用并随时停止；它不是手机控制页的虚拟屏浮窗。', 'Tap it to watch tool calls and stop them. It is not the virtual screen window in Phone control.')}</p>
      {overlayMsg !== null && <p className="dsh-dev-hint">{overlayMsg}</p>}

      {/* 0.13.1 W4：配置导入/导出（安全手改通道；引擎读私有目录，改共享目录副本无效） */}
      <div className="dsh-dev-row">
        <button type="button" className="dsh-dev-btn" onClick={exportConfig}>{tr('导出配置', 'Export config')}</button>
        <button type="button" className="dsh-dev-btn" onClick={importConfig}>{tr('导入配置', 'Import config')}</button>
      </div>
      {configMsg !== null && <p className="dsh-dev-hint">{configMsg}</p>}
      {/* 数据安全说明必须保留（配置不含密钥）；路径保留（用户要拿它去改）。 */}
      <p className="dsh-dev-hint">
        {tr('导出到 Documents/dshdata/exports/config/settings.yaml，改完点「导入配置」生效。导出不含 API 密钥。', 'Exported to Documents/dshdata/exports/config/settings.yaml; edit it there, then tap Import config. API keys are not included.')}
      </p>

      {/* 0.14.1 块 E（详档 §4.3）：运行时缓存清理——白名单制、先给可回收体积再执行、逐项落审计。 */}
      <RuntimeCacheRow />

      {/* 0.14.8 提级：模型能力补齐已从开发者选项**提级**为设置页一级分区「模型能力」。
          用户反馈在设置页找不到它（入口原先只在这里，而真实用户不走开发者选项）。
          同一功能双实现是审查档 §5 的结构性根因，故这里只留指路、不再渲染同一组控件。 */}
      <p className="dsh-dev-hint">{tr('第三方模型能力在「设置 → 模型能力」里。', 'Third-party model options live in Settings > Model capabilities.')}</p>

      {/* 0.15.0 提级：应用自更新入口已从开发者选项**提级**为设置页一级分区「应用更新」
          （用户拍板「更新块继续放设置页、从开发者选项提出来」）。真因同「通知」与「模型能力」：
          真实用户不走开发者选项，入口埋在这里等于不可达。
          同一功能双实现是审查档 §5 的结构性根因，故这里只留指路、不再渲染同一组控件。 */}
      <p className="dsh-dev-hint">{tr('应用更新在「设置 → 应用更新」里。', 'App updates live in Settings > App updates.')}</p>

      {/* 0.14.1 批 3（P3-5）：通知设置已从开发者选项**提级**为设置页一级分区「通知」。
          这里只留指路（同功能双实现是审查档 §5 的结构性根因，故不重复渲染同一组开关）。 */}
      <p className="dsh-dev-hint">{tr('提醒方式在「设置 → 通知」里。', 'Alert options live in Settings > Notifications.')}</p>

      {/* F5.1/D15：文件直达临时工作区（占用展示 + 一键清理；PRD R16 手动清理 + 占用展示） */}
      {incomingBytes !== null && (
        <div className="dsh-dev-row">
          <span>
            {tr('文件直达临时工作区占用：', 'Temporary workspace: ')}{fmtBytes(incomingBytes)}
          </span>
          {/* S3-14：破坏性操作一律先确认（旧实现单击即删，与同页「运行时缓存清理」的二次确认不一致）。 */}
          <button
            type="button"
            className="dsh-dev-btn dsh-dev-danger"
            disabled={cleaning || incomingBytes === 0}
            onClick={() => { setConfirm('clean') }}
          >
            {cleaning ? tr('清理中…', 'Clearing…') : tr('一键清理', 'Clear all')}
          </button>
        </div>
      )}
      {incomingMsg !== null && <p className="dsh-dev-hint" {...noticeDataAttrs(incomingMsg)}>{incomingMsg.text}</p>}
      <p className="dsh-dev-hint">{tr('清理会删除临时工作区内的外部文件；相关会话中的文件引用将失效。', 'Clearing deletes external files in the temporary workspace; references in sessions stop working.')}</p>
      <p className="dsh-dev-hint">{logPathHint}</p>
      <p className="dsh-dev-warn">{tr('日志包含命令与模型内容，仅用于排查，请及时清理。', 'Logs contain commands and model content; use them only for debugging and clear them soon.')}</p>

      {confirm !== null && (
        <div
          className="dsh-dev-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={confirmText()[confirm].title}
          onClick={cancelConfirm}
        >
          <div
            className="dsh-dev-modal"
            role="document"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="dsh-dev-modal-title">{confirmText()[confirm].title}</p>
            <p className="dsh-dev-modal-desc">{confirmText()[confirm].desc}</p>
            <div className="dsh-dev-modal-actions">
              <button
                type="button"
                className="dsh-dev-btn"
                autoFocus
                onClick={cancelConfirm}
              >取消</button>
              <button
                type="button"
                className={confirm === 'restart' ? 'dsh-dev-btn' : 'dsh-dev-btn dsh-dev-danger'}
                onClick={() => {
                  const which = confirm
                  setConfirm(null)
                  if (which === 'restart') doRestart()
                  else if (which === 'close') doClose()
                  else void cleanIncoming()
                }}
              >{confirmText()[confirm].ok}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
