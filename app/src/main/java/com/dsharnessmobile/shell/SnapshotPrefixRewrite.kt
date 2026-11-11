package com.dsharnessmobile.shell

import android.content.Context
import java.io.File

/**
 * 快照解压后的**一次性前缀重写**（issue #1234 第 5 条）。
 *
 * 背景：构建期 `fix-shebang.py` 把 usr/bin、usr/libexec、usr/lib 下文本脚本的 shebang 钉成
 * **构建期前缀** `/data/user/0/<pkg>/files/usr`。shebang 是内核 execve 直接解析的绝对路径，
 * **没有 $0、也没有 sh 语法可用**——所以它无法像 pnpm/git/PTC 那样自定位
 * （见 `scripts/build-snapshot-013.mjs` 的 `SELF_LOCATE_PREAMBLE`）。多用户设备上（DSH 装在 user 10）
 * 这条前缀指向 user 0 的那份安装，跨用户 FUSE 隔离 ⇒ 这些脚本一律 exec 失败。
 *
 * 处置：**首次解压完成后**把文本 shim 里的构建期前缀换成本机真实的 `usrDir`，然后写标记
 * `files/.prefix-rewrite-<version>`——此后启动不再扫全树（标记命中即返回）。
 *
 * 边界（如实登记）：
 *  - **只改文本 shim**：`.so` 与 ELF 一律不动（硬改 ELF 会破坏加载；功能路径由 `shellEnv()` 的
 *    env 兜住）。判据复用 [PrefixRelocation.isTextShim]，不在这里另写一套。
 *  - **不猜别的包**：只重写 `/data/{user/<n>|data}/<本包>/files/usr` 形态，且只换成本机 `usrDir`。
 *  - **指纹变了要重跑**：标记名只带版本（可读），标记**内容**带快照指纹；两者都相同才跳过。
 *    否则「同版本内换快照」会把新烧进来的前缀永久留在树上（静默半修好）。
 */
internal object SnapshotPrefixRewrite {

  /** 标记文件名前缀（后面接版本名）。版本变了就再跑一次——新版本可能又带进新的构建期前缀。 */
  const val MARKER_PREFIX = ".prefix-rewrite-"

  /**
   * 单次重写的**遍历条目**上限（文件 + 目录）。
   *
   * 为什么必须有界：`usr/lib` 有 3 万+ 小文件，全树遍历必须能停（`check-bounded-io.mjs` 的口径）。
   * 取值依据：出厂快照 bin+libexec+lib 实测 **37725** 个条目（31191 文件 + 6534 目录），取 5 倍余量——
   * 用户装插件会在 `usr/lib/node_modules` 下长出新树，余量太小会让「刚装完插件的那次启动」被截断。
   * **命中上限即视为未完成**（不写标记，下次重试），绝不允许「扫到一半就当修好了」——
   * 那正是本缺陷「看起来修了、其实只修了一部分」的形态。
   */
  const val MAX_VISITS = 200000

  /** 只考虑小文件：与 fix-shebang.py 的 4 MB 阈值同源。 */
  const val MAX_BYTES = 4L * 1024 * 1024

  /** 路径分隔符与替换串转义用的码位（写成码位而不是字面量，避免转义层数读错）。 */
  private const val SLASH = '/'
  private const val HASH = 35
  private const val BANG = 33
  private const val BACKSLASH = '\\'

  /** 判定「这是构建期烧死的本包 usr 前缀」——任意用户号都算（构建机烧的是 user 0）。 */
  private fun bakedPrefixRegex(pkg: String): Regex =
    Regex("/data/(?:user/[0-9]+|data)/" + Regex.escape(pkg) + "/files/usr")

  /**
   * 构建期烧进快照的前缀。与 `scripts/build-snapshot-013.mjs` 的 `NEW_PREFIX` 必须逐字相同。
   *
   * 用途只有一个：判断「本机的 usr 是不是就是这个前缀」——是的话整步无事可做。
   */
  internal const val BAKED_PREFIX = "/data/user/0/com.dsharnessmobile.shell/files/usr"

  /**
   * 本机 usr 是否**正好**是构建期烧的那个前缀。
   *
   * 为什么这条早退重要：构建期 `fix-shebang.py` 已经把前缀钉成上面那个值，
   * 而应用正常安装时本机 usr 也就是它（`/data/user/0/<pkg>/files/usr`）。
   * 两者相等意味着**树里所有 shebang 本来就对**，这一步无事可做——但旧实现仍要遍历
   * 4.2 万条目逐个读文件确认，在慢文件系统上要 8 分钟以上（实测见
   * `docs/NATIVE-PREFIX-REWRITE-COST-2026-11-11.md`）。
   *
   * 判据必须逐字相等：只要本机路径不同（多用户设备装在 user 10、或包名变了），
   * 就照常全量校验，绝不因为「看起来一样」而跳过。
   */
  internal fun usrMatchesBakedPrefix(usrDir: File): Boolean =
    usrMatchesBakedPrefixPath(usrDir.absolutePath)

  /**
   * 纯字符串版本（JVM 可测）。
   *
   * 为什么单独抽出来：`File("/data/user/0/...").absolutePath` 在**宿主 JVM** 上会加上当前
   * 工作目录前缀（Windows 上是盘符），拿它做断言只能测到宿主行为、测不到设备行为。
   * 把判据收敛成「一个路径字符串是否等于构建期前缀」，测试就能直接喂设备上的真实路径。
   */
  internal fun usrMatchesBakedPrefixPath(usrPath: String): Boolean =
    usrPath.replace(BACKSLASH, SLASH).trimEnd(SLASH) == BAKED_PREFIX

  /**
   * 把文本里的**本包构建期 usr 前缀**换成本机 `usrDir`（纯函数，JVM 可测）。
   *
   * 为什么不像 [PrefixRelocation.rewriteTextShim] 那样只认「当前用户」那个前缀：那条判据回答的是
   * 「这条路径属于当前用户的哪棵树」，用在**运行期自愈改写**上是对的（别替别的用户做主）。但这里
   * 处理的是**构建产物**：产物里烧的恒是构建机的 user 0，而当前安装的真实 usr 只有一个——
   * 本机的 `usrDir`。所以判据是「是不是本包烧死的 usr 前缀」，不是「是不是当前用户」。
   *
   * @param text 脚本文本。
   * @param pkg 本应用包名。
   * @param usrDir 本机真实的 usr 目录绝对路径。
   * @returns 重写后的文本（没有命中时**逐字节原样返回**）。
   */
  internal fun relocateBakedUsrPrefix(text: String, pkg: String, usrDir: String): String {
    if (pkg.isEmpty() || usrDir.isEmpty()) return text
    val actual = usrDir.trimEnd(SLASH)
    if (actual.isEmpty()) return text
    return bakedPrefixRegex(pkg).replace(text, escapeReplacement(actual))
  }

  /**
   * [Regex.replace] 的替换串里 美元符号 与 反斜杠 有特殊含义；路径里出现它们会抛异常，故转义。
   *
   * 不用 Kotlin 的 Regex.escapeReplacement 扩展：它要求当前类是被扩展的接收者，而这里只需要一个
   * 纯字符串变换——多一层接收者只会让「谁在转义」变得不清楚。
   */
  private fun escapeReplacement(literal: String): String {
    // 注意：这里必须是**字符**码位转成字符串，不能把常量写成 Int 再 toString（那会得到 "92"）。
    val backslash = Char(92).toString()
    val dollar = Char(36).toString()
    return literal.replace(backslash, backslash + backslash).replace(dollar, backslash + dollar)
  }

  /**
   * **单个文件的唯一判定点**：该不该改、改成什么。
   *
   * 把「判据 + 改写」合成一个纯函数，是为了让「把改写面放宽到 ELF」这种改法**必然红**：
   * 测试喂一份含 baked 前缀字面量的 ELF 字节，期望得到 null（= 不碰）；一旦 [PrefixRelocation.isTextShim]
   * 那一步被拿掉，就会返回改过的字节，测试立刻红。
   *
   * @param name 文件名（`.so` 判定用）。
   * @param bytes 文件原始字节。
   * @returns 改写后的字节；**null = 这不是文本 shim，一个字都不许动**。
   */
  internal fun rewriteFileBytes(name: String, bytes: ByteArray, pkg: String, usrDir: String): ByteArray? {
    // 1) 只认脚本：首两字节必须是 #!。ELF 的 0x7f E 天然过不了这一关。
    if (bytes.size < 2 || bytes[0] != HASH.toByte() || bytes[1] != BANG.toByte()) return null
    // 2) 只认文本：.so / ELF 魔数 / 含 NUL 的一律 false（复用 PR #1536 的判据，不另写一套）。
    if (!PrefixRelocation.isTextShim(name, bytes)) return null
    val before = String(bytes, Charsets.UTF_8)
    val after = relocateBakedUsrPrefix(before, pkg, usrDir)
    return if (after == before) null else after.toByteArray(Charsets.UTF_8)
  }

  /** 一次重写的结果（供日志/诊断面消费，不参与控制流）。 */
  internal data class Result(
    /** 真的被改写的文件数。 */
    val rewritten: Int,
    /** 扫到并判定为「带 shebang 的文本 shim」的文件数。 */
    val scanned: Int,
    /** 读/写失败的文件数（>0 时**不写标记**，下次启动重试）。 */
    val failed: Int,
    /** 是否因为标记已存在（且指纹一致）而跳过。 */
    val skipped: Boolean,
    /** 是否因达到 [MAX_VISITS] 而提前结束（true 时**不写标记**，下次启动续跑）。 */
    val truncated: Boolean = false,
  )

  /**
   * 只跑一次：标记命中且指纹一致即返回；否则重写 [usrRoot] 下的文本 shim 并写标记。
   *
   * 标记只在**零失败且未截断**时写（否则下次启动重试）。这与 `repairProfilePatch` 的既有口径
   * 一致（失败不写 marker，避免「半修好」被永久记住）。
   *
   * @param filesDir 应用私有根（标记落点）。
   * @param usrRoot 要重写的 usr 树（live 树）。
   * @param version 版本名（标记名的一部分：升级后允许再跑一次）。
   * @param pkg 本应用包名。
   * @param snapshotId 快照指纹（标记内容的一部分：同版本内换快照也要重跑）。
   * @param maxVisits 遍历上限（缺省 [MAX_VISITS]）。只有测试会传小值——生产路径不接受外部调参。
   * @param scriptManifest 构建期产出的文本脚本清单（相对 usrRoot）。给出时**只按清单校验**，
   *   不再遍历整棵树——慢文件系统上 4.2 万条目的 lstat 要十几分钟，而清单只有几百行。
   *   清单缺席（旧快照）时回落到原来的全树遍历，行为与之前一致。
   */
  internal fun runOnce(
    filesDir: File,
    usrRoot: File,
    version: String,
    pkg: String,
    snapshotId: String,
    maxVisits: Int = MAX_VISITS,
    scriptManifest: List<String>? = null,
  ): Result {
    val marker = File(filesDir, MARKER_PREFIX + version)
    if (marker.isFile && markerReadsSnapshot(marker, snapshotId)) return Result(0, 0, 0, skipped = true)
    if (!usrRoot.isDirectory) return Result(0, 0, 1, skipped = false)
    // 本机 usr 正好等于构建期烧的前缀 ⇒ 树里所有 shebang 本来就对，整步无事可做。
    // 这条早退把「必然为 0 的全量校验」直接省掉；判据是逐字相等，不相等就照常全量跑。
    if (usrMatchesBakedPrefix(usrRoot)) {
      writeMarkerIfComplete(marker, 0, 0, snapshotId)
      return Result(0, 0, 0, skipped = true)
    }
    var rewritten = 0
    var scanned = 0
    var failed = 0
    var visited = 0
    var truncated = false

    if (scriptManifest != null) {
      // 清单路径：构建期已经确认过「这些是文本脚本」，运行时只需逐个校验前缀，
      // 不必再遍历整棵树判断谁有 shebang。
      for (rel in scriptManifest) {
        if (visited >= maxVisits) { truncated = true; break }
        visited += 1
        val child = File(usrRoot, rel)
        val length = try { child.length() } catch (_: Throwable) { failed += 1; continue }
        if (length <= 0L || length > MAX_BYTES) continue
        scanned += 1
        val bytes = try { child.readBytes() } catch (_: Throwable) { failed += 1; continue }
        val after = rewriteFileBytes(child.name, bytes, pkg, usrRoot.absolutePath) ?: continue
        try {
          java.io.FileOutputStream(child).use { out ->
            out.write(after)
            out.flush()
            out.fd.sync()
          }
          rewritten += 1
        } catch (_: Throwable) {
          failed += 1
        }
      }
      if (failed == 0 && !truncated) {
        try {
          marker.writeText(
            "rewritten=" + rewritten + " scanned=" + scanned + " snapshot=" + snapshotId +
              " at " + System.currentTimeMillis() + "\n",
          )
        } catch (_: Throwable) {
          // 标记写不进去不算失败：下次启动会再跑一遍（幂等）。
        }
      }
      return Result(rewritten, scanned, failed, skipped = false, truncated = truncated)
    }
    // 与 fix-shebang.py 同范围（bin / libexec / lib）：它烧的前缀在哪，就只去哪修。
    val roots = listOf(File(usrRoot, "bin"), File(usrRoot, "libexec"), File(usrRoot, "lib"))
    for (root in roots) {
      if (!root.isDirectory) continue
      val stack = ArrayDeque<File>()
      stack.addLast(root)
      while (stack.isNotEmpty() && !truncated) {
        val dir = stack.removeLast()
        val children = try { dir.listFiles() } catch (_: Throwable) { null } ?: continue
        for (child in children) {
          if (visited >= maxVisits) { truncated = true; break }
          visited += 1
          // 一次 lstat 拿全部信息。
          //
          // 旧实现依次调用 isSymlink / isDirectory / isFile / length —— 那是同一份
          // lstat 的四次往返，在慢文件系统上每次 1–4 ms（设备实测，见
          // docs/NATIVE-PREFIX-REWRITE-COST-2026-11-11.md）。合并成一次即可省掉三次。
          // 软链一律不碰：目录链可能成环，文件链会把改写落到链目标上（改写范围不可控）。
          val attrs = try {
            java.nio.file.Files.readAttributes(
              child.toPath(),
              java.nio.file.attribute.BasicFileAttributes::class.java,
              java.nio.file.LinkOption.NOFOLLOW_LINKS,
            )
          } catch (_: Throwable) {
            null
          }
          if (attrs == null) continue
          if (attrs.isSymbolicLink) continue
          if (attrs.isDirectory) { stack.addLast(child); continue }
          if (!attrs.isRegularFile || attrs.size() > MAX_BYTES) continue
          val head = try { readHead(child, 2) } catch (_: Throwable) { failed += 1; continue }
          if (head.size < 2 || head[0] != HASH.toByte() || head[1] != BANG.toByte()) continue
          scanned += 1
          val bytes = try { child.readBytes() } catch (_: Throwable) { failed += 1; continue }
          val after = rewriteFileBytes(child.name, bytes, pkg, usrRoot.absolutePath) ?: continue
          try {
            // 就地写回：不删文件，保留既有 inode 与权限位（删了重建会丢执行位）。
            java.io.FileOutputStream(child).use { out ->
              out.write(after)
              out.flush()
              out.fd.sync()
            }
            rewritten += 1
          } catch (_: Throwable) {
            failed += 1
          }
        }
      }
    }
    if (failed == 0 && !truncated) {
      try {
        marker.writeText(
          "rewritten=" + rewritten + " scanned=" + scanned + " snapshot=" + snapshotId +
            " at " + System.currentTimeMillis() + "\n",
        )
      } catch (_: Throwable) {
        // 标记写不进去不算失败：下次启动会再跑一遍（幂等，代价是一次有界遍历）。
      }
    }
    return Result(rewritten, scanned, failed, skipped = false, truncated = truncated)
  }

  /** 构建期脚本清单在 live 树里的落点（由快照解压带进来）。 */
  private const val SCRIPT_MANIFEST_REL = ".dsh-shebang-scripts.txt"

  /**
   * Context 便利入口：live 树 = `<files>/usr`。
   *
   * 有清单就按清单校验（几百行），没有就回落全树遍历（旧快照）。清单只是加速，
   * **不是正确性前提**：读不到、为空、或路径不存在时一律回落，绝不因此跳过重写。
   */
  internal fun runOnce(context: Context, version: String, snapshotId: String): Result {
    val usr = File(context.filesDir, "usr")
    return runOnce(
      context.filesDir, usr, version, context.packageName, snapshotId,
      scriptManifest = readScriptManifest(usr),
    )
  }

  /** 读清单；任何异常或缺席都返回 null（调用方回落全树遍历）。 */
  private fun readScriptManifest(usr: File): List<String>? {
    val file = File(usr, SCRIPT_MANIFEST_REL)
    if (!file.isFile) return null
    val lines = try { file.readLines() } catch (_: Throwable) { return null }
    val clean = lines.map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("/") && ".." !in it.split("/") }
    return clean.ifEmpty { null }
  }

  /** 零失败时写标记（早退与常规路径共用，口径一致）。 */
  private fun writeMarkerIfComplete(marker: File, rewritten: Int, scanned: Int, snapshotId: String) {
    try {
      marker.writeText(
        "rewritten=" + rewritten + " scanned=" + scanned + " snapshot=" + snapshotId +
          " at " + System.currentTimeMillis() + "\n",
      )
    } catch (_: Throwable) {
      // 标记写不进去不算失败：下次启动会再跑一遍（幂等）。
    }
  }

  /**
   * 标记是否对**这一份快照**有效。
   *
   * 指纹为空（首次安装、指纹文件缺失）时按「无效」处理：宁可多扫一次，也不要因为读不到指纹
   * 就把可能带旧前缀的树当成已修好。
   */
  private fun markerReadsSnapshot(marker: File, snapshotId: String): Boolean {
    if (snapshotId.isEmpty()) return false
    val text = try { marker.readText() } catch (_: Throwable) { return false }
    return text.contains("snapshot=" + snapshotId)
  }

  private fun isSymlink(file: File): Boolean = try {
    java.nio.file.Files.isSymbolicLink(file.toPath())
  } catch (_: Throwable) {
    false
  }

  /**
   * 读文件头两字节。
   *
   * 为什么不用 `FileInputStream(file)`：那个构造函数会走
   * `File.getCanonicalPath()` → `UnixFileSystem.canonicalize()` → 逐级 `lstat`
   * 整条路径，每次约 16 ms（设备实测，见 docs/NATIVE-PREFIX-REWRITE-COST-2026-11-11.md）。
   * 4.2 万个文件累计 701 秒，占这一步总耗时的 55%，是唯一的主项。
   *
   * `java.nio.file.Files.newByteChannel` 直接按路径打开，不做规范化；本方法只被
   * 前缀重写用来嗅探 `#!`，路径已经来自 `listFiles()`，不存在需要规范化才能解析的形态。
   */
  private fun readHead(file: File, count: Int): ByteArray {
    val buffer = java.nio.ByteBuffer.allocate(count)
    java.nio.channels.FileChannel.open(
      file.toPath(),
      java.nio.file.StandardOpenOption.READ,
    ).use { channel ->
      while (buffer.hasRemaining()) {
        if (channel.read(buffer) < 0) break
      }
    }
    val read = buffer.position()
    return if (read == count) buffer.array() else buffer.array().copyOf(read)
  }
}
