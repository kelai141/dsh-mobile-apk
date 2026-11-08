package com.dsharnessmobile.shell

import android.app.AlertDialog
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.view.View
import android.webkit.MimeTypeMap
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.Locale
import java.util.UUID

/** Public folders only. Return URIs of explicit cache copies, never expose the storage root. */
internal class LegacyAttachmentPicker(
  private val activity: MainActivity,
  private val accept: List<String>,
  private val multiple: Boolean,
  private val requestPermission: () -> Unit,
  private val openSystem: () -> Unit,
  private val deliver: (List<Uri>) -> Unit,
) {
  private val root = Environment.getExternalStorageDirectory().canonicalFile
  private var current = File(root, Environment.DIRECTORY_DOWNLOADS).takeIf { it.isDirectory } ?: root
  private var rows = emptyList<File>()
  private val selected = linkedSetOf<File>()
  private var closed = false
  private var loading = false
  private var generation = 0
  private lateinit var dialog: AlertDialog
  private lateinit var status: TextView
  private lateinit var path: TextView
  private lateinit var parentButton: Button
  private lateinit var allow: Button
  private lateinit var adapter: ArrayAdapter<String>
  private val zh = activity.resources.configuration.locales[0].language == "zh"

  private fun tr(chinese: String, english: String) = if (zh) chinese else english
  private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()

  fun show() {
    path = TextView(activity)
    status = TextView(activity)
    parentButton = Button(activity).apply {
      text = tr("上一级", "Parent folder")
      setOnClickListener { current.parentFile?.takeIf(::inPublicRoot)?.let(::showFolder) }
    }
    allow = Button(activity).apply {
      text = tr("允许访问公共存储", "Allow storage access")
      visibility = View.GONE
      setOnClickListener { requestPermission() }
    }
    adapter = ArrayAdapter(activity, android.R.layout.simple_list_item_1)
    val list = ListView(activity).apply {
      adapter = this@LegacyAttachmentPicker.adapter
      setOnItemClickListener { _, _, position, _ ->
        val file = rows.getOrNull(position) ?: return@setOnItemClickListener
        if (loading) return@setOnItemClickListener
        when {
          file.isDirectory -> showFolder(file)
          !multiple -> finishWith(listOf(file))
          selected.remove(file) -> render()
          selected.size < MAX_FILES -> { selected.add(file); render() }
          else -> status.text = tr("最多选择 32 个文件。", "Select up to 32 files.")
        }
      }
    }
    val content = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(18), dp(6), dp(18), 0)
      addView(path)
      addView(parentButton)
      addView(status)
      addView(allow)
      addView(list, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
      minimumHeight = dp(280)
    }
    dialog = AlertDialog.Builder(activity)
      .setTitle(tr("选择附件", "Choose attachments"))
      .setView(content)
      .setNegativeButton(tr("取消", "Cancel")) { _, _ -> finishEmpty() }
      .setNeutralButton(tr("系统文件选择器", "System picker")) { _, _ ->
        closed = true
        openSystem()
      }
      .apply { if (multiple) setPositiveButton(tr("添加", "Add"), null) }
      .setOnCancelListener { finishEmpty() }
      .create()
    dialog.show()
    dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener { finishWith(selected.toList()) }
    showFolder(current)
  }

  fun refresh() {
    if (!closed && ::dialog.isInitialized && dialog.isShowing) showFolder(current)
  }

  private fun inPublicRoot(file: File): Boolean {
    val target = file.path
    val privateTree = File(root, "Android").path
    return WorkspacePickGate.isSharedStoragePath(target, root.path) &&
      target != privateTree && !target.startsWith(privateTree + File.separator)
  }

  private fun showFolder(folder: File) {
    val ticket = ++generation
    current = folder
    path.text = if (folder == root) tr("公共存储", "Public storage") else folder.path
    loading = true
    render()
    status.text = tr("正在读取文件…", "Loading files…")
    Thread {
      val result = runCatching {
        val canonical = folder.canonicalFile
        if (!inPublicRoot(canonical)) throw IOException()
        Files.newDirectoryStream(canonical.toPath()).use { entries ->
          entries.asSequence().take(MAX_SCAN).map { it.toFile() }
            .filter { !it.name.startsWith('.') && !(folder == root && it.name == "Android") }
            .filter { !Files.isSymbolicLink(it.toPath()) && (it.isDirectory || (it.isFile && matches(it, accept))) }
            .take(MAX_ENTRIES).toList()
            .sortedWith(compareBy<File> { !it.isDirectory }.thenBy { it.name.lowercase(Locale.ROOT) })
        }
      }
      activity.runOnUiThread {
        if (!dialog.isShowing || closed || ticket != generation) return@runOnUiThread
        loading = false
        rows = result.getOrNull().orEmpty()
        allow.visibility = if (result.isFailure && !hasReadPermission(activity)) View.VISIBLE else View.GONE
        status.text = when {
          result.isFailure -> tr("无法读取此目录。可授权、换个目录，或使用系统选择器。",
            "Cannot read this folder. Allow access, change folders, or use the system picker.")
          rows.isEmpty() -> tr("没有符合条件的文件。", "No matching files.")
          rows.size == MAX_ENTRIES -> tr("只显示前 500 项。", "Showing the first 500 entries.")
          else -> ""
        }
        render()
      }
    }.start()
  }

  private fun render() {
    parentButton.isEnabled = current != root && !loading
    adapter.clear()
    adapter.addAll(rows.map { file ->
      if (file.isDirectory) file.name + " /" else if (file in selected) "✓ " + file.name else file.name
    })
    dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.let { button ->
      button.text = tr("添加", "Add") + if (selected.isEmpty()) "" else " (" + selected.size + ")"
      button.isEnabled = !loading && selected.isNotEmpty()
    }
  }

  private fun finishEmpty() {
    if (closed) return
    closed = true
    deliver(emptyList())
  }

  private fun finishWith(files: List<File>) {
    if (loading || closed || files.isEmpty()) return
    loading = true
    render()
    status.text = tr("正在准备附件…", "Preparing attachments…")
    Thread {
      val result = runCatching { stage(files) }
      activity.runOnUiThread {
        if (!dialog.isShowing || closed) return@runOnUiThread
        loading = false
        result.onSuccess {
          closed = true
          dialog.dismiss()
          deliver(it)
        }.onFailure {
          status.text = tr("无法读取附件，或所选文件合计超过 100 MB。请重选。",
            "Could not read the files, or they exceed 100 MB in total. Choose again.")
          render()
        }
      }
    }.start()
  }

  private fun stage(files: List<File>): List<Uri> {
    val cache = File(activity.cacheDir, "legacy-uploads")
    cache.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > CACHE_TTL }?.forEach { it.deleteRecursively() }
    val batch = File(cache, UUID.randomUUID().toString())
    if (!batch.mkdirs()) throw IOException()
    var left = MAX_BYTES
    try {
      return files.mapIndexed { index, source ->
        val canonical = source.canonicalFile
        if (!inPublicRoot(canonical) || !canonical.isFile || canonical.length() > left) throw IOException()
        val sub = File(batch, index.toString())
        if (!sub.mkdir()) throw IOException()
        val copy = File(sub, source.name)
        canonical.inputStream().use { input ->
          copy.outputStream().use { output ->
            val buffer = ByteArray(32 * 1024)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              left -= count
              if (left < 0) throw IOException()
              output.write(buffer, 0, count)
            }
          }
        }
        FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", copy)
      }
    } catch (failure: Exception) {
      batch.deleteRecursively()
      throw failure
    }
  }

  companion object {
    private const val MAX_ENTRIES = 500
    private const val MAX_SCAN = 10_000
    private const val MAX_FILES = 32
    private const val MAX_BYTES = 100_000_000L
    private const val CACHE_TTL = 60 * 60 * 1000L

    fun hasReadPermission(context: Context) = context.checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED

    private fun matches(file: File, accept: List<String>): Boolean {
      if (accept.isEmpty()) return true
      val ext = file.extension.lowercase(Locale.ROOT)
      val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
      return accept.any { token ->
        val pattern = token.lowercase(Locale.ROOT)
        pattern == "*/*" || pattern == mime ||
          (pattern.startsWith(".") && file.name.lowercase(Locale.ROOT).endsWith(pattern)) ||
          (pattern.endsWith("/*") && mime.startsWith(pattern.dropLast(1)))
      }
    }
  }
}
