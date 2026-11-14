package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import android.os.Looper
import android.os.Process
import android.system.Os
import android.system.OsConstants
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** 同 UID 私有执行宿主。生命周期由壳持有，Node 只通过 socket 调用。 */
internal class NativeControlHost private constructor(
  private val server: NativeControlSocketServer,
  val endpoint: File,
  val initialization: JSONObject,
) : AutoCloseable {
  override fun close() = server.close()

  companion object {
    /** 初始化和 journal 恢复会访问磁盘；调用方必须使用后台线程。 */
    fun open(
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
          override fun readImage(callId: String) = NativeControlCore.readImage(callId)
        },
        facts = facts,
        platform = platform,
      )
      val server = NativeControlSocketServer(app, object : NativeControlSocketServer.Handler {
        override fun handle(request: JSONObject, cancellation: NativeControlSocketServer.Cancellation): JSONObject {
          if (request.optString("method") == "execute")
            com.dsharnessmobile.shell.EngineService.instance?.noteWakeActivity()
          return dispatcher.handle(request, cancellation)
        }
      })
      return try {
        NativeControlHost(server, server.start(), initialized)
      } catch (failure: Throwable) {
        server.close()
        throw failure
      }
    }

    /** 仪器测试沿用显式隔离入口；实现与壳侧宿主一致。 */
    fun openIsolated(
      context: Context,
      facts: NativeControlDispatcher.Facts,
      platform: NativeControlDispatcher.Platform,
    ): NativeControlHost = open(context, facts, platform)

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
