package com.dsharnessmobile.shell

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * 功能 B（0.14.6）：启动页「分享诊断包」——把必要日志与诊断打成 ZIP，交系统分享面板。
 *
 * 设计要点（逐条对应规格 B1-B7 与 Lead 裁决）：
 *
 *  - **引擎无关**（B3）：本对象不调用 EngineManager / 引擎 HTTP，只读文件与 logcat。
 *    引擎起不来时同样可用（现场最需要它的正是那一刻）。
 *  - **白名单打包**（B4）：只收 [candidateFiles] 明确点名的几份日志/诊断，不做目录遍历。
 *    应用私有区里的配置与凭据（.dsh 配置、凭据文件、settings.yaml、工作区、会话内容）
 *    **结构上不在候选清单里**，同时另有单测断言 ZIP 条目名不含它们。
 *  - **单出口脱敏**（B4）：所有文本条目都必须经 [LogSanitizer.sanitizeOrNull]；
 *    返回 null（fail-closed）= 丢弃该条目并在 manifest 里写 sanitize-failed，绝不原样写入。
 *  - **未点击不发送**（B5）：本对象只在 [shareFromGuide] 被**用户点击**后执行，
 *    没有任何自动调用点、没有后台任务、没有定时器。
 *  - **如实标注**（B6）：manifest.txt 逐条写 present / absent / truncated / read-failed /
 *    sanitize-failed，缺失就是缺失，不留空。压缩失败删除半截临时文件并如实回执。
 *  - **不新增确认步骤**（B7）：点一下即出系统分享面板，中间不弹二次确认框。
 */
internal object LogShare {

  private const val TAG = "dsh-log-share"

  /** 包体落点（cacheDir 下；FileProvider 最窄映射见 res/xml/file_paths.xml）。 */
  const val DIR_NAME = "log-share"

  /** ZIP 的 MIME（系统据此列出可接收应用）。 */
  const val MIME_ZIP = "application/zip"

  /** 单个条目上限：防止某一份日志爆掉整包（超出即截断并如实标注）。 */
  internal const val MAX_ENTRY_BYTES = 2 * 1024 * 1024

  /** 整包上限（脱敏后文本合计；超出即停止收录并如实标注）。 */
  internal const val MAX_TOTAL_BYTES = 12 * 1024 * 1024

  /** logcat 抽取上限与超时（与 LogCollector 同口径：进程内自读）。 */
  private const val LOGCAT_MAX_BYTES = 512 * 1024
  private const val LOGCAT_TIMEOUT_S = 10L

  /** manifest 条目名（读者第一眼该看到它）。 */
  internal const val MANIFEST_NAME = "manifest.txt"

  /** 设备信息条目名。 */
  internal const val DEVICE_NAME = "device.txt"

  /**
   * 一份待打包条目的来源：名字 + 惰性内容读取（可失败）。
   *
   * 用惰性读取而不是先全部读进内存：单条与整包两个字节闸门都要在**读到之后**按实际字节判定，
   * 先读全部再裁剪在小内存设备上就是一次 OOM 路径。
   */
  internal class InputEntry(val name: String, val read: () -> String?)

  /**
   * 打包结果。[ok]=false 时调用方必须如实回执 [reason]，不得静默。
   * [report] 是逐条状态行，既进 manifest.txt 也用于单测断言。
   */
  internal class PackResult(val ok: Boolean, val zipFile: File?, val report: List<String>, val reason: String? = null)

  /** 是否有可诊断证据（B1 的入口判据；纯函数，JVM 可测）。 */
  internal fun hasEvidence(bootFailPresent: Boolean, bootDiagPresent: Boolean, phaseFailed: Boolean): Boolean =
    bootFailPresent || bootDiagPresent || phaseFailed

  /**
   * 入口可见性判据（B1/B3）。
   *
   * 三类证据任一成立即可见，而**不要求必须有日志文件**（Lead 裁决）：
   *  - boot-fail.log 非空：一次启动被宣判失败的终态快照；
   *  - boot-diag.log 非空：启动卡住/插件装配失败的诊断（含页面侧装配失败契约行）；
   *  - 相位为 Error/Closed：壳侧已经认定出事了。
   * 最后一类覆盖「引擎起来了但有条目没激活」这类**尚未写 boot-fail** 的可诊断故障（功能 D 现场）。
   */
  internal fun shouldOffer(filesDir: File, phaseFailed: Boolean): Boolean = hasEvidence(
    bootFailPresent = nonEmpty(File(filesDir, "boot-fail.log")),
    bootDiagPresent = nonEmpty(File(filesDir, "boot-diag.log")),
    phaseFailed = phaseFailed,
  )

  private fun nonEmpty(f: File): Boolean = try {
    f.isFile && f.length() > 0L
  } catch (_: Throwable) {
    false
  }

  /**
   * 候选日志文件（**白名单**，不做目录遍历）。
   *
   * 只收壳侧自有的诊断面：engine.log 及其轮转世代、boot-fail / boot-diag / boot-segments
   * 及各自一代轮转。刻意**不含** home/.dsh 下的配置、凭据、工作区与会话内容——
   * 「不主动包含无关数据」是结构性的，不靠运行时过滤。
   */
  internal fun candidateFiles(filesDir: File): List<File> {
    val names = listOf(
      "engine.log", "engine.log.1", "engine.log.2", "engine.log.3", "engine.log.4", "engine.log.5",
      "boot-fail.log", "boot-fail.log.1",
      "boot-diag.log", "boot-diag.log.1",
      "boot-segments.log", "boot-segments.log.1",
    )
    return names.map { File(filesDir, it) }
  }

  /**
   * 组装待打包条目（不含 logcat 与设备信息——那两项需要环境与 Context，由调用方加）。
   *
   * @param filesDir 应用私有目录。
   * @param logDir 采集器当日日志目录（LogCollector.currentDir）；关闭采集器时可为 null 或空目录。
   */
  internal fun fileEntries(filesDir: File, logDir: File?): List<InputEntry> {
    val out = ArrayList<InputEntry>()
    for (f in candidateFiles(filesDir)) {
      out.add(InputEntry(f.name) { readTextBounded(f, MAX_ENTRY_BYTES) })
    }
    // 当日日志（调试采集器开启时才有；关闭时如实 absent，不凭空造）。
    val dayLog = logDir?.listFiles()
      ?.filter { it.isFile && it.name.startsWith("dsh-") }
      ?.maxByOrNull { it.name }
    out.add(InputEntry("dsh-day.log") { dayLog?.let { readTextBounded(it, MAX_ENTRY_BYTES) } })
    return out
  }

  /**
   * 把 UTF-8 字节数组截到 [max] 以内，并**回退到完整字符边界**。
   *
   * 不从中间劈开一个多字节序列：半个字符会变成替换符（U+FFFD），把日志最后一行弄成乱码，
   * 而排障时最后一行往往正是定性证据。回退最多 3 字节，代价可忽略。
   *
   * 纯函数，JVM 单测直接打（LogShareTest.truncateUtf8NeverSplitsAMultibyteCharacter 逐字节上限遍历，
   * 覆盖中文三字节边界）。
   */
  internal fun truncateUtf8(bytes: ByteArray, max: Int): ByteArray {
    if (bytes.size <= max) return bytes
    var end = max
    // 0b10xxxxxx 是 UTF-8 续字节：向前退到首个非续字节处，保证不切断序列。
    while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end--
    return bytes.copyOf(end)
  }

  /** 有界读取文本；不存在/不可读返回 null（调用方记为 absent）。 */
  private fun readTextBounded(f: File, maxBytes: Int): String? = try {
    if (!f.isFile) null else f.inputStream().use { input ->
      val buf = ByteArray(maxBytes + 1)
      var off = 0
      while (off < buf.size) {
        val n = input.read(buf, off, buf.size - off)
        if (n < 0) break
        off += n
      }
      String(buf, 0, off.coerceAtMost(maxBytes), Charsets.UTF_8)
    }
  } catch (t: Throwable) {
    Log.w(TAG, "read failed: " + f.name + " " + (t.message ?: t.javaClass.simpleName))
    null
  }

  /**
   * 打包核心（纯 IO，JVM 单测可直接打真实文件）。
   *
   * 原子落盘：先写同目录下带 .tmp 后缀的临时文件，全部条目成功后 rename 覆盖目标；任一步失败
   * **删除该临时文件**并把原因如实返回（不留半截垃圾、也不留下一个看起来能用的坏包）。
   *
   * @param zipFile 目标 ZIP（父目录不存在时创建）。
   * @param inputs 条目清单（顺序即包内顺序）。
   * @param totalCap 整包文本上限。
   * @param sanitize 脱敏函数（默认 [LogSanitizer.sanitizeOrNull]）。抽成参数是为了让单测能注入
   *   一个**必然失败**的脱敏器，从而真正覆盖 fail-closed 分支（丢弃条目 + manifest 标注），
   *   而不是只在注释里声称「我们会 fail-closed」。
   * @return [PackResult]；成功时 manifest 条目恒在，逐条状态见 [PackResult.report]。
   */
  internal fun packTo(
    zipFile: File,
    inputs: List<InputEntry>,
    totalCap: Long = MAX_TOTAL_BYTES.toLong(),
    sanitize: (String) -> String? = LogSanitizer::sanitizeOrNull,
  ): PackResult {
    val report = ArrayList<String>()
    val tmp = File(zipFile.parentFile, zipFile.name + ".tmp")
    return try {
      zipFile.parentFile?.mkdirs()
      if (tmp.exists()) tmp.delete()
      var total = 0L
      ZipOutputStream(tmp.outputStream().buffered()).use { zip ->
        for (entry in inputs) {
          val raw = try {
            entry.read()
          } catch (t: Throwable) {
            report.add(entry.name + "=read-failed")
            continue
          }
          if (raw == null) {
            report.add(entry.name + "=absent")
            continue
          }
          val safe = sanitize(raw)
          if (safe == null) {
            // fail-closed：脱敏失败**丢弃整条**并如实标注，绝不原样写入。
            report.add(entry.name + "=" + LogSanitizer.DEREDACT_FAILED)
            continue
          }
          var state = "present"
          var bytes = safe.toByteArray(Charsets.UTF_8)
          if (bytes.size > MAX_ENTRY_BYTES) {
            // **按字节**截断，不按字符：中文日志（本仓日志面大量是中文）单字符 UTF-8 占 3 字节，
            // 按字符 take(N) 会让实际字节数达到 N 的 3 倍——上限形同不存在。故用字节数组截取，
            // 再按 UTF-8 边界回退到不产生半个字符的位置。
            bytes = truncateUtf8(bytes, MAX_ENTRY_BYTES)
            state = "truncated"
          }
          if (total + bytes.size > totalCap) {
            report.add(entry.name + "=skipped-total-cap")
            continue
          }
          total += bytes.size
          zip.putNextEntry(ZipEntry(entry.name))
          zip.write(bytes)
          zip.closeEntry()
          report.add(entry.name + "=" + state + "(" + bytes.size + "B)")
        }
        // manifest 最后写：它必须包含上面每一条的真实状态。
        val manifest = buildString {
          append("dsh-log-share manifest\n")
          append("生成时间(epoch ms)=").append(System.currentTimeMillis()).append('\n')
          append("说明=本包只含壳侧诊断日志；缺失条目在下表中如实标注，没有任何条目被静默丢弃。\n")
          append("条目数=").append(report.size).append('\n')
          for (line in report) append(line).append('\n')
        }
        zip.putNextEntry(ZipEntry(MANIFEST_NAME))
        zip.write(manifest.toByteArray(Charsets.UTF_8))
        zip.closeEntry()
      }
      // #1057：包是**已完成的字节**，交给唯一原子写入口它才能保证「写完 + fsync + 原子发布」。
      // 旧实现是先 delete(zipFile) 再 rename（失败退 Files.move）：delete 之后被杀就没有包，
      // 而两条发布路径都不 fsync，掉电时可能发布出半截 zip。
      AtomicFileReplace.writeBytes(zipFile, tmp.readBytes())
      PackResult(true, zipFile, report)
    } catch (t: Throwable) {
      // 压缩失败：清掉半截临时文件（B6），并如实返回原因。
      try { if (tmp.exists()) tmp.delete() } catch (_: Throwable) { /* 清理失败不改变结论 */ }
      Log.w(TAG, "pack failed: " + (t.message ?: t.javaClass.simpleName))
      PackResult(false, null, report, "zip-failed:" + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** 设备信息条目（不含任何凭据；如实写版本/ABI/SDK/快照指纹与引擎日志状态）。 */
  internal fun deviceInfo(filesDir: File): String = buildString {
    // 每项都容 null：JVM 单测的 android.jar 桩对 String/int 常量返回默认值（null/0），
    // 无脑拼接会在测试里 NPE，而生产侧取值也可能缺失。取不到就写 na（不留空字段）。
    append("app=").append(BuildConfig.VERSION_NAME ?: "na")
      .append(" (").append(BuildConfig.VERSION_CODE).append(")\n")
    append("sdk=").append(Build.VERSION.SDK_INT).append('\n')
    append("release=").append(Build.VERSION.RELEASE ?: "na").append('\n')
    append("model=").append(Build.MODEL ?: "na").append('\n')
    append("abis=").append(Build.SUPPORTED_ABIS?.joinToString(",") ?: "na").append('\n')
    append("snapshotFingerprint=").append(readTrimmed(File(filesDir, ".snapshot-fingerprint")) ?: "na").append('\n')
    append("snapshotTransaction=")
      .append(if (File(filesDir, ".snapshot-transaction").exists()) "present" else "absent").append('\n')
    // describeEngineLogState 的返回值**自带** engineLog= 前缀（壳侧既有口径，设备侧 grep 靠它），
    // 故这里直接落它，不再加一层前缀——否则读出来是 engineLog=engineLog=bytes=…（实测）。
    append(LogCollector.describeEngineLogState(filesDir)).append('\n')
  }

  private fun readTrimmed(f: File): String? = try {
    if (f.isFile) f.readText().trim().ifEmpty { null } else null
  } catch (_: Throwable) {
    null
  }

  /** logcat 抽取（本进程自己的日志；有界 + 超时，走既有 [ProcIo.readBounded]）。 */
  internal fun logcatText(): String = try {
    val proc = ProcessBuilder(
      "/system/bin/logcat", "-d", "-v", "threadtime", "--pid=" + android.os.Process.myPid(),
    ).start()
    ProcIo.readBounded(proc, LOGCAT_TIMEOUT_S, LOGCAT_MAX_BYTES).text
  } catch (t: Throwable) {
    Log.w(TAG, "logcat read failed: " + (t.message ?: t.javaClass.simpleName))
    ""
  }

  /**
   * 用户点击后的完整流程（唯一入口；**没有任何自动调用点**——B5）。
   *
   * 线程纪律：打包是重 IO（读多份日志 + logcat + 压缩），**绝不在主线程做**；系统分享面板
   * 必须回主线程拉起。Activity 已销毁/正在结束时静默收尾（不弹面板、不抛异常）——这是
   * Android 生命周期面（B6）：用户点了分享又立刻退出，不能变成崩溃。
   *
   * @param activity 壳 Activity（startActivity 主体）。
   * @param onResult 回执（主线程回调；只在主线程调用）：成功给**文件名 + 缺失项数**这一细节，
   *   失败给**可读原因细节**。完整用户句由调用方用字符串资源拼（避免「已生成诊断包」重复两次）。
   */
  fun shareFromGuide(activity: Activity, onResult: (Boolean, String) -> Unit) {
    val ctx = activity.applicationContext
    val dir = File(ctx.cacheDir, DIR_NAME)
    Thread({
      val filesDir = ctx.filesDir
      val logDir = try { LogCollector.currentDir(ctx) } catch (_: Throwable) { null }
      val inputs = ArrayList<InputEntry>()
      inputs.add(InputEntry(DEVICE_NAME) { deviceInfo(filesDir) })
      inputs.addAll(fileEntries(filesDir, logDir))
      inputs.add(InputEntry("logcat.txt") { logcatText() })
      sweepOldPacks(dir, keep = 3)
      val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US)
        .format(java.util.Date())
      val zip = File(dir, "dsh-diag-" + stamp + ".zip")
      val result = packTo(zip, inputs)
      activity.runOnUiThread {
        if (activity.isDestroyed || activity.isFinishing) return@runOnUiThread
        if (!result.ok || result.zipFile == null) {
          onResult(false, "打包失败（" + (result.reason ?: "unknown") + "）")
          return@runOnUiThread
        }
        try {
          val uri: Uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", result.zipFile)
          val send = Intent(Intent.ACTION_SEND).apply {
            type = MIME_ZIP
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
          // 不新增 queries 声明：ACTION_SEND + createChooser 由系统解析，不需要包可见性。
          val chooser = Intent.createChooser(send, "分享诊断包")
          chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          activity.startActivity(chooser)
          // 回执只给**细节**（文件名 + 缺失项数），完整句子由调用方用字符串资源拼——
          // 否则「已生成诊断包」会在资源串里再出现一次，读成「已生成诊断包 已生成诊断包 x.zip」。
          val absent = result.report.count { it.endsWith("=absent") }
          val note = if (absent > 0) "（" + absent + " 项日志缺失，包内已如实标注）" else ""
          onResult(true, result.zipFile.name + note)
        } catch (_: ActivityNotFoundException) {
          // 连**系统分享宿主**都拉不起来（极简 ROM / resolver 被裁剪）——如实说，不假装已分享。
          //
          // 为什么这里**不**去提前查「有没有应用能收 ZIP」：Android 11+ 的包可见性过滤会让
          // queryIntentActivities 在未声明 queries 时返回空，从而把「有接收方」误报成「没有」；
          // 而本任务明确不新增 queries（清单加宽面）。系统 chooser 自己用的是全可见性解析，
          // 所以「有没有接收方」由它呈现（无接收方时它显示系统自带的空态），我们只如实回执
          // 「面板没拉起来」这一个我们真能判定的事实。
          onResult(false, "这台设备无法拉起系统分享面板")
        } catch (t: Throwable) {
          Log.w(TAG, "share failed: " + (t.message ?: t.javaClass.simpleName))
          onResult(false, "拉起分享面板失败（" + (t.message ?: t.javaClass.simpleName) + "）")
        }
      }
    }, "dsh-log-share").apply { isDaemon = true }.start()
  }

  /** 清理既有诊断包（保留最近 [keep] 份；避免每次分享都堆一个新包塞满 cache）。 */
  internal fun sweepOldPacks(dir: File, keep: Int = 3) {
    try {
      val packs = dir.listFiles { f -> f.isFile && f.name.endsWith(".zip") }?.sortedByDescending { it.name }
        ?: return
      for (old in packs.drop(keep)) old.delete()
    } catch (_: Throwable) {
      // 清理失败不影响分享本身。
    }
  }
}
