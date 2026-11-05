package com.dsharnessmobile.shell

/**
 * 把终端控制序列从字节流里剥掉，只留可读文本（控制台在**还没有真 PTY 渲染器**时用）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 * 一旦给子进程注入 \`TERM=xterm-256color\` + \`TERMINFO\`（见 [ConsoleTerminalEnv]），
 * dialog / top / vim 这类程序就会开始吐 CSI、OSC、DCS 序列。控制台页面
 * （assets/console.html）是 \`white-space: pre-wrap\` 的纯文本容器，不解析这些序列——
 * 原样上屏就会变成 \`^[[?1049h^[[22;0;0t\` 这样的乱码。
 *
 * 所以这一层的作用是：**让用户至少能看见程序在说什么**，而不是看见一堆转义。
 *
 * ── 边界（如实写清，不要把它当成终端模拟器）──────────────────────────────────
 * 只做剥离，不做光标定位、不做重绘、不做颜色。全屏 TUI 在剥离后剩下的是**语义碎片**
 * （菜单文字、进度百分比会重复堆叠），不是可用界面。要真正跑 vim/top，
 * 需要的是页面侧 ANSI 渲染器（后续 PR），这一层届时退化为直通。
 *
 * 逐状态推进而不是正则一次性替换：转义序列可以被缓冲区边界切断，
 * 正则跨块匹配会漏掉半截序列，把后面的正文一起吞掉。
 */
internal class ConsoleAnsiStripper {

  private enum class State { TEXT, ESC, ESC_PENDING, CSI, OSC, STRING, CR }

  /**
   * ESC 双字符引导符（`ESC ( X`、`ESC ) X`、`ESC * X`、`ESC + X`、`ESC # X`）：
   * ESC 与紧随的一个字符都只是引导符，真正的参数是第三个字符。
   * 少吞这一个字符，`ESC(B` 就会在正文里留下一个裸 `B`——
   * 用例 `charsetSelectionAfterEscDoesNotSwallowText` 与
   * `realDialogFragmentLeavesOnlyReadableText` 都钉住这条（实测 dialog 首帧即含 `ESC(B`）。
   */
  private fun isTwoCharIntroducer(ch: Char) = ch == '(' || ch == ')' || ch == '*' || ch == '+' || ch == '#'

  private var state = State.TEXT

  /**
   * 喂入一块文本，返回可上屏的纯文本。
   *
   * 序列可以跨块：未被闭合的序列留在内部状态里，下一块继续消费。
   *
   * @param input 原始字节流解码后的文本。
   * @return 已经剥掉控制序列的可见文本。
   */
  fun feed(input: String): String {
    if (input.isEmpty()) return input
    val out = StringBuilder(input.length)
    for (ch in input) {
      when (state) {
        State.TEXT -> when {
          ch == '\u001b' -> state = State.ESC
          // CR 先挂起到 CR 态：真 PTY 的行规程开着 ONLCR，每个换行都以 CRLF 输出——
          // 直接把 CR 折成换行会让紧随的 LF 再折一次，整屏双倍行距（2026-10-25 审计 I5）。
          ch == '\r' -> state = State.CR
          // 其余 C0 控制字符（BEL 等）一律丢弃：它们没有可见语义，只会进 UI 噪声。
          ch < ' ' && ch != '\n' && ch != '\t' -> Unit
          // DEL（0x7F）：C0 之外的另一个控制字符，`ch < ' '` 判不到它 ⇒ 会原样上屏
          // （实测 `a\u007fb` → `[97, 127, 98]`，控制台里就是个方块/空白）。
          ch == '\u007f' -> Unit
          // C1 控制字符（0x80–0x9F）：其中 `\u009b` 是 **8 位形式的 CSI**（真实终端会照常解析），
          // 其余（0x80–0x9A、0x9C–0x9F）没有可见语义。两者都不能当正文输出。
          ch == '\u009b' -> state = State.CSI
          ch in '\u0080'..'\u009f' -> Unit
          else -> out.append(ch)
        }
        // CR 的下一个字符决定折叠：LF 只算一个换行；其他字符则 CR 折行、字符按正文
        // 语义重新分发（ESC 引导/控制字符丢弃/普通字符输出——与 TEXT 态逐分支等价）。
        State.CR -> when {
          ch == '\n' -> { out.append('\n'); state = State.TEXT }
          // 连续 CR（`\r\r\n`）只该折一次：旧实现每个 CR 都输出一个换行 ⇒ 凭空多一空行。
          ch == '\r' -> Unit
          ch == '\u007f' -> Unit
          ch == '\u009b' -> { out.append('\n'); state = State.CSI }
          ch in '\u0080'..'\u009f' -> { out.append('\n'); state = State.TEXT }
          ch == '\u001b' -> { out.append('\n'); state = State.ESC }
          ch < ' ' && ch != '\t' -> { out.append('\n'); state = State.TEXT }
          else -> { out.append('\n'); out.append(ch); state = State.TEXT }
        }
        State.ESC -> when {
          ch == '[' -> state = State.CSI
          ch == ']' -> state = State.OSC
          ch == 'P' || ch == 'X' || ch == '^' || ch == '_' -> state = State.STRING
          isTwoCharIntroducer(ch) -> state = State.ESC_PENDING
          // ESC 后跟单个字符（ESC= 键盘模式、ESC> 数字键盘）：整体丢弃。
          else -> state = State.TEXT
        }
        // 双字符引导符的参数位：吃掉它，回到正文。
        State.ESC_PENDING -> state = State.TEXT
        State.CSI -> {
          // 参数字节 0x30-0x3F、中间字节 0x20-0x2F，终止字节 0x40-0x7E。
          if (ch in '@'..'~') state = State.TEXT
        }
        // OSC 以 BEL 或 ST 结束；DCS/SOS/PM/APC 以 ST 结束。ST 是 ESC \，统一按 ESC 看待。
        State.OSC, State.STRING -> when (ch) {
          '\u0007' -> state = State.TEXT
          '\u001b' -> state = State.ESC
          else -> Unit
        }
      }
    }
    return out.toString()
  }

  /** 会话重启时复位：残留的半截序列不得带进下一个进程的输出。 */
  fun reset() {
    state = State.TEXT
  }
}
