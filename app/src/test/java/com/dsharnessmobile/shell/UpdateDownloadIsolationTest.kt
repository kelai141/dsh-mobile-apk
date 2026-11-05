package com.dsharnessmobile.shell

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class UpdateDownloadIsolationTest {
  @get:Rule val folder = TemporaryFolder()

  private open class Connection(private val bytes: ByteArray) : HttpURLConnection(URL("https://github.com/test/release")) {
    var disconnected = false
    override fun connect() = Unit
    override fun disconnect() { disconnected = true }
    override fun usingProxy() = false
    override fun getResponseCode() = 200
    override fun getContentLengthLong() = bytes.size.toLong()
    override fun getInputStream(): InputStream = ByteArrayInputStream(bytes)
  }

  @Test fun retryAndInvalidatedDownloadOwnDifferentFiles() {
    val dest = File(folder.root, "app.apk")
    val paused = CountDownLatch(1)
    val resume = CountDownLatch(1)
    val active = AtomicBoolean(true)
    val oldResult = AtomicReference<String?>("pending")
    val failure = AtomicReference<Throwable?>()
    val old = Thread {
      try {
        oldResult.set(UpdateChecker.download("https://github.com/test/old", dest, {
          paused.countDown()
          check(resume.await(5, TimeUnit.SECONDS))
        }, allowMirrors = false, isActive = { active.get() },
          connectionFactory = { Connection("old-release".toByteArray()) }))
      } catch (error: Throwable) { failure.set(error) }
    }.apply { isDaemon = true; start() }
    try {
      assertTrue(paused.await(5, TimeUnit.SECONDS))
      val stagingCount = AtomicInteger()
      val used = UpdateChecker.download("https://github.com/test/new", dest, {
        stagingCount.set(folder.root.listFiles()!!.count { it.name.endsWith(".tmp") })
      }, allowMirrors = false, connectionFactory = { Connection("new-release".toByteArray()) })
      active.set(false)
      resume.countDown()
      old.join(5_000)
      assertFalse(old.isAlive)
      assertNull(failure.get())
      assertEquals(2, stagingCount.get())
      assertNotNull(used)
      assertNull(oldResult.get())
      assertEquals("new-release", dest.readText())
      assertEquals(listOf("app.apk"), folder.root.listFiles()!!.map { it.name })
    } finally {
      active.set(false)
      resume.countDown()
      old.join(5_000)
    }
  }

  @Test fun invalidationAtPublicationPreservesTheVerifiedTarget() {
    val dest = File(folder.root, "app.apk").apply { writeText("verified") }
    val publicationAsked = AtomicBoolean(false)
    val result = UpdateChecker.download("https://github.com/test/new", dest, {}, allowMirrors = false,
      publishIfActive = { publicationAsked.set(true); false },
      connectionFactory = { Connection("stale".toByteArray()) })
    assertTrue(publicationAsked.get())
    assertNull(result)
    assertEquals("verified", dest.readText())
    assertEquals(listOf("app.apk"), folder.root.listFiles()!!.map { it.name })
  }

  @Test fun failedReadCleansOnlyItsStagingFileAndDisconnects() {
    val dest = File(folder.root, "app.apk").apply { writeText("verified") }
    val connection = object : Connection(byteArrayOf(1)) {
      override fun getInputStream(): InputStream = object : InputStream() {
        override fun read(): Int = throw IOException("controlled read failure")
      }
    }
    val result = UpdateChecker.download("https://github.com/test/new", dest, {}, allowMirrors = false,
      connectionFactory = { connection })
    assertNull(result)
    assertTrue(connection.disconnected)
    assertEquals("verified", dest.readText())
    assertEquals(listOf("app.apk"), folder.root.listFiles()!!.map { it.name })
  }

  @Test fun successfulDownloadPublishesTheCompleteBytes() {
    val dest = File(folder.root, "app.apk")
    val connection = Connection("release".toByteArray())
    val progress = mutableListOf<Int>()
    val result = UpdateChecker.download("https://github.com/test/new", dest, { progress.add(it) },
      allowMirrors = false, connectionFactory = { connection })
    assertNotNull(result)
    assertEquals("release", dest.readText())
    assertEquals(100, progress.last())
    assertTrue(connection.disconnected)
  }

  @Test fun inactiveDownloadDoesNotOpenAConnection() {
    val dest = File(folder.root, "app.apk")
    val result = UpdateChecker.download("https://github.com/test/new", dest, {}, allowMirrors = false,
      isActive = { false }, connectionFactory = { error("inactive download opened a connection") })
    assertNull(result)
    assertTrue(folder.root.listFiles()!!.isEmpty())
  }
}
