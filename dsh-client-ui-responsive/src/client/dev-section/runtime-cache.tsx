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
  /** 失败/跳过原因。 */
  reason?: string
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

/** 跳过原因的中文短标签（未知原因原样透出，不吞）。 */
const SKIP_LABEL: Record<string, string> = {
  'not-allowlisted': '未列入白名单（本版不清理）',
  absent: '不存在',
  unreadable: '不可读',
  'log-root-unresolved': '日志目录未注入（壳侧未提供 DSH_FILES_DIR）',
  'current-generation-absent': '当前引擎日志不在场（引擎未启动）',
  preserved: '属保留项',
  'scope-rejected': '越出白名单作用域（已拒绝）',
  vanished: '执行前已消失',
  aborted: '被执行中断跳过',
}

function describe(item: CacheItem): string {
  const reason = item.reason ?? ''
  return SKIP_LABEL[reason] ?? (reason === '' ? '未知' : reason)
}

/**
 * 「清除运行时缓存」设置行。
 * @returns 该设置分区内的一个功能块。
 */
export function RuntimeCacheRow() {
  const [scan, setScan] = useState<CacheScan>({})
  const [report, setReport] = useState<CacheReport | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/android/runtime-cache/scan', { credentials: 'same-origin', cache: 'no-store' })
      if (response.status === 401 || response.status === 403) {
        setMessage('未获授权（HTTP ' + String(response.status) + '）——运行时缓存不可读')
        return
      }
      if (!response.ok) {
        setMessage('扫描失败（HTTP ' + String(response.status) + '）')
        return
      }
      const payload = (await response.json()) as CacheScan
      setScan(payload)
      setMessage(null)
    } catch {
      // 桌面宿主/未装配：静默（本行是 Android 壳设施，非安卓时不报错）
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
      if (response.status === 401 || response.status === 403) {
        setMessage('清理未获授权（HTTP ' + String(response.status) + '）——仅限本机壳侧/已授权页面')
        return
      }
      const payload = (await response.json().catch(() => null)) as CacheReport | null
      setReport(payload)
      if (payload === null) {
        setMessage('清理失败：响应不可解析')
      }
    } catch {
      setMessage('清理请求失败（仅安卓宿主可用）')
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
      <div className="dsh-dev-row">
        <span>
          运行时缓存可回收：{fmtBytes(reclaimable)}（{targets.length} 项）
        </span>
        <button
          type="button"
          className="dsh-dev-btn"
          disabled={busy}
          onClick={() => { void refresh() }}
        >重新扫描</button>
        <button
          type="button"
          className="dsh-dev-btn dsh-dev-danger"
          disabled={busy || reclaimable === 0}
          onClick={() => { setConfirming(true) }}
        >{busy ? '清理中…' : '清理'}</button>
      </div>

      {targets.length > 0 && (
        <ul className="dsh-dev-cache-list">
          {targets.map((item) => (
            <li key={item.label ?? item.id}>
              {item.label ?? item.id} — {fmtBytes(typeof item.bytes === 'number' ? item.bytes : 0)}
              {typeof item.files === 'number' ? '（' + String(item.files) + ' 项）' : ''}
            </li>
          ))}
        </ul>
      )}
      <p className="dsh-dev-hint">
        白名单制：只清理本版已知安全的引擎运行时残留（引擎日志历史代 + 应用私有数据下有名有据的缓存目录）。
        当前引擎日志（壳侧鉴权链依赖它）、会话与附件、凭据、用户设置、已装插件一律不触碰；
        DSH_HOME/cache 按子目录分别裁定，本版未纳入任何子目录，因此整目录逐项跳过并如实列出。
        未识别的路径会被显式跳过。本版不清理 pnpm store，也不触碰快照在途标志。
      </p>

      {skipped.length > 0 && (
        <details className="dsh-dev-hint">
          <summary>跳过 {skipped.length} 项（未识别/保留）</summary>
          <ul className="dsh-dev-cache-list">
            {skipped.map((item) => (
              <li key={item.label ?? item.id}>{item.label ?? item.id}：{describe(item)}</li>
            ))}
          </ul>
        </details>
      )}

      {message !== null && <p className="dsh-dev-hint">{message}</p>}

      {report !== null && (
        <div>
          <p className="dsh-dev-hint">
            已清理 {String(report.removed ?? 0)} 项，释放 {fmtBytes(typeof report.removedBytes === 'number' ? report.removedBytes : 0)}
            （扫描值 {fmtBytes(typeof report.plannedBytes === 'number' ? report.plannedBytes : 0)}）
            {typeof report.failed === 'number' && report.failed > 0 ? '；' + String(report.failed) + ' 项失败' : ''}
          </p>
          <ul className="dsh-dev-cache-list">
            {items.map((item) => (
              <li key={item.label ?? item.id}>
                {item.label ?? item.id} — {item.status === 'removed' ? '已删除 ' + fmtBytes(typeof item.bytes === 'number' ? item.bytes : 0)
                  : item.status === 'failed' ? '失败：' + describe(item)
                    : '跳过：' + describe(item)}
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
          aria-label="确认清除运行时缓存"
          onClick={() => { setConfirming(false) }}
        >
          <div className="dsh-dev-modal" role="document" onClick={(event) => { event.stopPropagation() }}>
            <p className="dsh-dev-modal-title">确认清除运行时缓存？</p>
            <p className="dsh-dev-modal-desc">
              将删除以下 {targets.length} 项，合计 {fmtBytes(reclaimable)}。会话、附件、凭据、
              设置、已装插件与当前引擎日志不受影响；删除逐项进行，失败项会如实列出。
            </p>
            <ul className="dsh-dev-cache-list">
              {targets.map((item) => (
                <li key={item.label ?? item.id}>{item.label ?? item.id} — {fmtBytes(typeof item.bytes === 'number' ? item.bytes : 0)}</li>
              ))}
            </ul>
            <div className="dsh-dev-modal-actions">
              <button type="button" className="dsh-dev-btn" autoFocus onClick={() => { setConfirming(false) }}>取消</button>
              <button type="button" className="dsh-dev-btn dsh-dev-danger" onClick={() => { void run() }}>清理</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
