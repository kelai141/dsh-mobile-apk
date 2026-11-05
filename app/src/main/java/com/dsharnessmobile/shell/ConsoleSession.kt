package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.TimeUnit

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
  // 2026-10-25 审计 M1：closed/generation 由 UI 线程写、读线程与 restart 读——补 @Volatile。
  @Volatile private var closed = false
  @Volatile private var generation = 0
  private val stripper = ConsoleAnsiStripper()

  /** 本会话是否按 PTY 协议跑（spawn 期决定；与 [ptyReady]「握手完成」是两件事）。 */
  @Volatile private var usingPty = false

  /** 是否真的建立了 PTY（中继回报 ready 之后为 true）。 */
  @Volatile private var ptyReady = false

  /**
   * PTY 握手窗口内缓冲的用户输入（2026-10-25 审计 I3）：中继在 ready 帧之前把 stdin 的
   * 每一行都按 JSON 解析，解析失败直接丢弃——裸写进去的首条命令会无声消失。ready 帧到达时
   * 统一重放。写者=UI 桥线程、读者=读线程，用 [inputLock] 串行化。
   */
  private val pendingInput = StringBuilder()
  private val inputLock = Any()

  /** 当前窗口尺寸。页面首帧常常测出 0，故初值取标准 80x24。 */
  @Volatile private var cols = ConsolePty.DEFAULT_COLS
  @Volatile private var rows = ConsolePty.DEFAULT_ROWS

  /** 把中继脚本解包到私有目录（二进制安全，一次性）。 */
  private fun relayScript(): File? {
    val target = File(context.filesDir, ConsolePty.RELAY_ASSET)
    // M-c4（2026-10-25 审计）：解包按进程只做一次——旧实现每次 start 都「读资产 → 全量复制 →
    // 覆盖同名文件」，重连/重开一次就重打一遍文件 IO（且发生在调用线程上）。
    if (relayUnpacked && target.isFile) return target
    return runCatching {
      context.assets.open(ConsolePty.RELAY_ASSET).use { input ->
        target.outputStream().use { out -> input.copyTo(out) }
      }
      relayUnpacked = true
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
          // PTY 模式：输出是 JSON 帧流，stderr 不能并进来（一行日志就截断协议）；中继自身的
          // stderr 由专职 drain 线程消费（I6——无人读的管道写满 64KB 后写端永久阻塞）。
          // 非 PTY 降级：bash 的 stderr 合并进主输出（终端本来就是混流面，I6 的冻结形态）。
          if (!canUsePty) p.redirectErrorStream(true)
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
      // M-c4：start 由后台线程执行，onDestroy 可能与 spawn 竞速——closed 已置位时当场回收，
      // 不留孤儿（destroy 会递增 generation，此后所有回调自然作废）。
      if (closed) {
        runCatching { proc.destroyForcibly() }
        listener.onStatus(State.FAILED, "控制台已随界面关闭")
        return false
      }
      process = proc
      ptyReady = false
      usingPty = canUsePty
      stripper.reset()
      if (canUsePty) {
        // 中继 stderr 的专职 drain（I6）：首块进日志（native/linker 报错可诊断），其余丢弃防刷屏。
        Thread({
          try {
            proc.errorStream.bufferedReader(Charsets.UTF_8).use { r ->
              val buf = CharArray(2048)
              var logged = false
              while (true) {
                val n = r.read(buf)
                if (n < 0) break
                if (!logged && n > 0) {
                  logged = true
                  Log.i(TAG, "console relay stderr: " + String(buf, 0, n).take(400).replace(Char(10), ' '))
                }
              }
            }
          } catch (_: Throwable) {
          }
        }, "dsh-console-relay-err").apply { isDaemon = true }.start()
      }
      val reader = Thread { readOutput(proc, gen, canUsePty, listener) }
      reader.isDaemon = true
      if (canUsePty) {
        listener.onStatus(State.READY, "bash 已就绪（快照 Termux 环境，正在建立 PTY）")
      } else {
        Log.w(TAG, "console: node/node-pty/relay missing, falling back to non-PTY bash -i")
        listener.onStatus(State.READY, "bash 已就绪（快照 Termux 环境，无 PTY）")
      }
      reader.start()
      true
    } catch (t: Throwable) {
      LogCollector.log(TAG, "console start FAILED: " + (t.message ?: t.javaClass.simpleName))
      listener.onStatus(State.FAILED, "控制台启动失败：" + (t.message ?: t.javaClass.simpleName))
      false
    }
  }

  /** Drain one relay and always settle unexpected EOF without duplicate exit events. */
  internal fun readOutput(proc: Process, gen: Int, canUsePty: Boolean, listener: Listener) {
    var exitSeenByReader = false
    try {
      if (canUsePty) {
        // 中继协议：一行一个 JSON。按行读而不是按字节流读，是因为帧边界就是换行。
        // 输出聚合（I7）：node-pty 的 onData 按小片段回调，每帧一次跨进程 JS 求值会把
        // 主线程打满（cat 大文件即 ANR）——按「16KB 或 50ms」聚合成块再回调。
        val output = ConsoleOutputBatcher(OUTPUT_FLUSH_BYTES, TimeUnit.NANOSECONDS.toMillis(OUTPUT_FLUSH_NS)) { chunk ->
          if (generation == gen) listener.onOutput(chunk)
        }
        try {
          proc.inputStream.bufferedReader(Charsets.UTF_8).use { r ->
            while (true) {
              val line = r.readLine() ?: break
              val data = ConsolePty.dataOf(line)
              if (data != null) {
                val chunk = stripper.feed(data)
                if (chunk.isNotEmpty()) {
                  output.append(chunk)
                }
                continue
              }
              val op = ConsolePty.fieldOf(line, "op")
              if (op == "ready") {
                output.flush()
                val ready = completePtyHandshake(proc, gen)
                if (generation == gen) {
                  if (ready) listener.onStatus(State.READY, "bash 已就绪（快照 Termux 环境，真 PTY）")
                  else listener.onStatus(State.FAILED, UiText.t(context,
                    "PTY 输入重放失败——请重连后重试", "PTY input replay failed. Reconnect to retry."))
                }
              } else if (op == "error") {
                // I4：中继启动期 error 后会立即 process.exit——它不会再服务任何输入，
                // 旧实现仍报 READY 是把死会话说成可用。如实报 FAILED（重连有意义），
                // 进程退出由下方 EOF 兜底（exit 帧不会再来）。
                val msg = ConsolePty.fieldOf(line, "message") ?: "未知错误"
                Log.w(TAG, "console relay error: " + msg)
                output.flush()
                if (generation == gen) listener.onStatus(State.FAILED, "PTY 建立失败：" + msg + "——可点重连重试")
              } else if (op == "exit") {
                val code = ConsolePty.numberFieldOf(line, "code") ?: -1
                exitSeenByReader = true
                output.flush()
                if (generation == gen) listener.onExit(code)
              }
            }
          }
        } finally {
          output.close()
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
    // EOF 兜底（I4 同族）：PTY 模式下 exit 帧已报过就不再重复；error 后中继自退没有
    // exit 帧，EOF 是唯一退出信号——旧实现只给非 PTY 路径报 onExit，死会话永远「就绪」。
    if (generation == gen) {
      synchronized(inputLock) { if (generation == gen) ptyReady = false }
      if (!canUsePty || !exitSeenByReader) listener.onExit(code)
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
    // I2：resize 帧只对 PTY 中继有意义；非 PTY 降级下 process 就是 bash 本身，
    // 往它 stdin 写 JSON 帧等于注入一条命令（页面加载即触发一次）。降级的初始
    // 尺寸已由 DSH_CONSOLE_COLS/ROWS 环境变量交付。
    if (usingPty) send(ConsolePty.resizeMessage(c, r))
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
    synchronized(inputLock) {
      val proc = process ?: return
      if (usingPty && !ptyReady) {
        // Readiness and queue insertion share the ready handler's critical section.
        pendingInput.append(text)
        return
      }
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
  }

  /** Serializes readiness, queued replay and later input for the current relay. */
  internal fun completePtyHandshake(proc: Process, gen: Int): Boolean = synchronized(inputLock) {
    if (closed || generation != gen || process !== proc) return@synchronized false
    val replay = pendingInput.toString()
    pendingInput.setLength(0)
    if (replay.isNotEmpty()) {
      try {
        proc.outputStream.write(ConsolePty.writeMessage(replay).toByteArray(Charsets.UTF_8))
        proc.outputStream.flush()
      } catch (t: Throwable) {
        Log.w(TAG, "console pending replay failed: " + (t.message ?: t.javaClass.simpleName))
        return@synchronized false
      }
    }
    ptyReady = true
    true
  }

  /** Serializes protocol frames with handshake replay and ordinary input. */
  private fun send(line: String) {
    synchronized(inputLock) {
      val proc = process ?: return
      try {
        proc.outputStream.write(line.toByteArray(Charsets.UTF_8))
        proc.outputStream.flush()
      } catch (t: Throwable) {
        Log.w(TAG, "console relay write failed: " + (t.message ?: t.javaClass.simpleName))
      }
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
    synchronized(inputLock) { pendingInput.setLength(0) }
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
    // M-c4：与后台 start 竞速时作废在途会话的回调（读线程的 generation 判据随之失效）。
    generation += 1
    val proc = process
    process = null
    if (proc != null) {
      if (ptyReady) {
        // C1：kill 帧必须直写局部 proc——旧实现此刻已把字段置 null，而 send 读的是字段，
        // kill 协议沦为死代码：实际回收只剩 SIGKILL 中继，vim/top 的 PTY 子进程全部残留。
        try {
          proc.outputStream.write(ConsolePty.KILL_MESSAGE.toByteArray(Charsets.UTF_8))
          proc.outputStream.flush()
        } catch (_: Throwable) {
        }
        // 给中继短窗按协议回收 PTY 子进程；不给窗的话紧随的 destroy 会与 kill 帧竞争。
        try {
          proc.waitFor(500, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
        }
      }
      ptyReady = false
      proc.destroy()
    }
  }

  companion object {
    private const val TAG = "dsh-console"

    /** 输出聚合阈值（I7）：16KB 或 50ms 先到者触发一次回调。 */
    internal const val OUTPUT_FLUSH_BYTES = 16 * 1024
    internal const val OUTPUT_FLUSH_NS = 50_000_000L

    /** 中继脚本解包完成标记（M-c4：进程级一次，重连/重开不再重打资产 IO）。 */
    @Volatile private var relayUnpacked = false
  }
}
