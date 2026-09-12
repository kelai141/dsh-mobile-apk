/**
 * 侧边栏 AI 浏览器的面板入口（U-1）：与上游「工作区文件」同级的右侧栏 tab 类型。
 *
 * 注册面与 ui-sidebar-files 完全同构：类型进 ctx.sidebarRightTabs（其 guide 条目就是
 * 「文件」面板里的同级卡片），body 进 keyed sidebar.right.pane.tab 座位。
 *
 * 数据面：引擎侧 host 半（plugins/dsh-android-browser）的**只读**路由
 * /api/android/browser/status。档位优先来自壳桥 browserCaps；op 未实现时回落 env/实测基线，
 * 并在 factsSource / capsNote 里如实标注（页面不得把它显示成"已实测"）。
 *
 * 跨包命名镜像：kind 与路由在本文件按 plugins/dsh-android-browser/src/contract.ts 的值镜像
 * （该插件是权威契约源；改名必须同批，否则面板打不开）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** 与 contract.ts 的 BROWSER_TAB_ID/BROWSER_TAB_KIND 对齐（openTab 用 kind）。 */
export const BROWSER_TAB_ID = 'android-browser'
export const BROWSER_TAB_KIND = 'android-browser'
/** 与 contract.ts 的 BROWSER_ROUTES.status 对齐。 */
export const BROWSER_STATUS_ROUTE = '/api/android/browser/status'

interface ViewportPreset { id: string; label: string; width: number; height: number; mobile: boolean }
interface IdentityProfile { id: string; label: string; requiresConfirm: boolean }

/** host 半状态路由的载荷（字段来自 plugins/dsh-android-browser/src/contract.ts）。 */
export interface BrowserStatus {
  ok: boolean
  available: boolean
  tier: string
  viewportRoute: string
  identityRoute: string
  factsSource: string
  capsNote?: string
  webviewMajor?: number
  densityDpi?: number
  uaChAvailable?: boolean
  androidxWebkitAvailable?: boolean
  densityOverrideSupported?: boolean
  browserWebViewAvailable?: boolean
  cdpEnabled?: boolean
  reasons?: string[]
  degradedNotes?: string[]
  viewportPresets?: ViewportPreset[]
  identityProfiles?: IdentityProfile[]
}

/**
 * 浏览器 tab 类型定义。
 * @returns 注册进 ctx.sidebarRightTabs 的定义（guide 条目 = 「文件」面板的同级卡片）。
 */
export function browserTabDefinition(): SidebarRightTabDefinition {
  return {
    id: BROWSER_TAB_ID,
    kind: BROWSER_TAB_KIND,
    priority: 'extension',
    title: () => 'AI 浏览器',
    guide: [
      {
        // 工作区文件（ui-sidebar-files）用 order 10；同级卡片排在它后面。
        order: 20,
        title: () => 'AI 浏览器',
        description: () => '在右侧栏打开 AI 专用浏览器工作台（档位 / 视口 / 身份）',
      },
    ],
  }
}

/**
 * 面板本体：档位 + 视口/身份档位骨架 + 页面区占位。
 * @param props - 组合槽位属性（本组件不读 owner 分享）。
 * @returns 面板元素树。
 */
export function BrowserTab(_props: PropsRuntime<'sidebar.right.pane.tab'>) {
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(BROWSER_STATUS_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
      if (r.status === 401 || r.status === 403) {
        setNote('未获授权（HTTP ' + r.status + '）——浏览器档位不可读')
        return
      }
      if (!r.ok) {
        setNote('档位接口不可用（HTTP ' + r.status + '）')
        return
      }
      const json = (await r.json().catch(() => null)) as BrowserStatus | null
      if (json === null || json.ok !== true) {
        setNote('档位接口返回异常')
        return
      }
      setStatus(json)
      setNote(null)
    } catch {
      setNote('浏览器面板不可用（host 半未挂载或引擎未就绪）')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onVisible = (): void => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refresh])

  const degraded = status?.degradedNotes ?? []

  return (
    <div
      data-plugin="android-browser"
      style={{ height: '100%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px', boxSizing: 'border-box' }}
    >
      {note !== null && <p data-testid="browser-note" style={{ margin: 0 }}>{note}</p>}
      {status !== null && (
        <>
          <p data-testid="browser-tier" style={{ margin: 0 }}>
            {'档位 ' + status.tier + ' · 视口 ' + status.viewportRoute + ' · 身份 ' + status.identityRoute}
          </p>
          <p data-testid="browser-source" style={{ margin: 0, opacity: 0.75 }}>
            {'事实来源 ' + status.factsSource + (status.capsNote === undefined ? '' : '（' + status.capsNote + '）')}
          </p>
          <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span>视口档位</span>
            <select data-testid="browser-viewport" disabled defaultValue="phone-portrait">
              {(status.viewportPresets ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.label + ' ' + String(p.width) + 'x' + String(p.height)}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span>身份档位</span>
            <select data-testid="browser-identity" disabled defaultValue="android-real">
              {(status.identityProfiles ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.label + (p.requiresConfirm ? '（需二次确认）' : '')}</option>
              ))}
            </select>
          </label>
          <div
            data-testid="browser-stage"
            style={{ flex: 1, minHeight: 0, border: '1px dashed currentColor', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px', textAlign: 'center', opacity: 0.85 }}
          >
            {status.browserWebViewAvailable
              ? '浏览器画面将在此显示（壳侧 host 已就绪）'
              : '壳侧 BrowserHost 未接入：等待 MainActivity 窗口释放后启用有头浏览面'}
          </div>
          {degraded.length > 0 && (
            <ul data-testid="browser-degraded" style={{ margin: 0, paddingLeft: '18px', opacity: 0.8 }}>
              {degraded.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
