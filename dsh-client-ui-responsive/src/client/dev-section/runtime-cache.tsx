/**
 * 开发者选项「清除运行时缓存」面板（0.14.1 块 E 的客户端半）。
 *
 * 交互口径（`docs/0.14.1-preview-LEGACY-AND-PERF.md` §4.3③「先给可回收体积再执行」）：
 *  1. 挂载即扫描（GET `/api/android/runtime-cache/scan`，只读）→ 展示**实测**可回收体积与逐项清单；
 *  2. 用户点「清理」→ 二次确认（列出即将删除的项与体积）→ POST `.../execute`；
 *  3. 结果按项展示（removed/failed/skipped 与原因）——失败与跳过都如实呈现，不粉饰成「已清干净」。
 *
 * 纪律：两次请求都带 `credentials: 'same-origin'`（浏览器面凭据 = same-origin 会话 cookie；
 * 与 `DevSection` 的 file-incoming 面同款），且**绝不展示绝对路径**——宿主只下发
 * `$DSH_HOME`/`$DSH_FILES_DIR` 形态的标签。
 *
 * 用户裁定 7（仅用户平面，不给模型工具）：本面板只有页面按钮 + 受鉴权宿主能力，零新增模型可见工具。
 */
import { useCallback, useEffect, useState } from 'react'
import { describeHttpFailure, noticeDataAttrs, type Notice } from '../user-copy.ts'
import { tr } from '../i18n.ts'

/** 扫描/执行接口返回的单项。 */
interface CacheItem {
  /** 稳定 id。 */
  id?: string
  /** 展示标签（`$DSH_HOME/...` 或 `$DSH_FILES_DIR/...`）。 */
  label?: string
  /** 类别（scan 面）：日志历史代 / cache 子目录。 */
  kind?: string
  /** 扫描体积（字节）。 */
  bytes?: number
  /** 命中项数。 */
  files?: number
  /** 执行结果（execute 面）。 */
  status?: 'removed' | 'failed' | 'skipped'
  /** 失败/跳过原因——**稳定码**（`not-allowlisted` / `remove-failed` …），页面按码翻译成人话。 */
  reason?: string
  /** 失败明细（诊断用，如 `EBUSY: ...`）：只进 `data-detail`，不进正文（P3-6）。 */
  detail?: string
}

/** 扫描载荷。 */
interface CacheScan {
  ok?: boolean
  reclaimableBytes?: number
  targets?: CacheItem[]
  skipped?: CacheItem[]
}

/** 执行载荷。 */
interface CacheReport {
  ok?: boolean
  removed?: number
  failed?: number
  removedBytes?: number
  plannedBytes?: number
  items?: CacheItem[]
}

/** 字节格式化（与设置页其它面同款口径）。 */
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

/**
 * 跳过原因的中文短标签（未知原因**不原样透出**，见 P3-6：机器码不上屏）。
 *
 * 未登记的原因落到 [describeSkipReason] 的兜底句，原始串只进 `data-reason`。
 */
const SKIP_LABEL: Record<string, string> = {
  'not-allowlisted': tr('未列入白名单（本版不清理）', 'Not on the allowlist; this version keeps it'),
  absent: tr('不存在', 'Not found'),
  unreadable: tr('不可读', 'Unreadable'),
  'log-root-unresolved': tr('日志目录未注入（应用未提供日志目录）', 'No log folder was provided by the app'),
  'current-generation-absent': tr('当前引擎日志不在场（引擎未启动）', 'The current engine log is absent (engine stopped)'),
  preserved: tr('属保留项', 'Kept on purpose'),
  'scope-rejected': tr('越出白名单作用域（已拒绝）', 'Outside the allowlist; refused'),
  vanished: tr('执行前已消失', 'Already gone before it ran'),
  aborted: tr('被执行中断跳过', 'Skipped because the run was interrupted'),
  // 执行期失败：原因是稳定码，OS 错误串在 `detail` 里（只进 data-detail）。
  'remove-failed': tr('删除失败（文件被占用、只读或权限不足）', 'Delete failed (in use, read-only, or not permitted)'),
}

/**
 * 跳过/失败原因 → 人话（P3-1）。
 * @param item - 扫描或执行结果里的一项。
 * @returns 已知原因的中文短标签；未知原因给兜底句（**不回显原码**）。
 */
function describe(item: CacheItem): string {
  const reason = item.reason ?? ''
  if (reason === '') return tr('原因未记录', 'No reason recorded')
  return SKIP_LABEL[reason] ?? tr('原因未在本版登记（可复制日志反馈）', 'This reason is not listed yet; copy the log and report it')
}

/**
 * 「清除运行时缓存」设置行。
 * @returns 该设置分区内的一个功能块。
 */
export function RuntimeCacheRow() {
  const [scan, setScan] = useState<CacheScan>({})
  /**
   * 扫描状态（S3-16）：`unknown`（还没读到/宿主不可用）与 `ok`（真值）必须分开——
   * 旧实现把「读不到」渲染成「可回收：0 B（0 项）」，看起来像「确实没东西可清」的合法空态。
   */
  const [scanState, setScanState] = useState<'unknown' | 'ok' | 'failed'>('unknown')
  const [report, setReport] = useState<CacheReport | null>(null)
  const [message, setMessage] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/android/runtime-cache/scan', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) {
        // P3-1/P3-6：状态码只作分档依据，进正文的是「发生了什么 + 能做什么」。
        setScanState('failed')
        setMessage({ text: describeHttpFailure('读取运行时缓存', response.status), http: response.status })
        return
      }
      const payload = (await response.json()) as CacheScan
      setScan(payload)
      setScanState('ok')
      setMessage(null)
    } catch {
      // 桌面宿主/未装配：不报错（本行是 Android 壳设施），但**也不许冒充真值**——
      // 状态留 unknown ⇒ 头部显示「读不到」而不是「0 B」。
      setScanState('unknown')
      setMessage(null)
    }
  }, [setScan])

  useEffect(() => { void refresh() }, [refresh])

  const run = useCallback(async (): Promise<void> => {
    setConfirming(false)
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/android/runtime-cache/execute', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) {
        setMessage({ text: describeHttpFailure('清理运行时缓存', response.status), http: response.status })
        return
      }
      const payload = (await response.json().catch(() => null)) as CacheReport | null
      setReport(payload)
      if (payload === null) {
        setMessage({ text: tr('清理结果无法解析（响应不是预期的数据）——请重试；仍失败可复制日志反馈', 'The result could not be read. Retry, or copy the log and report it.') })
      }
    } catch {
      setMessage({ text: tr('清理请求失败（仅安卓应用内有此能力）——请确认在本机应用内操作', 'Clearing is only available inside the Android app.') })
    } finally {
      setBusy(false)
      void refresh()
    }
  }, [refresh])

  const reclaimable = typeof scan.reclaimableBytes === 'number' ? scan.reclaimableBytes : 0
  const targets = Array.isArray(scan.targets) ? scan.targets : []
  const skipped = Array.isArray(scan.skipped) ? scan.skipped : []
  const items = report !== null && Array.isArray(report.items) ? report.items : []

  return (
    <div className="dsh-dev-cache" data-plugin="dev-runtime-cache">
      <div className="dsh-dev-row" data-scan-state={scanState}>
        <span>
          {scanState === 'ok'
            ? (reclaimable > 0
              // 真值：读到了，且有可回收体积。
              ? tr('运行时缓存可回收：', 'Runtime cache reclaimable: ') + fmtBytes(reclaimable) + tr('（', ' (') + String(targets.length) + tr(' 项）', ' items)')
              // 真值：读到了，确实没有可清理项（这才是合法的空态）。
              : tr('运行时缓存：暂无可清理项（本版白名单内没有残留）', 'Runtime cache: nothing to clear (the allowlist found no leftovers)'))
            : tr('运行时缓存可回收：读不到（不是 0——应用内的读取通道不可用或返回异常）', 'Runtime cache could not be read, so this is not zero: the app bridge is unavailable or returned an error')}
        </span>
        <button
          type="button"
          className="dsh-dev-btn"
          disabled={busy}
          onClick={() => { void refresh() }}
        >{tr('重新扫描', 'Scan again')}</button>
        <button
          type="button"
          className="dsh-dev-btn dsh-dev-danger"
          disabled={busy || scanState !== 'ok' || reclaimable === 0}
          onClick={() => { setConfirming(true) }}
        >{busy ? tr('清理中…', 'Clearing…') : tr('清理', 'Clear')}</button>
      </div>

      {/* S3-16（设备实测补正）：读不到时**不得**继续展示上一次的清单——那会让「读不到」的头部
          与一份看起来新鲜的清单同时在场，用户会拿陈旧数据当现值。清单只在真值态展示。 */}
      {scanState === 'ok' && targets.length > 0 && (
        <ul className="dsh-dev-cache-list">
          {targets.map((item) => (
            <li key={item.label ?? item.id}>
              {item.label ?? item.id} — {fmtBytes(typeof item.bytes === 'number' ? item.bytes : 0)}
              {typeof item.files === 'number' ? tr('（', ' (') + String(item.files) + tr(' 项）', ' items)') : ''}
            </li>
          ))}
        </ul>
      )}
      {/* 精简（0.14.7-B D5）：白名单制与「哪些不碰」是数据安全说明，必须保留；此处只去掉
          「本版未纳入任何子目录」这类与上方跳过清单逐条重复的实现口径。 */}
      <p className="dsh-dev-hint">
        {tr(
          '只按清单清理。图片距上次主动读取满120分钟可手动回收；不清理仍可用，清理后显示占位。会话文字、文件附件、凭据、设置、插件和当前日志保留。',
          'Only listed items are cleared. Images idle for 120 minutes can be cleared manually. They remain usable until you clear them, then become placeholders. Text history, file attachments, credentials, settings, plugins and the current log are kept.',
        )}
      </p>

      {skipped.length > 0 && (
        <details className="dsh-dev-hint">
          <summary>{tr('跳过 ', 'Skipped ')}{skipped.length}{tr(' 项（未识别/保留）', ' items (unknown or kept)')}</summary>
          <ul className="dsh-dev-cache-list">
            {skipped.map((item) => (
              <li key={item.label ?? item.id}>{item.label ?? item.id}{tr('：', ': ')}{describe(item)}</li>
            ))}
          </ul>
        </details>
      )}

      {message !== null && (
        <p className="dsh-dev-hint" {...noticeDataAttrs(message)}>{message.text}</p>
      )}

      {report !== null && (
        <div>
          <p className="dsh-dev-hint">
            {tr('已清理 ', 'Cleared ')}{String(report.removed ?? 0)}{tr(' 项，释放 ', ' items and freed ')}{fmtBytes(typeof report.removedBytes === 'number' ? report.removedBytes : 0)}
            {tr('（扫描值 ', ' (scanned ')}{fmtBytes(typeof report.plannedBytes === 'number' ? report.plannedBytes : 0)}{tr('）', ')')}
            {typeof report.failed === 'number' && report.failed > 0 ? tr('；', '; ') + String(report.failed) + tr(' 项失败', ' failed') : ''}
          </p>
          <ul className="dsh-dev-cache-list">
            {items.map((item) => (
              <li
                key={item.label ?? item.id}
                {...(item.reason === undefined || item.reason === '' ? {} : { 'data-reason': item.reason })}
                {...(item.detail === undefined || item.detail === '' ? {} : { 'data-detail': item.detail })}
              >
                {item.label ?? item.id} — {item.status === 'removed' ? tr('已删除 ', 'removed ') + fmtBytes(typeof item.bytes === 'number' ? item.bytes : 0)
                  : item.status === 'failed' ? tr('失败：', 'failed: ') + describe(item)
                    : tr('跳过：', 'skipped: ') + describe(item)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirming && (
        <div
          className="dsh-dev-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={tr('确认清除运行时缓存', 'Confirm clearing the runtime cache')}
          onClick={() => { setConfirming(false) }}
        >
          <div className="dsh-dev-modal" role="document" onClick={(event) => { event.stopPropagation() }}>
            <p className="dsh-dev-modal-title">{tr('确认清除运行时缓存？', 'Clear the runtime cache?')}</p>
            {/* 不可逆操作的后果说明必须保留：删哪几项、哪些不受影响、失败项如何处理。 */}
            <p className="dsh-dev-modal-desc">
              {tr('删除以下 ', 'Delete these ')}{targets.length}{tr(' 项，共 ', ' items, ')}{fmtBytes(reclaimable)}
              {tr('，无法恢复。清理的图片会替换为占位文字；会话文字、文件附件、凭据、设置、插件与当前日志保留。失败项会列出。', ', with no undo. Cleared images become text placeholders. Text history, file attachments, credentials, settings, plugins and the current log are kept. Failures are listed.')}
            </p>
            <ul className="dsh-dev-cache-list">
              {targets.map((item) => (
                <li key={item.label ?? item.id}>{item.label ?? item.id} — {fmtBytes(typeof item.bytes === 'number' ? item.bytes : 0)}</li>
              ))}
            </ul>
            <div className="dsh-dev-modal-actions">
              <button type="button" className="dsh-dev-btn" autoFocus onClick={() => { setConfirming(false) }}>{tr('取消', 'Cancel')}</button>
              <button type="button" className="dsh-dev-btn dsh-dev-danger" onClick={() => { void run() }}>{tr('清理', 'Clear')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
