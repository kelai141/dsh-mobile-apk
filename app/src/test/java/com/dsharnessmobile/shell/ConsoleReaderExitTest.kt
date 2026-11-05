package com.dsharnessmobile.shell

import android.content.ContextWrapper
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import org.junit.Assert.*
import org.junit.Test

class ConsoleReaderExitTest {
  private class FakeProcess(private val source: InputStream, private val code: Int = 23) : Process() {
    override fun getInputStream() = source
    override fun getOutputStream() = ByteArrayOutputStream()
    override fun getErrorStream() = ByteArrayInputStream(byteArrayOf())
    override fun waitFor() = code
    override fun exitValue() = code
    override fun destroy() = Unit
  }

  private class Events : ConsoleSession.Listener {
    val exits = mutableListOf<Int>()
    val sequence = mutableListOf<String>()
    override fun onOutput(text: String) { sequence.add("output:$text") }
    override fun onStatus(state: ConsoleSession.State, text: String) { sequence.add(state.wire) }
    override fun onExit(code: Int) { exits.add(code); sequence.add("exit:$code") }
  }

  private fun session(): ConsoleSession = ConsoleSession(ContextWrapper(null)).apply {
    javaClass.getDeclaredField("ptyReady").apply { isAccessible = true }.setBoolean(this, true)
  }

  @Test fun unexpectedPtyEofReportsExitAndClearsReadiness() {
    val session = session()
    val events = Events()
    session.readOutput(FakeProcess(ByteArrayInputStream(byteArrayOf())), 0, true, events)
    assertEquals(listOf(23), events.exits)
    assertFalse(session.hasPty())
  }

  @Test fun bufferedTailIsDeliveredBeforeUnexpectedExit() {
    val session = session()
    val events = Events()
    session.readOutput(FakeProcess(ByteArrayInputStream("{\"op\":\"data\",\"data\":\"tail\"}\n".toByteArray())), 0, true, events)
    assertEquals(listOf("output:tail", "exit:23"), events.sequence)
  }

  @Test fun explicitExitFrameIsNotReportedAgainAtEof() {
    val session = session()
    val events = Events()
    session.readOutput(FakeProcess(ByteArrayInputStream("{\"op\":\"exit\",\"code\":7}\n".toByteArray())), 0, true, events)
    assertEquals(listOf(7), events.exits)
    assertFalse(session.hasPty())
  }

  @Test fun readFailureStillReportsExit() {
    val session = session()
    val events = Events()
    session.readOutput(FakeProcess(object : InputStream() { override fun read(): Int = throw IOException("closed relay") }), 0, true, events)
    assertEquals(listOf(23), events.exits)
    assertFalse(session.hasPty())
  }

  @Test fun oldReaderCannotEndANewerSession() {
    val session = session()
    val events = Events()
    session.readOutput(FakeProcess(ByteArrayInputStream(byteArrayOf())), -1, true, events)
    assertTrue(events.exits.isEmpty())
    assertTrue(session.hasPty())
  }

  @Test fun fallbackEofStillReportsExit() {
    val session = session()
    val events = Events()
    session.readOutput(FakeProcess(ByteArrayInputStream("fallback\n".toByteArray())), 0, false, events)
    assertEquals(listOf("output:fallback\n", "exit:23"), events.sequence)
  }
}
