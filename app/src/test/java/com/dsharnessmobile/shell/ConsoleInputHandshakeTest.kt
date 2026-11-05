package com.dsharnessmobile.shell

import android.content.ContextWrapper
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConsoleInputHandshakeTest {
  private class Relay(private val output: OutputStream) : Process() {
    override fun getOutputStream() = output
    override fun getInputStream() = ByteArrayInputStream(byteArrayOf())
    override fun getErrorStream() = ByteArrayInputStream(byteArrayOf())
    override fun waitFor() = 0
    override fun exitValue() = 0
    override fun destroy() = Unit
  }

  private fun field(name: String) = ConsoleSession::class.java.getDeclaredField(name).apply { isAccessible = true }
  private fun session(process: Process, pty: Boolean = true) = ConsoleSession(ContextWrapper(null)).apply {
    field("process").set(this, process)
    field("usingPty").setBoolean(this, pty)
  }

  @Test fun inputBlockedAcrossReadyCannotBeStranded() {
    val output = ByteArrayOutputStream()
    val relay = Relay(output)
    val session = session(relay)
    val writer = Thread { session.writeRaw("early\n") }
    synchronized(field("inputLock").get(session)) {
      writer.start()
      val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
      while (writer.state != Thread.State.BLOCKED && System.nanoTime() < until) Thread.yield()
      assertEquals(Thread.State.BLOCKED, writer.state)
      assertTrue(session.completePtyHandshake(relay, 0))
    }
    writer.join(2000)
    assertFalse(writer.isAlive)
    assertEquals("", field("pendingInput").get(session).toString())
    assertEquals("early\n", JSONObject(output.toString("UTF-8")).getString("data"))
  }

  @Test fun queuedInputPrecedesWritesThatOverlapItsReplay() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val bytes = ByteArrayOutputStream()
    val output = object : OutputStream() {
      override fun write(value: Int) = bytes.write(value)
      override fun write(buffer: ByteArray, offset: Int, length: Int) {
        if (entered.count > 0) {
          entered.countDown()
          check(release.await(5, TimeUnit.SECONDS))
        }
        bytes.write(buffer, offset, length)
      }
    }
    val relay = Relay(output)
    val session = session(relay)
    session.writeRaw("early")
    assertEquals(0, bytes.size())
    val failure = AtomicReference<Throwable?>()
    val ready = Thread { try { assertTrue(session.completePtyHandshake(relay, 0)) } catch (error: Throwable) { failure.set(error) } }
    val later = Thread { try { session.writeRaw("later") } catch (error: Throwable) { failure.set(error) } }
    try {
      ready.start()
      assertTrue(entered.await(2, TimeUnit.SECONDS))
      later.start()
      val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
      while (later.state != Thread.State.BLOCKED && System.nanoTime() < until) Thread.yield()
      assertEquals(Thread.State.BLOCKED, later.state)
    } finally { release.countDown() }
    ready.join(2000)
    later.join(2000)
    assertFalse(ready.isAlive)
    assertFalse(later.isAlive)
    failure.get()?.let { throw it }
    val frames = bytes.toString("UTF-8").lineSequence().filter { it.isNotBlank() }.map { JSONObject(it).getString("data") }.toList()
    assertEquals(listOf("early", "later"), frames)
    assertEquals("", field("pendingInput").get(session).toString())
  }

  @Test fun staleReadyCannotDrainTheCurrentQueue() {
    val output = ByteArrayOutputStream()
    val relay = Relay(output)
    val session = session(relay)
    session.writeRaw("keep")
    field("generation").setInt(session, 1)
    assertFalse(session.completePtyHandshake(relay, 0))
    assertFalse(session.hasPty())
    assertEquals("keep", field("pendingInput").get(session).toString())
    assertEquals(0, output.size())
  }

  @Test fun fallbackInputRetainsItsLiteralBytes() {
    val output = ByteArrayOutputStream()
    val session = session(Relay(output), pty = false)
    session.writeRaw("echo literal\\n\n")
    assertEquals("echo literal\\n\n", output.toString("UTF-8"))
  }

  @Test fun failedReplayDoesNotPublishReadiness() {
    val relay = Relay(object : OutputStream() { override fun write(value: Int) { throw IOException("closed relay") } })
    val session = session(relay)
    session.writeRaw("early")
    assertFalse(session.completePtyHandshake(relay, 0))
    assertFalse(session.hasPty())
  }
}
