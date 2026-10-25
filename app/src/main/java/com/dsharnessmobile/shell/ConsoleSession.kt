package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Console session: spawns the snapshot bash (env matching the engine: PATH/LD_LIBRARY_PATH/
 * HOME/DSH_HOME/TERMUX_*), writes commands to stdin, reads merged stdout/stderr on a background
 * thread, and streams output back to the UI via a Listener. Works even when the engine is not
 * running (for diagnosing engine startup failures); the process dies with the Activity.
 *
 * Terminal environment: the child gets TERM/TERMINFO/VIMRUNTIME from [ConsoleTerminalEnv]. Without
 * them the snapshot's ncurses and vim fall back to their Termux build-time prefixes, which do not
 * exist under this app domain — "terminals database is inaccessible", "TERM environment variable
 * not set." and "E1187: Failed to source defaults.vim" all trace back to that missing wiring.
 *
 * Output: control sequences are stripped by [ConsoleAnsiStripper] because the page (console.html)
 * is a plain-text container. Non-PTY interaction (bash -i) still has no job control; a real PTY via
 * script(1) is a later iteration and will replace this stripping layer.
 */
class ConsoleSession(private val context: Context) {

  /**
   * 控制台会话的状态（S1-18）。
   *
   * 为什么要有这个枚举：旧实现只把**文案**推给页面（`onStatus("bash 已启动（快照 Termux 环境）")`），
   * 页面于是靠对文案做子串正则判就绪（`/已启动/`、`/退出|失败|缺失/`）。措辞一改，判据就静默错判
   * （页面永远停在「启动中」、输入框永久禁用，而壳侧一切正常）。现在状态是显式契约，文案只用于显示。
   *  `wire` 是与页面共享的字符串，**改名即与页面失配**（有测试钉住）。
   */
  enum class State(val wire: String) {
    /** 正在拉起 bash。 */
    STARTING("starting"),

    /** bash 已就绪，可执行命令。 */
    READY("ready"),

    /** 拉起失败（exec 被拒、环境异常…）——重连**有意义**。 */
    FAILED("failed"),

    /** bash 已退出（含退出码）。 */
    EXITED("exited"),

    /** 快照里的 bash 不存在——重连**必然同样失败**（S1-16），页面据此把按钮换成「返回应用」。 */
    MISSING("missing"),
  }

  interface Listener {
    /** Output chunk (\r collapsed, bell ignored); callback on any thread. */
    fun onOutput(text: String)
    /** 状态（显式枚举 + 面向用户的文案）；callback on any thread。 */
    fun onStatus(state: State, text: String)
    /** bash process exit code. */
    fun onExit(code: Int)
  }

  private var process: Process? = null
  private var closed = false
  private var generation = 0
  private val stripper = ConsoleAnsiStripper()

  /** Start bash; on failure report the reason via listener.onStatus and return false. */
  fun start(listener: Listener): Boolean {
    val engineManager = EngineManager(context, EngineManager.ensurePickToken())
    val bash = File(engineManager.usrDir, "bin/bash")
    if (!bash.exists()) {
      // P3-6：快照内的相对路径不上屏（用户看不懂 `usr/bin/bash`，也做不了什么）——
      // 正文说清「缺什么组件、能不能重试」，路径进日志。
      Log.w(TAG, "console unavailable: bash missing at " + bash.absolutePath)
      listener.onStatus(State.MISSING, "运行时缺少命令行组件（快照不完整），无法打开控制台——请重新安装应用或重装运行时快照")
      return false
    }
    // Exec-bit fallback: some devices/filesystems lose the exec bit after extraction (execve → EACCES,
    // "Permission denied"). The tar mode is theoretically preserved; this is an idempotent hardening step.
    try {
      bash.setExecutable(true, false)
    } catch (t: Throwable) {
      Log.w(TAG, "bash setExecutable failed: " + (t.message ?: t.javaClass.simpleName))
    }
    val gen = ++generation
    return try {
      fun build(argv: List<String>): ProcessBuilder =
        ProcessBuilder(argv).also { p ->
          p.environment().putAll(engineManager.shellEnv())
          // 终端环境必须在**子进程启动前**就在环境里：bash -i 起来时 TERM 已定，
          // 之后再 export 改变不了已经初始化的 ncurses 程序。
          p.environment().putAll(ConsoleTerminalEnv.terminalEnv(engineManager.usrDir))
          p.environment()["PS1"] = "dsh:\\w$ "
          p.redirectErrorStream(true)
        }
      val argv = listOf(bash.absolutePath, "-i")
      // Same fallback as the engine: Android 15/16 and some OEM systems (Honor/Huawei, measured)
      // forbid the app domain from exec'ing an app-data ELF directly (EACCES Permission denied);
      // loading via /system/bin/linker64 matches the Android system-lib mechanism and always works.
      val proc = try {
        build(argv).start()
      } catch (e: java.io.IOException) {
        Log.w(TAG, "console: direct exec denied, falling back to linker64: " + e.message)
        build(listOf("/system/bin/linker64") + argv).start()
      }
      process = proc
      stripper.reset()
      val reader = Thread {
        try {
          proc.inputStream.reader(Charsets.UTF_8).use { r ->
            // 逐字符 read() 已经在跑（行缓冲的实测依据见下），这里只把「一个字符」攒成块再交给
            // 剥离器：剥离器按字符推进，整块喂入既少建临时字符串，也让它跨块的序列状态自然接续。
            val raw = CharArray(1024)
            val sb = StringBuilder()
            while (true) {
              val n = r.read(raw)
              if (n < 0) break
              // 控制序列剥离 + CR 折行 + C0 丢弃统一在 [ConsoleAnsiStripper] 里做（有单测）。
              sb.append(stripper.feed(String(raw, 0, n)))
              // Line buffering: small output (echo etc.) must not wait for the 4096 threshold —
              // on-device measurement showed whole-block buffering stalls output until the next chunk/EOF.
              if (sb.length >= 4096 || sb.indexOf("\n") >= 0) {
                val chunk = sb.toString()
                sb.setLength(0)
                if (generation == gen) listener.onOutput(chunk)
              }
            }
            if (sb.isNotEmpty() && generation == gen) listener.onOutput(sb.toString())
          }
        } catch (t: Throwable) {
          if (!closed) Log.w(TAG, "console reader ended: " + (t.message ?: t.javaClass.simpleName))
        }
        // destroy() race: after bash closes stdout on SIGTERM (read hits EOF) the process may not have
        // fully exited yet — exitValue() then throws IllegalThreadStateException (measured when the app
        // is killed). Report as exited, or mark -1.
        val code = try {
          proc.exitValue()
        } catch (_: IllegalThreadStateException) {
          -1
        }
        if (generation == gen) listener.onExit(code)
      }
      reader.isDaemon = true
      reader.start()
      listener.onStatus(State.READY, "bash 已就绪（快照 Termux 环境）")
      true
    } catch (t: Throwable) {
      LogCollector.log(TAG, "console start FAILED: " + (t.message ?: t.javaClass.simpleName))
      listener.onStatus(State.FAILED, "控制台启动失败：" + (t.message ?: t.javaClass.simpleName))
      false
    }
  }

  /** Write one command (appends \n). */
  fun writeCommand(cmd: String) {
    val proc = process ?: return
    try {
      proc.outputStream.write((cmd + "\n").toByteArray(Charsets.UTF_8))
      proc.outputStream.flush()
    } catch (t: Throwable) {
      Log.w(TAG, "console write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  fun isAlive(): Boolean {
    val proc = process ?: return false
    return try {
      proc.exitValue()
      false
    } catch (_: IllegalThreadStateException) {
      true
    }
  }

  fun restart(listener: Listener): Boolean {
    generation += 1
    destroy()
    closed = false
    return start(listener)
  }

  /** Terminate the session (Activity destroyed). */
  fun destroy() {
    closed = true
    process?.destroy()
    process = null
  }

  companion object {
    private const val TAG = "dsh-console"
  }
}