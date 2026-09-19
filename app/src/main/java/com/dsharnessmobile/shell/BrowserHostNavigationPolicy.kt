package com.dsharnessmobile.shell

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI

/**
 * URL admission for the untrusted BrowserHost surface.
 *
 * 两层防线（两者共用同一套主机规范化，避免「一层按字面量、一层按 IP」的口径分裂）：
 *  - [normalize]：**顶层导航**准入。返回的串既用于判定、也用于实际 `loadUrl` —— 见下方
 *    「为什么必须用规范化后的 host 重建 URL」。
 *  - [blockedRequestReason]：**请求级**过滤（`shouldInterceptRequest`）。顶层导航串被查过，
 *    不代表页面发出去的子请求也被查过。
 */
internal object BrowserHostNavigationPolicy {

  /**
   * Normalize an address entered by the trusted workbench and reject local/trusted origins.
   *
   * 规范化面（审查 §3.2-S1 的修法）：**字符串级判定**曾可被 IP 的其它合法写法绕过——
   * `http://2130706433:3080/`（十进制整数）、`http://0x7f000001:3080/`（十六进制）、
   * `http://017700000001:3080/`（八进制）、`http://[::ffff:7f00:1]/`（IPv4-mapped IPv6）、
   * `http://localhost./`（结尾点）在旧实现下**全部放行**，而 Chromium 一律把它们规范化为
   * `127.0.0.1`。叠加「引擎鉴权 cookie 在进程级 CookieManager 里」这一事实，被绕过的后果不是
   * SSRF 探测，而是**以已登录身份打开引擎 API 并把响应正文读进模型上下文**。
   *
   * 为什么必须用规范化后的 host 重建 URL（而不是只拿它做判定）：只判定不重建仍然存在
   * 「策略看 A 串、Chromium 执行 B 串」的差值——策略算出的结论与实际被执行的目标可以不是同一个。
   * 重建后两者逐字同源。
   *
   * @return an http(s) or `about:blank` browser address, or null when the input is unsafe.
   */
  fun normalize(raw: String?): String? {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    if (trimmed == "about:blank") return trimmed
    val candidate = if (trimmed.contains("://") || trimmed.startsWith("about:")) trimmed else "https://$trimmed"
    return try {
      val parsed = URI(candidate)
      val scheme = parsed.scheme?.lowercase()
      if (scheme != "https" && scheme != "http") return null
      if (parsed.userInfo != null) return null
      val host = parsed.host
      if (host.isNullOrBlank()) return null
      val canonical = when (val verdict = canonicalHost(host, denyLinkLocal = false)) {
        is HostVerdict.Denied -> return null
        is HostVerdict.Ok -> verdict.host
      }
      val rebuilt = buildString {
        append(scheme).append("://").append(canonical)
        if (parsed.port >= 0) append(':').append(parsed.port)
        append(parsed.rawPath.orEmpty())
        parsed.rawQuery?.let { append('?').append(it) }
        parsed.rawFragment?.let { append('#').append(it) }
      }
      URI(rebuilt).toASCIIString()
    } catch (_: Throwable) {
      null
    }
  }

  /**
   * 请求级过滤（审查 §3.2-S4）：页面发起的**任意**子请求都过这里。
   *
   * 为什么必须有这一层：`shouldOverrideUrlLoading` 只覆盖顶层导航，而放行后的任意站点可以用
   * `<img>/<iframe>/<script>/<form>/fetch/XHR` 去打 `127.0.0.1:3080`、`192.168.*`、
   * `169.254.169.254`——旧实现在壳侧**零防线**，唯一的拦截是引擎侧的 `sec-fetch-site/origin`
   * 判定与 cookie 的 SameSite 语义，而**这两者都不是本仓可控属性**。
   *
   * 拒绝面分两档（与准入刻意不同，理由写在 [verdictForIpv4]）：
   *  - 恒定拒绝：回环（127/8、::1、IPv4-mapped 回环）、未指定（0.0.0.0、::）；
   *  - 额外拒绝：链路本地/元数据段（169.254/16、fe80::/10）——子资源没有正当理由访问它们。
   *
   * 域名不在此层判定（不做 DNS：本函数在请求热路径上，且 DNS 解析结果与 URL 字面量不是一回事）。
   * 局域网私网段（192.168/10/172.16）按 0.14.1 用户裁定**放行**（模型要能打开局域网设备页）。
   *
   * @return 拒绝原因（用于日志与计数）；null = 放行。
   */
  fun blockedRequestReason(rawUrl: String?): String? {
    val text = rawUrl?.trim().orEmpty()
    if (text.isEmpty()) return null
    return try {
      val parsed = URI(text)
      val scheme = parsed.scheme?.lowercase() ?: return null
      if (scheme != "http" && scheme != "https" && scheme != "ws" && scheme != "wss") return null
      val host = parsed.host ?: return null
      when (val verdict = canonicalHost(host, denyLinkLocal = true)) {
        is HostVerdict.Denied -> verdict.reason
        is HostVerdict.Ok -> null
      }
    } catch (_: Throwable) {
      // 解析不了的 URL 交给 WebView 自己处理：过滤层不引入新的失败面（它只做「目标是否本机」判定）。
      null
    }
  }

  private sealed class HostVerdict {
    class Ok(val host: String) : HostVerdict()
    class Denied(val reason: String) : HostVerdict()
  }

  /**
   * 主机规范化：把**任何等价写法**归一到可判定的字面量。
   * @param denyLinkLocal 是否连链路本地一起拒（准入 false / 请求过滤 true）
   */
  private fun canonicalHost(rawHost: String, denyLinkLocal: Boolean): HostVerdict {
    var host = rawHost.trim().lowercase()
    if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length - 1)
    host = host.trimEnd('.')          // `localhost.` / `example.com.` 都是合法写法（FQDN 根点）
    if (host.isEmpty() || host.contains('%')) return HostVerdict.Denied("malformed-host")
    if (host == "localhost") return HostVerdict.Denied("loopback")
    if (host.contains(':')) {
      // IPv6 字面量。只对含 ':' 的串调用平台解析（含 ':' 的不可能是域名 ⇒ 不会触发 DNS）。
      val address = try {
        InetAddress.getByName(host)
      } catch (_: Throwable) {
        return HostVerdict.Denied("malformed-host")
      }
      // IPv4-mapped（::ffff:127.0.0.1）在 JDK/Android 上通常直接落成 Inet4Address；两种形态都要覆盖。
      if (address is Inet4Address) return verdictForIpv4(address.address, denyLinkLocal)
      if (address is Inet6Address) {
        mappedIpv4Of(address)?.let { return verdictForIpv4(it, denyLinkLocal) }
        if (address.isLoopbackAddress) return HostVerdict.Denied("loopback")
        if (address.isAnyLocalAddress) return HostVerdict.Denied("unspecified")
        if (denyLinkLocal && address.isLinkLocalAddress) return HostVerdict.Denied("link-local")
        return HostVerdict.Ok("[" + address.hostAddress.lowercase() + "]")
      }
      return HostVerdict.Denied("malformed-host")
    }
    val ipv4 = parseIpv4Literal(host) ?: return HostVerdict.Ok(host)   // 非 IP 字面量 = 域名
    return verdictForIpv4(ipv4, denyLinkLocal)
  }

  /**
   * 单段数值：`0x…` 十六进制 / 前导 `0` 八进制 / 十进制。
   * 非法字符（含八进制里出现 8/9）返回 null ⇒ 调用方视为**域名**（Chromium 同样拒绝解析这种形态，
   * 转而走 DNS；把 DNS 交给浏览器、本层只判 IP 字面量，口径一致）。
   */
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

  /**
   * IPv4-mapped（`::ffff:a.b.c.d`）与 IPv4-compatible（`::a.b.c.d`，已废弃但仍被解析）的低 32 位。
   *
   * 两档拒绝面的差别就在本函数的下游：
   *  - 回环与未指定是**任何**层级都不该出现的目标（准入与请求过滤同拒）；
   *  - 链路本地/元数据只对**子资源**额外拒绝 —— 顶层导航刻意保留局域网能力（0.14.1 用户裁定：
   *    模型要能打开路由器/NAS 管理页），而 169.254/16 不属于「局域网设备页」这个场景。
   */
  private fun verdictForIpv4(bytes: ByteArray, denyLinkLocal: Boolean): HostVerdict {
    if (bytes.size != 4) return HostVerdict.Denied("malformed-host")
    val b0 = bytes[0].toInt() and 0xFF
    val b1 = bytes[1].toInt() and 0xFF
    val quad = "$b0.$b1.${bytes[2].toInt() and 0xFF}.${bytes[3].toInt() and 0xFF}"
    return when {
      b0 == 127 -> HostVerdict.Denied("loopback")
      b0 == 0 -> HostVerdict.Denied("unspecified")
      denyLinkLocal && b0 == 169 && b1 == 254 -> HostVerdict.Denied("link-local")
      else -> HostVerdict.Ok(quad)
    }
  }

  /** IPv4-mapped / IPv4-compatible 形态的低 32 位；非该形态返回 null（回环/未指定由调用方判）。 */
  private fun mappedIpv4Of(address: Inet6Address): ByteArray? {
    val bytes = address.address
    if (bytes.size != 16) return null
    for (i in 0 until 10) if (bytes[i] != 0.toByte()) return null
    val high = bytes[10].toInt() and 0xFF
    val low = bytes[11].toInt() and 0xFF
    val mapped = high == 0xFF && low == 0xFF
    val compatible = high == 0 && low == 0
    if (!mapped && !compatible) return null
    // `::`（全零）与 `::1`（回环）不在此处判：它们由 isAnyLocalAddress / isLoopbackAddress 覆盖，
    // 而这里的兼容形态提取会把 `::1` 的低 32 位读成 0.0.0.1 —— 同样会被判拒（b0==0），结果一致。
    return bytes.copyOfRange(12, 16)
  }
}
