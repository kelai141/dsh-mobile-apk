package com.dsharnessmobile.shell

import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import java.io.File
import java.util.Locale

/**
 * UI language source of truth: follow system, Chinese, or English.
 *
 * The shell resolves the preference, applies it to its own resources, and
 * mirrors the resulting dsh locale into `settings.yaml` so the engine UI uses
 * the same language. Only dsh's own preference field is written; other
 * settings stay untouched.
 */
internal object AppLanguage {
  const val PREFS = "dsh_settings"
  const val KEY_MODE = "ui_language"

  const val MODE_SYSTEM = "system"
  const val MODE_ZH = "zh"
  const val MODE_EN = "en"

  val MODES = listOf(MODE_SYSTEM, MODE_ZH, MODE_EN)

  /** Stored mode; an unreadable preference falls back to following the system. */
  fun mode(context: Context): String = try {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString(KEY_MODE, MODE_SYSTEM) ?: MODE_SYSTEM
  } catch (_: Exception) {
    MODE_SYSTEM
  }

  /** Only the three declared modes are accepted; anything else means follow system. */
  fun setMode(context: Context, mode: String): String {
    val normalized = if (mode in MODES) mode else MODE_SYSTEM
    try {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().putString(KEY_MODE, normalized).apply()
    } catch (_: Exception) {
      // Persisting failed: still return what the UI should show this session.
    }
    return normalized
  }

  /** dsh locale id for this mode; the system language decides when following it. */
  fun dshLocale(context: Context): String = when (val selected = mode(context)) {
    MODE_ZH -> MODE_ZH
    MODE_EN -> MODE_EN
    else -> systemLocale(context)
  }

  /**
   * Primary subtag of the device language, ignoring any forced override.
   *
   * `MainActivity.attachBaseContext` wraps the activity context in the chosen
   * language, so reading `context.resources` there would return the old forced
   * language after the user switches back to "follow system". The application
   * context is never wrapped, which makes it the honest device answer.
   */
  fun systemLocale(context: Context): String {
    val configuration = try {
      context.applicationContext.resources.configuration
    } catch (_: Exception) {
      null
    }
    val primary = configuration?.locales?.let { locales: LocaleList ->
      if (locales.isEmpty) null else locales[0].language
    } ?: Locale.getDefault().language
    return if (primary.equals(MODE_ZH, ignoreCase = true)) MODE_ZH else MODE_EN
  }

  /** System language tags in preference order, for dsh's own locale detector. */
  fun systemLanguages(context: Context): List<String> {
    val locales = try {
      context.applicationContext.resources.configuration.locales
    } catch (_: Exception) {
      null
    }
    val tags = locales?.let { list -> (0 until list.size()).map { list[it].toLanguageTag() } }.orEmpty()
    return tags.filter { it.isNotBlank() }.ifEmpty { listOf(Locale.getDefault().toLanguageTag()) }
  }

  /** True when the current preference forces a language instead of following the system. */
  fun isForced(context: Context): Boolean = mode(context) != MODE_SYSTEM

  /**
   * Mirror the resolved locale into the profile patch dsh actually reads.
   *
   * dsh 0.2.x stores this namespace in `profiles/web/cordis.patch.yml`; the
   * old `settings.yaml` section is only imported once and no longer read.
   *
   * 2026-10-24: 「跟随系统」不再是设置页里的一个选项——壳侧在启动时把系统语言解析成
   * 具体 locale 写进 `- id: locale`（`dshLocale`：非中文一律 `en`，`zh`/`zh-CN`/
   * `zh-HK`/`zh-TW` 等 `zh-*` 都算中文）。因此这里始终写具体值；用户在上游语言行里
   * 显式选择后会走 `setMode`，下次启动不再被系统语言覆盖。
   * @return true when the patch now matches the resolved locale.
   */
  fun syncDshLocale(context: Context): Boolean = syncDshLocale(context, dshLocale(context))

  /**
   * Write one concrete dsh locale into the profile patch.
   *
   * Kept separate so startup can resolve the system language once and write it
   * without touching the stored shell mode: a profile that still says "system"
   * keeps following the device on every launch, while an explicit choice from
   * the upstream language row stores `zh`/`en` and wins from then on.
   * @param locale - `zh` or `en`.
   * @return true when the patch now matches the locale.
   */
  fun syncDshLocale(context: Context, locale: String): Boolean {
    val file = profilePatchFile(context) ?: return false
    return try {
      val original = if (file.exists()) file.readText() else ""
      val updated = withDshLocalePreference(original, locale)
      if (updated != original) {
        file.parentFile?.mkdirs()
        // #1057：固定名 tmp + 失败回退直写都去掉，改走唯一原子写入口（唯一临时名 + fsync）。
        // 这个文件是引擎真正加载的 patch：直写回退在崩溃窗口内会留下半份 YAML。
        AtomicFileReplace.writeText(file, updated)
      }
      true
    } catch (_: Exception) {
      false
    }
  }

  /**
   * Base context for an activity, carrying the forced or system locale.
   * @param base - context handed to attachBaseContext.
   * @returns a context whose resources resolve strings in the chosen language.
   */
  fun wrap(base: Context): Context {
    if (mode(base) == MODE_SYSTEM) return base
    val configuration = Configuration(base.resources.configuration)
    val language = if (mode(base) == MODE_ZH) Locale.SIMPLIFIED_CHINESE else Locale.ENGLISH
    configuration.setLocales(LocaleList(language))
    return try {
      base.createConfigurationContext(configuration)
    } catch (_: Exception) {
      base
    }
  }

  /** Live profile patch (`files/home/.dsh/profiles/web/cordis.patch.yml`). */
  private fun profilePatchFile(context: Context): File? = try {
    File(File(context.filesDir, "home"), ".dsh/profiles/web/cordis.patch.yml")
  } catch (_: Exception) {
    null
  }

  /**
   * Set or clear the dsh locale row in a profile patch sequence.
   *
   * Only top-level `- id: locale` rows are touched; rows inside `insert:`
   * blocks belong to bundles and must keep their own config. `null` removes
   * the preference (and the row when its config becomes empty), so dsh follows
   * the system language again.
   * @param text - current patch document (empty on a fresh install).
   * @param locale - `zh`, `en`, or null to follow the system.
   * @returns the patch with at most one locale preference.
   */
  internal fun withDshLocalePreference(text: String, locale: String?): String {
    val lines = text.lines().toMutableList()
    val start = lines.indexOfFirst { isTopLevelLocaleRow(it) }
    if (start >= 0) {
      var end = start + 1
      while (end < lines.size) {
        val line = lines[end]
        if (line.isNotBlank() && !line.startsWith(" ") && !line.startsWith("\t")) break
        end++
      }
      val block = lines.subList(start, end).toMutableList()
      val configIndex = block.indexOfFirst { it.trim() == "config:" }
      if (configIndex >= 0) {
        val configIndent = block[configIndex].length - block[configIndex].trimStart().length
        var preference = -1
        var index = configIndex + 1
        while (index < block.size) {
          val line = block[index]
          val indent = line.length - line.trimStart().length
          if (line.isNotBlank() && indent <= configIndent) break
          if (line.trim().startsWith("preference:")) { preference = index; break }
          index++
        }
        if (locale == null) {
          if (preference >= 0) block.removeAt(preference)
        } else {
          val line = " ".repeat(configIndent + 2) + "preference: $locale"
          if (preference >= 0) block[preference] = line else block.add(configIndex + 1, line)
        }
      } else if (locale != null) {
        block.add("  config:")
        block.add("    preference: $locale")
      }
      // Separator blank lines belong to the document, not to the row: drop them before
      // deciding whether the row still carries any config worth keeping.
      while (block.size > 1 && block.last().isBlank()) block.removeAt(block.lastIndex)
      val onlyId = block.size == 1 || (block.size == 2 && block[1].trim() == "config:")
      if (locale == null && onlyId) {
        lines.subList(start, end).clear()
        // The removed row took its trailing blank line with it; keep exactly one separator.
        if (start < lines.size && lines[start].isBlank() && (start == 0 || lines[start - 1].isBlank())) {
          lines.removeAt(start)
        }
      } else {
        lines.subList(start, end).clear()
        lines.addAll(start, block)
      }
    } else if (locale != null) {
      while (lines.isNotEmpty() && lines.last().isBlank()) lines.removeAt(lines.lastIndex)
      if (lines.isNotEmpty()) lines.add("")
      lines.add("- id: locale")
      lines.add("  config:")
      lines.add("    preference: $locale")
    }
    return lines.joinToString("\n").trimEnd() + "\n"
  }

  /** A top-level sequence row naming the locale entry (never an `insert:` child). */
  private fun isTopLevelLocaleRow(line: String): Boolean =
    line.startsWith("- id: locale") && line.substring("- id: locale".length).trim().isEmpty()

  /**
   * Locale that the current mode already displays.
   *
   * The bootstrap mirrors user choices back into the shell preference, so a
   * write first has to know whether the current mode would show that language
   * anyway. A locale the mode already produces (the forced language, or the
   * device language when following the system) is not a new preference; storing
   * it would pin "follow system" to one language.
   *
   * The system branch resolves the way dsh resolves its own bootstrap: the first
   * device tag naming a shipped locale id wins, exact before primary subtag, and
   * the shipped fallback locale answers when nothing matches.
   * @param mode - stored preference (`system`, `zh`, `en`).
   * @param languages - device language tags in preference order.
   * @returns `zh` or `en`.
   */
  internal fun expectedLocale(mode: String, languages: List<String>): String {
    if (mode == MODE_ZH || mode == MODE_EN) return mode
    for (tag in languages.filter { it.isNotBlank() }.distinct()) {
      val requested = tag.lowercase(Locale.ROOT)
      if (requested == MODE_ZH || requested == MODE_EN) return requested
      val primary = requested.substringBefore('-')
      if (primary == MODE_ZH || primary == MODE_EN) return primary
    }
    return MODE_EN
  }

  /**
   * Document-start script that gives dsh its native locale bootstrap.
   *
   * dsh only reads a language preference through `__DSH_LOCALE__` inside the
   * WebView; without it the page falls back to the browser language and the
   * settings page would show a language that the shell never applies. The
   * bridge reads the shell preference on every page load, so a reload after a
   * switch is enough to converge.
   *
   * `onChange` is the only engine-to-shell channel, and dsh publishes on it for
   * its own reasons while a page loads: once with the locale it activated with,
   * and again whenever the durable settings scope pushes a value into the
   * running runtime — which a reload does while racing the shell's own profile
   * rewrite. Those automatic publishes carry no user intent, and ignoring only
   * the first one leaves the rest to be written back; that is what pinned
   * "follow system" to a fixed language (issue #487).
   *
   * A write therefore needs a real interaction in the page, and it must change
   * the language the shell currently displays. The displayed language is read
   * from the bridge at call time rather than baked in here: this script is
   * installed once per activity, while the mode changes underneath it on every
   * switch, so a captured value would judge the second switch against the first.
   * @param mode - stored preference (`system`, `zh`, `en`); the fallback answer
   *   when the bridge cannot be read.
   * @param languages - device language tags in preference order.
   * @returns a classic script safe to run before the engine bundle.
   */
  internal fun bootstrapScript(mode: String, languages: List<String>): String {
    val preference = if (mode == MODE_SYSTEM) "null" else jsQuote(mode)
    val ordered = languages.filter { it.isNotBlank() }.distinct()
    val tags = (ordered.ifEmpty { listOf(MODE_ZH) }).joinToString(",") { jsQuote(it) }
    val baked = jsQuote(expectedLocale(mode, languages))
    return "(function(){try{" +
      "var tags=[$tags];var baked=$baked;var armed=false;" +
      "function arm(){armed=true;setTimeout(function(){armed=false},0)}" +
      "function shown(){" +
      "var mode=null;" +
      "try{var b=window.androidBridge;" +
      "if(b&&typeof b.getUiLanguage==='function')mode=String(b.getUiLanguage())}catch(e){}" +
      "if(mode==='zh'||mode==='en')return mode;" +
      "if(mode==='system'){for(var i=0;i<tags.length;i++){" +
      "var t=String(tags[i]).toLowerCase();" +
      "if(t==='zh'||t==='en')return t;" +
      "var p=t.split('-')[0];if(p==='zh'||p==='en')return p}" +
      "return 'en'}" +
      "return baked}" +
      "try{document.addEventListener('click',arm,true);" +
      "document.addEventListener('keydown',arm,true);" +
      "document.addEventListener('touchend',arm,true)}catch(e){}" +
      "globalThis.__DSH_LOCALE__={read:function(){return Promise.resolve({languages:tags,preference:$preference})}," +
      "onChange:function(locale){if(!armed)return;armed=false;" +
      "var next=String(locale);" +
      // 桥只认三档；语言包 id 不在这里静默降级成「跟随系统」。
      "if(next!=='zh'&&next!=='en')return;" +
      "if(next===shown())return;" +
      "try{var b=window.androidBridge;" +
      "if(b&&typeof b.setUiLanguage==='function')b.setUiLanguage(next)" +
      "}catch(e){}}};" +
      "}catch(e){}})();"
  }

  /** Minimal JS string literal; tags come from Locale and contain no quotes or line breaks. */
  private fun jsQuote(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
