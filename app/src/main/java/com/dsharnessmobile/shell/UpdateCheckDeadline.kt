package com.dsharnessmobile.shell

import java.io.InterruptedIOException

/** Monotonic end-to-end budget shared by metadata sources and redirect hops. */
internal class UpdateCheckDeadline private constructor(
  private val expiresAt: Long,
  private val now: () -> Long,
  private val isActive: () -> Boolean,
) {
  fun remainingMs(): Long {
    if (!isActive()) throw InterruptedIOException("Update check was cancelled")
    val remaining = expiresAt - now()
    if (remaining <= 0) throw InterruptedIOException("Update check deadline exceeded")
    return remaining
  }

  fun timeoutMs(limit: Int): Int = minOf(limit.toLong(), remainingMs()).coerceAtLeast(1).toInt()

  fun source(timeoutMs: Int): UpdateCheckDeadline =
    UpdateCheckDeadline(minOf(expiresAt, now() + timeoutMs.toLong() * 2), now, isActive)

  companion object {
    // Six connect/read pairs total 182 seconds; retain scheduling and parsing headroom.
    const val TOTAL_MS = 200_000L

    fun start(
      now: () -> Long = { System.nanoTime() / 1_000_000 },
      isActive: () -> Boolean = { true },
    ): UpdateCheckDeadline = UpdateCheckDeadline(now() + TOTAL_MS, now, isActive)
  }
}
