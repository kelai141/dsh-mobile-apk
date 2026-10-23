package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File
import java.nio.file.Files
import org.json.JSONObject

/** One process-wide endpoint. Requests read a volatile snapshot; disk is touched only at boot/bind. */
internal object EngineEndpoint {
  const val HOST = "127.0.0.1"
  const val DEFAULT_PORT = 4145
  private data class State(val preferred: Int = DEFAULT_PORT, val binding: Boolean = false, val generation: Long = 0)
  @Volatile private var state = State()
  @Volatile private var root: File? = null
  /** Only a confirmed current generation may be addressed; a saved preference is not a listener. */
  val port: Int get() = state.let { if (it.binding || it.generation <= 0) 0 else it.preferred }
  val preferredPort: Int get() = state.preferred
  val awaitingBind: Boolean get() = state.binding
  val confirmed: Boolean get() = state.let { !it.binding && it.generation > 0 }
  val authority: String get() = HOST + ":" + port
  val url: String get() = "http://" + authority

  @Synchronized fun init(context: Context) {
    if (root != null) return
    root = context.applicationContext?.filesDir ?: context.filesDir
    val file = File(root, ".engine-endpoint.json")
    val saved = runCatching {
      if (!file.isFile || file.length() > 4096 || Files.isSymbolicLink(file.toPath())) null
      else savedPort(file.readText())
    }.getOrNull()
    state = State(preferred = saved ?: DEFAULT_PORT)
  }

  /** No caller may send cookies/API requests to a candidate listener before our child reports it. */
  @Synchronized fun beginBinding() { state = state.copy(binding = true, generation = 0) }
  /** A stopped or dead child invalidates the endpoint until the next generation publishes. */
  @Synchronized fun invalidate() { state = state.copy(binding = true, generation = 0) }
  @Synchronized fun markGeneration(atMs: Long) { state = state.copy(generation = atMs) }

  /** Called only after EngineAuth has verified the current-generation, non-rotated log. */
  @Synchronized fun publishReportedPort(port: Int, generation: Long): Boolean {
    val before = state
    if (port !in 1024..65535 || generation <= 0 || before.generation != generation) return false
    if (!before.binding && before.preferred == port) return true
    state = State(port, generation = generation)
    root?.let { directory ->
      runCatching {
        val record = JSONObject().put("schema", 1).put("port", port).toString()
        SnapshotTransaction.writeTextAtomic(File(directory, ".engine-endpoint.json"), record, "引擎端口") {
          require(savedPort(it) == port)
        }
      }.onFailure { Log.w("dsh-engine", "could not persist engine endpoint: " + it.javaClass.simpleName) }
    }
    return true
  }

  internal fun savedPort(text: String): Int? = runCatching {
    val record = JSONObject(text)
    if (record.optInt("schema") != 1) null
    else (record.opt("port") as? Number)?.takeIf { it.toDouble() == it.toInt().toDouble() }
      ?.toInt()?.takeIf { it in 1024..65535 }
  }.getOrNull()

  /** A token URL must be an exact IPv4 loopback origin, never an arbitrary logged URL. */
  internal fun reportedPort(url: String): Int? = runCatching {
    val uri = java.net.URI(url)
    if (uri.scheme != "http" || uri.host != HOST || uri.rawUserInfo != null ||
      uri.rawPath != "/" || uri.fragment != null || uri.port !in 1024..65535) null else uri.port
  }.getOrNull()
}
