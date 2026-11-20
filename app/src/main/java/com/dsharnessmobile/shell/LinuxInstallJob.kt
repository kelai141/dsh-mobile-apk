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
    var candidateIndex: Int? = null
    for (i in 0 until assets.length()) {
      val item = assets.getJSONObject(i)
      val kind = LinuxAssetIO.Kind.parse(item.getString("kind")) ?: error("Unrecognized asset kind")
      val spec = LinuxAssetIO.Spec(item.getString("url"), item.getString("sha256"), item.getLong("size"),
        kind, item.optString("source", "official"))
      require(LinuxAssetIO.specVerdict(spec) == null && LinuxAssetIO.urlVerdict(spec.url) == null)
      if (item.opt("rootfsCandidate") == true) {
        require(kind == LinuxAssetIO.Kind.ROOTFS && candidateIndex == null)
        candidateIndex = i
      }
    }
    return JSONObject().put("runtimeId", runtimeId).put("version", version).put("assets", assets)
      .put("candidateIndex", candidateIndex).put("index", 0).put("state", "queued")
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
            val prepared = asset.put("kind", kind).put("source", source)
            if (kind == "rootfs" && runtime.opt("rootfsCandidateHandoff") == true) prepared.put("rootfsCandidate", true)
            assets.put(prepared)
          }
          enqueue(app, JSONObject().put("version", manifest.getString("version"))
            .put("runtimeId", runtimeId).put("assets", assets).toString())
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
    val candidateIndex = job.optInt("candidateIndex", -1)
    if (candidateIndex >= 0 && job.getInt("index") > candidateIndex) {
      // A restarted or retried job can have a consumed or expired receipt.
      if (job.optString("state") == "installing" && statusFromEngine(app, "status").optString("version") == version) {
        synchronized(lock) { save(path, job, "done") }
        return
      }
      synchronized(lock) {
        job.put("index", candidateIndex).remove("rootfsCandidate")
        save(path, job, "queued")
      }
    }
    for (index in job.getInt("index") until assets.length()) {
      val asset = assets.getJSONObject(index)
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
            check(result.optString("sha256") == asset.getString("sha256")) { "The prepared asset changed" }
            if (index == candidateIndex) {
              val id = response.getString("rootfsCandidate")
              check(result.optString("rootfsCandidate") == id) { "The prepared rootfs candidate changed" }
              job.put("rootfsCandidate", id)
            }
            break
          }
          "paused" -> continue
          else -> error(result.optString("detail", "Linux download failed"))
        }
      }
      synchronized(lock) {
        job.put("index", index + 1)
        save(path, job, "queued")
      }
    }
    synchronized(lock) { save(path, job, "installing") }
    LinuxDownloadNotification.show("installing", 0, 0)
    var response = statusFromEngine(app, "status")
    if (response.optString("version") != version) {
      val install = JSONObject().put("confirmed", true).put("runtimeId", job.getString("runtimeId"))
        .put("expectedVersion", version)
      if (candidateIndex >= 0) install.put("rootfsCandidate", job.getString("rootfsCandidate"))
      response = statusFromEngine(app, "install", install)
      check(response.optString("version") == version) { "Linux did not install the selected release" }
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
