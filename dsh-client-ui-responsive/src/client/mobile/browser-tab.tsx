/** Official BrowserBody/BrowserTitle chrome with an Android-native page provider. */
import { useLayoutEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { GuideArtworkBrowser, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { BrowserBody, type BrowserBodyProps } from './upstream-browser/view/BrowserBody.tsx'
import type { NativeBrowserControlsInjected } from './native-browser-adapter.ts'
import css from './BrowserTab.module.css'

/** Own dispatch id; existing Android browser layout records keep their occurrence ids. */
export const BROWSER_TAB_ID = 'android-browser'
/** Take the official builtin kind through the registry's extension band. */
export const BROWSER_TAB_KIND = 'browser'
/** Guide-less resolver for pre-0.2 Android layouts, without rewriting any layout data. */
export const LEGACY_BROWSER_TAB_KIND = 'android-browser'
/** Legacy needs a distinct implementation id because registry ids are globally unique. */
export const LEGACY_BROWSER_TAB_ID = 'android-browser.legacy'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The official Browser URL parameter; native ids stay private to the adapter. */
    browser: { readonly url?: string }
  }
}

/**
 * Contribute the official guide artwork and one Browser entry, not a replacement workspace tree.
 * @param t - locale-live private Browser dictionary.
 * @returns extension-band browser type.
 */
export function browserTabDefinition(t: TranslateNS<'androidSidebarBrowser'>): SidebarRightTabDefinition {
  return { id: BROWSER_TAB_ID, kind: BROWSER_TAB_KIND, priority: 'extension', multiple: true, keepMounted: true,
    title: () => t('type.label'),
    guide: [{ id: 'new', commandId: 'browser.new' as ShortcutCommandId, order: 30,
      title: () => t('guide.title'), description: () => t('guide.description'), icon: GuideArtworkBrowser }] }
}

/** @param t - locale-live copy. @returns guide-less compatibility resolver. */
export function legacyBrowserTabDefinition(t: TranslateNS<'androidSidebarBrowser'>): SidebarRightTabDefinition {
  return { ...browserTabDefinition(t), id: LEGACY_BROWSER_TAB_ID, kind: LEGACY_BROWSER_TAB_KIND, guide: [] }
}

/** Bound neutral browser state plus native-specific controls; no component sees Context. */
export type AndroidBrowserBodyProps = BrowserBodyProps & InjectFace<NativeBrowserControlsInjected>

function parseResolution(value: string): { width: number; height: number } | undefined {
  const match = /^\s*(\d{2,4})\s*[x×*]\s*(\d{2,4})\s*$/i.exec(value)
  if (match === null) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  return width >= 240 && width <= 3840 && height >= 240 && height <= 3840 ? { width, height } : undefined
}

/** Reuse the official address/start/restore UI; native controls occupy their own non-stage row. */
export function BrowserTab(props: AndroidBrowserBodyProps): ReactNode {
  const { useTabInfo, useNativeBrowserState, setBrowserVisible, setBrowserIdentity, setBrowserViewport, refreshBrowserStatus, t } = props
  const { tab } = useTabInfo()
  const state = useNativeBrowserState(tab.id)
  const current = state !== undefined && state.viewportWidth > 0 && state.viewportHeight > 0
    ? state.viewportWidth + 'x' + state.viewportHeight : '390x844'
  const [edit, setEdit] = useState<{ readonly current: string; readonly value: string }>()
  const [invalid, setInvalid] = useState(false)
  const value = edit?.current === current ? edit.value : current
  const ready = state?.available === true && state.nativeTabId !== undefined
  const desktop = state?.identityId === 'linux-desktop'
  const mobile = state?.identityId === 'android-real'
  useLayoutEffect(() => {
    setBrowserVisible(tab.id, tab.visible)
    return () => { setBrowserVisible(tab.id, false) }
  }, [setBrowserVisible, tab.id, tab.visible])
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const resolution = parseResolution(value)
    setInvalid(resolution === undefined)
    if (resolution !== undefined) setBrowserViewport(tab.id, resolution.width, resolution.height)
  }
  return <div className={css.root}>
    {state?.available === false && <div className={css.status} role="status">
      {t('native.unavailable', { reason: state.reason })}
      <button type="button" onClick={() => { refreshBrowserStatus(tab.id) }}>{t('native.retry')}</button>
    </div>}
    {state?.available === true && state.reason !== '' && <div className={css.status} role="status">
      {t('native.operation.failed', { reason: state.reason })}
    </div>}
    {state?.available === true && state.isolationAvailable === false && <div className={css.status} role="status">
      {/* 隔离不可用是提示，不是错误：浏览器本体仍可用（单一身份档回退）。 */}
      {t('native.isolation.unavailable')}
    </div>}
    <div className={css.official}><BrowserBody {...props} /></div>
    <form className={css.controls} onSubmit={submit}>
      <button type="button" className={css.mode} disabled={!ready} aria-pressed={desktop}
        onClick={() => { setBrowserIdentity(tab.id, true) }}>{t('native.desktop')}</button>
      <button type="button" className={css.mode} disabled={!ready} aria-pressed={mobile}
        onClick={() => { setBrowserIdentity(tab.id, false) }}>{t('native.mobile')}</button>
      <input className={css.resolution} value={value} aria-label={t('native.viewport')} aria-invalid={invalid}
        disabled={!ready} spellCheck={false} onChange={event => { setEdit({ current, value: event.currentTarget.value }); setInvalid(false) }} />
      <button type="submit" className={css.apply} disabled={!ready}>{t('native.viewport.apply')}</button>
    </form>
    {invalid && <div className={css.status} role="alert">{t('native.viewport.invalid')}</div>}
  </div>
}

/** Framework-owned menu occurrence; content actions join the real Sidebar tab menu. */
export type BrowserTabMenuProps = PropsRuntime<'sidebar.right.tab.menu.item'>
  & PropsLocale<'androidSidebarBrowser'> & InjectFace<NativeBrowserControlsInjected>

/** Add native profile/status/close actions without fabricating a public toolbar slot. */
export function BrowserTabMenu({ tab, dismiss, useNativeBrowserState, setBrowserIdentity, refreshBrowserStatus, closeBrowserTab, t }: BrowserTabMenuProps): ReactNode {
  const state = useNativeBrowserState(tab.id)
  if (tab.kind !== BROWSER_TAB_KIND && tab.kind !== LEGACY_BROWSER_TAB_KIND) return null
  const ready = state?.available === true && state.nativeTabId !== undefined
  return <>
    <MenuItemButton separatorBefore disabled={!ready} onSelect={() => { dismiss(); setBrowserIdentity(tab.id, true) }}>{t('native.desktop')}</MenuItemButton>
    <MenuItemButton disabled={!ready} onSelect={() => { dismiss(); setBrowserIdentity(tab.id, false) }}>{t('native.mobile')}</MenuItemButton>
    <MenuItemButton onSelect={() => { dismiss(); refreshBrowserStatus(tab.id) }}>{t('native.retry')}</MenuItemButton>
    <MenuItemButton danger onSelect={() => { dismiss(); closeBrowserTab(tab.id) }}>{t('native.close')}</MenuItemButton>
  </>
}
