package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.Executors

/** Persists the manifest asset queue before downloading and resumes it when the engine service returns. */
internal object LinuxInstallJob {
  private class NodeStageRequired : Exception("The shared Node asset needs preparation")

  private const val NAME = "install-job.json"
  private val lock = Any()
  private val worker = Executors.newSingleThreadExecutor()
  private var running = false
  private var automaticScheduled = false

  fun enqueue(context: Context, raw: String): String = synchronized(lock) {
    val path = path(context)
    val old = read(path)
    if (running || old?.optString("state") in listOf("queued", "paused", "installing")) {
      return@synchronized JSONObject().put("ok", false).put("code", "linux-install-busy").toString()
    }
    val job = runCatching { parse(raw) }.getOrElse {
      return@synchronized JSONObject().put("ok", false).put("code", "linux-install-invalid").toString()
    }
    AtomicFileReplace.writeText(path, job.toString())
    resumePending(context)
    JSONObject().put("ok", true).toString()
  }

  private fun parse(raw: String): JSONObject {
    require(raw.length <= 16_384)
    val input = JSONObject(raw)
    val runtimeId = input.getString("runtimeId")
    val version = input.getString("version")
    val assets = input.getJSONArray("assets")
    require(runtimeId.matches(Regex("[a-z0-9][a-z0-9-]{0,79}")))
    require(version.matches(Regex("[0-9][a-zA-Z0-9.+-]{0,79}")))
    require(assets.length() in 1..4)
    for (i in 0 until assets.length()) {
      val item = assets.getJSONObject(i)
      val kind = LinuxAssetIO.Kind.parse(item.getString("kind")) ?: error("Unrecognized asset kind")
      val spec = LinuxAssetIO.Spec(item.getString("url"), item.getString("sha256"), item.getLong("size"),
        kind, item.optString("source", "official"))
      require(LinuxAssetIO.specVerdict(spec) == null && LinuxAssetIO.urlVerdict(spec.url) == null)
    }
    return JSONObject().put("runtimeId", runtimeId).put("version", version).put("assets", assets)
      .put("sharedNodeReuse", input.optBoolean("sharedNodeReuse"))
      .put("index", 0).put("state", "queued")
  }

  fun scheduleAutomaticUpdate(context: Context) = synchronized(lock) {
    if (automaticScheduled || !path(context).parentFile!!.isDirectory) return@synchronized
    automaticScheduled = true
    val app = context.applicationContext
    worker.execute {
      runCatching {
        repeat(12) {
          val status = statusFromEngine(app, "status")
          if (!status.optBoolean("installed") || !status.optBoolean("autoUpdate") || !status.optBoolean("enabled")) return@runCatching
          if (status.optBoolean("busy")) { Thread.sleep(1_000); return@repeat }
          if (!status.optBoolean("updateAvailable")) return@runCatching
          val runtimeId = status.optString("runtimeId")
          val manifest = statusFromEngine(app, "manifest").getJSONObject("manifest")
          val runtimes = manifest.getJSONArray("runtimes")
          val runtime = (0 until runtimes.length()).map(runtimes::getJSONObject)
            .firstOrNull { it.optString("id") == runtimeId } ?: return@runCatching
          val old = synchronized(lock) { read(path(app)) }
          if (old?.optString("state") == "failed" && old.optString("version") == manifest.optString("version")) return@runCatching
          val source = old?.optJSONArray("assets")?.optJSONObject(0)?.optString("source", "auto") ?: "auto"
          val assets = JSONArray()
          val entries = listOf(
            "plugin" to manifest.getJSONObject("plugins").getJSONObject("runtime"),
            "backend" to runtime.getJSONObject("backendAsset"),
            "rootfs" to runtime.getJSONObject("rootfsAsset"),
            "node" to runtime.getJSONObject("nodeAsset"),
          )
          for ((kind, asset) in entries) {
            if (kind == "rootfs" && runtime.optBoolean("rootfsCandidateHandoff")) asset.put("rootfsCandidate", true)
            assets.put(asset.put("kind", kind).put("source", source))
          }
          enqueue(app, JSONObject().put("version", manifest.getString("version"))
            .put("runtimeId", runtimeId).put("sharedNodeReuse", runtime.optBoolean("sharedNodeReuse"))
            .put("assets", assets).toString())
          return@runCatching
        }
      }.onFailure { android.util.Log.w("dsh-linux-install", "Automatic Linux update check failed", it) }
    }
  }

  fun status(context: Context): String = synchronized(lock) {
    val job = read(path(context)) ?: return@synchronized "{}"
    val progress = JSONObject(LinuxAssetPrepare.status())
    val assets = job.getJSONArray("assets")
    val index = job.getInt("index")
    val spec = assets.optJSONObject(index)
    JSONObject().put("state", job.optString("state")).put("error", job.optString("error"))
      .put("index", index + 1).put("total", assets.length()).put("kind", spec?.optString("kind"))
      .put("progress", if (spec?.optString("sha256") == progress.optString("sha256")) progress else JSONObject())
      .toString()
  }

  fun pause(context: Context): Boolean = synchronized(lock) {
    val path = path(context)
    val job = read(path) ?: return@synchronized false
    if (job.optString("state") != "queued") return@synchronized false
    if (!LinuxAssetPrepare.pause()) return@synchronized false
    save(path, job, "paused")
    true
  }

  fun retry(context: Context): Boolean = synchronized(lock) {
    val path = path(context)
    val job = read(path) ?: return@synchronized false
    if (job.optString("state") !in listOf("paused", "failed")) return@synchronized false
    save(path, job, "queued")
    if (running) {
      // The worker waits for the current transfer to acknowledge the pause.
      return@synchronized true
    }
    resumePending(context)
    true
  }

  fun resumePending(context: Context): Unit = synchronized(lock) {
    val app = context.applicationContext
    val path = path(app)
    val job = read(path) ?: return@synchronized
    if (running || job.optString("state") !in listOf("queued", "installing")) return@synchronized
    running = true
    worker.execute {
      try {
        perform(app, path, job)
      } catch (error: Exception) {
        synchronized(lock) { save(path, job, "failed", error.message ?: error.javaClass.simpleName) }
      } finally {
        synchronized(lock) {
          running = false
          LinuxDownloadNotification.show(null, 0, 0)
          resumePending(app)
        }
      }
    }
  }

  private fun perform(app: Context, path: File, job: JSONObject) {
    val assets = job.getJSONArray("assets")
    val version = job.getString("version")
    val runtimeId = job.getString("runtimeId")
    fun installed(status: JSONObject): Boolean =
      status.optBoolean("installed") && status.optString("version") == version && status.optString("runtimeId") == runtimeId

    val rootfsIndex = (0 until assets.length()).firstOrNull { assets.getJSONObject(it).optBoolean("rootfsCandidate") }
    var index = job.getInt("index")
    if (rootfsIndex != null && index > rootfsIndex) {
      // Activation may have committed or consumed the one-use directory before the last checkpoint.
      if (installed(statusFromEngine(app, "status"))) {
        synchronized(lock) { save(path, job, "done") }
        return
      }
      val id = job.optString("rootfsCandidate")
      if (!LinuxAssetPrepare.hasCandidate(app.filesDir, id)) {
        index = rootfsIndex
        job.remove("rootfsCandidate")
      }
    }
    var deferredNode: Int? = null
    for (i in index until assets.length()) {
      val asset = assets.getJSONObject(i)
      val canReuse = i == assets.length() - 1 && asset.optString("kind") == "node" && job.optBoolean("sharedNodeReuse") && job.has("rootfsCandidate")
      val node = if (canReuse) statusFromEngine(app, "status").optJSONObject("runtime") else null
      if (node?.optBoolean("healthy") == true && node.optString("nodeAssetSha256") == asset.getString("sha256")) {
        deferredNode = i
        break
      }
      while (true) {
        if (synchronized(lock) { read(path)?.optString("state") == "paused" }) return
        val response = JSONObject(LinuxAssetPrepare.start(app.filesDir, asset.toString(), app.cacheDir))
        if (!response.optBoolean("ok")) error(response.optString("detail", response.optString("code")))
        var result: JSONObject
        do {
          Thread.sleep(300)
          result = JSONObject(LinuxAssetPrepare.status())
        } while (result.optString("phase") == "running")
        when (result.optString("phase")) {
          "ok" -> {
            check(result.optString("sha256") == asset.getString("sha256")) { "Prepared asset changed" }
            if (asset.optBoolean("rootfsCandidate")) {
              val candidate = response.getString("rootfsCandidate")
              check(result.getString("rootfsCandidate") == candidate) { "Prepared rootfs candidate changed" }
              job.put("rootfsCandidate", candidate)
            }
            break
          }
          "paused" -> continue
          else -> error(result.optString("detail", "Linux download failed"))
        }
      }
      synchronized(lock) {
        job.put("index", i + 1)
        save(path, job, "queued")
      }
    }
    synchronized(lock) { save(path, job, "installing") }
    LinuxDownloadNotification.show("installing", 0, 0)
    if (!installed(statusFromEngine(app, "status"))) {
      val install = JSONObject().put("confirmed", true).put("runtimeId", runtimeId).put("expectedVersion", version)
      if (job.has("rootfsCandidate")) install.put("rootfsCandidate", job.getString("rootfsCandidate"))
      try {
        check(installed(statusFromEngine(app, "install", install))) { "Linux did not install the selected runtime and release" }
      } catch (miss: NodeStageRequired) {
        if (deferredNode == null) throw miss
        synchronized(lock) {
          job.put("sharedNodeReuse", false).put("index", deferredNode)
          save(path, job, "queued")
        }
        return
      }
    }
    synchronized(lock) { save(path, job, "done") }
  }

  private fun statusFromEngine(app: Context, action: String, payload: JSONObject? = null): JSONObject {
    repeat(20) {
      if (!EngineEndpoint.confirmed || (EngineAuth.cookie(app) ?: EngineAuth.refresh(app)) == null) {
        Thread.sleep(500)
        return@repeat
      }
      val connection = URL(EngineEndpoint.url + "/api/android/linux-environment/" + action)
        .openConnection(Proxy.NO_PROXY) as HttpURLConnection
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 3000
      connection.readTimeout = 25 * 60_000
      try {
        EngineAuth.attach(app, connection)
        if (payload != null) {
          connection.requestMethod = "POST"
          connection.doOutput = true
          connection.setRequestProperty("Content-Type", "application/json")
          connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
        }
        val code = connection.responseCode
        if (code in 200..299) return JSONObject(connection.inputStream.bufferedReader().use { input -> input.readText() })
        val detail = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (code == 409 && runCatching { JSONObject(detail).optString("reason") }.getOrNull() == "linux-node-stage-required") {
          throw NodeStageRequired()
        }
        if (code != 503 && code != 401) error(detail.ifEmpty { "Linux installation returned HTTP $code" })
      } finally {
        connection.disconnect()
      }
      Thread.sleep(500)
    }
    error("DSH engine is unavailable")
  }

  private fun path(context: Context) = File(File(context.filesDir, LinuxAssetIO.ENV_DIR), NAME)
  private fun read(path: File): JSONObject? = runCatching { JSONObject(path.readText()) }.getOrNull()
  private fun save(path: File, job: JSONObject, state: String, error: String = "") {
    AtomicFileReplace.writeText(path, job.put("state", state).put("error", error).toString())
  }
}
