package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import android.os.Looper
import android.os.Process
import android.system.Os
import android.system.OsConstants
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** 隔离入口。尚未注册到 Application、Manifest、WebView bridge 或旧控制轮询。 */
internal class NativeControlHost private constructor(
  private val server: NativeControlSocketServer,
  val endpoint: File,
  val initialization: JSONObject,
) : AutoCloseable {
  override fun close() = server.close()

  companion object {
    /** 初始化和 journal 恢复会访问磁盘；调用方必须使用后台线程。 */
    fun openIsolated(
      context: Context,
      facts: NativeControlDispatcher.Facts,
      platform: NativeControlDispatcher.Platform,
    ): NativeControlHost {
      check(Looper.myLooper() != Looper.getMainLooper()) { "native-initialize-on-main-thread" }
      val app = context.applicationContext
      val base = privateDirectory(app.filesDir.canonicalFile, ".native-control")
      val state = privateDirectory(base, "state")
      val initialized = JSONObject(NativeControlCore.initialize(state.absolutePath, Process.myUid()))
      if (!initialized.optBoolean("ok") || !initialized.optBoolean("identityVerified")) {
        throw IOException("native-initialize-failed:${initialized.optString("code")}")
      }
      val dispatcher = NativeControlDispatcher(
        core = object : NativeControlDispatcher.Core {
          override fun exchange(request: JSONObject) = JSONObject(NativeControlCore.exchange(request.toString()))
          override fun fastExchange(request: JSONObject) = JSONObject(NativeControlCore.exchangeNonblocking(request.toString()))
        },
        facts = facts,
        platform = platform,
      )
      val server = NativeControlSocketServer(app, dispatcher)
      return try {
        NativeControlHost(server, server.start(), initialized)
      } catch (failure: Throwable) {
        server.close()
        throw failure
      }
    }

    private fun privateDirectory(parent: File, name: String): File {
      val directory = File(parent, name)
      if (!directory.exists() && !directory.mkdir()) throw IOException("native-directory-create-failed")
      val metadata = Os.lstat(directory.absolutePath)
      if (!OsConstants.S_ISDIR(metadata.st_mode) || metadata.st_uid != Process.myUid() ||
        directory.canonicalFile != directory.absoluteFile) throw IOException("native-directory-invalid")
      Os.chmod(directory.absolutePath, 448)
      return directory
    }
  }
}
