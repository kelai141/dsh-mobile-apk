package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Boundary rules for the startup video; these run without Android. */
class SplashPolicyTest {

  @Test
  fun coverFillsTabletsAndPhonesWithoutDistortingVideoPixels() {
    val viewports = listOf(3008 to 1880, 1880 to 3008, 1600 to 900, 1080 to 2400)
    val videos = listOf(1080 to 1920, 1920 to 1080, 3840 to 2160, 1080 to 1080)
    for ((vw, vh) in viewports) for ((mw, mh) in videos) {
      val transform = SplashPolicy.coverTransform(vw, vh, mw, mh)!!
      val drawnWidth = vw * transform.scaleX
      val drawnHeight = vh * transform.scaleY
      assertTrue("left edge uncovered", transform.dx <= 0.001f)
      assertTrue("top edge uncovered", transform.dy <= 0.001f)
      assertTrue("right edge uncovered", transform.dx + drawnWidth >= vw - 0.001f)
      assertTrue("bottom edge uncovered", transform.dy + drawnHeight >= vh - 0.001f)
      assertEquals("video pixels must stay square", drawnWidth / mw, drawnHeight / mh, 0.001f)
      assertEquals("horizontal crop must be centred", vw.toFloat(), drawnWidth + 2 * transform.dx, 0.001f)
      assertEquals("vertical crop must be centred", vh.toFloat(), drawnHeight + 2 * transform.dy, 0.001f)
      assertTrue("one axis must fit exactly", kotlin.math.abs(drawnWidth - vw) < 0.001f || kotlin.math.abs(drawnHeight - vh) < 0.001f)
    }
  }

  @Test
  fun matchingAspectRatioUsesIdentityEvenForHigherResolutionVideo() {
    assertEquals(SplashPolicy.CoverTransform(1f, 1f, 0f, 0f), SplashPolicy.coverTransform(1600, 900, 3840, 2160))
  }

  @Test
  fun coverWaitsForBothTheSurfaceAndVideoDimensions() {
    assertNull(SplashPolicy.coverTransform(0, 900, 1920, 1080))
    assertNull(SplashPolicy.coverTransform(1600, 0, 1920, 1080))
    assertNull(SplashPolicy.coverTransform(1600, 900, 0, 1080))
    assertNull(SplashPolicy.coverTransform(1600, 900, 1920, -1))
  }

  @Test
  fun acceptsExactlyFiftyMebibytesAndRejectsOneByteMore() {
    assertTrue(SplashPolicy.isSizeAllowed(50L * 1024L * 1024L))
    assertFalse(SplashPolicy.isSizeAllowed(50L * 1024L * 1024L + 1L))
  }

  @Test
  fun rejectsEmptyFiles() {
    assertFalse(SplashPolicy.isSizeAllowed(0L))
    assertFalse(SplashPolicy.isSizeAllowed(-1L))
  }

  @Test
  fun rejectsTsByExtensionRegardlessOfCase() {
    assertEquals("forbidden-ts", SplashPolicy.rejection("clip.ts", "video/mp4", 1024L))
    assertEquals("forbidden-ts", SplashPolicy.rejection("CLIP.TS", null, 1024L))
  }

  @Test
  fun rejectsTsByMimeEvenWhenTheNameLooksHarmless() {
    assertEquals("forbidden-ts", SplashPolicy.rejection("clip.mp4", "video/mp2t", 1024L))
    assertEquals("forbidden-ts", SplashPolicy.rejection("clip.mp4", "video/vnd.dlna.mpeg-tts", 1024L))
    assertEquals("forbidden-ts", SplashPolicy.rejection("clip.mp4", "video/mp2t; charset=binary", 1024L))
  }

  @Test
  fun acceptsCommonContainersIncludingUppercaseExtensions() {
    assertNull(SplashPolicy.rejection("intro.mp4", "video/mp4", 10L * 1024L * 1024L))
    assertNull(SplashPolicy.rejection("intro.MKV", "video/x-matroska", 10L * 1024L * 1024L))
    assertNull(SplashPolicy.rejection("intro.webm", "video/webm", 10L))
    assertNull(SplashPolicy.rejection("intro", null, 10L))
  }

  @Test
  fun rejectsTooLargeBeforeLookingAtTheCopy() {
    assertEquals("too-large", SplashPolicy.rejection("huge.mp4", "video/mp4", 50L * 1024L * 1024L + 1L))
  }

  @Test
  fun extensionParsingHandlesPathsAndDots() {
    assertEquals("mp4", SplashPolicy.extensionOf("a/b/intro.mp4"))
    assertEquals("mp4", SplashPolicy.extensionOf("C:\\clips\\intro.mp4"))
    assertEquals("", SplashPolicy.extensionOf("no-dot"))
    assertEquals("", SplashPolicy.extensionOf(".hidden"))
    assertEquals("", SplashPolicy.extensionOf("trailing."))
  }

  @Test
  fun storedNameStaysInsideTheSplashFolder() {
    assertEquals("splash_video.mp4", SplashPolicy.storedFileName("../evil.mp4"))
    assertEquals("splash_video", SplashPolicy.storedFileName("no-extension"))
    assertEquals("splash_video.ts", SplashPolicy.storedFileName("clip.TS"))
  }

  @Test
  fun autostartDefaultsOnAndHonoursAnExplicitFalse() {
    assertTrue(SplashPolicy.autoStartEnabled(null))
    assertTrue(SplashPolicy.autoStartEnabled(true))
    assertFalse(SplashPolicy.autoStartEnabled(false))
  }

  @Test
  fun byteFormattingUsesOneDecimal() {
    assertEquals("512 B", SplashPolicy.formatBytes(512L))
    assertEquals("1.0 KB", SplashPolicy.formatBytes(1024L))
    assertEquals("50.0 MB", SplashPolicy.formatBytes(50L * 1024L * 1024L))
  }

  @Test
  fun durationFormattingIsEmptyForUnknownValues() {
    assertEquals("", SplashPolicy.formatDuration(-1L))
    assertEquals("", SplashPolicy.formatDuration(0L))
    assertEquals("0:07", SplashPolicy.formatDuration(7_000L))
    assertEquals("2:03", SplashPolicy.formatDuration(123_000L))
    assertEquals("1:00:05", SplashPolicy.formatDuration(3_605_000L))
  }

  /** The store must only ever touch its own folder and its own file names. */
  @Test
  fun storePathSourceStaysUnderFilesDirSplash() {
    val raw = source("SplashStore.kt")
    assertTrue(raw.contains("File(context.filesDir, DIR)"))
    assertTrue(raw.contains("private const val DIR = \"splash\""))
    assertFalse("must not use the shared snapshot tree", raw.contains("home/.dsh"))
    assertFalse("must not use the volatile cache dir", raw.contains("cacheDir"))
  }

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name)
    return file.readText()
  }
}
