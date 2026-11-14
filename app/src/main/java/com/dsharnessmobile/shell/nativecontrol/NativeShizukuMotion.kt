package com.dsharnessmobile.shell.nativecontrol

import android.os.Bundle
import android.os.Process as AndroidProcess
import android.os.SystemClock
import com.dsharnessmobile.shell.ProcIo
import org.json.JSONObject
import java.io.File

/**
 * Shell-UID motion adapter for one explicit display.
 *
 * Every command is a fixed argv. The caller cannot supply an argv, a shell fragment or a
 * component. The only variable tokens are the planned display id (0 = real screen; anything
 * else must already be a registered virtual display), bounded numbers, one of four directions,
 * one of eleven key names, one of four global actions and a package name checked against the
 * Android package grammar before the platform resolves it.
 *
 * Result discipline is deliberately the same as the existing tap/text adapters:
 * - [Outcome.executed] = "no" when no side effect was started;
 * - "unknown" when a side effect may have happened but was not confirmed;
 * - "yes" only when the completed command returned the expected evidence.
 *
 * A started command is never retried. A deadline is an elapsedRealtime value and is checked
 * immediately before every command that may change device state.
 */
internal object NativeShizukuMotion {
  private const val SHELL_UID = 2000
  private const val MAX_DEADLINE_MS = 5_000L
  private const val LONG_CLICK_MS = 600L
  private const val SCROLL_MS = 300L
  private const val MIN_SWIPE_MS = 50L
  private const val MAX_SWIPE_MS = 2_000L
  private const val DEFAULT_SWIPE_MS = 300L

  private const val INPUT = "/system/bin/input"
  private const val CMD = "/system/bin/cmd"
  private const val AM = "/system/bin/am"
  private const val DUMPSYS = "/system/bin/dumpsys"

  private const val INPUT_LIMIT = 1_024
  private const val RESOLVE_LIMIT = 16 * 1_024
  private const val AM_LIMIT = 16 * 1_024
  private const val READBACK_LIMIT = 512 * 1_024

  private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)*$")
  private val CLASS = Regex("^[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*$")
  private val DISPLAY_HEADER = Regex("^\\s*Display #([0-9]+)")

  /**
   * 固定 keyEvent 映射：名字 -> KEYCODE，只认这 11 个名字，不接受任意 keycode。
   * Android 语义：DEL(67) 是退格，FORWARD_DEL(112) 才是删除。
   */
  private val KEYCODES = mapOf(
    "enter" to 66,
    "tab" to 61,
    "escape" to 111,
    "backspace" to 67,
    "delete" to 112,
    "space" to 62,
    "up" to 19,
    "down" to 20,
    "left" to 21,
    "right" to 22,
    "back" to 4,
  )

  internal data class Outcome(val ok: Boolean, val code: String, val executed: String)

  /** Device seam: production uses Android APIs; JVM tests substitute a bounded fake. */
  internal interface Environment {
    fun uid(): Int
    fun canExecute(path: String): Boolean
    fun start(argv: List<String>): Process
    fun now(): Long
  }

  private object Device : Environment {
    override fun uid(): Int = AndroidProcess.myUid()
    override fun canExecute(path: String): Boolean = File(path).canExecute()
    override fun start(argv: List<String>): Process =
      ProcessBuilder(argv).redirectErrorStream(true).start()
    override fun now(): Long = SystemClock.elapsedRealtime()
  }

  /** Public adapter entry used by the future typed AIDL transaction. */
  fun execute(operation: String, args: JSONObject, deadlineMs: Long): Bundle =
    bundle(execute(Device, operation, args, deadlineMs))

  /** Display-aware entry: displayId must be 0 or an already-resolved virtual display id. */
  fun execute(displayId: Int, operation: String, args: JSONObject, deadlineMs: Long): Bundle =
    bundle(execute(Device, displayId, operation, args, deadlineMs))

  /** Only operations whose binaries are actually executable by this shell UID are advertised. */
  fun advertisedOps(): List<String> = advertisedOps(Device)

  /**
   * 坐标手势是否可派发：shell 身份的 input 可执行。这是设备/通道级的测量；
   * 具体屏的身份与它是否能被看到，由应用侧注册表和 display 探针各自判定。
   */
  fun gesturesAvailable(): Boolean =
    advertisedOps(Device).containsAll(listOf("click", "longClick", "scroll", "swipe", "keyEvent"))

  internal fun execute(environment: Environment, operation: String, args: JSONObject,
    deadlineMs: Long): Outcome {
    return execute(environment, 0, operation, args, deadlineMs)
  }

  /**
   * Display-aware execution. Each operation keeps the same fixed argv template; the only added
   * token is the display id, which the caller cannot invent: display 0 is the real screen and any
   * other value must be a registered virtual display resolved by the app.
   * Global actions and launchApp keep real-display semantics and are refused for other displays.
   */
  internal fun execute(environment: Environment, displayId: Int, operation: String,
    args: JSONObject, deadlineMs: Long): Outcome {
    if (environment.uid() != SHELL_UID) return no("shizuku-motion-unavailable")
    if (displayId < 0) return no("invalid-display")
    if (!deadlineWindow(environment, deadlineMs)) return no("deadline-invalid")
    return when (operation) {
      "click" -> tap(environment, displayId, args, deadlineMs)
      "longClick" -> longClick(environment, displayId, args, deadlineMs)
      "scroll" -> scroll(environment, displayId, args, deadlineMs)
      "swipe" -> swipe(environment, displayId, args, deadlineMs)
      "keyEvent" -> keyEvent(environment, displayId, args, deadlineMs)
      // global 在虚拟屏只放行 back；home/recents/notifications 由 global 内部明确拒绝。
      "global" -> global(environment, displayId, args, deadlineMs)
      // 跨屏启动始终是 display 0 语义，虚拟屏不接受这个 op。
      "launchApp" -> if (displayId == 0) launchApp(environment, args, deadlineMs) else no("invalid-display")
      else -> no("unsupported-operation")
    }
  }

  /** Plain point tap. displayId 0 keeps the historical real-screen semantics. */
  private fun tap(environment: Environment, displayId: Int, args: JSONObject,
    deadlineMs: Long): Outcome {
    if (!exactKeys(args, setOf("x", "y"))) return no("invalid-arguments")
    val x = intArg(args, "x", 0, 65_535) ?: return no("invalid-coordinate")
    val y = intArg(args, "y", 0, 65_535) ?: return no("invalid-coordinate")
    if (!alive(environment, deadlineMs)) return no("deadline-expired")
    if (!executable(environment, INPUT)) return no("shizuku-motion-unavailable")
    val argv = buildList {
      add(INPUT)
      if (displayId != 0) { add("-d"); add(displayId.toString()) }
      addAll(listOf("tap", x.toString(), y.toString()))
    }
    return accepted(command(environment, argv, deadlineMs, INPUT_LIMIT), "tap-accepted")
  }

  internal fun advertisedOps(environment: Environment): List<String> {
    if (environment.uid() != SHELL_UID) return emptyList()
    val input = executable(environment, INPUT)
    val cmd = executable(environment, CMD)
    val am = executable(environment, AM)
    val dumpsys = executable(environment, DUMPSYS)
    return buildList {
      if (input) {
        addAll(listOf("click", "longClick", "scroll", "swipe", "keyEvent"))
      }
      // Global covers all four fixed actions; recents/notifications need the status bar service.
      if (input && cmd) add("global")
      if (cmd && am && dumpsys) add("launchApp")
    }
  }

  private fun longClick(environment: Environment, displayId: Int, args: JSONObject,
    deadlineMs: Long): Outcome {
    if (!exactKeys(args, setOf("x", "y"))) return no("invalid-arguments")
    val x = intArg(args, "x", 0, 65_535) ?: return no("invalid-coordinate")
    val y = intArg(args, "y", 0, 65_535) ?: return no("invalid-coordinate")
    if (!alive(environment, deadlineMs, LONG_CLICK_MS)) return no("deadline-expired")
    if (!executable(environment, INPUT)) return no("shizuku-motion-unavailable")
    val result = command(environment, listOf(INPUT, "-d", displayId.toString(), "swipe", x.toString(),
      y.toString(), x.toString(), y.toString(), LONG_CLICK_MS.toString()), deadlineMs, INPUT_LIMIT)
    return accepted(result, "long-click-accepted")
  }

  private fun scroll(environment: Environment, displayId: Int, args: JSONObject,
    deadlineMs: Long): Outcome {
    if (!exactKeys(args, setOf("direction", "x", "y", "fraction", "width", "height")))
      return no("invalid-arguments")
    val direction = stringArg(args, "direction") ?: return no("invalid-direction")
    if (direction !in setOf("up", "down", "left", "right")) return no("invalid-direction")
    val width = intArg(args, "width", 2, 65_535) ?: return no("invalid-dimensions")
    val height = intArg(args, "height", 2, 65_535) ?: return no("invalid-dimensions")
    val x = intArg(args, "x", 0, width - 1) ?: return no("invalid-coordinate")
    val y = intArg(args, "y", 0, height - 1) ?: return no("invalid-coordinate")
    val fraction = numberArg(args, "fraction") ?: return no("invalid-fraction")
    if (fraction !in 0.1..1.0) return no("invalid-fraction")
    val segment = NativeRawGeometry.swipeSegment(x.toFloat(), y.toFloat(), width, height,
      direction, fraction) ?: return no("invalid-scroll-geometry")
    val x1 = roundClamped(segment.x1, width - 1)
    val y1 = roundClamped(segment.y1, height - 1)
    val x2 = roundClamped(segment.x2, width - 1)
    val y2 = roundClamped(segment.y2, height - 1)
    if (x1 == x2 && y1 == y2) return no("invalid-scroll-geometry")
    if (!alive(environment, deadlineMs, SCROLL_MS)) return no("deadline-expired")
    if (!executable(environment, INPUT)) return no("shizuku-motion-unavailable")
    val result = command(environment, listOf(INPUT, "-d", displayId.toString(), "swipe", x1.toString(),
      y1.toString(), x2.toString(), y2.toString(), SCROLL_MS.toString()), deadlineMs, INPUT_LIMIT)
    return accepted(result, "scroll-accepted")
  }

  /**
   * 任意起终点的滑动：`input -d <displayId> swipe x1 y1 x2 y2 durationMs`。
   *
   * 与 [scroll] 分开：scroll 是「按方向 + 轴长比例」算出的线段，swipe 直接吃调用方给的两点。
   * 四个端点各自只做 0..65535 的范围校验，不要求 x1<=x2 或 y1<=y2——反向滑动本身合法。
   * durationMs 夹在 50..2000，缺省 300。
   */
  private fun swipe(environment: Environment, displayId: Int, args: JSONObject,
    deadlineMs: Long): Outcome {
    val allowed = setOf("x1", "y1", "x2", "y2", "durationMs")
    // durationMs 可选，所以这里只要求「键集合是允许集的子集」+ 四个端点必填；
    // 用 exactKeys 会把可选项也当成必填。
    if (!subsetOf(args, allowed)) return no("invalid-arguments")
    if (!args.has("x1") || !args.has("y1") || !args.has("x2") || !args.has("y2"))
      return no("invalid-arguments")
    val x1 = intArg(args, "x1", 0, 65_535) ?: return no("invalid-coordinate")
    val y1 = intArg(args, "y1", 0, 65_535) ?: return no("invalid-coordinate")
    val x2 = intArg(args, "x2", 0, 65_535) ?: return no("invalid-coordinate")
    val y2 = intArg(args, "y2", 0, 65_535) ?: return no("invalid-coordinate")
    val duration = if (args.has("durationMs")) {
      val raw = numberArg(args, "durationMs") ?: return no("invalid-duration")
      if (raw != Math.floor(raw) || raw < MIN_SWIPE_MS.toDouble() || raw > MAX_SWIPE_MS.toDouble())
        return no("invalid-duration")
      raw.toLong()
    } else DEFAULT_SWIPE_MS
    if (x1 == x2 && y1 == y2) return no("gesture-degenerate")
    if (!alive(environment, deadlineMs, duration)) return no("deadline-expired")
    if (!executable(environment, INPUT)) return no("shizuku-motion-unavailable")
    val result = command(environment, listOf(INPUT, "-d", displayId.toString(), "swipe",
      x1.toString(), y1.toString(), x2.toString(), y2.toString(), duration.toString()),
      deadlineMs, INPUT_LIMIT)
    return accepted(result, "swipe-accepted")
  }

  /**
   * 固定 keyEvent：`input -d <displayId> keyevent <code>`。
   *
   * 只接受 [KEYCODES] 里的 11 个名字，参数里出现任何其它键（含 keycode）都拒绝，
   * 调用方无法传任意 keycode 或额外 argv。
   */
  private fun keyEvent(environment: Environment, displayId: Int, args: JSONObject,
    deadlineMs: Long): Outcome {
    if (!exactKeys(args, setOf("key"))) return no("invalid-arguments")
    val key = stringArg(args, "key") ?: return no("invalid-key")
    val code = KEYCODES[key] ?: return no("invalid-key")
    if (!alive(environment, deadlineMs)) return no("deadline-expired")
    if (!executable(environment, INPUT)) return no("shizuku-motion-unavailable")
    val result = command(environment,
      listOf(INPUT, "-d", displayId.toString(), "keyevent", code.toString()), deadlineMs, INPUT_LIMIT)
    return accepted(result, "key-event-accepted")
  }

  /**
   * 全局动作。
   *
   * back 用 `input -d <displayId> keyevent 4`，所以真实屏与虚拟屏都能落在目标屏上。
   * 其余动作都没有 display 参数（`input -d 0 keyevent` 与 `cmd statusbar ...` 都固定在默认屏），
   * 因此在虚拟屏上无法保证落在目标屏。按「不能打真实屏冒充」的要求，非 display 0 一律
   * target-unsupported 明确拒绝（与 Rust 的虚拟 global 判定同码），而不是悄悄在真实屏执行。
   *
   * 只有下面这些动作被实现。没有设备实测证据的动作（powerDialog / lockScreen /
   * toggleSplitScreen / accessibilityShortcut）不在这里出现，避免发布未验证的能力。
   */
  private fun global(environment: Environment, displayId: Int, args: JSONObject,
    deadlineMs: Long): Outcome {
    if (!exactKeys(args, setOf("action"))) return no("invalid-arguments")
    val action = stringArg(args, "action") ?: return no("invalid-global-action")
    val command: List<String> = when (action) {
      "back" -> listOf(INPUT, "-d", displayId.toString(), "keyevent", "4")
      // 以下动作都没有 display 参数：只能真实屏执行，虚拟屏明确拒绝。
      "home" -> realOnly(displayId) { listOf(INPUT, "-d", "0", "keyevent", "3") }
      "recents" -> realOnly(displayId) { listOf(INPUT, "-d", "0", "keyevent", "187") }
      "menu" -> realOnly(displayId) { listOf(INPUT, "-d", "0", "keyevent", "82") }
      "mediaPlayPause" -> realOnly(displayId) { listOf(INPUT, "-d", "0", "keyevent", "85") }
      "notifications" -> realOnly(displayId) { listOf(CMD, "statusbar", "expand-notifications") }
      // MuMu 上 `cmd statusbar help` 只读确认过这两条在场。
      "quickSettings" -> realOnly(displayId) { listOf(CMD, "statusbar", "expand-settings") }
      "dismissNotificationShade" -> realOnly(displayId) { listOf(CMD, "statusbar", "collapse") }
      else -> return no("invalid-global-action")
    }
    if (command.isEmpty()) return no("target-unsupported")
    if (!alive(environment, deadlineMs)) return no("deadline-expired")
    // 按实际 argv 的可执行文件判断：recents 走的是 input keyevent，不是 cmd。
    val binary = command.first()
    if (!executable(environment, binary)) return no("shizuku-motion-unavailable")
    return accepted(command(environment, command, deadlineMs, INPUT_LIMIT), "global-accepted")
  }

  /**
   * 只允许真实屏的动作。
   *
   * 虚拟屏直接返回空 argv，由 [global] 统一转成 target-unsupported：拒绝发生在起进程之前，
   * 不会有一条落在 display 0 的命令被执行。
   */
  private inline fun realOnly(displayId: Int, argv: () -> List<String>): List<String> =
    if (displayId == 0) argv() else emptyList()

  /**
   * Resolve a launcher component, start it on display 0 with fixed argv, then read back the
   * package's ActivityRecord from that display. Only a positive display-0 readback is "yes".
   */
  private fun launchApp(environment: Environment, args: JSONObject, deadlineMs: Long): Outcome {
    if (!exactKeys(args, setOf("pkg"))) return no("invalid-arguments")
    val pkg = stringArg(args, "pkg") ?: return no("invalid-package")
    if (!validPackage(pkg)) return no("invalid-package")
    if (!alive(environment, deadlineMs)) return no("deadline-expired")
    if (!executable(environment, CMD)) return no("shizuku-motion-unavailable")

    val resolved = command(environment, listOf(CMD, "package", "resolve-activity", "--brief",
      "-c", "android.intent.category.LAUNCHER", pkg), deadlineMs, RESOLVE_LIMIT)
    val component = when (resolved) {
      is CommandResult.Finished -> if (resolved.exitCode == 0) parseComponent(pkg, resolved.text) else null
      else -> null
    } ?: return no("launch-unresolved")

    if (!alive(environment, deadlineMs)) return no("deadline-expired")
    if (!executable(environment, AM)) return no("shizuku-motion-unavailable")
    val started = command(environment, listOf(AM, "start", "--display", "0", "-n", component),
      deadlineMs, AM_LIMIT)
    when (started) {
      is CommandResult.NotStarted -> return no("deadline-expired")
      is CommandResult.StartFailed -> return no("launch-start-failed")
      is CommandResult.Uncertain -> return unknown("launch-unconfirmed")
      is CommandResult.Finished -> {
        if (started.exitCode != 0 || reportsError(started.text)) return unknown("launch-unconfirmed")
      }
    }

    // From here on the start command may already have changed the device; failures are unknown.
    if (!alive(environment, deadlineMs)) return unknown("deadline-expired")
    if (!executable(environment, DUMPSYS)) return unknown("launch-readback-unavailable")
    val readback = command(environment, listOf(DUMPSYS, "activity", "activities"), deadlineMs,
      READBACK_LIMIT, allowTruncated = true)
    return when (readback) {
      is CommandResult.Finished -> {
        if (readback.exitCode != 0) return unknown("launch-readback-unavailable")
        val displays = runningDisplays(pkg, readback.text)
        when {
          displays.contains(0) -> yes("launch-confirmed")
          displays.isNotEmpty() -> unknown("launch-wrong-display")
          else -> unknown("launch-unverified")
        }
      }
      else -> unknown("launch-readback-unavailable")
    }
  }

  private sealed class CommandResult {
    object NotStarted : CommandResult()
    object StartFailed : CommandResult()
    object Uncertain : CommandResult()
    class Finished(val exitCode: Int, val text: String) : CommandResult()
  }

  private fun command(environment: Environment, argv: List<String>, deadlineMs: Long,
    limitBytes: Int, allowTruncated: Boolean = false): CommandResult {
    if (!alive(environment, deadlineMs)) return CommandResult.NotStarted
    val process = try {
      environment.start(argv)
    } catch (_: Exception) {
      return CommandResult.StartFailed
    }
    val timeout = (deadlineMs - environment.now()).coerceIn(1L, MAX_DEADLINE_MS)
    val result = try {
      ProcIo.readBoundedMillis(process, timeout, limitBytes)
    } catch (_: Exception) {
      return CommandResult.Uncertain
    }
    if (!result.complete || (result.truncated && !allowTruncated)) return CommandResult.Uncertain
    val exitCode = try {
      process.exitValue()
    } catch (_: Exception) {
      return CommandResult.Uncertain
    }
    return CommandResult.Finished(exitCode, result.text)
  }

  /** A simple input/status-bar command is accepted only on a clean exit and empty output. */
  private fun accepted(result: CommandResult, successCode: String): Outcome = when (result) {
    is CommandResult.NotStarted -> no("deadline-expired")
    is CommandResult.StartFailed -> no("motion-start-failed")
    is CommandResult.Uncertain -> unknown("motion-unconfirmed")
    is CommandResult.Finished -> if (result.exitCode == 0 && result.text.isBlank()) yes(successCode)
      else unknown("motion-unconfirmed")
  }

  private fun parseComponent(pkg: String, output: String): String? {
    val line = output.lineSequence().map { it.trim() }.lastOrNull { it.startsWith("$pkg/") }
      ?: return null
    if (line.length > 512 || line.any { it.isWhitespace() || it.isISOControl() }) return null
    val slash = line.indexOf('/')
    if (slash <= 0 || line.substring(0, slash) != pkg) return null
    val rawClass = line.substring(slash + 1)
    val className = if (rawClass.startsWith(".")) rawClass.substring(1) else rawClass
    if (className.isEmpty() || !CLASS.matches(className)) return null
    return line
  }

  /** Package -> displays where an ActivityRecord mentions it. Empty means no evidence. */
  private fun runningDisplays(pkg: String, activities: String): Set<Int> {
    val out = linkedSetOf<Int>()
    if (pkg.isEmpty()) return out
    val member = Regex("(^|[\\s:])" + Regex.escape(pkg) + "/")
    var display = -1
    for (line in activities.lineSequence()) {
      val header = DISPLAY_HEADER.find(line)
      if (header != null) {
        display = header.groupValues[1].toIntOrNull() ?: -1
        continue
      }
      if (display < 0 || !line.contains("ActivityRecord{")) continue
      if (member.containsMatchIn(line)) out += display
    }
    return out
  }

  private fun validPackage(pkg: String): Boolean =
    pkg.isNotEmpty() && pkg.length <= 255 && pkg.all { !it.isWhitespace() && !it.isISOControl() } &&
      PACKAGE.matches(pkg)

  private fun reportsError(output: String): Boolean = output.lineSequence().any { line ->
    line.contains("Error:", ignoreCase = true) || line.contains("Exception", ignoreCase = true)
  }

  private fun deadlineWindow(environment: Environment, deadlineMs: Long): Boolean {
    val remaining = deadlineMs - environment.now()
    return remaining in 1..MAX_DEADLINE_MS
  }

  private fun alive(environment: Environment, deadlineMs: Long, neededMs: Long = 1L): Boolean =
    deadlineMs - environment.now() >= neededMs

  private fun executable(environment: Environment, path: String): Boolean =
    try { environment.canExecute(path) } catch (_: Exception) { false }

  private fun exactKeys(args: JSONObject, required: Set<String>): Boolean {
    val keys = args.keys()
    while (keys.hasNext()) if (keys.next() !in required) return false
    return required.all { args.has(it) }
  }

  /** 只允许 [allowed] 里的键（不要求全部在场），用于带可选参数的 op。 */
  private fun subsetOf(args: JSONObject, allowed: Set<String>): Boolean {
    val keys = args.keys()
    while (keys.hasNext()) if (keys.next() !in allowed) return false
    return true
  }

  private fun intArg(args: JSONObject, key: String, min: Int, max: Int): Int? {
    val number = numberArg(args, key) ?: return null
    if (number != Math.floor(number) || number < min.toDouble() || number > max.toDouble()) return null
    return number.toInt()
  }

  private fun numberArg(args: JSONObject, key: String): Double? {
    if (!args.has(key)) return null
    val value = args.get(key)
    if (value !is Number) return null
    val number = value.toDouble()
    return if (number.isFinite()) number else null
  }

  private fun stringArg(args: JSONObject, key: String): String? {
    if (!args.has(key)) return null
    return args.get(key) as? String
  }

  private fun roundClamped(value: Float, max: Int): Int =
    Math.round(value).coerceIn(0, max)

  private fun no(code: String) = Outcome(false, code, "no")
  private fun unknown(code: String) = Outcome(false, code, "unknown")
  private fun yes(code: String) = Outcome(true, code, "yes")

  private fun bundle(outcome: Outcome): Bundle = Bundle().apply {
    putBoolean("ok", outcome.ok)
    putString("code", outcome.code)
    putString("executed", outcome.executed)
  }
}
