package com.dsharnessmobile.shell.nativecontrol

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Bounds active and optionally queued work. A settled operation frees its slot before replying. */
internal class NativeOperationWorker(name: String, parallelism: Int = 1, queued: Int = 0) {
  private val slots = Semaphore(parallelism + queued)
  private val executor = ThreadPoolExecutor(
    parallelism, parallelism, 10, TimeUnit.SECONDS, ArrayBlockingQueue(parallelism + queued),
  ) { task -> Thread(task, name).apply { isDaemon = true } }.apply { allowCoreThreadTimeOut(true) }

  fun <T> supplyAsync(operation: () -> T): CompletableFuture<T> {
    if (!slots.tryAcquire()) throw RejectedExecutionException("native operation worker is busy")
    val result = CompletableFuture<T>()
    try {
      executor.execute {
        val outcome = try {
          runCatching(operation)
        } finally {
          slots.release()
        }
        outcome.fold(result::complete, result::completeExceptionally)
      }
    } catch (error: RejectedExecutionException) {
      slots.release()
      throw error
    }
    return result
  }
}
