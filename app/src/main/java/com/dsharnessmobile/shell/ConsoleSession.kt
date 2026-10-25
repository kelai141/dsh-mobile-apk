package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Console session: runs a real pty-hosted bash and streams its output to the UI.
 *
 * Terminal environment: the child gets TERM/TERMINFO/VIMRUNTIME from [ConsoleTerminalEnv]. Without
 * them the snapshot's ncurses and vim fall back to their Termux build-time prefixes, which do not
 * exist under this app domain — "terminals database is inaccessible", "TERM environment variable
 * not set." and "E1187: Failed to source defaults.vim" all trace back to that missing wiring.
 *
 * PTY: the shell runs under a node-pty relay ([ConsolePty]). A real pty is what makes
 * top/vim/termux-change-repo work at all; without it bash prints "no job control in this shell"
 * and every full-screen program refuses to start. The snapshot's script(1) was the first attempt
 * and did not work — see [ConsolePty] for the measured reason.
 *
 * Output: control sequences pass through [ConsoleAnsiStripper] because the page (console.html) is a
 * plain-text container. The stripping is the current rendering compromise, not a property of the
 * PTY — a page-side ANSI renderer replaces exactly this layer and nothing else.
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
    /** 正在拉起。 */
    STARTING("starting"),

    /** 已就绪，可执行命令。 */
    READY("ready"),

    /** 拉起失败（exec 被拒、环境异常…）——重连**有意义**。 */
    FAILED("failed"),

    /** 已退出（含退出码）。 */
    EXITED("exited"),

    /** 快照里的 bash 不存在——重连**必然同样失败**（S1-16），页面据此把按钮换成「返回应用」。 */
    MISSING("missing"),
  }

  interface Listener {
    /** Output chunk (control sequences already stripped); callback on any thread. */
    fun onOutput(text: String)
    /** 状态（显式枚举 + 面向用户的文案）；callback on any thread。 */
    fun onStatus(state: State, text: String)
    /** 进程退出码。 */
    fun onExit(code: Int)
  }

  private var process: Process? = null
  private var closed = false
  private var generation = 0
  private val stripper = ConsoleAnsiStripper()

  /** 是否真的建立了 PTY（中继回报 ready 之后为 true）。 */
  @Volatile private var ptyReady = false

  /** 当前窗口尺寸。页面首帧常常测出 0，故初值取标准 80x24。 */
  @Volatile private var cols = ConsolePty.DEFAULT_COLS
  @Volatile private var rows = ConsolePty.DEFAULT_ROWS

  /** 把中继脚本解包到私有目录（二进制安全，一次性）。 */
  private fun relayScript(): File? {
    val target = File(context.filesDir, ConsolePty.RELAY_ASSET)
    return runCatching {
      context.assets.open(ConsolePty.RELAY_ASSET).use { input ->
        target.outputStream().use { out -> input.copyTo(out) }
      }
      target
    }.onFailure { Log.w(TAG, "console relay unpack failed: " + (it.message ?: it.javaClass.simpleName)) }
      .getOrNull()
  }

  /** Start the PTY session; on failure report the reason via listener.onStatus and return false. */
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

    val node = File(engineManager.usrDir, ConsolePty.NODE_RELATIVE)
    val relay = relayScript()
    val ptyModule = File(engineManager.usrDir, ConsolePty.DEFAULT_NODE_PTY)
    // 三条依赖缺任一都退化为非 PTY：命令照样能敲，只是 TUI 不可用。
    // 判据是文件存在，不猜系统版本，也不把「可能能用」当成「能用」。
    val canUsePty = node.isFile && relay != null && ptyModule.isDirectory

    val gen = ++generation
    return try {
      fun build(argv: List<String>): ProcessBuilder =
        ProcessBuilder(argv).also { p ->
          p.environment().putAll(engineManager.shellEnv())
          // 终端环境必须在**子进程启动前**就在环境里：bash -i 起来时 TERM 已定，
          // 之后再 export 改变不了已经初始化的 ncurses 程序。
          p.environment().putAll(ConsoleTerminalEnv.terminalEnv(engineManager.usrDir))
          p.environment()["PS1"] = "dsh:\\w$ "
          p.environment()["DSH_CONSOLE_PREFIX"] = engineManager.usrDir.absolutePath
          p.environment()["DSH_CONSOLE_SHELL"] = bash.absolutePath
          p.environment()["DSH_CONSOLE_NODE_PTY"] = ptyModule.absolutePath
          p.environment()["DSH_CONSOLE_COLS"] = ConsolePty.normalizeSize(cols, rows).first.toString()
          p.environment()["DSH_CONSOLE_ROWS"] = ConsolePty.normalizeSize(cols, rows).second.toString()
          // 输出里混着 JSON 帧：stderr 不能并进来，否则一行日志就把 JSON 流截断了。
        }
      val argv = if (canUsePty) ConsolePty.argv(node, relay!!) else listOf(bash.absolutePath, "-i")
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
      ptyReady = false
      stripper.reset()
      val reader = Thread {
        try {
          if (canUsePty) {
            // 中继协议：一行一个 JSON。按行读而不是按字节流读，是因为帧边界就是换行。
            proc.inputStream.bufferedReader(Charsets.UTF_8).use { r ->
              while (true) {
                val line = r.readLine() ?: break
                val data = ConsolePty.dataOf(line)
                if (data != null) {
                  val chunk = stripper.feed(data)
                  if (chunk.isNotEmpty() && generation == gen) listener.onOutput(chunk)
                  continue
                }
                val op = ConsolePty.fieldOf(line, "op")
                if (op == "ready") {
                  ptyReady = true
                  if (generation == gen) {
                    listener.onStatus(State.READY, "bash 已就绪（快照 Termux 环境，真 PTY）")
                  }
                } else if (op == "error") {
                  val msg = ConsolePty.fieldOf(line, "message") ?: "未知错误"
                  Log.w(TAG, "console relay error: " + msg)
                  if (generation == gen) listener.onStatus(State.READY, "控制台可用，但 PTY 建立失败：" + msg)
                } else if (op == "exit") {
                  val code = ConsolePty.numberFieldOf(line, "code") ?: -1
                  if (generation == gen) listener.onExit(code)
                }
              }
            }
          } else {
            // 非 PTY 降级路径：与旧实现一致，按块读并剥离控制序列。
            proc.inputStream.reader(Charsets.UTF_8).use { r ->
              val raw = CharArray(1024)
              val sb = StringBuilder()
              while (true) {
                val n = r.read(raw)
                if (n < 0) break
                sb.append(stripper.feed(String(raw, 0, n)))
                if (sb.length >= 4096 || sb.indexOf("\n") >= 0) {
                  val chunk = sb.toString()
                  sb.setLength(0)
                  if (generation == gen) listener.onOutput(chunk)
                }
              }
              if (sb.isNotEmpty() && generation == gen) listener.onOutput(sb.toString())
            }
          }
        } catch (t: Throwable) {
          if (!closed) Log.w(TAG, "console reader ended: " + (t.message ?: t.javaClass.simpleName))
        }
        val code = try {
          proc.exitValue()
        } catch (_: IllegalThreadStateException) {
          -1
        }
        if (generation == gen && !canUsePty) listener.onExit(code)
      }
      reader.isDaemon = true
      reader.start()
      if (canUsePty) {
        listener.onStatus(State.READY, "bash 已就绪（快照 Termux 环境，正在建立 PTY）")
      } else {
        Log.w(TAG, "console: node/node-pty/relay missing, falling back to non-PTY bash -i")
        listener.onStatus(State.READY, "bash 已就绪（快照 Termux 环境，无 PTY）")
      }
      true
    } catch (t: Throwable) {
      LogCollector.log(TAG, "console start FAILED: " + (t.message ?: t.javaClass.simpleName))
      listener.onStatus(State.FAILED, "控制台启动失败：" + (t.message ?: t.javaClass.simpleName))
      false
    }
  }

  /**
   * 页面尺寸变化时调用。
   *
   * @param cols 列数（页面按字符度量估算）。
   * @param rows 行数。
   */
  fun resize(cols: Int, rows: Int) {
    val (c, r) = ConsolePty.normalizeSize(cols, rows)
    if (c == this.cols && r == this.rows) return
    this.cols = c
    this.rows = r
    send(ConsolePty.resizeMessage(c, r))
  }

  /** Write one command (appends \n). */
  fun writeCommand(cmd: String) {
    writeRaw(cmd + "\n")
  }

  /**
   * 写入原始字节（不追加换行）。
   *
   * 有了真 PTY 之后，方向键、Ctrl-C、Tab 补全都是裸控制字符；
   * 只提供"整行命令"的入口等于把这些能力挡在门外。
   *
   * @param text 要写入的文本（可含控制字符）。
   */
  fun writeRaw(text: String) {
    val proc = process ?: return
    if (ptyReady) {
      send(ConsolePty.writeMessage(text))
      return
    }
    try {
      proc.outputStream.write(text.toByteArray(Charsets.UTF_8))
      proc.outputStream.flush()
    } catch (t: Throwable) {
      Log.w(TAG, "console write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** 向中继写一行协议消息。 */
  private fun send(line: String) {
    val proc = process ?: return
    try {
      proc.outputStream.write(line.toByteArray(Charsets.UTF_8))
      proc.outputStream.flush()
    } catch (t: Throwable) {
      Log.w(TAG, "console relay write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** 当前是否运行在真 PTY 下（页面据此决定是否显示按键条）。 */
  fun hasPty(): Boolean = ptyReady

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
    stripper.reset()
    return start(listener)
  }

  /**
   * Terminate the session (Activity destroyed).
   *
   * 先给中继发 kill 让它按协议回收 PTY 子进程，再 destroy 兜底：
   * 只 destroy 中继会留下「pty 已关、bash 还在跑」的孤儿（vim/top 实测残留）。
   */
  fun destroy() {
    closed = true
    val proc = process
    process = null
    if (proc != null) {
      if (ptyReady) send(ConsolePty.KILL_MESSAGE)
      ptyReady = false
      proc.destroy()
    }
  }

  companion object {
    private const val TAG = "dsh-console"
  }
}
