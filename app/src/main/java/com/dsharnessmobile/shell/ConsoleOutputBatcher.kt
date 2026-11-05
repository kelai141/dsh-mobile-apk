package com.dsharnessmobile.shell

import java.io.Closeable
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Flushes a terminal burst by size or deadline, including when its reader is idle. */
internal class ConsoleOutputBatcher(
  private val maxChars: Int,
  private val delayMillis: Long,
  private val emit: (String) -> Unit,
) : Closeable {
  private val pending = StringBuilder()
  private val scheduler = Executors.newSingleThreadScheduledExecutor { task ->
    Thread(task, "dsh-console-output-flush").apply { isDaemon = true }
  }
  private var deadline: ScheduledFuture<*>? = null
  private var closed = false

  init {
    require(maxChars > 0 && delayMillis > 0)
  }

  @Synchronized fun append(text: String) {
    if (closed || text.isEmpty()) return
    pending.append(text)
    if (pending.length >= maxChars) {
      flush()
    } else if (deadline == null) {
      deadline = scheduler.schedule({ flush() }, delayMillis, TimeUnit.MILLISECONDS)
    }
  }

  @Synchronized fun flush() {
    deadline?.cancel(false)
    deadline = null
    if (pending.isEmpty()) return
    val text = pending.toString()
    pending.setLength(0)
    // Emission shares the append lock so a timer cannot overtake a producer's flush.
    emit(text)
  }

  @Synchronized override fun close() {
    if (closed) return
    closed = true
    try {
      flush()
    } finally {
      scheduler.shutdownNow()
    }
  }
}
