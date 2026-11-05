/**
 * Copy for our own injected surfaces.
 *
 * Upstream owns `ctx.locale`, but most of our UI is imperative DOM built outside
 * a slot, so it cannot receive the `t` seat. The engine keeps
 * `<html lang>` in sync with the active locale, and a language change reloads
 * this page, so reading that attribute at call time is enough.
 */

/**
 * True when the active dsh locale is English.
 *
 * Chinese stays the default: an empty `<html lang>` (tests, hosts that have not
 * synchronized the attribute yet) must not flip every surface to English.
 */
export function isEnglish(): boolean {
  try {
    return document.documentElement.lang.toLowerCase().startsWith('en')
  } catch {
    return false
  }
}

/** Pick Chinese or English copy for the active locale. */
export function tr(zh: string, en: string): string {
  return isEnglish() ? en : zh
}

/**
 * Candidate labels for an upstream control we match by text.
 *
 * Upstream localizes its own copy, so a claimed action must accept both
 * languages regardless of the active one.
 */
export function both(zh: string, en: string): string[] {
  return [zh, en]
}


/**
 * 观察 <html lang> 的变更并在每次变化后回调（2026-10-29 真机缺陷）。
 *
 * 为什么需要：本插件注入的控件在 DOM ready 时就渲染，而壳侧的语言引导脚本是**页面加载之后**才把
 * <html lang> 改成 en —— 于是「创建那一刻读到 zh」的标签会一直停在中文（真机：切英文后
 * 「展开插件工具」「上传附件」仍是中文，重载页面也不变）。观察 lang 变化再回写是最小且确定的修法。
 * @param apply 每次语言变化后执行（立即执行一次，保证首帧也正确）。
 * @returns 取消观察的函数。
 */
export function observeDocumentLanguage(apply: () => void): () => void {
  apply()
  if (typeof MutationObserver === "undefined") return () => {}
  const observer = new MutationObserver(() => apply())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] })
  return () => observer.disconnect()
}