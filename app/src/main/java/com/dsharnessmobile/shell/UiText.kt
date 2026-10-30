package com.dsharnessmobile.shell

import android.content.Context

/**
 * Bilingual copy for native screens.
 *
 * Strings that only exist inline keep both languages at the call site, so the
 * English text cannot drift away from the Chinese one it replaces. Long-lived
 * screens read the preference on each render; the preference only changes from
 * the settings page, which reloads the Web UI and rebuilds native screens.
 */
internal object UiText {
  /** True when the English locale is active; an absent context keeps Chinese. */
  fun isEnglish(context: Context?): Boolean = context != null && AppLanguage.dshLocale(context) == AppLanguage.MODE_EN

  /** Pick the copy for the active locale. */
  fun t(context: Context?, zh: String, en: String): String = t(isEnglish(context), zh, en)

  /**
   * Same table, locale already resolved.
   *
   * Exists so a pure function (no `Context`) can carry bilingual copy and still be asserted
   * in JVM tests **in both directions**: a `Context`-only entry point leaves the English branch
   * unreachable from a unit test, which is how the Chinese-only literals it replaces survived.
   */
  fun t(english: Boolean, zh: String, en: String): String = if (english) en else zh
}
