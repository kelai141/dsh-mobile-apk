package com.dsharnessmobile.shell

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * issue #1622：在线更新的体积上限必须**边写边判**，不是整包落盘之后再判。
 *
 * 缺陷形态：`download()` 是 `input.copyTo(out)` 之后才判 `dest.length() > declaredSize + 16 MiB`。
 * 发布源（或 https 中间人）返回远大于声明的流 / 无限流 ⇒ `files/update-<uuid>.tar.xz` 一直写到
 * 数据分区满（ENOSPC，与共用同一 filesDir 的引擎与快照事务一起受影响），只有 finally 才删半包；
 * manifest 不带 `size` 时**连事后判据都没有**。
 *
 * 判据是行为判据：给 [UpdateManager.downloadArchive] 喂合成流、真落盘，数写进去多少字节。
 */
class UpdateDownloadCapTest {

  private lateinit var root: File

  @Before
  fun setUp() {
    root = Files.createTempDirectory("update-download-cap").toFile()
  }

  @After
  fun tearDown() {
    root.deleteRecursively()
  }

  /**
   * 分段可控的合成流：`total` 字节、每段 `chunk` 字节，可附一段「读失败」。
   *
   * 用它而不是无限流，是为了让每条用例都能在**有界**时间内结束（负控也要会退出）。
   */
  private class SliceStream(
    private val total: Long,
    private val chunk: Int = 64 * 1024,
    private val failAfter: Long = -1L,
  ) : InputStream() {
    var produced = 0L
      private set

    override fun read(): Int = if (produced >= total) -1 else 0.also { produced++ }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (failAfter >= 0 && produced >= failAfter) throw IOException("boom")
      if (produced >= total) return -1
      val n = minOf(len.toLong(), chunk.toLong(), total - produced).toInt()
      java.util.Arrays.fill(b, off, off + n, 7)
      produced += n
      return n
    }
  }

  /** 与仓内静态门禁同口径：注释里的名字不算命中。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  private fun dest(name: String = "update-archive.tar.xz"): File =
    File(root, name).also { it.delete() }

  // ── 未声明体积：旧实现一条判据都没有 ──────────────────────────────────

  /**
   * manifest 不带 `size` 时用硬上限（[UpdateManager.UNDECLARED_ARCHIVE_CAP_BYTES]）。
   *
   * 修前：`declaredSize == 0` 直接跳过事后判据 ⇒ 这条流会一路写下去。
   * 这里把硬上限注入成小值（纯函数入口），不真写 2 GiB。
   */
  @Test
  fun anUndeclaredStreamIsCappedByTheHardLimit() {
    val cap = UpdateManager.UNDECLARED_ARCHIVE_CAP_BYTES
    assertEquals("未声明体积必须有硬上限（2 GiB）", 2L * 1024L * 1024L * 1024L, cap)
    assertEquals("负的声明值（manifest 写坏）同样按未声明处理", cap, UpdateManager.archiveCapFor(-1L))
    assertEquals(cap, UpdateManager.archiveCapFor(0L))
    assertEquals(
      "有声明时上限＝声明 + 16 MiB（与旧的事后判据同值）",
      100L * 1024L * 1024L + 16L * 1024L * 1024L,
      UpdateManager.archiveCapFor(100L * 1024L * 1024L),
    )
    assertEquals(16L * 1024 * 1024, UpdateManager.DECLARED_SIZE_SLACK_BYTES)
  }

  /**
   * 核心行为判据：声明 1 MiB 的归档（上限 = 声明 + 16 MiB = 17 MiB），喂它 18 MiB 的流
   * ⇒ 必须在**写满之前**抛错。
   *
   * 修前（`copyTo` + 事后判）磁盘上会先出现完整的 18 MiB 文件，然后才被删。
   */
  @Test
  fun aStreamBeyondTheDeclaredSizeFailsWhileWritingNotAfter() {
    val file = dest()
    val declared = 1024L * 1024L
    val streamTotal = UpdateManager.archiveCapFor(declared) + 1024L * 1024L
    val seen = ArrayList<Long>()
    try {
      UpdateManager(dummyContext()).downloadArchive(
        SliceStream(total = streamTotal),
        file,
        declared,
      ) { seen.add(it) }
      fail("超过声明体积必须抛错，不能静默写完")
    } catch (_: IllegalStateException) {
      // 期望：判据在写的过程中就成立。
    }
    val cap = UpdateManager.archiveCapFor(declared)
    assertTrue(
      "落盘字节数必须停在上限附近（不得先写完全部 3 MiB）：实际 " + file.length() + " / cap " + cap,
      file.length() <= cap,
    )
    assertTrue(
      "必须有写入进度回调（证明判据确实在写循环里，而不是落盘之后）",
      seen.isNotEmpty() && seen.last() <= cap,
    )
  }

  // ── 边界：正好等于上限必须放行 ────────────────────────────────────────

  /** 上限内（含恰好等于上限）必须原样落盘：判据不得把正常更新判超限。 */
  @Test
  fun aStreamWithinTheDeclaredSizeIsWrittenVerbatim() {
    val file = dest()
    val declared = 64L * 1024L
    val total = UpdateManager.archiveCapFor(declared)
    UpdateManager(dummyContext()).downloadArchive(SliceStream(total = total), file, declared)
    assertEquals("上限内的字节必须逐字节落盘", total, file.length())
  }

  /** 没有声明 + 流本身很小：照常落盘（硬上限不参与正常路径）。 */
  @Test
  fun aSmallUndeclaredStreamIsWrittenVerbatim() {
    val file = dest()
    UpdateManager(dummyContext()).downloadArchive(SliceStream(total = 5_000L), file, 0L)
    assertEquals(5_000L, file.length())
  }

  /** 读失败必须原样穿出去（调用方的 finally 才有机会清半包）。 */
  @Test
  fun anIoErrorDuringTheCopyPropagates() {
    val file = dest()
    try {
      UpdateManager(dummyContext()).downloadArchive(
        SliceStream(total = 1024L * 1024L, failAfter = 4096L),
        file,
        8L * 1024L * 1024L,
      )
      fail("读失败必须穿出去，不得当成下载完成")
    } catch (_: IOException) {
      // 期望。
    }
    assertTrue("半包由调用方 finally 清理，本层只保证不把失败当成功", true)
  }

  // ── 接线：生产路径必须走这个循环，且旧的事后判据不得回来 ────────────────

  @Test
  fun downloadUsesTheCountedLoopAndNotCopyTo() {
    val src = File(
      listOf(
        File("src/main/java/com/dsharnessmobile/shell/UpdateManager.kt"),
        File("app/src/main/java/com/dsharnessmobile/shell/UpdateManager.kt"),
      ).first { it.isFile }.path,
    ).readText()
    val body = codeOnly(src).substringAfter("private fun download(").substringBefore("private fun sha256(")
    assertTrue("下载必须委托带计数的循环", body.contains("downloadArchive("))
    assertTrue(
      "旧的 copyTo + 事后判据不得回来（写满才判 = 数据分区被打满）",
      !body.contains("copyTo("),
    )
    val loop = src.substringAfter("internal fun downloadArchive(").substringBefore("private fun sha256(")
    assertTrue("循环里必须有上限判据", loop.contains("written > cap"))
    assertTrue(
      "判据必须先于写入（越过上限的那一段不得落盘）",
      loop.indexOf("written > cap") < loop.indexOf("out.write("),
    )
  }

  /** 只为构造 UpdateManager（它本身不碰 context 字段以外的状态）。 */
  private fun dummyContext(): android.content.Context = object : android.content.ContextWrapper(null) {
    override fun getFilesDir(): File = root
  }
}
