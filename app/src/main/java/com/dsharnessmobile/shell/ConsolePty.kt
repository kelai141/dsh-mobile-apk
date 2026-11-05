package com.dsharnessmobile.shell

import java.io.File

/**
 * 控制台 PTY 的中继参数与协议编解码（issue：内置终端没有真 PTY，TUI 程序全瘫）。
 *
 * ── 为什么不用快照里的 script(1) ──────────────────────────────────────────────
 * 这是本轮实测推翻了原方案的地方，记下来免得后人再走一遍：
 * script 确实能 forkpty，但**壳侧拿不到它的输入通道**。壳侧用 ProcessBuilder 拉起进程，
 * stdin 必然是管道；而 script 在 stdin 非 tty 时按 cooked 语义收字节，行结束符不构成一次提交。
 * 设备实测三种调用形式（-c 子命令 / -- 形式 / 默认 shell）表现完全一致：
 * 写进去的 "echo X\n" 只被**回显成文本**，bash 从不执行它。也就是说 script 只能看、不能用。
 * （中途还踩过 -E never：加了之后连回显都没了，命令更不会执行。）
 *
 * ── 为什么用 node-pty ─────────────────────────────────────────────────────────
 * node-pty 自己 forkpty 并持有主端，读写走它自己的 fd，不依赖 stdin 是 tty，所以管道下可用。
 * 快照随引擎已经附带它（[DEFAULT_NODE_PTY] 处为 Android NDK 构建的 pty.node），
 * 不新增依赖、不新增构建面。设备实测：写入 "echo PTYOK\r" 后命令真的执行。
 *
 * 代价是多一个 node 中继进程（实测 require 约 681ms 的一次性开销），
 * 换来的是 TUI 程序（top/vim/termux-change-repo）能真正跑起来。
 */
internal object ConsolePty {

  /** 默认列数。80x24 是终端事实标准，任何 TUI 都按它兜底排版。 */
  const val DEFAULT_COLS = 80

  /** 默认行数。 */
  const val DEFAULT_ROWS = 24

  /** 尺寸下限：再小 TUI 会算出负数布局。 */
  private const val MIN_COLS = 20
  private const val MIN_ROWS = 5

  /** 中继脚本在 assets 里的名字（壳侧解包到私有目录后运行）。 */
  const val RELAY_ASSET = "console-pty.mjs"

  /** 快照内 node-pty 模块的相对路径（相对 usr 目录）。 */
  const val DEFAULT_NODE_PTY = "lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty"

  /** 快照内 node 的相对路径（相对 usr 目录）。 */
  const val NODE_RELATIVE = "bin/node"

  /**
   * 拉起中继的 argv。
   *
   * @param node 快照里的 node 可执行文件。
   * @param relay 已解包到私有目录的中继脚本。
   * @return argv（不含 linker64 回退前缀）。
   */
  fun argv(node: File, relay: File): List<String> = listOf(node.absolutePath, relay.absolutePath)

  /**
   * 把页面上报的尺寸规整成可用的行列数。
   *
   * 页面在首帧测出的高度可能为 0（布局未完成），直接下发会得到 0x0 的 PTY，
   * TUI 按它排版就会错乱。所以这里给出下限兜底。
   *
   * @param cols 页面估算的列数。
   * @param rows 页面估算的行数。
   * @return 规整后的 (cols, rows)。
   */
  fun normalizeSize(cols: Int, rows: Int): Pair<Int, Int> {
    val c = if (cols < MIN_COLS) DEFAULT_COLS else cols
    val r = if (rows < MIN_ROWS) DEFAULT_ROWS else rows
    return c to r
  }

  /**
   * 构造一行写入中继的 JSON。
   *
   * 为什么用 JSON 分帧而不是裸字节：控制台的输出里本来就混着换行与任意控制字符，
   * 裸字节没有帧边界，壳侧没法判断一个 chunk 到哪里算结束。
   *
   * @param text 要写进 PTY 的文本（可含控制字符）。
   * @return 单行 JSON（含结尾换行）。
   */
  fun writeMessage(text: String): String = "{\"op\":\"write\",\"data\":" + quote(text) + "}\n"

  /**
   * 构造 resize 消息。
   *
   * @param cols 列数。
   * @param rows 行数。
   * @return 单行 JSON（含结尾换行）。
   */
  fun resizeMessage(cols: Int, rows: Int): String =
    "{\"op\":\"resize\",\"cols\":" + cols + ",\"rows\":" + rows + "}\n"

  /** 构造 kill 消息。 */
  const val KILL_MESSAGE = "{\"op\":\"kill\"}\n"

  /**
   * JSON 字符串转义。
   *
   * 只处理 JSON 规范要求的那些：引号、反斜杠、C0 控制字符。
   * 输出里 \u001b 这类序列必须原样进 JSON，否则页面收到的是被吃掉的控制字符。
   *
   * @param s 原文。
   * @return 带双引号的 JSON 字符串字面量。
   */
  fun quote(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (ch in s) {
      when (ch) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        '\b' -> sb.append("\\b")
        else -> {
          if (ch.code < 0x20) {
            sb.append("\\u")
            sb.append(String.format("%04x", ch.code))
          } else {
            sb.append(ch)
          }
        }
      }
    }
    sb.append('"')
    return sb.toString()
  }

  /**
   * 从中继的一行 JSON 里取出 PTY 输出。
   *
   * 只认 op=data；其余（ready/exit/error）由调用方按需处理。
   *
   * @param line 一行 JSON 文本（不含结尾换行）。
   * @return 输出内容；不是 data 消息或解析失败时返回 null。
   */
  fun dataOf(line: String): String? {
    val op = fieldOf(line, "op") ?: return null
    if (op != "data") return null
    return stringFieldOf(line, "data")
  }

  /**
   * 取一行 JSON 里的字符串字段（只支持顶层、无转义的简单场景）。
   *
   * 中继端的 JSON 由 node 的 JSON.stringify 生成，字段值可能含任意转义，
   * 所以这里必须真的按 JSON 规则解转义，不能做字符串切分。
   *
   * @param line 一行 JSON。
   * @param key 字段名。
   * @return 字段值；不存在或解析失败时返回 null。
   */
  fun fieldOf(line: String, key: String): String? = stringFieldOf(line, key)

  /**
   * 取一行 JSON 里的数字字段。
   *
   * @param line 一行 JSON。
   * @param key 字段名。
   * @return 数值；不存在或解析失败时返回 null。
   */
  fun numberFieldOf(line: String, key: String): Int? {
    val v = stringFieldOf(line, key)
    return v?.toIntOrNull() ?: rawNumberFieldOf(line, key)?.toIntOrNull()
  }

  /**
   * 取字符串字段的实现：定位 key 之后按 JSON 规则解转义。
   *
   * @param line 一行 JSON。
   * @param key 字段名。
   * @return 解码后的值；不存在时返回 null。
   */
  private fun stringFieldOf(line: String, key: String): String? {
    val marker = "\"" + key + "\":\""
    val start = line.indexOf(marker)
    if (start < 0) return null
    var i = start + marker.length
    val sb = StringBuilder()
    while (i < line.length) {
      val ch = line[i]
      if (ch == '"') return sb.toString()
      if (ch == '\\' && i + 1 < line.length) {
        when (val esc = line[i + 1]) {
          'n' -> { sb.append('\n'); i += 2 }
          'r' -> { sb.append('\r'); i += 2 }
          't' -> { sb.append('\t'); i += 2 }
          'b' -> { sb.append('\b'); i += 2 }
          'f' -> { sb.append('\u000C'); i += 2 }
          '"' -> { sb.append('"'); i += 2 }
          '\\' -> { sb.append('\\'); i += 2 }
          '/' -> { sb.append('/'); i += 2 }
          'u' -> {
            if (i + 6 > line.length) return sb.toString()
            val code = line.substring(i + 2, i + 6).toIntOrNull(16) ?: return sb.toString()
            sb.append(code.toChar())
            i += 6
          }
          else -> { sb.append(esc); i += 2 }
        }
      } else {
        sb.append(ch)
        i += 1
      }
    }
    return null
  }

  /**
   * 取原始数字字段（不加引号的）。
   *
   * @param line 一行 JSON。
   * @param key 字段名。
   * @return 数字字面量；不存在时返回 null。
   */
  private fun rawNumberFieldOf(line: String, key: String): String? {
    val marker = "\"" + key + "\":"
    val start = line.indexOf(marker)
    if (start < 0) return null
    var i = start + marker.length
    val sb = StringBuilder()
    while (i < line.length) {
      val ch = line[i]
      if (ch.isDigit() || ch == '-') { sb.append(ch); i += 1 } else break
    }
    return sb.toString().takeIf { it.isNotEmpty() }
  }
}
