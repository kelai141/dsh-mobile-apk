package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject

/**
 * sh* op：Shizuku 特权 shell 通道（0.14.0 §6 —— 替换退役的内置 adb）。
 *
 * 两条通道独立可用：本组 op 由 [ControlCarrier] 承载（随前台引擎服务起停），**不依赖无障碍服务**；
 * 引擎侧 `execAdbShell` / `execAdbLine` 经控制队列投递到这里，由 [ShizukuTransport] 在 shell
 * uid=2000 的 UserService 内执行。执行面复查屏幕范围（§6 末条：两条通道的执行点都要复查）。
 *
 * 两处调用方：
 * - `DeviceControlService.handle`：六面登记链按行首引号解析分支名，分支必须留在 handle 里，
 *   实现委托到本对象（scripts/check-control-ops.mjs 的 A 项）；
 * - `ControlCarrier`：无障碍关闭时的承载者（队列由前台引擎服务持有）。
 */
internal object ShellOps {

  /**
   * 目标屏参数（三种拼写；值保留**原样十进制串**）。
   *
   * 与引擎侧 `screen-scope.ts` 的 `displayOptionsIn` **逐字同源**（含空白类：两侧都用显式 ASCII
   * `[ \t]`——JS 的 `\s` 含 Unicode 空白、Java 的 `\s` 只含 ASCII，用 `\s` 会让「逐字相同」的两份
   * 正则**不等价**，见审查 N-5）。
   *
   * 取值不数值化：`screencap -d` 吃的是 SurfaceFlinger display token，设备实测虚拟屏形如
   * `11529215046816944610`——超出 `Long` 上界，数值化即失真（见坑 147）。
   */
  /**
   * 短选项 `-d` 与长选项的取值语法**不同**，不能共用一个正则（与引擎侧同源）：
   *   - `-d` 是 getopt 短选项 ⇒ `-d7`（粘连）与 `-d 7`（空格）合法，**`-d=7` 不合法**：
   *     AOSP 用 `atoi(optarg)`，`atoi("=7") == 0` ⇒ 实际读/操作的是 display **0**（真实屏）。
   *     旧正则用 `[ \t=]+` 让 `-d=7` 吃到了 `7`，于是拿它当"已注册虚拟屏 7"的凭据放行（漏拦）；
   *     同时 `-d7` 因为缺分隔符反而认不出来（误拦）。
   *   - 长选项 `--display` / `--display-id` 才接受 `=`。
   */
  private val SHORT_DISPLAY_OPTION = Regex("""(?:^|[ \t])-d[ \t]*(\d+)""")
  private val LONG_DISPLAY_OPTION = Regex("""(?:^|[ \t])(--display|--display-id)[ \t=]+(\d+)""")

  /**
   * 「形似 display 选项但取值不是纯数字」的形态（`-d=7`、`-dx`）。
   *
   * 为什么要单独判：`-d=7` 的真实值是 `=7`（`atoi` 后为 0），所以它**不能**被当成"已认证 7"；
   * 也**不能**被当成"没有 display 选项"就放行 —— 它在不同工具下可能落到默认屏 0（真实屏）。
   * 两侧都必须 fail-closed。注意 `-d7` 是合法粘连形态，前瞻要排除数字。
   */
  private val MALFORMED_DISPLAY_OPTION = Regex("""(?:^|[ \t])-d(?:[ \t]*=[ \t]*\S|(?![0-9\s])\S)""")

  /** 命令词家族：每个家族自带「哪种拼写才算它的目标屏」（与引擎侧 `SCREEN_COMMAND_FAMILIES` 同表）。 */
  private data class ScreenFamily(val name: String, val pattern: Regex, val targetFlags: List<String>)

  private val ALL_DISPLAY_FLAGS = listOf("-d", "--display", "--display-id")

  private val SCREEN_FAMILIES = listOf(
    ScreenFamily("screencap", Regex("""\bscreencap\b""", RegexOption.IGNORE_CASE), ALL_DISPLAY_FLAGS),
    ScreenFamily("screenrecord", Regex("""\bscreenrecord\b""", RegexOption.IGNORE_CASE), ALL_DISPLAY_FLAGS),
    ScreenFamily(
      "input",
      // 正式语法是 `input [<source>] [-d DISPLAY_ID] <command> [<arg>…]`：source 是位置词
      // （touchscreen/touchpad/…），漏了它整类命令都进不了命令词面；`press` 是其新命令，同族。
      // source 用通配而不是列举：枚举里少了 `touchpad`（真机 `input` 裸跑列出它），
      // `input touchpad tap 9999 9999` / `swipe` / `-d 0 tap` 三条 RC=0 而门禁判 allow（2026-10-29 自查）。
      Regex(
        """\binput[ \t]+(?:[a-z][a-z0-9_-]*[ \t]+)?""" +
          """(?:tap|swipe|roll|draganddrop|motionevent|text|keyevent|keycombination|press)\b""",
        RegexOption.IGNORE_CASE,
      ),
      ALL_DISPLAY_FLAGS,
    ),
    // `wm` 的改屏子命令（`user-rotation` 在本机 MIUI 上未生效，但命令语义同样是改真实屏）。
    ScreenFamily(
      "wm",
      Regex("""\bwm[ \t]+(?:size|density|overscan|user-rotation|fixed-to-user-rotation)\b""", RegexOption.IGNORE_CASE),
      ALL_DISPLAY_FLAGS,
    ),
    // `cmd window …` 是 `wm` 的等价拼写（实测 `cmd window size 900x1600` 真改真实屏）；
    // 目标屏参数是**子命令内**的 `[-d DISPLAY_ID]`（实测 `cmd window size 900x1600 -d 7` 被接受）。
    ScreenFamily("cmd-window", Regex("""\bcmd[ \t]+window\b""", RegexOption.IGNORE_CASE), ALL_DISPLAY_FLAGS),
    // `cmd display …` 用 `--id DISPLAY_ID`（不是 ScreenTarget 的两种 id 空间）⇒ 无法自证，恒拒。
    ScreenFamily("cmd-display", Regex("""\bcmd[ \t]+display\b""", RegexOption.IGNORE_CASE), emptyList()),
    // `uiautomator dump` 没有目标屏参数：dump 的是**默认屏**的语义树 ⇒ 无法自证，恒拒。
    ScreenFamily("uiautomator", Regex("""\buiautomator\b""", RegexOption.IGNORE_CASE), emptyList()),
    // 直接读写 input 设备的命令：`sendevent` 能注入任意事件（含触摸），`getevent` 能读回触摸/按键。
    // 两者都没有目标屏参数 ⇒ 自证不了「作用于已注册虚拟屏」，与 `uiautomator` 同档（恒拒）。
    // 小米 14 Pro 实测（2026-10-28 自查）：shell 直写 /dev/input/eventN 被拒，但已 root 时
    // `su -c 'sendevent … 0 0 0'` RC=0，而 `su -c` 的载荷会被本门禁展开重扫 ⇒ 修前整条放行。
    ScreenFamily("sendevent", Regex("""\bsendevent\b""", RegexOption.IGNORE_CASE), emptyList()),
    ScreenFamily("getevent", Regex("""\bgetevent\b""", RegexOption.IGNORE_CASE), emptyList()),
    // `dumpsys activity` 也会打完整 `View Hierarchy:`（含每个控件的 bounds）—— 与 `uiautomator dump`
    // 同级的「读真实屏 UI」，2026-10-28 自查补进来；`battery`/`meminfo` 这类与屏无关的不受影响。
    ScreenFamily(
      "dumpsys",
      Regex("""\bdumpsys[ \t]+(?:window|display|input|activity)\b""", RegexOption.IGNORE_CASE),
      emptyList(),
    ),
    // `am` 的显示参数是 `--display`；`-d` 是 Intent data，**不得**作为目标屏凭据。
    ScreenFamily("am", Regex("""\bam[ \t]+(?:start|start-activity|force-stop|kill)\b""", RegexOption.IGNORE_CASE),
      listOf("--display", "--display-id")),
    ScreenFamily("monkey", Regex("""\bmonkey\b""", RegexOption.IGNORE_CASE), listOf("--display", "--display-id")),
    // `cmd activity <start-activity|start|force-stop|kill>` 与 `am start` 走同一个
    // ActivityManagerShellCommand（无 `--display` 时默认 display 0）——只认 `am` 会把这条等价拼写
    // 整类放行。`--display` 才是它的目标屏参数。
    ScreenFamily(
      "cmd-activity",
      Regex("""\bcmd[ \t]+activity[ \t]+(?:start-activity|start|force-stop|kill|stop-app)\b""",
        RegexOption.IGNORE_CASE),
      listOf("--display", "--display-id"),
    ),
  )

  /** SurfaceFlinger 的虚拟屏 token 行 / 其后的 name= 行（设备实测形态，见坑 147）。 */
  private val SF_DISPLAY_LINE = Regex("""Virtual Display[ \t]+(\d+)""")
  private val SF_NAME_LINE = Regex("""[ \t]*name="([^"]*)"""")
  private const val SF_NAME_PREFIX = "DSH "

  /** 嵌套执行体再切一层的深度上限（与引擎侧 `MAX_NESTING` 相同）。 */
  private const val MAX_NESTING = 4

  /**
   * 管道/输入重定向喂**裸 shell 解释器**的段（`| sh`、`| xargs bash`、段尾裸 `sh`）。
   *
   * `echo 'screencap -d 0' | sh` 切段后：喂入段是引号文本（stripQuotedText 抹空，无命令词），
   * 接收段是裸 `sh`（同样无命令词）——两条都不进屏幕命令词面 ⇒ 判 ALLOW；执行时 sh 从
   * stdin 读到命令照跑，virtual-only 下真实屏可读（#509）。该形态在本通道没有正当用途：
   * 合法执行本来就整条传给 `shExec`（本身就是 `sh -c`），要嵌套也有 `sh -c '…'`（载荷可见、
   * 由 SHELL_C_PAYLOAD 展开队列正常判定）。故裸解释器段一律按看不懂拒绝（fail-closed），
   * 与引擎侧 `screen-scope.ts` 的同构判据同批演进（fixture 权威源用例另行补充）。
   */
  private val INTERPRETER_NAMES = setOf("sh", "bash", "mksh", "ash", "dash", "zsh")
  // 包装词白名单：与引擎侧 INTERPRETER_WRAPPERS 逐条同源。缺一个 = 该包装器后面的裸解释器
  // 识别不出来，循环停在包装词上返回 false（当成"不是解释器"）⇒ 载荷不可见的段放行。
  // 小米 14 Pro（SDK 37）实测（2026-10-28 自查）：`echo '…' | nice sh` / `| setsid -w sh` /
  // `| ionice sh` / `| taskset 1 sh` 都会真的执行 stdin 里的脚本，而 `| sh` 本来就判
  // deny-unparsed ⇒ 多套一层包装即可绕过 #509 的裸解释器判据。
  private val INTERPRETER_WRAPPERS =
    setOf(
      "env", "timeout", "nohup", "xargs", "busybox", "toybox", "su", "command", "exec",
      // 调度 / 资源类（真机实测可喂 sh）
      "nice", "ionice", "taskset", "setsid", "chrt", "numactl", "unshare", "runcon",
      // 缓冲 / 计时 / 锁类
      "stdbuf", "time", "flock", "watch",
    )

  /**
   * 该段的命令词是不是「载荷对判定器不可见」的解释器调用（#509 的放宽版，与引擎侧
   * `interpreterPayloadUnparsed` 逐条同源）。
   *
   * 只有 `sh -c '<可见载荷>'` 能被展开后判定；其余载荷都来自**运行时**：
   * `sh -s` / `sh -e` / 无参 `sh`（读 stdin）、`sh /tmp/x.sh`、`. /tmp/x.sh`、`source x`，
   * 以及经 `env`/`timeout`/`xargs`/`busybox` 包装的同族形态 —— 一律 fail-closed。
   * 旧实现只认「整段恰好等于解释器名」这一条最窄形态，`sh -s`/`sh file`/`.` 全部放行。
   */
  private fun interpreterPayloadUnparsed(segment: String): Boolean {
    var text = segment.trim()
    for (guard in 0 until 8) {
      val parsed = firstShellWord(text)
      val word = parsed.first
      if (word.isEmpty()) return false
      val base = word.substringAfterLast('/')
      // 变量赋值前缀、包装器、包装器自己的选项/数字参数都不改变「命令词」。
      if (Regex("""^[A-Za-z_][A-Za-z0-9_]*=""").containsMatchIn(word)) { text = parsed.second.trim(); continue }
      if (base in INTERPRETER_WRAPPERS || word.startsWith("-") || Regex("""^\d+$""").matches(word)) {
        text = parsed.second.trim()
        continue
      }
      if (base == "." || base == "source") return true
      if (base in INTERPRETER_NAMES) {
        return !Regex("""(?:^|[ \t])-[^\s]*c[^\s]*(?:[ \t]|$)""").containsMatchIn(parsed.second)
      }
      return false
    }
    return false
  }

  /** 取 shell 文本第一个词（quote-aware，去包裹引号）与其剩余；与引擎侧 `firstShellWord` 同源。 */
  private fun firstShellWord(text: String): Pair<String, String> {
    var i = 0
    while (i < text.length && (text[i] == ' ' || text[i] == '\t')) i += 1
    if (i >= text.length) return "" to ""
    val quote = text[i]
    if (quote == '\'' || quote == '"') {
      var j = i + 1
      while (j < text.length) {
        if (quote == '"' && text[j] == '\\') { j += 2; continue }
        if (text[j] == quote) return text.substring(i + 1, j) to text.substring(j + 1)
        j += 1
      }
      return text.substring(i + 1) to ""
    }
    var j = i
    while (j < text.length && text[j] !in " \t;&|") j += 1
    return text.substring(i, j) to text.substring(j)
  }

  /**
   * 载荷里第一个**非选项终结符**词：`--` 只是选项终结符，真正的载荷在它后面。
   *
   * 与引擎侧 `firstPayloadWord` 同源（2026-10-28 自查实测，安全侧漏拦）：
   * `trap -- 'screencap -p /sdcard/real.png' EXIT` / `sh -c -- '…'` / `eval -- '…'` 的载荷以
   * `--` 开头，旧实现直接把它当载荷 ⇒ 真正的内层命令被丢弃 ⇒ 该段无屏幕命令词、
   * 无目标屏参数 ⇒ 放行（读真实屏）。小米 14 Pro（`/system/bin/sh` = mksh，SDK 37）实测三条
   * **都会真的执行 `--` 后面的命令**；`--` 被引号包裹时同样是终结符
   * （`trap "--" 'cmd' EXIT` 真机实测执行），故判据用**解引号后**的词是否恰好等于 `--`。
   */
  private fun firstPayloadWord(text: String): String {
    var rest = text
    for (guard in 0 until 8) {
      val (word, remainder) = firstShellWord(rest)
      if (word != "--") return word
      rest = remainder
    }
    return ""
  }

  /**
   * 「当前段已经走到**载荷位置**」的尾巴判据（`sh -c ` / `eval ` / `trap ` 之后），与引擎侧同名。
   *
   * 用来认**不带引号**的运行时载荷：`` sh -c `cat /sdcard/x.sh` `` 的反引号在顶层切段时就被展开，
   * 段里不再留反引号字符，段级判据看不见它 —— 只能在切段当场看「替换前那段 buf 是否停在载荷位置」。
   * `sh -c "a b" $(date)` 这种「载荷已给、替换在下一个参数」的形态不命中（脚本静态可见）。
   */
  private val PAYLOAD_SLOT_TAIL = Regex("""(?:^|[ \t])(?:-[^\s]*c|eval|trap)[ \t]+$""")

  /**
   * 段**命令名位置**上是不是运行时值（`$CMD`、`$(…)`、反引号）。
   *
   * 小米 14 Pro（SDK 37）实测都会真的执行变量/文件里的内容：`sh -c "$CMD"`、
   * `sh -c "$(cat /sdcard/x.sh)"`、`` sh -c `cat /sdcard/x.sh` ``、`trap "$(cat …)" EXIT`、
   * `eval "$(cat …)"` —— 与 `sh /x.sh`（脚本文件）同一性质：静态看不到执行什么 ⇒ fail-closed。
   * 只看**段首词**：参数位置的替换不改变命令身份，不得误拦；`$'…'` / `$"…"` 是 ANSI-C 引号
   * （静态字面量），必须排除。
   */
  private fun isRuntimeCommandName(segment: String): Boolean {
    val head = firstShellWord(segment.trim()).first
    if (head.startsWith("$'") || head.startsWith("$\"")) return false
    return head.startsWith("$") || head.startsWith("`")
  }

  /**
   * `awk` 的 `system(…)` 能执行任意命令，而程序文本通常整段在引号里 —— stripQuotedText 之后
   * 命令词面只剩 `awk`，载荷里的屏幕命令完全不可见。
   *
   * 真机实测（2026-10-29）：`awk 'BEGIN{system("screencap -p /sdcard/awk.png")}'` RC=0，
   * 出图 2872362 B。修前判 allow。对照 `awk '{print $1}' /sdcard/a.txt` 必须继续放行。
   */
  private val AWK_EXEC_PAYLOAD = Regex(
    """^[ \t]*(?:[^\s]*/)?(?:busybox[ \t]+|toybox[ \t]+)?awk\b[^;|&]*\bsystem[ \t]*\(""",
    RegexOption.IGNORE_CASE,
  )

  /**
   * `sh -c '<内层>'` 形式（含 `/system/bin/sh`、`busybox sh`、`su` 等包装）。
   *
   * 末段必须是「短选项**簇**且簇尾是 `c`」（`-[a-zA-Z]*c`），不能只认光杆 `-c`：
   * `sh -lc '…'` / `sh -ec '…'` / `sh -xc '…'` / `su -lc '…'` 的 `c` 都在组合簇里，光杆 `-c`
   * 匹配不到 ⇒ 载荷不展开 ⇒ 该段无命令词 ⇒ 放行。小米 14 Pro（SDK 37，mksh）实测四种簇形态
   * 都会真的执行引号里的脚本（设备无 bash，Linux 侧同样成立）；`-l -c` 分离写法旧实现本来能认。
   *
   * 前置组还要能跳过**带独立参数的短选项**（`-o` / `+o` 各吃一个词）：`sh -o errexit -c '…'` 里
   * `errexit` 既不是 `-` 开头也不在选项簇里，旧前置组会卡在它上面 ⇒ 整条不匹配 ⇒ 载荷不展开 ⇒ 放行。
   * 小米 14 Pro（mksh）实测 `sh -o errexit -c 'echo X'` 与 `sh +o errexit -c 'echo X'` 都会真的执行。
   * `[+-]o` 必须排在 `-[^\s]+` **前面**，否则 `-o` 会被整词分支先吃掉、剩下 `errexit` 无处可去。
   */
  private val SHELL_C_PAYLOAD = Regex(
    """(?:^|[ \t])(?:[^\s]*/)?(?:sh|bash|mksh|ash|dash|zsh|busybox|toybox|su)[ \t]+(?:[+-]o[ \t]+\S+[ \t]+|-[^\s]+[ \t]+)*-[a-zA-Z]*c[ \t]+([\s\S]*)$""",
  )

  /**
   * `eval <载荷>`：载荷会被 shell **再解释一遍**（等价于把那段文本当命令粘回来执行）。
   *
   * 为什么必须单独列：`eval "screencap -p /sdcard/real.png"` 的引号内容会被引号抹除逻辑吃掉，
   * 命令词面里看不到 `screencap` ⇒ 只靠 [SHELL_C_PAYLOAD] 时它一路放行（2026-10-28 自查实测：
   * 引擎侧同一形态也漏，两侧必须同改）。与 `sh -c` 同型：拿原文载荷、解一层引号、递归扫。
   */
  private val EVAL_PAYLOAD = Regex("""(?:^|[ \t;&|(])eval[ \t]+([\s\S]*)$""")

  /**
   * `trap <载荷> <信号…>`：第一个参数是**要执行的命令**，退出/收到信号时 shell 会照跑。
   * 与 `eval` / `sh -c` 并列进「载荷再解释一遍」入口（引擎侧同名入口，fixture 双向锁死）。
   */
  private val TRAP_PAYLOAD = Regex("""(?:^|[ \t;&|(])trap[ \t]+([\s\S]*)$""")

  /**
   * 屏幕范围判定的结果码——与引擎侧 `ScreenCommandVerdict` 的字符串**逐字相同**，
   * 由跨语言 fixture（`scripts/gen-screen-scope-fixture.mjs`）双向锁死。
   */
  internal enum class ScreenCommandVerdict(val wire: String) {
    ALLOW("allow"),
    DENY_UNPARSED("deny-unparsed"),
    DENY_ORPHAN_TARGET_TOKEN("deny-orphan-target-token"),
    DENY_UNCERTIFIED_TARGET("deny-uncertified-target"),
  }

  fun handle(context: Context, op: String, args: JSONObject): JSONObject = when (op) {
    "shExec" -> exec(context, args)
    "shPull" -> pull(context, args)
    "shPush" -> push(context, args)
    "shRemove" -> remove(context, args)
    else -> JSONObject()
      .put("__error", "未知特权 shell 操作 $op")
      .put("reason", "unknown-op")
      .put("op", op)
  }

  private fun exec(context: Context, args: JSONObject): JSONObject {
    val command = args.optString("command", "")
    if (command.isBlank()) return fail("shExec 缺少 command", "shell-empty")
    scopeDenied(context, command)?.let {
      // G-7：执行点拒绝**必须落账**（旧实现 `return` 早于 audit，安全事件 screen-out-of-scope 零留痕）
      audit(context, "shExec", command, ControlAudit.RESULT_DENIED)
      return it
    }
    val result = ShizukuTransport.runShell(
      context,
      command,
      timeoutMs = args.optInt("timeoutMs", 20_000),
      capture = args.optBoolean("capture", false),
    )
    // 2026-09-30（主人定例「我们不是做 root 适配吗」）：**su 直连回退**。
    //
    // 为什么：Shizuku 通道的可用性押在「Shizuku 已安装 + 在运行 + 已授权 + 服务端以 root 启动」
    // 四件事上，任一不成立整条链就死（本机实测：服务端判 denied ⇒ 通道恒不可用 ⇒ 连属主自愈
    // 都跑不了）。而本机 su 是好的 ⇒ 应用自身获 Root 管理器授权即可执行 root 命令。
    // 判据：只在**通道级失败**（code 以 shizuku- 开头 / root-grant-required / 未绑定）时回退——
    // 命令自身跑失败（exitCode≠0）不重跑（那是命令的事实，不是通道的问题）。
    val code = result.optString("code")
    // Policy refusals and ambiguous post-dispatch Binder failures must never replay a command.
    val channelBroken = !result.optBoolean("ok") && !result.optBoolean("noReplay") && canFallbackBeforeDispatch(code)
    if (channelBroken && RootGrant.isGranted(context) && RootAccess.isGranted(context)) {
      val viaSu = RootAccess.execRoot(context, command, args.optInt("timeoutMs", 20_000))
      if (viaSu.optBoolean("ok") || viaSu.optString("code") != "no-su") {
        audit(context, "shExec", command, resultOf(viaSu))
        return viaSu.put("op", "shExec").put("transport", "su")
      }
    }
    audit(context, "shExec", command, resultOf(result))
    return result.put("op", "shExec").put("transport", "shizuku")
  }

  internal fun canFallbackBeforeDispatch(code: String): Boolean = code in setOf(
    "shizuku-absent", "shizuku-not-running", "shizuku-denied", "shizuku-prev11",
    "shizuku-user-service-not-bound", "shizuku-user-service-too-old",
    // issue #471：用户服务连续启动即崩（如联发科 ROM + Shizuku 13.6.0）。绑定从未成功，
    // 命令一定未派发 ⇒ 回退 su 直连不构成重放。
    "shizuku-user-service-start-failed",
  )

  private fun pull(context: Context, args: JSONObject): JSONObject {
    val remote = args.optString("remote", "")
    val local = args.optString("local", "")
    if (remote.isBlank() || local.isBlank()) return fail("shPull 需要 remote 与 local", "shell-path-missing")
    val result = ShizukuTransport.pullFile(context, remote, local)
    audit(context, "shPull", "$remote -> $local", resultOf(result))
    return result.put("op", "shPull").put("transport", "shizuku")
  }

  private fun push(context: Context, args: JSONObject): JSONObject {
    val local = args.optString("local", "")
    val remote = args.optString("remote", "")
    if (local.isBlank() || remote.isBlank()) return fail("shPush 需要 local 与 remote", "shell-path-missing")
    val result = ShizukuTransport.pushFile(context, local, remote)
    audit(context, "shPush", "$local -> $remote", resultOf(result))
    return result.put("op", "shPush").put("transport", "shizuku")
  }

  private fun remove(context: Context, args: JSONObject): JSONObject {
    val remote = args.optString("remote", "")
    if (remote.isBlank()) return fail("shRemove 需要 remote", "shell-path-missing")
    val result = ShizukuTransport.removeRemote(context, remote)
    audit(context, "shRemove", remote, resultOf(result))
    return result.put("op", "shRemove").put("transport", "shizuku")
  }

  /** §6：virtual-only / real-only 屏幕范围在本通道执行点复查；两份判据与引擎侧同口径。 */
  private fun scopeDenied(context: Context, command: String): JSONObject? {
    when (ScreenScopePrefs.current(context)) {
      ScreenScope.ALL -> return null
      ScreenScope.REAL_ONLY -> {
        if (realOnlyScreenCommandAllowed(command)) return null
        return JSONObject()
          .put("__error", "用户当前开放屏幕范围为 real-only；屏幕命令只能作用于物理屏 display 0。虚拟屏或无法确认的显式显示目标已拒绝。")
          .put("reason", "screen-out-of-scope")
          .put("op", "shExec")
      }
      ScreenScope.VIRTUAL_ONLY -> Unit
    }
    // 块G F5（0.14.1）：目标屏是**已注册虚拟屏**的命令放行——`screencap -d <虚拟屏 id>` 读的是
    // 范围内的屏，与无参 `screencap`（读真实屏 0）根本不是一件事。
    //
    // 为什么壳侧必须有这一条（真缺陷，不是可选优化）：引擎侧 `screen-scope.ts` 的
    // `realScreenAdbCommandDenied` 已修了 F2，但本函数是同一判据的 **Kotlin 副本**——它在
    // **执行点**（Shizuku 通道真正下发命令前）复查。只修引擎侧 ⇒ 壳侧这条二次拦截会把 F2
    // 完全抵消（引擎放行、壳侧仍拒），用户看到的仍是「范围允许 virtual-1 却说不许访问真实屏」。
    // 两处必须同口径，且由跨语言 fixture 锁死等价性。
    //
    // 0.14.1 复审：判据从「整条命令里每个 -d 都属虚拟屏」升级为**段级自证**——
    // 引号感知切段 + 每段各自认证（否则 `screencap -d <虚拟屏>; screencap /sdcard/real.png`
    // 会被第一个 `-d` 整行洗白），且命令词匹配前先归一化目标屏参数（否则 `input -d 0 tap 1 2`
    // 这种**选项在子命令前**的正式写法不进命令词面）。逐条理由见 decideScreenCommand。
    //
    // 走完整判定（不做「无命令词即放行」的短路）：短路会把 `deny-unparsed`（引号不闭合）也一并
    // 放行——而那条恰恰是「看不懂就不放行」的 fail-closed 面。SF token 反查的开销由
    // screenVerdictWithRegistry 的**惰性谓词**化解，不靠短路省。
    if (screenVerdictWithRegistry(context, command) == ScreenCommandVerdict.ALLOW) return null
    return JSONObject()
      .put("__error", "用户当前开放屏幕范围为 virtual-only，不允许经特权 shell 读取或操作真实屏幕"
        + "（screencap / screenrecord / uiautomator / input / wm / cmd window / cmd display /"
        + " dumpsys window|display|input / am / monkey / sendevent / getevent）。"
        + "命令里显式指定的目标屏若确为**已注册虚拟屏**（DisplayManager displayId 或该屏的 SurfaceFlinger token）即可放行；"
        + "本条命令的目标屏未能与壳侧注册表核对上，故拒绝。请确认虚拟屏仍在活跃状态"
        + "（android_vdisplay_create / vdInfo），或由用户在设置中修改范围后重试。")
      .put("reason", "screen-out-of-scope")
      .put("op", "shExec")
  }

  /**
   * real-only 下的 raw shell 判据：无显式 display 参数的屏幕命令使用 Android 物理默认屏 0；
   * 有明确显示参数时仅 0 通过。未知/虚拟目标 fail-closed。非屏幕命令保持可用。
   */
  internal fun realOnlyScreenCommandAllowed(command: String): Boolean {
    val parsed = splitCommandSegments(command)
    if (parsed.unparsed) return false
    for (segment in parsed.segments) {
      // 裸解释器段同 virtual-only：载荷不可见即不可证明（连「目标是不是物理屏 0」都无从核对）。
      if (interpreterPayloadUnparsed(stripQuotedText(segment))) return false
      val bare = stripQuotedText(segment)
      val options = displayOptionsIn(bare)
      if (MALFORMED_DISPLAY_OPTION.containsMatchIn(bare)) return false
      val normalized = stripDisplayOptions(bare)
      val families = SCREEN_FAMILIES.filter { it.pattern.containsMatchIn(normalized) }
      for (family in families) {
        val relevant = options.filter { it.flag in family.targetFlags }
        if (family.targetFlags.isEmpty() && options.isNotEmpty()) return false
        if (relevant.any { it.value != "0" }) return false
      }
    }
    return true
  }

  /**
   * 命令是否命中「真实屏读写命令词」面（[SCREEN_FAMILIES] 的可测入口）。
   * 生产路径由 [scopeDenied] / [decideScreenCommand] 内部调用，此处单独暴露只为让 JVM 单测锁住
   * **命令词面不得缩水**（缩水 = 直接放行真实屏，是范围门禁的自毁形态）。
   */
  internal fun commandTargetsRealScreen(command: String): Boolean = screenFamiliesIn(command).isNotEmpty()

  /** 归一化（剥引号文本 + 抹目标屏参数）后命中的命令词家族名。 */
  internal fun screenFamiliesIn(command: String): List<String> =
    SCREEN_FAMILIES.filter { it.pattern.containsMatchIn(stripDisplayOptions(stripQuotedText(command))) }
      .map { it.name }

  /**
   * 命令的显式目标屏是否**确为**一块已注册虚拟屏（G-F5 放行分支的生产入口）。
   *
   * SF token 反查是 **Shizuku 往返**，因此**惰性求值**：只有 displayId 空间没能自证成功、
   * 真的需要按 token 核对时才付这一跳（审查 N-4：旧实现把 `sfTokensOfRegisteredDisplays(context)`
   * 作为实参**急切求值**，于是每条带 `-d` 的命令都要先跑一次 `dumpsys SurfaceFlinger`）。
   *
   * @param context 用于 SF token 反查；null 时（JVM 单测）等价于「反查不可达」→ 恒拒（fail-closed）。
   */
  internal fun targetsRegisteredVirtualScreen(context: Context?, command: String): Boolean =
    screenVerdictWithRegistry(context, command) == ScreenCommandVerdict.ALLOW

  /**
   * 带注册表的生产判定：`ownsTarget` 的**两个 id 空间**都接上真数据面。
   *
   * `context == null`（JVM 单测）→ 全部判否 ⇒ 只能走到拒绝侧（这正是 `targetsRegisteredVirtualScreen`
   * 单测只覆盖拒绝的原因；放行侧由 [decideTargetsRegisteredVirtualScreen] 的纯判据覆盖）。
   */
  internal fun screenVerdictWithRegistry(context: Context?, command: String): ScreenCommandVerdict {
    if (context == null) return decideScreenCommand(command) { false }
    var sfTokens: Set<String>? = null
    return decideScreenCommand(command) { raw ->
      val id = raw.toIntOrNull()
      if (id != null && id != 0 && VdisplayController.aliasForDisplayId(id) != null) {
        true
      } else {
        val tokens = sfTokens ?: sfTokensOfRegisteredDisplays(context).also { sfTokens = it }
        tokens.contains(raw)
      }
    }
  }

  /**
   * 纯判据：命令的显式目标屏是否确为一块**已注册**虚拟屏（G-F5 放行分支的可测入口）。
   *
   * 为什么单独抽出来：放行分支此前**零测试覆盖**——所有 JVM 用例都传 `context = null`，
   * 而 `null` 恒走 fail-closed 路径（因此只测到了拒绝）。注册表的数据面
   * （`VdisplayController.aliasForDisplayId` / SF 反查）在 JVM 下不可注入（`Record` 持真实
   * `VirtualDisplay`/`ImageReader`），于是「合法目标屏必须放行」这条**在单测里根本无法表达**。
   * 抽成纯函数后，放行与拒绝两侧都能被钉死，且改坏放行逻辑即判红。
   *
   * 与引擎侧 `targetsRegisteredVirtualScreen(command, options)` 同构（同两条 id 空间、同 fail-closed）。
   *
   * @param ownsDisplayId displayId 空间：该 id 是否属于一块已注册虚拟屏（**不含 0**）
   * @param ownedSfTokens token 空间：已注册虚拟屏的 SF token 集合（已与产品别名配对）
   */
  internal fun decideTargetsRegisteredVirtualScreen(
    command: String,
    ownsDisplayId: (Int) -> Boolean,
    ownedSfTokens: Set<String>,
  ): Boolean = decideScreenCommand(command) { raw ->
    if (raw == "0") {
      false
    } else {
      val id = raw.toIntOrNull()
      (id != null && id != 0 && ownsDisplayId(id)) || ownedSfTokens.contains(raw)
    }
  } == ScreenCommandVerdict.ALLOW

  /**
   * 纯判据：一条 raw shell 命令在 virtual-only 下是否**只**作用于已注册虚拟屏。
   *
   * `ownsTarget(raw)`：该十进制串是否属于一块**已注册**虚拟屏（displayId 空间或 SF token 空间，
   * 两个空间的取值都按**原样字符串**比对；`0` 恒为真实屏、永不属于）。
   *
   * 三态拒绝（每一态都有独立的反证用例）：
   *  - [ScreenCommandVerdict.DENY_UNPARSED]：引号不闭合 / 嵌套过深 —— 看不懂就不放行；
   *  - [ScreenCommandVerdict.DENY_ORPHAN_TARGET_TOKEN]：某段带目标屏参数却**自身不含任何屏幕命令词**。
   *    这类 token 没有合法用途，它的存在只为「给同一行的其它命令发通行证」（`echo -d <token>; cat …`）；
   *  - [ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET]：命中屏幕命令词面，但该家族**没有**可用目标屏
   *    参数、参数缺席、或参数值不在注册表里（无参 `screencap`、`-d 0`、`-d <未知>`、
   *    `am start -d 5` 都在此列）。
   *
   * 与引擎侧 `screenCommandVerdict` 同一算法（那侧是调用点第一道，本侧是执行点第二道）。
   */
  internal fun decideScreenCommand(command: String, ownsTarget: (String) -> Boolean): ScreenCommandVerdict {
    val parsed = splitCommandSegments(command)
    if (parsed.unparsed) return ScreenCommandVerdict.DENY_UNPARSED
    for (segment in parsed.segments) {
      val bare = stripQuotedText(segment)
      // 命令名来自运行时（`$CMD` / `"$(cat /sdcard/x.sh)"` / 反引号）：执行什么静态不可判。
      if (isRuntimeCommandName(segment)) return ScreenCommandVerdict.DENY_UNPARSED
      // `awk` 的 system() 载荷不可见（程序文本在引号里）⇒ fail-closed。
      if (AWK_EXEC_PAYLOAD.containsMatchIn(segment)) {
        return ScreenCommandVerdict.DENY_UNPARSED
      }
      // 裸解释器段：管道/重定向喂 shell 的载荷对判定器不可见（#509），fail-closed。
      if (interpreterPayloadUnparsed(bare)) {
        return ScreenCommandVerdict.DENY_UNPARSED
      }
      val options = displayOptionsIn(bare)
      if (MALFORMED_DISPLAY_OPTION.containsMatchIn(bare)) {
        return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
      }
      val normalized = stripDisplayOptions(bare)
      val families = SCREEN_FAMILIES.filter { it.pattern.containsMatchIn(normalized) }
      if (families.isEmpty()) {
        // 非屏幕命令段：允许，但**不得**携带目标屏凭据（否则就是洗白凭据）。
        if (options.isNotEmpty()) return ScreenCommandVerdict.DENY_ORPHAN_TARGET_TOKEN
        continue
      }
      for (family in families) {
        if (family.targetFlags.isEmpty()) return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
        // `input` 的 `-d` 只在 **command 词之前**有意义：`input tap 1 2 -d 7` 里的 `-d 7` 是 tap 的
        // 多余 argv，真实 input 仍操作默认 display 0（Android 只在 command 前解析 -d）。全段扫描会让
        // 尾随 `-d <owned>` 变成"已认证"的通行证（与引擎侧同源修法）。
        val limit = if (family.name == "input") inputCommandIndex(bare) else bare.length
        val owned = options
          .filter { it.flag in family.targetFlags && it.index < limit }
          .map { it.value }
        // 该家族必须在**本段内**自证：参数缺席、或任一值不属于已注册虚拟屏 → 拒（不得只认证其中一个）。
        if (owned.isEmpty()) return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
        if (!owned.all { ownsTarget(it) }) return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
      }
    }
    return ScreenCommandVerdict.ALLOW
  }

  private val INPUT_COMMAND =
    Regex("""\b(?:tap|swipe|roll|draganddrop|motionevent|text|keyevent|keycombination|press)\b""",
      RegexOption.IGNORE_CASE)

  /** `input` 家族里 command 词的位置（「只有它之前的 `-d` 才算凭据」的边界）。 */
  private fun inputCommandIndex(text: String): Int =
    INPUT_COMMAND.find(text)?.range?.first ?: text.length

  /** 引号感知切段结果（与引擎侧 `CommandSegments` 同构）。 */
  internal class ParsedCommand(val segments: List<String>, val unparsed: Boolean)

  /**
   * 引号感知地把一条命令切成**可判定段**：顶层段 + 反引号 / `$()` / `sh -c` 的嵌套执行体。
   *
   * 四条不变量（与引擎侧 `splitCommandSegments` 逐条对应，跨语言 fixture 锁死）：
   *  ① 分隔符（`;` `&&` `||` `|` `&` 换行）**只在引号外**切段；
   *  ② 嵌套执行体再切一层——它们会被 shell 真正执行，不切开就等于放过
   *     `sh -c "screencap -d <token>; input tap 1 2"`；
   *  ③ 引号不闭合（无法解析）一律判拒（fail-closed）。
   */
  internal fun splitCommandSegments(command: String): ParsedCommand {
    val segments = ArrayList<String>()
    var unparsed = false

    fun scan(text: String, depth: Int) {
      if (depth > MAX_NESTING) {
        unparsed = true
        return
      }
      val buf = StringBuilder()
      // 词首状态（注释判定用，见下方 `#` 分支）：分隔符/空白置位，其它字符（含转义对）清除。
      var atWordStart = true
      fun flush() {
        segments.add(buf.toString())
        buf.setLength(0)
        atWordStart = true
      }
      var i = 0
      while (i < text.length) {
        val ch = text[i]
        if (ch == '\\') {
          buf.append(text, i, minOf(i + 2, text.length))
          i += 2
          atWordStart = false
          continue
        }
        if (ch == '\'') {
          val end = text.indexOf('\'', i + 1)
          if (end < 0) {
            unparsed = true
            buf.append(text, i, text.length)
            i = text.length
            continue
          }
          buf.append(text, i, end + 1)
          i = end + 1
          atWordStart = false
          continue
        }
        if (ch == '"') {
          var j = i + 1
          while (j < text.length) {
            val inner = text[j]
            if (inner == '\\') {
              j += 2
              continue
            }
            if (inner == '"') break
            // 双引号内的 `$(...)` 与反引号**会执行**（单引号才不执行）：必须按原文递归扫，
            // 否则 `echo "$(screencap -p /sdcard/real.png)"` 会把真实屏命令当纯文本放行（issue #674）。
            if (inner == '`') {
              val end = backtickEnd(text, j + 1)
              if (end < 0) {
                unparsed = true
                j = text.length
                break
              }
              scan(text.substring(j + 1, end), depth + 1)
              j = end + 1
              continue
            }
            if (inner == '$' && j + 1 < text.length && text[j + 1] == '(') {
              val end = parenEnd(text, j + 2)
              if (end < 0) {
                unparsed = true
                j = text.length
                break
              }
              scan(text.substring(j + 2, end), depth + 1)
              j = end + 1
              continue
            }
            j += 1
          }
          if (j >= text.length) {
            unparsed = true
            buf.append(text, i, text.length)
            i = text.length
            continue
          }
          buf.append(text, i, j + 1)
          i = j + 1
          atWordStart = false
          continue
        }
        if (ch == '`') {
          val end = backtickEnd(text, i + 1)
          if (end < 0) {
            unparsed = true
            buf.append(text, i, text.length)
            i = text.length
            continue
          }
          // **命令位置**上的命令替换：替换结果是运行时文本、会被当成命令执行 ⇒ 执行什么静态不可判
          // （`sh -c "\`cat /sdcard/x.sh\`"` 真机实测执行文件内容）；**载荷位置**上的替换
          // （`` sh -c \`cat f\` ``）等于整段脚本来自运行时，同样 fail-closed。参数位置的替换不影响命令身份。
          if (buf.isBlank() || PAYLOAD_SLOT_TAIL.containsMatchIn(buf)) unparsed = true
          scan(text.substring(i + 1, end), depth + 1)
          buf.append(' ')
          i = end + 1
          continue
        }
        if (ch == '$' && i + 1 < text.length && text[i + 1] == '(') {
          val end = parenEnd(text, i + 2)
          if (end < 0) {
            unparsed = true
            buf.append(text, i, text.length)
            i = text.length
            continue
          }
          // 同上：`sh -c "$(cat /sdcard/x.sh)"` / `sh -c "echo hi; $(cat x.sh)"` 的第二段都是
          // 「命令名来自运行时」⇒ 与 `sh /x.sh`（脚本文件）同档，fail-closed。
          if (buf.isBlank() || PAYLOAD_SLOT_TAIL.containsMatchIn(buf)) unparsed = true
          scan(text.substring(i + 2, end), depth + 1)
          buf.append(' ')
          i = end + 1
          continue
        }
            // shell 注释：`#` 只有在**词首**才开注释。词首＝未转义、未引用的 ASCII 空白 / `;` / `&` / `|`
            // 之后（atWordStart 显式跟踪）—— 不能用「buf 末尾是空白」判定：`echo\ #; screencap …` 里
            // 那个空格是**转义的**（属词内容），`#` 因此是 echo 的参数而不是注释，screencap 照跑
            // （dash 实测 `echo\ #; echo REACHED` 会执行 REACHED）；VT/FF/CR/NBSP 也不是分隔符。
            if (ch == '#' && atWordStart) {
              val lineEnd = text.indexOf('\n', i)
              i = if (lineEnd < 0) text.length else lineEnd
              continue
            }
        if (ch == ';' || ch == '\n' || ch == '\r') {
          flush()
          i += 1
          continue
        }
        if (ch == '&' || ch == '|') {
          flush()
          i += if (i + 1 < text.length && text[i + 1] == ch) 2 else 1
          continue
        }
        if (ch == ' ' || ch == '\t') atWordStart = true else atWordStart = false
        buf.append(ch)
        i += 1
      }
      flush()
    }

    scan(command, 0)

    // `sh -c` 载荷是**再看一层**的入口：它整段都在引号里（stripQuotedText 会把它抹掉），
    // 必须用**原文**匹配、再解一层引号把内层当命令扫。工作队列让嵌套的 `sh -c "sh -c …"` 也被展开
    // （载荷是子串，必然收缩；上限只是防御性护栏）。
    val pending = ArrayDeque(segments)
    var round = 0
    while (pending.isNotEmpty() && round < 16) {
      round += 1
      val segment = pending.removeFirst()
      // `sh -c` 与 `eval` 都是「载荷会被再解释一遍」的入口，两者都要展开（issue #674 同类）。
      val payload = SHELL_C_PAYLOAD.find(segment)
        ?: EVAL_PAYLOAD.find(segment)
        ?: TRAP_PAYLOAD.find(segment)
        ?: continue
      // 取载荷的**第一个词**（不是整段剩余）：`sh -c 'cmd' sh` / `eval 'cmd' foo` / `trap 'cmd' EXIT`
      // 的尾随 argv 会让「整段首尾成对」判据失效，从而整段不展开（安全侧漏拦，与引擎侧同源）。
      // `--` 是**选项终结符**，不是载荷：`trap -- 'cmd' EXIT` 真机会执行 cmd（见 `firstPayloadWord`）。
      val inner = firstPayloadWord(payload.groupValues[1])
      if (inner.isEmpty()) continue
      val before = segments.size
      scan(inner, 1)
      for (k in before until segments.size) pending.addLast(segments[k])
    }
    return ParsedCommand(segments.filter { it.isNotBlank() }, unparsed)
  }

  /** 反引号段结束位置；`\`` 转义不算结束。返回 -1 = 未闭合。 */
  private fun backtickEnd(text: String, from: Int): Int {
    var i = from
    while (i < text.length) {
      if (text[i] == '\\') {
        i += 2
        continue
      }
      if (text[i] == '`') return i
      i += 1
    }
    return -1
  }

  /** `$(` 的配对 `)` 位置（内部引号与嵌套括号都计入）。返回 -1 = 未闭合。 */
  private fun parenEnd(text: String, from: Int): Int {
    var depth = 1
    var i = from
    while (i < text.length) {
      val ch = text[i]
      if (ch == '\\') {
        i += 2
        continue
      }
      if (ch == '\'' || ch == '"') {
        val quote = ch
        i += 1
        while (i < text.length) {
          if (quote == '"' && text[i] == '\\') {
            i += 2
            continue
          }
          if (text[i] == quote) break
          i += 1
        }
        i += 1
        continue
      }
      if (ch == '(') {
        depth += 1
      } else if (ch == ')') {
        depth -= 1
        if (depth == 0) return i
      }
      i += 1
    }
    return -1
  }

  /** 去掉一层首尾成对的引号（`sh -c "…"` 的载荷取值）。不成对则原样返回。 */
  private fun unwrapOneQuote(text: String): String {
    val trimmed = text.trim()
    if (trimmed.length >= 2) {
      val first = trimmed[0]
      if ((first == '"' || first == '\'') && trimmed[trimmed.length - 1] == first) {
        return trimmed.substring(1, trimmed.length - 1)
      }
    }
    return trimmed
  }

  /**
   * 把**引号内文本与转义字符**替换成 shell 真正会执行的字面量：
   *  - 引号段整体抹成空白（引号内不是命令词，也不是参数——`echo "screencap"` 不执行它）；
   *  - `\x` 解成 `x`（shell 会消掉反斜杠：`input \-d 0 tap 1 2` 实际执行的就是 `input -d 0 tap 1 2`）。
   *
   * 与引擎侧 `stripQuotedText` 同规则。
   */
  internal fun stripQuotedText(text: String): String {
    val out = StringBuilder()
    var i = 0
    // 只对**段内第一个词**（命令词位置）做 quote removal —— shell 在查找命令前会剥掉那里的引号，
    // 所以 `"screencap" -p /sdcard/x` 真的会执行 screencap（dash 实测），旧实现把引号段一律抹平
    // ⇒ 命令词位置上的引号内容也被抹掉 ⇒ 整条放行（2026-10-28 自查，安全侧漏拦，与引擎侧同源）。
    // 参数位置的引号必须继续抹掉：`echo "screencap"` 只是打印（fixture 有这条对照）。
    var inFirstWord = true
    while (i < text.length) {
      val ch = text[i]
      if (ch == '\\') {
        if (i + 1 < text.length) out.append(text[i + 1])
        i += 2
        inFirstWord = false
        continue
      }
      // `$'…'` / `$"…"` 在词首同样属于命令词：dash/bash 实测 `$'screencap' -p …` 会执行。
      val ansiC = inFirstWord && ch == '$' && i + 1 < text.length && (text[i + 1] == '\'' || text[i + 1] == '"')
      if (ch == '\'' || ch == '"' || ansiC) {
        val quote = if (ansiC) text[i + 1] else ch
        var j = (if (ansiC) i + 1 else i) + 1
        while (j < text.length) {
          if (quote == '"' && text[j] == '\\') {
            j += 2
            continue
          }
          if (text[j] == quote) break
          j += 1
        }
        if (j >= text.length) {
          out.append(' ')
          i = text.length
          continue
        }
        if (inFirstWord) out.append(text, (if (ansiC) i + 1 else i) + 1, j) else out.append(' ')
        i = j + 1
        inFirstWord = false
        continue
      }
      if (ch == ' ' || ch == '\t' || ch == ';' || ch == '&' || ch == '|' || ch == '\n' || ch == '\r') {
        // 第一个词在此结束：之后的引号都是参数，回到「抹掉」语义。
        inFirstWord = false
        out.append(ch)
        i += 1
        continue
      }
      inFirstWord = false
      out.append(ch)
      i += 1
    }
    return out.toString()
  }

  /** 把目标屏参数整体抹成空白（命令词匹配前归一化，使 `input -d 0 tap …` 也进命令词面）。 */
  internal fun stripDisplayOptions(text: String): String =
    LONG_DISPLAY_OPTION.replace(SHORT_DISPLAY_OPTION.replace(text, " "), " ")

  /** 命令里的全部目标屏参数（拼写 + 原样数字串）。 */
  /** 目标屏选项：flag / 原始值 / 在文本里的起始下标（下标用于 input 的「只在 command 前才算」）。 */
  internal data class DisplayOption(val flag: String, val value: String, val index: Int)

  internal fun displayOptionsIn(text: String): List<DisplayOption> {
    val out = ArrayList<DisplayOption>()
    for (m in SHORT_DISPLAY_OPTION.findAll(text)) out.add(DisplayOption("-d", m.groupValues[1], m.range.first))
    for (m in LONG_DISPLAY_OPTION.findAll(text)) {
      out.add(DisplayOption(m.groupValues[1], m.groupValues[2], m.range.first))
    }
    return out.sortedBy { it.index }
  }

  /**
   * 当前**已注册**虚拟屏的 SF token 集合（块G F6）。经 Shizuku shell 通道读
   * `dumpsys SurfaceFlinger`（收窄到 Virtual Display + name 两行），把 `name="DSH <alias>"`
   * 配对回产品别名，再与 `VdisplayController.activeAliases()` 求交——**只有配对别名仍注册**
   * 的 token 才有效（虚拟屏已销毁 → 其 token 立刻失效）。
   *
   * 必须**先 grep 收窄**：设备实测全量 `dumpsys SurfaceFlinger` 为 31,590 B，而虚拟屏段落在
   * 第 ~9,500 字节之后，超出 shell 通道的 inline 回传窗口 ⇒ 全量取回拿不到目标行、反查恒空。
   *
   * fail-closed：通道不可达/超时/输出为空/解析不出 → 空集（调用方据此拒绝）。
   */
  private fun sfTokensOfRegisteredDisplays(context: Context): Set<String> {
    val registered = VdisplayController.activeAliases()
    if (registered.isEmpty()) return emptySet()
    return try {
      val r = ShizukuTransport.runShell(
        context,
        "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'",
        timeoutMs = 8_000,
      )
      if (!r.optBoolean("ok")) return emptySet()
      val stdout = r.optString("stdout", "")
      if (stdout.isBlank()) return emptySet()
      parseSfDisplayTokens(stdout).filter { it.first in registered }.map { it.second }.toSet()
    } catch (_: Throwable) {
      emptySet()
    }
  }

  /**
   * 纯函数：解析 `dumpsys SurfaceFlinger` 输出里的 `Virtual Display <token>` + 紧跟
   * `name="DSH <alias>"` 配对（与引擎侧 `screenTokensFromSfDump` 同规则）。
   *
   * 设备实测形态：
   * ```
   *     name="mumuscreen000"
   * Virtual Display 11529215046816944610
   *     name="DSH virtual-1"
   * ```
   * 尾随空白必须**容忍**：设备 `dumpsys` 输出常见行尾空格，而旧实现用 `matchEntire` 钉死整行
   * ⇒ 壳侧解析恒空、判定恒拒（审查 N-5 的功能回归面）。
   *
   * @return (alias, token) 列表；token 原样字符串
   */
  internal fun parseSfDisplayTokens(sfDump: String): List<Pair<String, String>> {
    val out = ArrayList<Pair<String, String>>()
    var pending: String? = null
    for (raw in sfDump.lines()) {
      val tokenMatch = SF_DISPLAY_LINE.matchEntire(raw.trim())
      if (tokenMatch != null) {
        pending = tokenMatch.groupValues[1]
        continue
      }
      if (pending == null) continue
      val nameMatch = SF_NAME_LINE.matchEntire(raw.trimEnd())
      if (nameMatch == null) continue
      val displayName = nameMatch.groupValues[1]
      val token = pending
      if (displayName.startsWith(SF_NAME_PREFIX) && token != null) {
        out.add(displayName.removePrefix(SF_NAME_PREFIX) to token)
      }
      // 配对已消费（无论是否 DSH 屏）：防止把下一个 name= 错配到本 token 上。
      pending = null
    }
    return out
  }

  /**
   * 命令里的目标屏数字串（**保留原样，不数值化**）——token 超 `Int`/`Long` 值域，
   * 数值化即失真（见坑 147）。与引擎侧 `adbCommandDisplayTokens` 的取法一致。
   */
  internal fun commandDisplayTokens(command: String): List<String> =
    displayOptionsIn(command).map { it.value }

  /**
   * 落一条审计。
   *
   * G-7（2026-09-25）：`result` 由调用方按**真实结果**传入（[ControlAudit.RESULT_OK] /
   * [ControlAudit.RESULT_FAILED] / [ControlAudit.RESULT_DENIED]），不再恒为 ok。
   * `detail` 已截断到 512 字符，避免把整条命令行（可能含长路径）写爆审计文件。
   *
   * @param context 用于解析 filesDir 与 Shizuku uid。
   * @param op 动作名（shExec / shPull / shPush / shRemove）。
   * @param detail 可读摘要（命令或路径对）。
   * @param result 真实结果三态之一。
   */
  private fun audit(context: Context, op: String, detail: String, result: String) {
    val uid = ShizukuTransport.identity(context).optInt("uid", -1)
    ControlAudit.log(
      context,
      op,
      result,
      mapOf(
        "transport" to "shizuku",
        "uid" to uid,
        "op" to op,
        "detail" to detail.take(512),
        "ok" to (result == ControlAudit.RESULT_OK),
      ),
    )
  }

  /** 由 Shizuku 结果对象取真实结果串（ok=true → ok，否则 failed）。 */
  internal fun resultOf(result: JSONObject): String =
    if (result.optBoolean("ok")) ControlAudit.RESULT_OK else ControlAudit.RESULT_FAILED

  private fun fail(message: String, reason: String): JSONObject = JSONObject()
    .put("__error", message)
    .put("reason", reason)
}
