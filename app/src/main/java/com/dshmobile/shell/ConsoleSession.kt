package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File

/**
 * 控制台会话：spawn 快照 bash（env 与引擎一致：PATH/LD_LIBRARY_PATH/
 * HOME/DSH_HOME/TERMUX_*），stdin 写命令、stdout/stderr 合并后台读，
 * 输出经 Listener 回调回 UI。引擎未运行时也可用（排查引擎启动失败场景）；
 * Activity 销毁时进程随之终止。
 *
 * 非 PTY 交互（bash -i）：无 job control 提示，命令逐行执行；完整 PTY
 * （script -q -c bash）列为后续迭代。
 */
class ConsoleSession(private val context: Context) {

  interface Listener {
    /** 输出块（已做 \r 折叠、bell 忽略），任意线程回调。 */
    fun onOutput(text: String)
    /** 状态文案（启动/退出），任意线程回调。 */
    fun onStatus(text: String)
    /** bash 进程退出码。 */
    fun onExit(code: Int)
  }

  private var process: Process? = null
  private var closed = false

  /** 启动 bash；失败时经 listener.onStatus 报告原因并返回 false。 */
  fun start(listener: Listener): Boolean {
    val engineManager = EngineManager(context, EngineManager.ensurePickToken())
    val bash = File(engineManager.usrDir, "bin/bash")
    if (!bash.exists()) {
      listener.onStatus("快照缺失（usr/bin/bash 不存在），无法打开控制台")
      return false
    }
    // 可执行位兜底：个别设备/文件系统解压后可能丢失 exec 位（execve → EACCES，
    // 报"Permission denied"）。tar 内模式理论上保留，这里幂等加固。
    try {
      bash.setExecutable(true, false)
    } catch (t: Throwable) {
      Log.w(TAG, "bash setExecutable failed: " + (t.message ?: t.javaClass.simpleName))
    }
    return try {
      fun build(argv: List<String>): ProcessBuilder =
        ProcessBuilder(argv).also { p ->
          p.environment().putAll(engineManager.shellEnv())
          p.environment()["PS1"] = "dsh:\\w$ "
          p.redirectErrorStream(true)
        }
      val argv = listOf(bash.absolutePath, "-i")
      // 与引擎同款回退：Android 15/16 及部分厂商系统（荣耀/华为实测）禁止 app 域
      // 直接 exec app-data ELF（EACCES Permission denied），经 /system/bin/linker64
      // 加载机制与 Android 系统库一致，始终允许。
      val proc = try {
        build(argv).start()
      } catch (e: java.io.IOException) {
        Log.w(TAG, "console: direct exec denied, falling back to linker64: " + e.message)
        build(listOf("/system/bin/linker64") + argv).start()
      }
      process = proc
      val reader = Thread {
        try {
          proc.inputStream.bufferedReader().use { r ->
            val sb = StringBuilder()
            while (true) {
              val c = r.read()
              if (c < 0) break
              // \r 折叠为 \n（无 PTY 时输出含 CR）；bell 忽略（避免 UI 噪音）。
              if (c == '\r'.code) {
                sb.append('\n')
              } else if (c != '\u0007'.code) {
                sb.append(c.toChar())
              }
              // 行缓冲：小输出（echo 等）不能在 4096 阈值后才 flush——
              // 设备实测整块缓冲会把输出卡到下一次大块/EOF。
              if (c == '\n'.code || sb.length >= 4096) {
                val chunk = sb.toString()
                sb.setLength(0)
                listener.onOutput(chunk)
              }
            }
            if (sb.isNotEmpty()) listener.onOutput(sb.toString())
          }
        } catch (t: Throwable) {
          if (!closed) Log.w(TAG, "console reader ended: " + (t.message ?: t.javaClass.simpleName))
        }
        // destroy() 竞态：bash 收到 SIGTERM 关闭 stdout 后（read 返回 EOF）
        // 进程可能尚未完全退出——exitValue() 此时抛 IllegalThreadStateException
        // （设备实测：App 被杀）。按已退出报告，或标记 -1。
        val code = try {
          proc.exitValue()
        } catch (_: IllegalThreadStateException) {
          -1
        }
        listener.onExit(code)
      }
      reader.isDaemon = true
      reader.start()
      listener.onStatus("bash 已启动（快照 Termux 环境）")
      true
    } catch (t: Throwable) {
      LogCollector.log(TAG, "console start FAILED: " + (t.message ?: t.javaClass.simpleName))
      listener.onStatus("控制台启动失败：" + (t.message ?: t.javaClass.simpleName))
      false
    }
  }

  /** 写一条命令（自动补 \n）。 */
  fun writeCommand(cmd: String) {
    val proc = process ?: return
    try {
      proc.outputStream.write((cmd + "\n").toByteArray(Charsets.UTF_8))
      proc.outputStream.flush()
    } catch (t: Throwable) {
      Log.w(TAG, "console write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** 终止会话（Activity 销毁）。 */
  fun destroy() {
    closed = true
    process?.destroy()
    process = null
  }

  companion object {
    private const val TAG = "dsh-console"
  }
}
