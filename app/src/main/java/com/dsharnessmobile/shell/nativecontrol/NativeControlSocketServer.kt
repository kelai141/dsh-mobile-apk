package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import android.system.Os
import android.system.OsConstants
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 本应用私有的 Unix socket 传输。它不选通道、不推断权限，不持有控制状态。
 * 当前未接生产启动路径；只有宿主完成 Rust 初始化后才可显式启动。
 */
internal class NativeControlSocketServer(
  context: Context,
  private val handler: Handler,
  private val socketName: String = "control-v1.sock",
) : AutoCloseable {
  interface Handler {
    fun handle(request: JSONObject, cancellation: Cancellation): JSONObject
    fun cancel(callId: String)
  }

  class Cancellation internal constructor() {
    private val cancelled = AtomicBoolean(false)
    fun isCancelled(): Boolean = cancelled.get()
    internal fun cancel(): Boolean = cancelled.compareAndSet(false, true)
  }

  private val app = context.applicationContext
  private val appUid = Process.myUid()
  private val stopped = AtomicBoolean(false)
  private val started = AtomicBoolean(false)
  private val active = ConcurrentHashMap<LocalSocket, Pair<Cancellation, String?>>()
  private val workers = ThreadPoolExecutor(
    2, 2, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue(4),
    { runnable -> Thread(runnable, "native-control-rpc").apply { isDaemon = true } },
    ThreadPoolExecutor.AbortPolicy(),
  )
  private val timer = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "native-control-deadline").apply { isDaemon = true }
  }
  private var boundSocket: LocalSocket? = null
  private var server: LocalServerSocket? = null
  private var socketFile: File? = null
  private var socketInode: Long? = null

  /** 返回应用私有路径，供宿主写入同 UID 可读的端点文件。 */
  fun start(): File {
    check(started.compareAndSet(false, true)) { "native-server-already-started" }
    check(!stopped.get()) { "native-server-closed" }
    return try { bind() } catch (failure: Throwable) {
      close()
      throw failure
    }
  }

  private fun bind(): File {
    require(socketName.matches(Regex("[a-z0-9-]{1,32}\\.sock"))) { "invalid-socket-name" }
    val parent = app.filesDir.canonicalFile
    val directory = File(parent, ".native-control")
    if (!directory.exists() && !directory.mkdir()) throw IOException("native-directory-create-failed")
    val info = Os.lstat(directory.absolutePath)
    if (!OsConstants.S_ISDIR(info.st_mode) || info.st_uid != appUid || directory.canonicalFile != directory.absoluteFile) {
      throw IOException("native-directory-invalid")
    }
    Os.chmod(directory.absolutePath, 448) // 0700，目录仅供应用 UID 使用。
    val file = File(directory, socketName)
    if (file.absolutePath.toByteArray(Charsets.UTF_8).size >= 104) throw IOException("native-socket-path-too-long")
    if (file.exists() || java.nio.file.Files.isSymbolicLink(file.toPath())) {
      val old = Os.lstat(file.absolutePath)
      if (!OsConstants.S_ISSOCK(old.st_mode) || old.st_uid != appUid) throw IOException("native-socket-path-invalid")
      val probe = LocalSocket()
      try {
        probe.connect(LocalSocketAddress(file.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
        throw IOException("native-server-already-running")
      } catch (failure: IOException) {
        if (failure.message == "native-server-already-running") throw failure
        if (failure.message?.contains("ECONNREFUSED") != true && failure.message?.contains("ENOENT") != true) throw failure
      } finally {
        probe.close()
      }
      if (!file.delete()) throw IOException("native-stale-socket-remove-failed")
    }
    val binding = LocalSocket()
    try {
      binding.bind(LocalSocketAddress(file.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
      socketFile = file
      socketInode = Os.lstat(file.absolutePath).st_ino
      Os.chmod(file.absolutePath, 384) // 0600；仍须在 accept 后核对真实 peer UID。
      val listener = LocalServerSocket(binding.fileDescriptor)
      boundSocket = binding
      server = listener
      Thread({ acceptLoop(listener) }, "native-control-accept").apply { isDaemon = true; start() }
      return file
    } catch (failure: Throwable) {
      runCatching { binding.close() }
      throw failure
    }
  }

  private fun acceptLoop(listener: LocalServerSocket) {
    while (!stopped.get()) {
      val connection = try { listener.accept() } catch (_: IOException) { break }
      val trusted = runCatching { connection.peerCredentials.uid == appUid }.getOrDefault(false)
      if (!trusted) {
        runCatching { connection.close() }
        continue
      }
      val cancellation = Cancellation()
      active[connection] = cancellation to null
      try {
        workers.execute { serve(connection, cancellation) }
      } catch (_: RejectedExecutionException) {
        active.remove(connection)
        runCatching { connection.close() }
      }
    }
  }

  private fun serve(socket: LocalSocket, cancellation: Cancellation) {
    var callId: String? = null
    var handlerEntered = false
    var deadline: java.util.concurrent.ScheduledFuture<*>? = null
    try {
      socket.soTimeout = 5000
      if (stopped.get() || cancellation.isCancelled()) return
      val request = NativeControlFrames.readRequest(socket.inputStream)
      callId = (request.opt("callId") as? String)
      active[socket] = cancellation to callId
      val timeout = request.optInt("timeoutMs", 15_000)
      deadline = timer.schedule({
        if (cancellation.cancel()) callId?.let { runCatching { handler.cancel(it) } }
        runCatching { socket.close() }
      }, timeout.toLong(), TimeUnit.MILLISECONDS)
      if (stopped.get() || cancellation.isCancelled()) return
      handlerEntered = true
      val response = handler.handle(request, cancellation)
      if (!cancellation.isCancelled()) NativeControlFrames.writeResponse(socket.outputStream, response)
    } catch (failure: NativeControlFrames.WireException) {
      if (handlerEntered && cancellation.cancel()) callId?.let { runCatching { handler.cancel(it) } }
      runCatching { NativeControlFrames.writeResponse(socket.outputStream, rejection(failure.code, handlerEntered)) }
    } catch (_: IOException) {
      if (cancellation.cancel()) callId?.let { runCatching { handler.cancel(it) } }
    } catch (_: Exception) {
      if (cancellation.cancel()) callId?.let { runCatching { handler.cancel(it) } }
      runCatching { NativeControlFrames.writeResponse(socket.outputStream, rejection("native-request-failed", handlerEntered)) }
    } finally {
      deadline?.cancel(false)
      active.remove(socket)
      runCatching { socket.close() }
    }
  }

  private fun rejection(code: String, uncertain: Boolean = false): JSONObject = JSONObject()
    .put("protocolVersion", NativeControlFrames.PROTOCOL_VERSION)
    .put("ok", false).put("code", code).put("executed", if (uncertain) "unknown" else "no")
    .put("screenId", JSONObject.NULL)

  override fun close() {
    if (!stopped.compareAndSet(false, true)) return
    active.forEach { (socket, state) ->
      if (state.first.cancel()) state.second?.let { runCatching { handler.cancel(it) } }
      runCatching { socket.close() }
    }
    runCatching { server?.close() }
    runCatching { boundSocket?.close() }
    workers.shutdownNow()
    timer.shutdownNow()
    val file = socketFile ?: return
    runCatching {
      val current = Os.lstat(file.absolutePath)
      if (OsConstants.S_ISSOCK(current.st_mode) && current.st_uid == appUid && current.st_ino == socketInode) file.delete()
    }
  }
}
