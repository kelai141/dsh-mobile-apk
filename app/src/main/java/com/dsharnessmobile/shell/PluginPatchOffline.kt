package com.dsharnessmobile.shell

/**
 * 未启动引擎时的插件管理数据源：直接读写 live 装配清单（profile patch）。
 *
 * 为什么需要它：插件管理此前只有一条数据源——运行中的引擎（pluginManager RPC）。引擎起不来时
 * 页面只剩「启动引擎」一个出口，而「某个 soft 插件导致引擎起不来」恰恰是用户最需要管理插件的
 * 时刻（悖论：先起引擎才能关掉导致起不来的插件）。这里提供第二条数据源，语义与上游
 * plugin-manager/src/patch.ts 同源：只做 Cordis 的 disabled 覆盖（顶层 - id: X + disabled 的
 * 条目级覆盖，或插入条目自身的 disabled 行），不解析 YAML、不重排、不删除任何用户内容。
 *
 * 边界（有意保守）：
 * - 只列出 insert 组里的子条目（= 可装配的插件来源）；顶层 - id: 是对既有条目的配置覆盖，
 *   不是插件来源，因此不作为可管理行，只作为「禁用覆盖」参与状态判定。
 * - Hard 清单中的 {id, name} 一律不列出（产品件由壳侧与安全模式负责，离线页面不提供入口）。
 * - 没有 id 的条目无法被覆盖寻址，不列出。
 * - 任何无法唯一确定的目标一律返回 null（拒绝写入），绝不猜。
 */
internal object PluginPatchOffline {

  /** 一行可管理的 soft 插件。[enabled] 已按 Cordis 覆盖语义折叠为生效值。 */
  internal data class Row(val id: String, val name: String?, val enabled: Boolean)

  private val TOP_LEVEL = Regex("""^-(?:\s|$)""")
  private val TOP_INSERT = Regex("""^-\s+insert:\s*$""")
  private val TOP_ID = Regex("""^-\s+id:\s*(.*)$""")
  private val ITEM = Regex("""^(\s*)-\s+(id|name):\s*(.*)$""")
  private val KEY = Regex("""^(\s*)(id|name|disabled):\s*(.*)$""")
  private val DISABLED_ROW = Regex("""^(\s*)disabled:\s*(true|false)\s*(#.*)?$""")

  private fun clean(line: String): String = line.trimEnd('\r')

  /**
   * 去掉标量引号并还原我们**自己**写出的转义。
   *
   * 必须成对：写侧只产出 YAML 双引号标量（转义反斜杠与双引号），读侧就要还原同样两种，
   * 否则「写进去的 name 与读回来的 name 不相等」——覆盖会被自己的读取口径判成不生效。
   */
  private fun unquote(value: String): String {
    val text = value.trim()
    if (text.length < 2) return text
    val first = text.first()
    val last = text.last()
    if (first != last || (first != '\'' && first != '"')) return text
    val body = text.substring(1, text.length - 1)
    if (first == '\'') return body.replace("''", "'")
    return body.replace("\\\"", "\"").replace("\\\\", "\\")
  }

  private class Block(val start: Int, val end: Int, val insert: Boolean)

  private fun blocks(lines: List<String>): List<Block> {
    val out = ArrayList<Block>()
    var start = -1
    for (index in lines.indices) {
      if (!TOP_LEVEL.containsMatchIn(clean(lines[index]))) continue
      if (start >= 0) out += Block(start, index, TOP_INSERT.matches(clean(lines[start])))
      start = index
    }
    if (start >= 0) out += Block(start, lines.size, TOP_INSERT.matches(clean(lines[start])))
    return out
  }

  /** insert 组内的一条子条目：行区间 + 自身 id/name/disabled。 */
  private class Span(val start: Int, val end: Int, val id: String?, val name: String?, val disabled: Boolean?)

  private fun spans(lines: List<String>, block: Block): List<Span> {
    val body = (block.start + 1 until block.end).mapNotNull { index ->
      ITEM.matchEntire(clean(lines[index]))?.let { index to it }
    }
    if (body.isEmpty()) return emptyList()
    val itemIndent = body.minOf { it.second.groupValues[1].length }
    val heads = body.filter { it.second.groupValues[1].length == itemIndent }.map { it.first }
    return heads.mapIndexed { position, headLine ->
      val end = heads.getOrNull(position + 1) ?: block.end
      val head = ITEM.matchEntire(clean(lines[headLine]))
      var id: String? = if (head?.groupValues?.get(2) == "id") unquote(head.groupValues[3]) else null
      var name: String? = if (head?.groupValues?.get(2) == "name") unquote(head.groupValues[3]) else null
      var disabled: Boolean? = null
      for (index in headLine + 1 until end) {
        val key = KEY.matchEntire(clean(lines[index])) ?: continue
        if (key.groupValues[1].length != itemIndent + 2) continue
        when (key.groupValues[2]) {
          "name" -> if (name == null) name = unquote(key.groupValues[3])
          "disabled" -> disabled = key.groupValues[3].trim().substringBefore(' ').toBooleanStrictOrNull()
        }
      }
      Span(headLine, end, id, name, disabled)
    }
  }

  /** 顶层 - id: 覆盖块：块内 id/name/disabled。 */
  private class Override(val id: String, val name: String?, val disabled: Boolean?, val disabledLine: Int?)

  private fun overrides(lines: List<String>, block: Block): Override? {
    val head = TOP_ID.matchEntire(clean(lines[block.start])) ?: return null
    val id = unquote(head.groupValues[1]).takeIf { it.isNotEmpty() } ?: return null
    var name: String? = null
    var disabled: Boolean? = null
    var disabledLine: Int? = null
    for (index in block.start + 1 until block.end) {
      val key = KEY.matchEntire(clean(lines[index])) ?: continue
      if (key.groupValues[1].length != 2) continue
      when (key.groupValues[2]) {
        "name" -> name = unquote(key.groupValues[3])
        "disabled" -> {
          disabled = key.groupValues[3].trim().substringBefore(' ').toBooleanStrictOrNull()
          disabledLine = index
        }
      }
    }
    return Override(id, name, disabled, disabledLine)
  }

  /**
   * 列出可离线管理的 soft 插件。
   * @param patchText live 装配清单全文。
   * @param hard 当前快照绑定的 Hard 清单（调用方保证非空）。
   */
  internal fun rows(patchText: String, hard: PluginMounts.HardManifest): List<Row> {
    val lines = patchText.split("\n")
    val all = blocks(lines)
    val overrideRows = all.filterNot { it.insert }.mapNotNull { overrides(lines, it) }
    val out = ArrayList<Row>()
    for (block in all) {
      if (!block.insert) continue
      for (span in spans(lines, block)) {
        val id = span.id ?: continue
        val name = span.name
        if (hard.owns(id, name)) continue
        // Cordis 覆盖语义：同 id 的顶层覆盖按出现顺序最后一条生效；name 断言不匹配的覆盖不生效。
        val effective = overrideRows.lastOrNull { row ->
          row.id == id && (row.name == null || name == null || row.name == name) && row.disabled != null
        }?.disabled
        val enabled = !(effective ?: span.disabled ?: false)
        out += Row(id, name, enabled)
      }
    }
    return out.distinctBy { it.id }.sortedWith(compareBy({ it.name ?: "" }, { it.id }))
  }

  /**
   * 把某个条目的启用状态写成 Cordis patch 覆盖。纯函数：不改动其它任何字节。
   *
   * 顺序（与上游 writePluginEnabled 同源）：
   * 1. 已有顶层覆盖带 disabled ⇒ 就地改写该值（最后一条生效）；
   * 2. 否则条目自身的 disabled 行 ⇒ 就地改写；
   * 3. 否则「停用」⇒ 追加一条 id + name + disabled: true 覆盖；
   *    「启用」而当前无任何禁用痕迹 ⇒ 已是启用态，无改动。
   *
   * @return 新全文；null = 无改动或无法安全定位（调用方不得落盘）。
   */
  internal fun setEnabled(patchText: String, id: String, name: String?, enabled: Boolean): String? {
    val wanted = id.trim()
    if (wanted.isEmpty()) return null
    val lines = patchText.split("\n").toMutableList()
    val all = blocks(lines)
    val overrideRows = all.filterNot { it.insert }.mapNotNull { overrides(lines, it) }
    val targetOverride = overrideRows.lastOrNull { row ->
      row.id == wanted && (row.name == null || name == null || row.name == name) && row.disabled != null
    }
    val overrideLine = targetOverride?.disabledLine
    if (targetOverride != null && overrideLine != null) {
      // disabled 标记的语义是「停用」：期望启用 ⇒ 目标值 false。
      if (targetOverride.disabled == !enabled) return null
      lines[overrideLine] = rewriteDisabled(lines[overrideLine], !enabled)
      return lines.joinToString("\n")
    }
    // 定位插入条目（与读取侧同一判据）。已存在其它插件而目标不在其中 ⇒ 拒绝写入，绝不凭 id 猜目标。
    val managed = all.filter { it.insert }.flatMap { spans(lines, it) }
    val span = managed.firstOrNull { it.id == wanted && (name == null || it.name == name) }
    if (managed.isNotEmpty() && span == null) return null
    // 条目自身带 disabled 行时改那一行：改的是「这个插入条目」，语义与上游 patch.ts 一致。
    if (span != null && span.disabled != null) {
      if (span.disabled == !enabled) return null
      for (index in span.start + 1 until span.end) {
        if (!DISABLED_ROW.matches(clean(lines[index]))) continue
        lines[index] = rewriteDisabled(lines[index], !enabled)
        return lines.joinToString("\n")
      }
      return null
    }
    // 启用而当前没有任何禁用痕迹：已经是启用态，不制造多余的覆盖条目。
    if (enabled) return null
    val newline = if (patchText.contains("\r\n")) "\r\n" else "\n"
    val tail = StringBuilder()
    // 覆盖块之间留一个空行，避免与前一条的 config 缩进粘连；空清单（[]）直接续写。
    if (patchText.isNotEmpty() && !patchText.trimEnd().endsWith("[]")) tail.append(newline)
    tail.append("- id: ").append(quote(wanted)).append(newline)
    name?.takeIf { it.isNotBlank() }?.let { tail.append("  name: ").append(quote(it)).append(newline) }
    tail.append("  disabled: true").append(newline)
    return patchText + tail.toString()
  }

  /** 只改写 disabled: 的取值，保留缩进与行尾注释。 */
  private fun rewriteDisabled(line: String, want: Boolean): String {
    val cr = if (line.endsWith('\r')) "\r" else ""
    val body = if (cr.isEmpty()) line else line.dropLast(1)
    val match = DISABLED_ROW.matchEntire(body) ?: return line
    val comment = match.groupValues[3]
    val suffix = if (comment.isBlank()) "" else " " + comment
    return match.groupValues[1] + "disabled: " + want + suffix + cr
  }

  /**
   * YAML 标量：可裸写的才裸写，其余加双引号。
   *
   * 判据必须排除**首字符**为 `@` 的形态——YAML 把 `@` 与反引号保留给未来版本，裸写的
   * `name: @scope/pkg` 是非法标量（这正是我们注入集里最常见的包名形态）。
   *
   * 转义只做 YAML 自己要的那两个字符。这里**不得**借用 JSON 序列化器：它会把 `/` 写成
   * `\/`（JSON 合法、YAML 也能读，但那是给 JSON 用的写法），而我们自己的读取口径与
   * 上游 patch 的 name 断言都按字面比较，多一个反斜杠就对不上了。
   */
  private fun quote(value: String): String =
    if (value.matches(Regex("[A-Za-z0-9_][A-Za-z0-9@/._+-]*"))) value
    else "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
