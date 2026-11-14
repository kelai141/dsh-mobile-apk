package com.dsharnessmobile.shell

import android.content.ContextWrapper
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * issue #1583：开屏视频导入的**每条早退路径**都必须清掉临时文件。
 *
 * 缺陷形态：`import()` 先把选中文档拷到 `files/splash/.splash-XXXX.tmp`，只有 `catch` 里删 temp，
 * 没有 finally。五条早退（unreadable / too-large / empty / decode-failed / io-failed）都是从 try 里
 * 直接 `return`，temp 留在盘上；而 `purgeOtherStoredVideos` 只删 `splash_video*` 前缀，
 * `.splash-*.tmp` **永不回收**——一次可达 50 MiB，重复几次即数倍，且在 app 私有目录里用户看不见。
 *
 * 判据是行为判据：真跑 [SplashStore.importFrom]、真落盘、真数目录里的残留文件。
 * 流源可注入只是为了绕开「JVM 里拿不到 ContentResolver」这一层（见 importFrom 注释），
 * 落盘 / 校验 / 发布语义与生产完全同一条代码。
 */
class SplashTempCleanupTest {

  private lateinit var root: File

  @Before
  fun setUp() {
    root = Files.createTempDirectory("splash-temp-cleanup").toFile()
  }

  @After
  fun tearDown() {
    root.deleteRecursively()
  }

  private fun context(): android.content.Context = object : ContextWrapper(null) {
    override fun getFilesDir(): File = root
  }

  /** 导入目录里残留的临时文件（生产命名：`.splash-*.tmp`，见 SplashStore 的 createTempFile）。 */
  private fun leftoverTemps(): List<File> =
    File(root, "splash").listFiles().orEmpty().filter { it.isFile && it.name.endsWith(".tmp") }

  private fun splashEntries(): List<File> = File(root, "splash").listFiles().orEmpty().toList()

  /** 一条永不结束的合成流：用来触达「拷贝途中越界」这条早退（不会把 50 MiB 放进内存）。 */
  private class ZeroForeverStream : InputStream() {
    override fun read(): Int = 0
    override fun read(b: ByteArray, off: Int, len: Int): Int {
      java.util.Arrays.fill(b, off, off + len, 0)
      return len
    }
  }

  // ── 三条不写大文件的早退路径 ────────────────────────────────────────────

  /**
   * openInputStream 返回 null（provider 删了文件 / 权限被撤）：`unreadable`。
   *
   * 修前这里留下一个 0 字节的 `.splash-*.tmp`（temp 在 openInputStream 之前就建好了）。
   */
  @Test
  fun unreadableStreamLeavesNoTempFile() {
    val result = SplashStore.importFrom(context(), "a.mp4", 0L, "video/mp4") { null }
    assertEquals("unreadable", (result as SplashStore.Result.Rejected).code)
    assertTrue(
      "早退路径不得留下 .splash-*.tmp，实际残留：" + leftoverTemps().map { it.name },
      leftoverTemps().isEmpty(),
    )
  }

  /** 空文档：`empty`（0 字节不是可播放视频，也不能冒充成功）。 */
  @Test
  fun emptyStreamLeavesNoTempFile() {
    val result = SplashStore.importFrom(context(), "a.mp4", 0L, "video/mp4") {
      ByteArrayInputStream(ByteArray(0))
    }
    assertEquals("empty", (result as SplashStore.Result.Rejected).code)
    assertTrue(
      "早退路径不得留下 .splash-*.tmp，实际残留：" + leftoverTemps().map { it.name },
      leftoverTemps().isEmpty(),
    )
  }

  /**
   * 扩展名是视频但容器解不开（`decode-failed`）：整份副本已经落进 temp 之后才早退。
   *
   * 这是 issue 列的触发路径②，也是「残留等于整份视频大小」的那一条。
   */
  @Test
  fun undecodableContainerLeavesNoTempFile() {
    val payload = ByteArray(4096) { (it % 251).toByte() }
    val result = SplashStore.importFrom(context(), "broken.mp4", 0L, "video/mp4") {
      ByteArrayInputStream(payload)
    }
    assertEquals("decode-failed", (result as SplashStore.Result.Rejected).code)
    assertTrue(
      "解码失败早退不得留下整份副本，实际残留：" + leftoverTemps().map { it.name + "(" + it.length() + ")" },
      leftoverTemps().isEmpty(),
    )
    assertTrue(
      "更不得因为删 temp 而把已存在的可用视频一起清掉（目录里应有 0 个文件）",
      splashEntries().isEmpty(),
    )
  }

  // ── 在拷的过程中越界的那一条（50 MiB 上限，issue 触发路径①）──────────────

  /**
   * declaredBytes 缺失（provider 不报 SIZE ⇒ -1）+ 大于 50 MiB 的流：`too-large`。
   *
   * 修前这里留下的是「50 MiB + 一个缓冲块」的 temp——issue 说的数倍空间就是这样堆起来的。
   */
  @Test
  fun oversizedStreamLeavesNoTempFile() {
    val result = SplashStore.importFrom(context(), "huge.mp4", -1L, "video/mp4") { ZeroForeverStream() }
    assertEquals("too-large", (result as SplashStore.Result.Rejected).code)
    assertTrue(
      "超限早退不得留下 50 MiB 级的 .tmp，实际残留：" +
        leftoverTemps().map { it.name + "(" + it.length() + ")" },
      leftoverTemps().isEmpty(),
    )
  }

  // ── 反方向：修复不得改掉成功路径的语义 ────────────────────────────────

  /**
   * 死代码探针：`import` 仍委托同一个实现，且 finally 里的清理**不参与返回值判定**。
   *
   * 理由：成功路径（`Result.Saved`）在本 JVM 上不可达——它需要 MediaMetadataRetriever 解出真实时长。
   * 因此这里用源码级判据锁住两点（与 AtomicWriteEntryTest 的口径一致）：
   *  ① temp 清理写在 finally，不是写在某个分支里（分支清理又会漏掉别的早退）；
   *  ② Saved 分支之后没有任何「temp 已不存在 ⇒ 判失败」的判定。
   */
  @Test
  fun theTempCleanupIsInFinallyAndDoesNotAffectTheSavedVerdict() {
    val src = File(
      listOf(
        File("src/main/java/com/dsharnessmobile/shell/SplashStore.kt"),
        File("app/src/main/java/com/dsharnessmobile/shell/SplashStore.kt"),
      ).first { it.isFile }.path,
    ).readText()
    val body = src.substringAfter("internal fun importFrom(").substringBefore("fun clear(")
    val finallyAt = body.indexOf("} finally {")
    val savedAt = body.indexOf("Result.Saved(")
    assertTrue("必须存在 finally 分支（五条早退都在 try 里 return）", finallyAt >= 0)
    assertTrue("Saved 分支必须仍在 try 内", savedAt >= 0 && savedAt < finallyAt)
    val finallyBody = body.substring(finallyAt)
    assertTrue(
      "finally 里必须真的删 temp（早退路径的唯一清理点）",
      finallyBody.contains("if (temp.exists()) temp.delete()"),
    )
    val catchAt = body.indexOf("} catch (")
    assertTrue("必须存在 catch 分支", catchAt > savedAt)
    assertTrue(
      "Saved 判定不得依赖 temp 是否仍在（发布成功后它已被 move 消费）",
      !body.substring(savedAt, catchAt).contains("temp"),
    )
  }
}
