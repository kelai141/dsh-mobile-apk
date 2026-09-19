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
  private val DISPLAY_OPTION = Regex("""(?:^|[ \t])(-d|--display|--display-id)[ \t=]+(\d+)""")

  /** 命令词家族：每个家族自带「哪种拼写才算它的目标屏」（与引擎侧 `SCREEN_COMMAND_FAMILIES` 同表）。 */
  private data class ScreenFamily(val name: String, val pattern: Regex, val targetFlags: List<String>)

  private val ALL_DISPLAY_FLAGS = listOf("-d", "--display", "--display-id")

  private val SCREEN_FAMILIES = listOf(
    ScreenFamily("screencap", Regex("""\bscreencap\b""", RegexOption.IGNORE_CASE), ALL_DISPLAY_FLAGS),
    ScreenFamily("screenrecord", Regex("""\bscreenrecord\b""", RegexOption.IGNORE_CASE), ALL_DISPLAY_FLAGS),
    ScreenFamily(
      "input",
      Regex("""\binput[ \t]+(?:tap|swipe|roll|draganddrop|motionevent|text|keyevent|keycombination)\b""",
        RegexOption.IGNORE_CASE),
      ALL_DISPLAY_FLAGS,
    ),
    ScreenFamily("wm", Regex("""\bwm[ \t]+(?:size|density|overscan)\b""", RegexOption.IGNORE_CASE), ALL_DISPLAY_FLAGS),
    // `uiautomator dump` 没有目标屏参数：dump 的是**默认屏**的语义树 ⇒ 无法自证，恒拒。
    ScreenFamily("uiautomator", Regex("""\buiautomator\b""", RegexOption.IGNORE_CASE), emptyList()),
    ScreenFamily("dumpsys", Regex("""\bdumpsys[ \t]+(?:window|display|input)\b""", RegexOption.IGNORE_CASE), emptyList()),
    // `am` 的显示参数是 `--display`；`-d` 是 Intent data，**不得**作为目标屏凭据。
    ScreenFamily("am", Regex("""\bam[ \t]+(?:start|start-activity|force-stop|kill)\b""", RegexOption.IGNORE_CASE),
      listOf("--display", "--display-id")),
    ScreenFamily("monkey", Regex("""\bmonkey\b""", RegexOption.IGNORE_CASE), listOf("--display", "--display-id")),
  )

  /** SurfaceFlinger 的虚拟屏 token 行 / 其后的 name= 行（设备实测形态，见坑 147）。 */
  private val SF_DISPLAY_LINE = Regex("""Virtual Display[ \t]+(\d+)""")
  private val SF_NAME_LINE = Regex("""[ \t]*name="([^"]*)"""")
  private const val SF_NAME_PREFIX = "DSH "

  /** 嵌套执行体再切一层的深度上限（与引擎侧 `MAX_NESTING` 相同）。 */
  private const val MAX_NESTING = 4

  /** `sh -c '<内层>'` 形式（含 `/system/bin/sh`、`busybox sh`、`su` 等包装）。 */
  private val SHELL_C_PAYLOAD = Regex(
    """(?:^|[ \t])(?:[^\s]*/)?(?:sh|bash|mksh|ash|dash|zsh|busybox|toybox|su)[ \t]+(?:-[^\s]+[ \t]+)*-c[ \t]+([\s\S]*)$""",
  )

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
    scopeDenied(context, command)?.let { return it }
    val result = ShizukuTransport.runShell(
      context,
      command,
      timeoutMs = args.optInt("timeoutMs", 20_000),
      capture = args.optBoolean("capture", false),
    )
    audit(context, "shExec", command, result.optBoolean("ok"))
    return result.put("op", "shExec").put("transport", "shizuku")
  }

  private fun pull(context: Context, args: JSONObject): JSONObject {
    val remote = args.optString("remote", "")
    val local = args.optString("local", "")
    if (remote.isBlank() || local.isBlank()) return fail("shPull 需要 remote 与 local", "shell-path-missing")
    val result = ShizukuTransport.pullFile(context, remote, local)
    audit(context, "shPull", "$remote -> $local", result.optBoolean("ok"))
    return result.put("op", "shPull").put("transport", "shizuku")
  }

  private fun push(context: Context, args: JSONObject): JSONObject {
    val local = args.optString("local", "")
    val remote = args.optString("remote", "")
    if (local.isBlank() || remote.isBlank()) return fail("shPush 需要 local 与 remote", "shell-path-missing")
    val result = ShizukuTransport.pushFile(context, local, remote)
    audit(context, "shPush", "$local -> $remote", result.optBoolean("ok"))
    return result.put("op", "shPush").put("transport", "shizuku")
  }

  private fun remove(context: Context, args: JSONObject): JSONObject {
    val remote = args.optString("remote", "")
    if (remote.isBlank()) return fail("shRemove 需要 remote", "shell-path-missing")
    val result = ShizukuTransport.removeRemote(context, remote)
    audit(context, "shRemove", remote, result.optBoolean("ok"))
    return result.put("op", "shRemove").put("transport", "shizuku")
  }

  /** §6：屏幕范围（virtual-only 栅栏）在本通道执行点复查——与引擎侧同一套段级判据。 */
  private fun scopeDenied(context: Context, command: String): JSONObject? {
    if (ScreenScopePrefs.current(context) != ScreenScope.VIRTUAL_ONLY) return null
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
        + "（screencap / screenrecord / uiautomator / input / wm / dumpsys window|display|input / am / monkey）。"
        + "命令里显式指定的目标屏若确为**已注册虚拟屏**（DisplayManager displayId 或该屏的 SurfaceFlinger token）即可放行；"
        + "本条命令的目标屏未能与壳侧注册表核对上，故拒绝。请确认虚拟屏仍在活跃状态"
        + "（android_vdisplay_create / vdInfo），或由用户在设置中修改范围后重试。")
      .put("reason", "screen-out-of-scope")
      .put("op", "shExec")
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
      val options = displayOptionsIn(bare)
      val normalized = stripDisplayOptions(bare)
      val families = SCREEN_FAMILIES.filter { it.pattern.containsMatchIn(normalized) }
      if (families.isEmpty()) {
        // 非屏幕命令段：允许，但**不得**携带目标屏凭据（否则就是洗白凭据）。
        if (options.isNotEmpty()) return ScreenCommandVerdict.DENY_ORPHAN_TARGET_TOKEN
        continue
      }
      for (family in families) {
        if (family.targetFlags.isEmpty()) return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
        val owned = options.filter { it.first in family.targetFlags }.map { it.second }
        // 该家族必须在**本段内**自证：参数缺席、或任一值不属于已注册虚拟屏 → 拒（不得只认证其中一个）。
        if (owned.isEmpty()) return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
        if (!owned.all { ownsTarget(it) }) return ScreenCommandVerdict.DENY_UNCERTIFIED_TARGET
      }
    }
    return ScreenCommandVerdict.ALLOW
  }

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
      fun flush() {
        segments.add(buf.toString())
        buf.setLength(0)
      }
      var i = 0
      while (i < text.length) {
        val ch = text[i]
        if (ch == '\\') {
          buf.append(text, i, minOf(i + 2, text.length))
          i += 2
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
          continue
        }
        if (ch == '"') {
          var j = i + 1
          while (j < text.length) {
            if (text[j] == '\\') {
              j += 2
              continue
            }
            if (text[j] == '"') break
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
          scan(text.substring(i + 2, end), depth + 1)
          buf.append(' ')
          i = end + 1
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
      val payload = SHELL_C_PAYLOAD.find(segment) ?: continue
      val inner = unwrapOneQuote(payload.groupValues[1])
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
    while (i < text.length) {
      val ch = text[i]
      if (ch == '\\') {
        if (i + 1 < text.length) out.append(text[i + 1])
        i += 2
        continue
      }
      if (ch == '\'' || ch == '"') {
        val quote = ch
        var j = i + 1
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
        out.append(' ')
        i = j + 1
        continue
      }
      out.append(ch)
      i += 1
    }
    return out.toString()
  }

  /** 把目标屏参数整体抹成空白（命令词匹配前归一化，使 `input -d 0 tap …` 也进命令词面）。 */
  internal fun stripDisplayOptions(text: String): String = DISPLAY_OPTION.replace(text, " ")

  /** 命令里的全部目标屏参数（拼写 + 原样数字串）。 */
  internal fun displayOptionsIn(text: String): List<Pair<String, String>> =
    DISPLAY_OPTION.findAll(text).map { it.groupValues[1] to it.groupValues[2] }.toList()

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
    displayOptionsIn(command).map { it.second }

  private fun audit(context: Context, op: String, detail: String, ok: Boolean) {
    val uid = ShizukuTransport.identity(context).optInt("uid", -1)
    ControlAudit.log(
      context,
      op,
      mapOf(
        "transport" to "shizuku",
        "uid" to uid,
        "op" to op,
        "detail" to detail.take(512),
        "ok" to ok,
      ),
    )
  }

  private fun fail(message: String, reason: String): JSONObject = JSONObject()
    .put("__error", message)
    .put("reason", reason)
}
