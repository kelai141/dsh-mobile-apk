package com.dsharnessmobile.shell

/**
 * 通知文件尾部的**无换行记录切分**（issue #1358）。
 *
 * ## 缺陷形态
 *
 * 消费循环以「最后一个换行」为边界（`NotifyStore.drainBytes`）：找不到换行就零消费。于是
 *
 * - 上游写一行的中途崩溃，留下无换行的残行 ⇒ 偏移永远卡住，而读取侧只要 `len > offset` 就继续读，
 *   **该行之后所有完整行都读不到**，直到文件轮转（512KB）才自愈；
 * - 更常见的一种：上游不写行尾换行（把分隔符写在下一条**前面**），两条记录就粘成
 *   `{...}{...}` —— 按换行切分只会得到一行、JSON 解析失败，**两条一起丢**。
 *
 * ## 修法
 *
 * 尾行不再「只认换行」，而是**按 JSON 值的边界切分**：只要最后一个换行之后存在**完整的顶层
 * JSON 对象**，就把它当作一条记录消费掉，并继续切下一个。于是
 *
 * - 两条连续帧都不带换行 → 两条都能出来；
 * - 混排（一帧有换行、下一帧无换行）→ 两条都能出来；
 * - 真正的半截帧（括号不闭合）→ 仍然等下一次补齐（**不宽容**）。
 *
 * 为什么可以按花括号切：这些是 NDJSON 记录，字符串内部的换行与花括号在 JSON 里必须转义，
 * 所以裸的左右花括号只可能来自结构本身。
 */
internal object NotifyTailSplit {
  /**
   * 从 [buf] 的 [from, to) 里切出**开头连续的若干完整 JSON 值**。
   *
   * @param buf 字节缓冲。
   * @param from 起始下标（通常 = 最后一个换行 + 1）。
   * @param to 结束下标（不含）。
   * @returns 第一个 = 切出的各条原文（已 trim）；第二个 = 切掉的字节数（0 = 尾部还不完整，等下次）。
   */
  fun split(buf: ByteArray, from: Int, to: Int): Pair<List<String>, Int> {
    val out = ArrayList<String>()
    var i = from
    // 跳过前导空白（空格 / 制表 / 回车 / 换行）
    while (i < to) { if (isSpace(buf[i])) i += 1 else break }
    var consumedEnd = i
    while (i < to) {
      val start = i
      // 只处理以左花括号开头的值；其它形态交给调用方按「无换行残行」处理。
      if (buf[i].toInt().toChar() != '{') break
      var depth = 0
      var inString = false
      var escaped = false
      var end = -1
      while (i < to) {
        val c = buf[i].toInt().toChar()
        if (inString) {
          if (escaped) escaped = false
          else if (c == '\\') escaped = true
          else if (c == '"') inString = false
        } else {
          if (c == '"') inString = true
          else if (c == '{') depth += 1
          else if (c == '}') {
            depth -= 1
            if (depth == 0) { end = i + 1; i += 1; break }
          }
        }
        i += 1
      }
      if (end < 0) { i = start; break } // 半截帧：本次不消费
      out.add(String(buf, start, end - start, Charsets.UTF_8).trim())
      consumedEnd = end
      while (i < to) { if (isSpace(buf[i])) i += 1 else break }
      consumedEnd = i
    }
    return out to (consumedEnd - from).coerceAtLeast(0)
  }

  private fun isSpace(b: Byte): Boolean {
    val c = b.toInt().toChar()
    return c == ' ' || c == '\t' || c.equals(0x0d.toChar()) || c == '\n'
  }
}
