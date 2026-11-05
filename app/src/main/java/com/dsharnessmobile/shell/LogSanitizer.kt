package com.dsharnessmobile.shell

/**
 * 功能 B（0.14.6）诊断包出口的**唯一脱敏咽喉**（规格 B4）。
 *
 * 为什么单独成一个对象、而不是散在打包代码里：脱敏是「要么全对、要么全错」的性质——
 * 只要有一条出口忘了过它，整份诊断包就是泄漏源。故本对象是**纯函数**（只有输入输出，
 * 无 IO、无 Context、无静态可变状态），生产调用方只有一处（LogShare.pack），
 * JVM 单测可直接喂真实形态的凭据样本做正反例。
 *
 * 与 [EngineAuth.redact] 的关系：后者是壳侧既有的日志出口脱敏（0.13.8 #184），负责启动令牌
 * 参数。本对象**先复用**它，再补上其余类别；不复制它的实现，避免两处口径漂移。
 *
 * **fail-closed**：[sanitizeOrNull] 任一步抛异常一律返回 null，调用方必须**丢弃整条条目**
 * 并在 manifest 里如实标注 sanitize-failed——绝不允许「脱敏失败就原样写进去」。
 *
 * 覆盖七类（顺序有意义，见各正则注释）：PEM 私钥整块 / 授权头 / Cookie 头 / 厂商密钥形态 /
 * 敏感键名键值 / 环境变量导出行 / URL 查询串敏感参数。
 *
 * 方向性取舍：**宁可多打码，不可漏打码**。多打码的代价是排障时少读一个非敏感值；
 * 漏打码的代价是用户真实凭据被发出去，不可撤回。
 */
internal object LogSanitizer {

  /** 打码占位符（与 [EngineAuth.redact] 的令牌打码同形，便于对照阅读）。 */
  const val MASK = "***"

  /** 私钥整块占位符：块边界也要消失，否则读者会以为密钥只是被截断。 */
  const val PRIVATE_KEY_MASK = "[REDACTED-PRIVATE-KEY]"

  /** 单条条目脱敏失败时 manifest 里的标注（不得静默消失）。 */
  const val DEREDACT_FAILED = "sanitize-failed"

  /**
   * 第 1 类：PEM 私钥整块（跨行）。
   *
   * 块内每一行都可能是密钥材料，因此**整块**替换而不逐行处理。(?s) 让点号跨行匹配；
   * 单独拆成 [redactPrivateKeyBlocks] 是因为逐行规则无法覆盖 BEGIN/END 之间的内容。
   */
  private val PRIVATE_KEY_BLOCK =
    Regex("""(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----""")

  /** 第 2 类：授权头。方案前缀一并吃掉，避免只打码方案名而把令牌留在原地。 */
  private val AUTH_HEADER =
    Regex("""(?i)\b(authorization|proxy-authorization)(\s*:\s*)(?:[A-Za-z]+\s+)?\S+""")

  /** 第 3 类：Cookie 头整行值（dsh-auth 会话 cookie 与普通 cookie 一视同仁）。
   *
   * 判据用 \b 定位头名而不是行首锚定：curl verbose / HTTP 抓包导出的请求头带行内前缀
   * （`> Cookie: …`、`[req] Cookie: …`），`^` 锚定会整行放过（#508 实测漏网形态）。
   * 值吞到行尾；正文里出现 `cookie: xxx` 同样打码——符合「宁可多打码」口径。
   */
  private val COOKIE_HEADER = Regex("""(?i)\b((?:set-)?cookie\s*:\s*).*""")

  /**
   * 第 4 类：厂商密钥形态。
   *
   * 长度下限刻意取得很短：这里是**脱敏**口径而不是**提取**口径——[EngineAuth] 已经因为把
   * 提取正则（带长度下限）误用到脱敏出口而漏打过短令牌（0.14.1 实测），同一坑不在这里重犯。
   */
  private val VENDOR_KEYS = Regex(
    """\b(?:sk-[A-Za-z0-9_\-]{4,}|xai-[A-Za-z0-9_\-]{4,}|ghp_[A-Za-z0-9]{8,}""" +
      """|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AIza[0-9A-Za-z_\-]{8,}|AKIA[0-9A-Z]{16})""",
  )

  /**
   * 第 8 类：裸 JWT（`eyJ….….…`，既无键名也无 `Authorization` 前缀）。
   *
   * 为什么必须单独一类：OAuth 的 `access_token` 与部分 session cookie **本身就是 JWT**，
   * 日志里最常见的形态是光秃秃一行（`dump: eyJhbGci…`）。`AUTH_HEADER` 只认 header 前缀、
   * `SENSITIVE_KV` 只认键名 ⇒ 两类都盖不到（2026-10-28 自查实测：整段原样保留）。
   * 形态足够特征（`eyJ` 开头 = `{"` 的 base64 + 恰好两段 `.` 分隔的 base64url），误伤面很小。
   * 刻意**只打三段完整形态**：单独一段 `eyJ…` 与普通 base64 分不开，打成码会淹掉正常日志。
   */
  private val BARE_JWT = Regex("""\beyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}""")

  /**
   * 第 5 类：敏感键名 + 分隔符（半角冒号/等号与全角冒号）。
   *
   * 只按**键名**判定，不检查值的形状：password: hunter2 与 token: false 都会被打码。
   * 这是刻意的 fail-closed——值长什么样都不能作为「这不是凭据」的证据。
   */
  private val SENSITIVE_KV = Regex(
    """(?i)(["']?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token""" +
      """|id[_-]?token|client[_-]?secret|secret|password|passwd|credential|credentials|token)["']?\s*[:=：]\s*)""" +
      """(?:"[^"]*"|'[^']*'|[^\s,;&#]+)""",
  )

  /**
   * 第 6 类：环境变量导出整行（OPENAI_API_KEY 一类大写键名）。
   *
   * 允许行首空白与可选 `export ` 前缀：`^` 锚定会放过 `export FOO_KEY=…` 导出行（#508）。
   * 裸 `KEY` 后缀（`MY_SERVICE_KEY`）是 SENSITIVE_KV 子串匹配兜不到的形态，本规则是唯一覆盖面。
   */
  private val ENV_SECRET_LINE = Regex(
    """(?im)^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*=\s*).*""",
  )

  /** 第 7 类：URL 查询串敏感参数（启动令牌参数已由 [EngineAuth.redact] 负责，这里补齐其余键名）。 */
  private val QUERY_SECRET = Regex(
    """([?&](?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret""" +
      """|password|passwd|auth)=)[^\s&"'<>]+""",
  )

  /**
   * 脱敏出口。**任一步抛异常返回 null**（fail-closed，调用方必须丢弃该条目并如实记 manifest）。
   *
   * @param text 原始文本（日志条目 / 清单 / 设备信息）。
   * @returns 脱敏后的文本；失败返回 null。
   */
  fun sanitizeOrNull(text: String): String? = try {
    var out = redactPrivateKeyBlocks(EngineAuth.redact(text))
    out = out.lineSequence().joinToString("\n") { line ->
      var cur = AUTH_HEADER.replace(line) { m -> m.groupValues[1] + m.groupValues[2] + MASK }
      cur = COOKIE_HEADER.replace(cur) { m -> m.groupValues[1] + MASK }
      cur = VENDOR_KEYS.replace(cur) { MASK }
      cur = BARE_JWT.replace(cur) { MASK }
      cur = SENSITIVE_KV.replace(cur) { m -> m.groupValues[1] + MASK }
      cur = ENV_SECRET_LINE.replace(cur) { m -> m.groupValues[1] + MASK }
      cur = QUERY_SECRET.replace(cur) { m -> m.groupValues[1] + MASK }
      cur
    }
    out
  } catch (_: Throwable) {
    null
  }

  /** 私钥整块替换（纯函数；循环处理，支持一份文本里多个块）。 */
  internal fun redactPrivateKeyBlocks(text: String): String {
    var out = text
    while (true) {
      val m = PRIVATE_KEY_BLOCK.find(out) ?: break
      out = out.substring(0, m.range.first) + PRIVATE_KEY_MASK + out.substring(m.range.last + 1)
    }
    return out
  }
}
