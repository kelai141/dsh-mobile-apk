package com.dsharnessmobile.shell

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI

/**
 * One canonical destination policy for navigation, page requests and profile service workers.
 * Loopback is only admitted after BrowserHost has verified a nonDefault profile assignment.
 * The conservative defaults preserve callers that have not established that trust boundary.
 * This is a literal-host policy, not a DNS/network firewall (no DNS on the request hot path).
 */
internal object BrowserHostNavigationPolicy {
  private val PROTECTED_ENGINE_PORT: Int get() = EngineEndpoint.port

  /** Rebuild the actual load URL from the same canonical host used for admission. */
  fun normalize(
    raw: String?,
    isolatedProfile: Boolean = false,
    allowAnonymousEngineAccess: Boolean = false,
  ): String? {
    val text = raw?.trim().orEmpty()
    if (text.isEmpty()) return null
    if (text == "about:blank") return text
    // A bare host may omit the scheme; an explicit unsafe scheme must never become a host.
    if (Regex("^(?i:javascript|file|content|data|blob|intent|about|mailto|tel|ws|wss):").containsMatchIn(text)) return null
    val candidate = if (text.contains("://")) text else "https://$text"
    return try {
      val parsed = URI(candidate)
      val scheme = parsed.scheme?.lowercase()
      if (scheme != "http" && scheme != "https") return null
      val destination = destination(parsed, isolatedProfile, allowAnonymousEngineAccess)
      if (destination.reason != null) return null
      val rebuilt = buildString {
        append(scheme).append("://").append(destination.host)
        destination.port?.let { append(':').append(it) }
        append(parsed.rawPath.orEmpty())
        parsed.rawQuery?.let { append('?').append(it) }
        parsed.rawFragment?.let { append('#').append(it) }
      }
      URI(rebuilt).toASCIIString()
    } catch (_: Exception) {
      null
    }
  }

  /** null means admitted. Safe inline/blob resources are not network destinations. */
  fun blockedRequestReason(
    rawUrl: String?,
    isolatedProfile: Boolean = false,
    allowAnonymousEngineAccess: Boolean = false,
  ): String? {
    val text = rawUrl?.trim().orEmpty()
    if (text.isEmpty() || text == "about:blank") return null
    return try {
      val parsed = URI(text)
      when (parsed.scheme?.lowercase()) {
        "http", "https", "ws", "wss" -> destination(parsed, isolatedProfile, allowAnonymousEngineAccess).reason
        "data", "blob" -> null
        else -> "unsupported-scheme"
      }
    } catch (_: Exception) {
      "malformed-url"
    }
  }

  private data class Destination(val host: String = "", val port: Int? = null, val reason: String? = null)

  private fun destination(parsed: URI, isolatedProfile: Boolean, allowAnonymousEngineAccess: Boolean): Destination {
    val authority = parsed.rawAuthority ?: return Destination(reason = "malformed-host")
    if (parsed.userInfo != null || authority.contains('@')) return Destination(reason = "userinfo")
    // Encoded hosts, scoped IPv6, backslashes and control characters disagree across parsers.
    if (authority.any { it == '%' || it == '\\' || it <= ' ' || it == '\u007f' }) {
      return Destination(reason = "malformed-host")
    }
    val host: String
    val portText: String?
    if (authority.startsWith("[")) {
      val end = authority.indexOf(']')
      if (end < 0) return Destination(reason = "malformed-host")
      host = authority.substring(0, end + 1)
      val suffix = authority.substring(end + 1)
      if (suffix.isNotEmpty() && !suffix.startsWith(":")) return Destination(reason = "malformed-host")
      portText = suffix.takeIf { it.isNotEmpty() }?.substring(1)
    } else {
      if (authority.count { it == ':' } > 1) return Destination(reason = "malformed-host")
      host = authority.substringBefore(':')
      portText = if (authority.contains(':')) authority.substringAfter(':') else null
    }
    val port = if (portText != null) {
      if (portText.isEmpty() || portText.any { it !in '0'..'9' }) return Destination(reason = "invalid-port")
      portText.toIntOrNull()?.takeIf { it in 1..65535 } ?: return Destination(reason = "invalid-port")
    } else null
    return when (val verdict = canonicalHost(host)) {
      is HostVerdict.Denied -> Destination(reason = verdict.reason)
      is HostVerdict.Ok -> when {
        verdict.loopback && !isolatedProfile -> Destination(reason = "loopback")
        verdict.loopback && port == PROTECTED_ENGINE_PORT && !allowAnonymousEngineAccess ->
          Destination(reason = "protected-engine-origin")
        else -> Destination(verdict.host, port)
      }
    }
  }

  private sealed class HostVerdict {
    class Ok(val host: String, val loopback: Boolean = false) : HostVerdict()
    class Denied(val reason: String) : HostVerdict()
  }

  private fun canonicalHost(rawHost: String): HostVerdict {
    var host = rawHost.lowercase()
    if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length - 1)
    host = host.trimEnd('.')
    if (host.isEmpty() || host.contains('%')) return HostVerdict.Denied("malformed-host")
    // Chromium treats *.localhost as loopback too. Pin it rather than relying on DNS.
    if (host == "localhost" || host.endsWith(".localhost")) return HostVerdict.Ok("127.0.0.1", loopback = true)
    if (host.contains(':')) {
      // Only literal IPv6 reaches InetAddress: never resolve a domain on this hot path.
      val address = try { InetAddress.getByName(host) } catch (_: Exception) {
        return HostVerdict.Denied("malformed-host")
      }
      if (address is Inet4Address) return verdictForIpv4(address.address)
      if (address is Inet6Address) {
        if (address.isAnyLocalAddress) return HostVerdict.Denied("unspecified")
        if (address.isLoopbackAddress) return HostVerdict.Ok("[::1]", loopback = true)
        mappedIpv4Of(address)?.let { return verdictForIpv4(it) }
        if (address.isLinkLocalAddress) return HostVerdict.Denied("link-local")
        val canonical = address.hostAddress ?: return HostVerdict.Denied("malformed-host")
        return HostVerdict.Ok("[" + canonical.lowercase() + "]")
      }
      return HostVerdict.Denied("malformed-host")
    }
    parseIpv4Literal(host)?.let { return verdictForIpv4(it) }
    if (host.length > 253 || host.split('.').any { label ->
      label.isEmpty() || label.length > 63 || label.startsWith('-') || label.endsWith('-') ||
        label.any { it !in 'a'..'z' && it !in '0'..'9' && it != '-' }
    }) return HostVerdict.Denied("malformed-host")
    // Numeric-looking invalid IPv4 must not slip into a DNS branch and differ from Chromium.
    val last = host.substringAfterLast('.')
    if (last.all { it in '0'..'9' } || last.startsWith("0x")) return HostVerdict.Denied("malformed-host")
    return HostVerdict.Ok(host)
  }

  private fun parseNumericPart(part: String): Long? {
    if (part.isEmpty()) return null
    val radix: Int
    val digits: String
    when {
      part.startsWith("0x") || part.startsWith("0X") -> { radix = 16; digits = part.substring(2) }
      part.length > 1 && part.startsWith("0") -> { radix = 8; digits = part.substring(1) }
      else -> { radix = 10; digits = part }
    }
    if (digits.isEmpty()) return 0L
    var value = 0L
    for (ch in digits) {
      val digit = when {
        ch in '0'..'9' -> ch - '0'
        radix == 16 && ch in 'a'..'f' -> ch - 'a' + 10
        else -> return null
      }
      if (digit >= radix) return null
      value = value * radix + digit
      if (value > 0xFFFFFFFFL) return null
    }
    return value
  }

  /**
   * `inet_aton` 语义的 IPv4 字面量解析（Chromium 与 libc 同款）：
   * `a` / `a.b` / `a.b.c` / `a.b.c.d`，各段可用十/八/十六进制，**最后一段填充剩余字节**。
   * 于是 `2130706433`、`0x7f000001`、`017700000001`、`0177.0.0.1`、`127.1` 全部 = `127.0.0.1`。
   * @return 4 字节地址；null = 不是 IPv4 字面量（含非数字段时即视为域名）
   */
  private fun parseIpv4Literal(host: String): ByteArray? {
    val parts = host.split('.')
    if (parts.isEmpty() || parts.size > 4) return null
    val values = LongArray(parts.size)
    for (index in parts.indices) {
      values[index] = parseNumericPart(parts[index]) ?: return null
    }
    val head = parts.size - 1
    var address = 0L
    for (i in 0 until head) {
      if (values[i] > 0xFF) return null
      address = (address shl 8) or values[i]
    }
    val tailBytes = 4 - head
    val limit = if (tailBytes >= 4) 0xFFFFFFFFL else (1L shl (8 * tailBytes)) - 1
    if (values[head] > limit) return null
    address = (address shl (8 * tailBytes)) or values[head]
    return byteArrayOf(
      ((address shr 24) and 0xFF).toByte(),
      ((address shr 16) and 0xFF).toByte(),
      ((address shr 8) and 0xFF).toByte(),
      (address and 0xFF).toByte(),
    )
  }

  /** LAN private addresses remain supported; unspecified and metadata/link-local never do. */
  private fun verdictForIpv4(bytes: ByteArray): HostVerdict {
    if (bytes.size != 4) return HostVerdict.Denied("malformed-host")
    val b0 = bytes[0].toInt() and 0xFF
    val b1 = bytes[1].toInt() and 0xFF
    val quad = "$b0.$b1.${bytes[2].toInt() and 0xFF}.${bytes[3].toInt() and 0xFF}"
    return when {
      b0 == 0 -> HostVerdict.Denied("unspecified")
      b0 == 169 && b1 == 254 -> HostVerdict.Denied("link-local")
      else -> HostVerdict.Ok(quad, loopback = b0 == 127)
    }
  }

  private fun mappedIpv4Of(address: Inet6Address): ByteArray? {
    val bytes = address.address
    if (bytes.size != 16) return null
    for (i in 0 until 10) if (bytes[i] != 0.toByte()) return null
    val high = bytes[10].toInt() and 0xFF
    val low = bytes[11].toInt() and 0xFF
    val mapped = high == 0xFF && low == 0xFF
    val compatible = high == 0 && low == 0
    if (!mapped && !compatible) return null
    return bytes.copyOfRange(12, 16)
  }
}
