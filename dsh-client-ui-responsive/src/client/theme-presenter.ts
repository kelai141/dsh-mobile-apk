/**
 * Global theme DOM applier: projects the resolved ThemeSnapshot onto the
 * document — `html { color-scheme }` for native UA chrome (scrollbars, form
 * controls), `body[data-ds-dark-theme]` for the token palette, the active
 * theme's alias-token overrides as inline CSS variables on body, and one
 * presenter-owned `meta[name="theme-color"]` for surrounding browser UI. Pure
 * DOM writes, no React involvement; the presenter only ever retracts what it
 * wrote itself, so foreign attributes, metadata, and inline styles survive.
 */
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Body attribute selecting the dark base palette in the token stylesheets. */
export const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** Applies theme snapshots to the document; one instance per plugin fiber. */
export class ThemePresenter {
  private static nextId = 0
  /** Last-writer marker (L3): global writes (colorScheme/dark attribute) are retracted only by the
   *  last apply'ing instance — under HMR dual fibers / multiple coexisting instances, an earlier
   *  dispose must not clear a later writer's global state. */
  private readonly uid = 'p' + ThemePresenter.nextId++
  /** Token variables and the values this presenter wrote (L3: dispose retracts only variables whose
   *  value is still "mine" — when a later writer overrode the same token, the earlier dispose must
   *  not delete the later writer's value). */
  private appliedTokens = new Map<string, string>()
  /** The single metadata node this presenter inserts and removes. */
  private readonly themeColorMeta: HTMLMetaElement

  /** Create the presenter-owned metadata node before the first snapshot arrives. */
  constructor() {
    this.themeColorMeta = document.createElement('meta')
    this.themeColorMeta.name = 'theme-color'
  }

  /**
   * Project a snapshot onto the document: set root `color-scheme` and the body
   * palette attribute from `active.colorScheme` (never the id — `system` is
   * resolved upstream), then replace the previously applied token variables
   * with `active.tokens`. Browser theme-color metadata follows the computed
   * body background after those writes, so the rendered palette remains the
   * color authority.
   * @param snapshot - resolved theme snapshot from ctx.theme.
   */
  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    document.documentElement.dataset.dshPresenter = this.uid
    for (const [name, value] of this.appliedTokens) {
      if (body.style.getPropertyValue(name) === value) body.style.removeProperty(name)
    }
    this.appliedTokens.clear()
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.set(name, value)
    }
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta)
  }

  /** Retract what this presenter wrote: global fields only when still owned
   *  (last writer), token variables and the owned metadata node always. */
  dispose(): void {
    if (document.documentElement.dataset.dshPresenter === this.uid) {
      document.documentElement.style.removeProperty('color-scheme')
      document.body.removeAttribute(DARK_ATTRIBUTE)
      delete document.documentElement.dataset.dshPresenter
    }
    const body = document.body
    for (const [name, value] of this.appliedTokens) {
      if (body.style.getPropertyValue(name) === value) body.style.removeProperty(name)
    }
    this.appliedTokens.clear()
    this.themeColorMeta.remove()
  }
}
