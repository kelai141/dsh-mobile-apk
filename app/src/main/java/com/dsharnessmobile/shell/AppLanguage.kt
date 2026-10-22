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
   * Mirror the preference into the profile patch dsh actually reads.
   *
   * dsh 0.2.x stores this namespace in `profiles/web/cordis.patch.yml`; the
   * old `settings.yaml` section is only imported once and no longer read. A
   * forced mode writes `- id: locale` with `config.preference`; following the
   * system removes that preference so dsh falls back to the system languages
   * supplied by the WebView bridge.
   * @return true when the patch now matches the preference.
   */
  fun syncDshLocale(context: Context): Boolean {
    val file = profilePatchFile(context) ?: return false
    val locale = if (mode(context) == MODE_SYSTEM) null else dshLocale(context)
    return try {
      val original = if (file.exists()) file.readText() else ""
      val updated = withDshLocalePreference(original, locale)
      if (updated != original) {
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, ".cordis.patch.yml.lang-tmp")
        temporary.writeText(updated)
        if (!temporary.renameTo(file)) {
          file.writeText(updated)
          temporary.delete()
        }
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
   * Document-start script that gives dsh its native locale bootstrap.
   *
   * dsh only reads a language preference through `__DSH_LOCALE__` inside the
   * WebView; without it the page falls back to the browser language and the
   * settings page would show a language that the shell never applies. The
   * bridge reads the shell preference on every page load, so a reload after a
   * switch is enough to converge.
   * @param mode - stored preference (`system`, `zh`, `en`).
   * @param languages - device language tags in preference order.
   * @returns a classic script safe to run before the engine bundle.
   */
  internal fun bootstrapScript(mode: String, languages: List<String>): String {
    val preference = if (mode == MODE_SYSTEM) "null" else jsQuote(mode)
    val ordered = languages.filter { it.isNotBlank() }.distinct()
    val tags = (ordered.ifEmpty { listOf(MODE_ZH) }).joinToString(",") { jsQuote(it) }
    // onChange 的第一次调用是 dsh 发布「它自己解析出的当前语言」，不是用户选择：
    // 把它写回壳偏好会把「跟随系统」变成固定语言。之后的选择才是用户在设置页
    // 显式切换，交回壳侧存 ui_language 并同步 profile（壳侧据偏好重建原生界面）。
    return "(function(){try{" +
      "var tags=[$tags];var first=true;" +
      "globalThis.__DSH_LOCALE__={read:function(){return Promise.resolve({languages:tags,preference:$preference})}," +
      "onChange:function(locale){if(first){first=false;return}" +
      "try{var b=window.androidBridge;" +
      "if(b&&typeof b.setUiLanguage==='function')b.setUiLanguage(String(locale))" +
      "}catch(e){}}};" +
      "}catch(e){}})();"
  }

  /** Minimal JS string literal; tags come from Locale and contain no quotes or line breaks. */
  private fun jsQuote(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
