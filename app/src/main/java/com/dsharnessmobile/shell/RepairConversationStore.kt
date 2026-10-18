package com.dsharnessmobile.shell

import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** A compact reference shown in the native conversation drawer. */
internal data class RepairConversationRef(val id: String, val title: String)

/**
 * A durable repair conversation. Request history and visible events are stored
 * separately: history keeps provider responses byte-for-byte stable, while
 * events reproduce tool cards and notices without changing model context.
 */
internal data class RepairConversation(
  val id: String,
  val title: String,
  val history: JSONArray,
  val events: JSONArray,
  val modelIdentity: String? = null,
  val reasoningEffort: String? = null,
)

/** Private JSON storage for the native repair chat. No external runtime is used. */
internal object RepairConversationStore {
  private const val MAX_CONVERSATIONS = 50
  private const val INDEX_FILE = "index.json"
  private val lock = Any()

  fun list(rootDir: File): List<RepairConversationRef> = synchronized(lock) {
    readIndex(rootDir).mapNotNull { ref ->
      val id = ref.optString("id")
      if (!validId(id) || !sessionFile(rootDir, id).isFile) return@mapNotNull null
      RepairConversationRef(id, ref.optString("title").ifBlank { "修复会话" })
    }
  }

  fun create(rootDir: File, title: String = "新的修复"): RepairConversation = synchronized(lock) {
    val id = UUID.randomUUID().toString()
    val session = RepairConversation(id, title, JSONArray(), JSONArray())
    writeSession(rootDir, session)
    val refs = readIndex(rootDir).filter { it.optString("id") != id }.toMutableList()
    refs.add(0, JSONObject().put("id", id).put("title", title))
    writeIndex(rootDir, refs.take(MAX_CONVERSATIONS))
    prune(rootDir, refs.take(MAX_CONVERSATIONS))
    session
  }

  fun load(rootDir: File, id: String): RepairConversation? = synchronized(lock) {
    if (!validId(id)) return null
    val file = sessionFile(rootDir, id)
    if (!file.isFile) return null
    val root = runCatching { JSONObject(file.readText()) }.getOrNull() ?: return null
    val title = root.optString("title").ifBlank { "修复会话" }
    RepairConversation(
      id = root.optString("id").takeIf(::validId) ?: id,
      title = title,
      history = root.optJSONArray("history") ?: JSONArray(),
      events = root.optJSONArray("events") ?: JSONArray(),
      modelIdentity = root.optString("modelIdentity").takeIf { it.isNotBlank() },
      reasoningEffort = root.optString("reasoningEffort").takeIf { it.isNotBlank() },
    )
  }

  fun save(rootDir: File, session: RepairConversation) = synchronized(lock) {
    require(validId(session.id)) { "invalid conversation id" }
    writeSession(rootDir, session)
    val refs = readIndex(rootDir).filter { it.optString("id") != session.id }.toMutableList()
    refs.add(0, JSONObject().put("id", session.id).put("title", session.title))
    writeIndex(rootDir, refs.take(MAX_CONVERSATIONS))
    prune(rootDir, refs.take(MAX_CONVERSATIONS))
  }

  fun delete(rootDir: File, id: String) = synchronized(lock) {
    if (!validId(id)) return@synchronized
    sessionFile(rootDir, id).delete()
    writeIndex(rootDir, readIndex(rootDir).filter { it.optString("id") != id })
  }

  private fun validId(id: String): Boolean = id.matches(Regex("[A-Za-z0-9-]{8,80}"))

  private fun root(rootDir: File): File =
    File(rootDir, "native-repair/conversations").apply { mkdirs() }

  private fun sessionFile(rootDir: File, id: String): File {
    require(validId(id)) { "invalid conversation id" }
    return File(root(rootDir), "session-" + id + ".json")
  }

  private fun readIndex(rootDir: File): MutableList<JSONObject> {
    val file = File(root(rootDir), INDEX_FILE)
    if (!file.isFile) return mutableListOf()
    val array = runCatching { JSONArray(file.readText()) }.getOrNull() ?: return mutableListOf()
    val result = mutableListOf<JSONObject>()
    for (i in 0 until array.length()) {
      array.optJSONObject(i)?.let { result += JSONObject(it.toString()) }
    }
    return result
  }

  private fun writeIndex(rootDir: File, refs: List<JSONObject>) {
    val array = JSONArray()
    refs.forEach { array.put(JSONObject(it.toString())) }
    atomicWrite(File(root(rootDir), INDEX_FILE), array.toString())
  }

  private fun writeSession(rootDir: File, session: RepairConversation) {
    val root = JSONObject()
      .put("id", session.id)
      .put("title", session.title)
      .put("history", JSONArray(session.history.toString()))
      .put("events", JSONArray(session.events.toString()))
    session.modelIdentity?.let { root.put("modelIdentity", it) }
    session.reasoningEffort?.let { root.put("reasoningEffort", it) }
    atomicWrite(sessionFile(rootDir, session.id), root.toString())
  }

  private fun prune(rootDir: File, retained: List<JSONObject>) {
    val ids = retained.mapTo(HashSet()) { it.optString("id") }
    root(rootDir).listFiles { file -> file.name.startsWith("session-") }.orEmpty().forEach { file ->
      val id = file.name.removePrefix("session-").removeSuffix(".json")
      if (id !in ids) file.delete()
    }
  }

  private fun atomicWrite(target: File, text: String) {
    val temp = File(target.parentFile, target.name + ".tmp")
    temp.writeText(text)
    if (!temp.renameTo(target)) {
      target.writeText(text)
      temp.delete()
    }
  }
}
