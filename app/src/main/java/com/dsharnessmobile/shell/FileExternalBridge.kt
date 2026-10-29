package com.dsharnessmobile.shell

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import androidx.core.content.FileProvider
import java.io.File
import org.json.JSONObject

/**
 * 文件「外部打开 / 转发」的候选面、授权面与执行面（0.15.0）。
 *
 * 两个出口：用别的应用打开（[KIND_OPEN]）与转发出去（[KIND_SHARE]）。二者共用同一套 Uri
 * 授权、探活与选择器组装，差别只在主意图（ACTION_VIEW vs ACTION_SEND）。
 *
 * 为什么全塞进一个 chooser：ACTION_SEND 与 ACTION_VIEW 是**两套不同的接收面**（聊天工具只注册
 * SEND，编辑器只注册 VIEW），只发其中一条就会漏掉另一半应用；EXTRA_INITIAL_INTENTS 让另一条
 * 作为并列候选进同一个选择器，而不是弹两次。
 *
 * 为什么必须同时设 ClipData：FLAG_GRANT_READ_URI_PERMISSION 只对 intent 的 data 生效，对
 * EXTRA_STREAM 与 EXTRA_INITIAL_INTENTS 里的 Uri 不生效。只加 flag 不加 ClipData 是「目标应用
 * 报无法打开 / 空白」最常见的原因。
 *
 * **为什么中间隔一层 [IntentSpec]**：本仓单测开了 isReturnDefaultValues，`Uri.parse`、
 * `Intent.createChooser` 在 JVM 里直接返回 null，`intent.action`/`flags` 也读不出真值——直接对
 * Intent 断言等于对所有分支瞎绿。所以「要发几条、每条的 action/type/Uri/授权」先算成纯数据
 * （[IntentSpec]，全部 String），单测钉这一层；[toIntent] 只做无判定的格式转换。
 *
 * 安全口径与 [PathOpen] 同源：允许面 = FileIncoming.isReaderAllowed（工作区 / tmp / usr/bin /
 * 导出仓库），应用私密区（含 .credentials.yaml）永不进选择器。页面内容按不可信处理。
 */
internal object FileExternalBridge {

  /** 「用别的应用打开」：主意图 ACTION_VIEW。 */
  const val KIND_OPEN = "open"
  /** 「转发给别的应用」：主意图 ACTION_SEND。 */
  const val KIND_SHARE = "share"

  /** 目录型 Uri 的系统 MIME（文件管理器据此定位）。 */
  const val MIME_FOLDER = "resource/folder"

  // Intent 的 action 常量是编译期字符串常量，这里显式写出来便于单测断言字面值。
  private const val ACTION_VIEW = "android.intent.action.VIEW"
  private const val ACTION_SEND = "android.intent.action.SEND"

  // ── 错误码（页面据此选文案）──────────────────────────────────────────────
  /** 没有任何应用能接这个文件（探活为空）。`open` 与 `share` 共用这枚。 */
  const val ERROR_NO_RECEIVER = "no-receiver"
  /** 文件不在允许面内 / FileProvider 拒绝映射（私密区、越界、无映射）。 */
  const val ERROR_URI_DENIED = "uri-denied"
  /** 读不到文件（不存在 / 不可读 / 权限不足）。 */
  const val ERROR_IO = "io"
  /** 参数缺失（path 为空）——不并进 io：那是调用方写错，不是磁盘问题。 */
  const val ERROR_BAD_REQUEST = "bad-request"

  /** 全部错误码（单测据此断言「每个码都有文案」）。 */
  internal val ALL_ERRORS =
    listOf(ERROR_NO_RECEIVER, ERROR_URI_DENIED, ERROR_IO, ERROR_BAD_REQUEST)

  /**
   * 一次 Uri 读授权：交给目标应用的 Uri 与它的 MIME。
   *
   * @property uri 需要授权的 content Uri（文本形式）。
   * @property mime ClipData 的 MIME 标签。
   */
  internal data class Grant(val uri: String, val mime: String)

  /**
   * 一条要交给系统的意图（纯描述）。
   *
   * @property action 动作字面值（ACTION_VIEW / ACTION_SEND）。
   * @property dataUri 作为 intent data 的 Uri（null = 不设 data）。
   * @property type MIME 类型（null = 由系统按 Uri 推断）。
   * @property streamUri 作为 EXTRA_STREAM 的 Uri（ACTION_SEND 用）。
   * @property grants 这条意图必须携带的读授权；**非空即意味着 [toIntent] 会设 flag + ClipData**。
   */
  internal data class IntentSpec(
    val action: String,
    val dataUri: String?,
    val type: String?,
    val streamUri: String?,
    val grants: List<Grant>,
  )

  /**
   * 完整计划：主意图 + 并列候选。
   *
   * @property primary 交给 createChooser 的主意图。
   * @property initial 并列候选（EXTRA_INITIAL_INTENTS）。
   */
  internal data class Plan(val primary: IntentSpec, val initial: List<IntentSpec>)

  // ── 组装（纯逻辑，JVM 可测）──────────────────────────────────────────────

  /**
   * 组装「用别的应用打开」的计划。
   *
   * 主意图 = ACTION_VIEW（能打开该类型的应用）；并列候选 = 父目录定位（可授权时才有）。
   * 不把 ACTION_SEND 混进「打开」的候选：它属于 [sharePlan] 的主意图，混进来会让「打开方式」
   * 也列出只发不收的应用，用户点进去看到的是转发界面。
   *
   * @param fileUri 文件的 content Uri 文本。
   * @param mime 生效 MIME。
   * @param parentUri 父目录的 content Uri 文本；null = 父目录不可授权，**不提供**目录项。
   * @returns 主意图 + 并列候选。
   */
  internal fun openPlan(fileUri: String, mime: String, parentUri: String?): Plan {
    val primary = IntentSpec(
      action = ACTION_VIEW,
      dataUri = fileUri,
      type = mime,
      streamUri = null,
      grants = listOf(Grant(fileUri, mime)),
    )
    val initial = ArrayList<IntentSpec>()
    folderSpec(parentUri)?.let { initial.add(it) }
    return Plan(primary, initial)
  }

  /**
   * 组装「转发」的计划。
   *
   * 主意图 = ACTION_SEND + EXTRA_STREAM（聊天/邮件等只注册 SEND 的应用）；并列候选 =
   * ACTION_VIEW（编辑器/看图等只注册 VIEW 的应用）+ 父目录定位（可授权时才有）。
   *
   * @param fileUri 文件的 content Uri 文本。
   * @param mime 生效 MIME。
   * @param parentUri 父目录的 content Uri 文本；null = 不提供目录项。
   * @returns 主意图 + 并列候选。
   */
  internal fun sharePlan(fileUri: String, mime: String, parentUri: String?): Plan {
    val primary = IntentSpec(
      action = ACTION_SEND,
      dataUri = null,
      type = mime,
      streamUri = fileUri,
      grants = listOf(Grant(fileUri, mime)),
    )
    val initial = ArrayList<IntentSpec>()
    initial.add(
      IntentSpec(
        action = ACTION_VIEW,
        dataUri = fileUri,
        type = mime,
        streamUri = null,
        grants = listOf(Grant(fileUri, mime)),
      ),
    )
    folderSpec(parentUri)?.let { initial.add(it) }
    return Plan(primary, initial)
  }

  /**
   * 「定位到所在目录」这一项。
   *
   * 为什么可能返回 null：`resource/folder` 只对**目录型** Uri 有意义。文件管理器收到一个文件 Uri
   * （type=resource/folder）会打不开或显示空白。所以父目录不可授权时宁可不提供这一项，
   * 也不硬塞一个打不开的 URI。
   *
   * @param parentUri 父目录的 content Uri 文本；null = 不提供。
   * @returns 目录候选意图；null = 本文件不提供该项。
   */
  internal fun folderSpec(parentUri: String?): IntentSpec? {
    if (parentUri == null || parentUri.isBlank()) return null
    return IntentSpec(
      action = ACTION_VIEW,
      dataUri = parentUri,
      type = MIME_FOLDER,
      streamUri = null,
      grants = listOf(Grant(parentUri, MIME_FOLDER)),
    )
  }

  /**
   * 一条意图需要授权哪些 Uri。
   *
   * 单测据此断言「凡是对外给了 Uri 的意图，都必须有对应授权」——这正是用户说的
   * 「否则目标应用常报无法打开/空白」的防线。
   *
   * @param spec 待检查的意图描述。
   * @returns 该意图对外暴露的全部 Uri 文本。
   */
  internal fun exposedUris(spec: IntentSpec): List<String> =
    listOfNotNull(spec.dataUri, spec.streamUri)

  /**
   * 每个对外暴露的 Uri 是否都有对应授权（授权缺失 = 目标应用打不开）。
   *
   * @param spec 待检查的意图描述。
   * @returns true = 全部已授权。
   */
  internal fun fullyGranted(spec: IntentSpec): Boolean {
    val granted = spec.grants.map { it.uri }.toSet()
    return exposedUris(spec).all { granted.contains(it) }
  }

  // ── 探活（框架调用，只做判定）────────────────────────────────────────────

  /**
   * 探活：有哪些应用能接这条意图。
   *
   * 为什么用 queryIntentActivities 而不是 resolveActivity：resolveActivity 只回**默认**那一个，
   * 而这里要判「有没有候选」。Android 11+ 的包可见性会让未声明的应用查不到——本仓已声明
   * QUERY_ALL_PACKAGES（见 manifest），因此拿到的是真实全集。
   *
   * @param context 取 PackageManager。
   * @param spec 待探活的意图描述。
   * @returns 候选列表（可能为空）。
   */
  internal fun candidates(context: Context, spec: IntentSpec): List<ResolveInfo> = try {
    context.packageManager.queryIntentActivities(toIntent(spec), PackageManager.MATCH_DEFAULT_ONLY)
  } catch (_: Exception) {
    emptyList()
  }

  /**
   * 候选数 > 0。
   *
   * @param rows 已探活的候选列表。
   * @returns true = 至少有一个应用能接。
   */
  internal fun hasReceiver(rows: List<ResolveInfo>): Boolean = rows.isNotEmpty()

  /**
   * 探活过滤：只留下真有接收方的并列候选。
   *
   * 为什么必须过滤：把没人能接的意图塞进 EXTRA_INITIAL_INTENTS，选择器里会出现一个点了没
   * 反应的条目。用户口径「探活到才加」就是这一条。
   *
   * @param context 取 PackageManager。
   * @param specs 待过滤的并列候选。
   * @returns 过滤后的列表（保持原顺序）。
   */
  internal fun aliveSpecs(context: Context, specs: List<IntentSpec>): List<IntentSpec> =
    specs.filter { hasReceiver(candidates(context, it)) }

  /**
   * 最终判定：主意图与并列候选**合起来**有没有接收方。
   *
   * 为什么不是只看主意图：share 的主意图是 ACTION_SEND，可能一个应用都没注册，但 ACTION_VIEW
   * 有（编辑器）。这时报 no-receiver 是错的——用户在选择器里确实能选到那个应用。
   *
   * @param primaryAlive 主意图是否有接收方。
   * @param aliveInitial 过滤后的并列候选。
   * @returns true = 至少有一个可选目标。
   */
  internal fun anyReceiver(primaryAlive: Boolean, aliveInitial: List<IntentSpec>): Boolean =
    primaryAlive || aliveInitial.isNotEmpty()

  // ── 适配层（IntentSpec → 真 Intent；无判定，只做格式转换）─────────────────

  /**
   * 把 [IntentSpec] 转成真 Intent，并**按 grants 设 flag + ClipData**。
   *
   * 这层刻意不含任何判定：要发几条、授权哪些 Uri 全部在 [openPlan]/[sharePlan] 算好。
   * 因此单测钉住描述层，就等于钉住了这一层的输入。
   *
   * @param spec 意图描述。
   * @returns 可直接交给 startActivity / chooser 的 Intent。
   */
  internal fun toIntent(spec: IntentSpec): Intent {
    val intent = Intent(spec.action)
    spec.dataUri?.let { intent.data = android.net.Uri.parse(it) }
    spec.type?.let { intent.type = it }
    spec.streamUri?.let { intent.putExtra(Intent.EXTRA_STREAM, android.net.Uri.parse(it)) }
    // 每条意图各自授权：EXTRA_INITIAL_INTENTS 不继承 chooser 的授权。
    for (grant in spec.grants) {
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      intent.clipData = ClipData.newRawUri(grant.mime, android.net.Uri.parse(grant.uri))
    }
    return intent
  }

  /**
   * 组装最终交给系统的 chooser。
   *
   * chooser 自身也要 flag + ClipData：系统把授权转给用户选中的目标时读的是 chooser 这一层。
   *
   * @param plan 组装结果。
   * @param aliveInitial 过滤后的并列候选。
   * @param title 选择器标题（已本地化）。
   * @returns chooser intent。
   */
  internal fun chooser(plan: Plan, aliveInitial: List<IntentSpec>, title: String): Intent {
    val primary = toIntent(plan.primary)
    val chooser = Intent.createChooser(primary, title)
    for (grant in plan.primary.grants) {
      chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      chooser.clipData = ClipData.newRawUri(grant.mime, android.net.Uri.parse(grant.uri))
    }
    if (aliveInitial.isNotEmpty()) {
      chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, aliveInitial.map { toIntent(it) }.toTypedArray())
    }
    return chooser
  }

  // ── MIME 兜底（纯逻辑）────────────────────────────────────────────────────

  /**
   * 页面没给 mime 时按扩展名兜底。
   *
   * 为什么需要兜底：ACTION_SEND 与 ACTION_VIEW 都靠 type 匹配接收方，type 为空或星号全类型时
   * 多数应用不注册，选择器会空掉——比猜错类型更糟。命中不了才回 application/octet-stream
   * （至少 Office / 压缩包管理器会接）。
   *
   * @param fileName 文件名（可含路径，只看最后一段的扩展名）。
   * @returns 非空 MIME 字符串。
   */
  internal fun mimeForExtension(fileName: String): String {
    val dot = fileName.lastIndexOf('.')
    if (dot < 0 || dot == fileName.length - 1) return "application/octet-stream"
    return when (fileName.substring(dot + 1).lowercase()) {
      "jpg", "jpeg" -> "image/jpeg"
      "png" -> "image/png"
      "gif" -> "image/gif"
      "webp" -> "image/webp"
      "heic" -> "image/heic"
      "mp4" -> "video/mp4"
      "mov" -> "video/quicktime"
      "mp3" -> "audio/mpeg"
      "m4a" -> "audio/mp4"
      "wav" -> "audio/wav"
      "pdf" -> "application/pdf"
      "txt", "log", "md", "kt", "java", "js", "ts", "py", "sh", "css" -> "text/plain"
      "json" -> "application/json"
      "xml" -> "text/xml"
      "html", "htm" -> "text/html"
      "csv" -> "text/csv"
      "zip" -> "application/zip"
      "apk" -> "application/vnd.android.package-archive"
      "doc" -> "application/msword"
      "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      "xls" -> "application/vnd.ms-excel"
      "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      "ppt" -> "application/vnd.ms-powerpoint"
      "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      else -> "application/octet-stream"
    }
  }

  /**
   * 最终生效的 MIME：页面给的优先，空或星号则退回按扩展名推断。
   *
   * @param provided 页面传入的 mime（可能为空白）。
   * @param fileName 文件名（推断扩展名用）。
   * @returns 非空 MIME。
   */
  internal fun effectiveMime(provided: String?, fileName: String): String {
    val given = provided?.trim().orEmpty()
    // 星号类型在 ACTION_SEND/VIEW 上几乎匹配不到接收方（等于把选择器清空），按「未给」处理。
    if (given.isEmpty() || given == "*/*") return mimeForExtension(fileName)
    return given
  }

  // ── 结果与文案 ──────────────────────────────────────────────────────────

  /** 结果 JSON：成功只回 ok（与既有 PathOpen 同形，页面不需要额外字段）。 */
  internal fun okPayload(): String = JSONObject().put("ok", true).toString()

  /**
   * 结果 JSON：失败回 ok + error。
   *
   * @param error 上面四枚错误码之一。
   * @param detail 可选排查线索（不进用户文案）。
   */
  internal fun errorPayload(error: String, detail: String? = null): String {
    val json = JSONObject().put("ok", false).put("error", error)
    if (detail != null) json.put("detail", detail)
    return json.toString()
  }

  /**
   * 错误码 → 用户文案（中英双语）。
   *
   * 为什么文案放壳侧：页面只拿 code；把中文散到页面里会让同一错误在不同入口说法不同。
   *
   * @param english true = 英文。
   * @param error 错误码。
   * @returns 用户可读文案。
   */
  internal fun messageFor(english: Boolean, error: String): String = when (error) {
    ERROR_NO_RECEIVER -> pick(english, "没有能打开这个文件的应用", "No app can open this file")
    ERROR_URI_DENIED -> pick(english, "这个文件不在可分享的目录里", "This file is outside the shareable directories")
    ERROR_IO -> pick(english, "读不到这个文件（可能已被删除或移动）", "This file cannot be read (it may have been deleted or moved)")
    ERROR_BAD_REQUEST -> pick(english, "没有给出文件路径", "No file path was given")
    else -> pick(english, "无法打开这个文件", "This file cannot be opened")
  }

  /** 按语言取一句。 */
  private fun pick(english: Boolean, zh: String, en: String): String = if (english) en else zh

  // ── 执行面（碰 Activity / PackageManager / FileProvider）──────────────────

  /**
   * 执行一次「外部打开 / 转发」：校验 → 组计划 → 探活 → startActivity。
   *
   * 每步失败都回明确错误码，异常不冒到页面：
   * 1. path 为空 → bad-request；
   * 2. 文件不存在/不可读 → io；
   * 3. 不在允许面 → uri-denied（与 PathOpen 同一道门）；
   * 4. FileProvider 拒绝映射 → uri-denied；
   * 5. 探活：主意图与并列候选合起来一个都没有 → no-receiver；
   * 6. startActivity 抛异常 → no-receiver（典型 ActivityNotFoundException，系统说没人接）。
   *
   * @param activity 壳 Activity。
   * @param path 设备绝对路径。
   * @param mime 页面给的 MIME（空则按扩展名推断）。
   * @param kind [KIND_OPEN] 或 [KIND_SHARE]。
   * @param english 选择器标题语言。
   * @returns 结果 JSON 文本。
   */
  internal fun openOrShare(
    activity: MainActivity,
    path: String,
    mime: String?,
    kind: String,
    english: Boolean = false,
  ): String {
    if (path.isBlank()) return errorPayload(ERROR_BAD_REQUEST)
    val file = File(path)
    if (!file.isFile || !file.canRead()) {
      android.util.Log.w("dsh-open", kind + ": unreadable: " + path)
      return errorPayload(ERROR_IO, path)
    }
    if (!PathOpen.isChooserAllowedFor(activity, file)) {
      android.util.Log.w("dsh-open", kind + ": outside allowlist: " + path)
      return errorPayload(ERROR_URI_DENIED, path)
    }
    val fileUri = try {
      FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
    } catch (e: Exception) {
      android.util.Log.w("dsh-open", kind + ": uri failed: " + path + " -> " + e.message)
      return errorPayload(ERROR_URI_DENIED, e.message)
    }
    val effective = effectiveMime(mime, file.name)
    // 目录项只在父目录**也能授权**时才提供：否则文件管理器收到一个打不开的 Uri，
    // 宁可不给（用户口径：不要硬塞一个打不开的 URI）。
    val parentUri = file.parentFile?.let { dir ->
      if (!PathOpen.isChooserAllowedFor(activity, dir)) {
        null
      } else {
        try {
          FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", dir)
        } catch (_: Exception) {
          null
        }
      }
    }
    val plan = if (kind == KIND_SHARE) {
      sharePlan(fileUri.toString(), effective, parentUri?.toString())
    } else {
      openPlan(fileUri.toString(), effective, parentUri?.toString())
    }
    val primaryAlive = hasReceiver(candidates(activity, plan.primary))
    val aliveInitial = aliveSpecs(activity, plan.initial)
    if (!anyReceiver(primaryAlive, aliveInitial)) {
      android.util.Log.w("dsh-open", kind + ": no receiver: " + path + " mime=" + effective)
      return errorPayload(ERROR_NO_RECEIVER, effective)
    }
    val title = if (kind == KIND_SHARE) {
      pick(english, "转发到", "Share with")
    } else {
      pick(english, "打开方式", "Open with")
    }
    return try {
      activity.startActivity(chooser(plan, aliveInitial, title))
      android.util.Log.i(
        "dsh-open",
        kind + " ok: " + path + " mime=" + effective + " primary=" + primaryAlive +
          " initial=" + aliveInitial.size,
      )
      okPayload()
    } catch (e: Exception) {
      android.util.Log.w("dsh-open", kind + ": startActivity failed: " + path + " -> " + e.message)
      errorPayload(ERROR_NO_RECEIVER, e.message)
    }
  }
}