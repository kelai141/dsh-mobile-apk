package com.dsharnessmobile.shell

/**
 * Pure policy for the startup-screen video.
 *
 * The shell accepts any video the platform can decode except MPEG-TS, bounded to
 * 50 MiB. Keeping the decision here (no Android types) lets the JVM tests pin the
 * boundary rules that the settings page and the importer both read.
 */
internal object SplashPolicy {
  /** App-private preference file; it survives APK upgrades and snapshot refreshes. */
  const val PREFS = "splash_prefs"
  const val KEY_NAME = "video_name"
  const val KEY_BYTES = "video_bytes"
  const val KEY_AUTOSTART = "autostart_on_open"

  /** The user-facing limit is 50 MB; use MiB so a 50 MB file is never rejected by rounding. */
  const val MAX_BYTES = 50L * 1024L * 1024L

  private val FORBIDDEN_EXTENSIONS = setOf("ts")
  private val FORBIDDEN_MIME = setOf("video/mp2t", "video/vnd.dlna.mpeg-tts")

  /** Enabled unless the user stored an explicit false. */
  fun autoStartEnabled(stored: Boolean?): Boolean = stored ?: true

  /** Zero-byte picks are rejected: they cannot be played and they look like a failed copy. */
  fun isSizeAllowed(bytes: Long): Boolean = bytes in 1..MAX_BYTES

  /** Lowercase extension without the dot; empty when the name has none. */
  fun extensionOf(name: String): String {
    val leaf = name.substringAfterLast('/').substringAfterLast('\\')
    val dot = leaf.lastIndexOf('.')
    if (dot <= 0 || dot == leaf.lastIndex) return ""
    return leaf.substring(dot + 1).lowercase()
  }

  /** MPEG-TS is refused by extension and by MIME, so a renamed file cannot slip through. */
  fun isForbidden(name: String, mime: String?): Boolean {
    if (extensionOf(name) in FORBIDDEN_EXTENSIONS) return true
    val normalized = mime?.substringBefore(';')?.trim()?.lowercase()
    return normalized != null && normalized in FORBIDDEN_MIME
  }

  /**
   * Stable on-disk name inside the app-private splash folder. The original name is kept
   * only in preferences for display; the file itself gets a fixed stem so removal can
   * never delete anything outside that folder.
   */
  fun storedFileName(original: String): String {
    val ext = extensionOf(original)
    val safe = ext.filter { it in 'a'..'z' || it in '0'..'9' }.take(8)
    return if (safe.isEmpty()) "splash_video" else "splash_video.$safe"
  }

  /** Null means the pick is acceptable; otherwise a stable rejection code. */
  fun rejection(name: String, mime: String?, declaredBytes: Long): String? = when {
    isForbidden(name, mime) -> "forbidden-ts"
    declaredBytes > MAX_BYTES -> "too-large"
    else -> null
  }

  /** Bytes for the settings page, one decimal (e.g. 12.3 MB). */
  fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return bytes.toString() + " B"
    val kb = bytes / 1024.0
    if (kb < 1024) return String.format(java.util.Locale.US, "%.1f KB", kb)
    val mb = kb / 1024.0
    if (mb < 1024) return String.format(java.util.Locale.US, "%.1f MB", mb)
    return String.format(java.util.Locale.US, "%.1f GB", mb / 1024.0)
  }

  /** Duration for the settings page; negative or unknown becomes an empty string. */
  fun formatDuration(ms: Long): String {
    if (ms <= 0) return ""
    val total = ms / 1000
    val seconds = total % 60
    val minutes = (total / 60) % 60
    val hours = total / 3600
    return if (hours > 0) {
      String.format(java.util.Locale.US, "%d:%02d:%02d", hours, minutes, seconds)
    } else {
      String.format(java.util.Locale.US, "%d:%02d", minutes, seconds)
    }
  }
}
