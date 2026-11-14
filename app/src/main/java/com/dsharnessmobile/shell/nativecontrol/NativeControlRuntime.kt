package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import com.dsharnessmobile.shell.LogCollector
import com.dsharnessmobile.shell.ScreenScopePrefs
import com.dsharnessmobile.shell.ShizukuTransport
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Shell-owned native host. Engine restarts do not recreate the Rust controller or its receipts. */
internal object NativeControlRuntime {
  private val lifecycle = Executors.newSingleThreadExecutor { task ->
    Thread(task, "native-control-lifecycle").apply { isDaemon = true }
  }
  private val desiredEpoch = AtomicLong(0)
  private var host: NativeControlHost? = null
  private val observer = Executors.newSingleThreadScheduledExecutor { task ->
    Thread(task, "native-control-observer").apply { isDaemon = true }
  }
  private var observation: ScheduledFuture<*>? = null

  fun ensureStarted(context: Context) {
    val app = context.applicationContext
    val epoch = desiredEpoch.get()
    lifecycle.execute {
      if (epoch != desiredEpoch.get() || host != null) return@execute
      try {
        val a11y = NativeA11yExecution()
        val androidFacts = NativePlatformFacts(app, a11y, { ScreenScopePrefs.current(app).wire })
        val androidExecution = NativeSharedHostExecution(NativeShizukuExecution(a11y), NativeVdisplayExecution({ app }))
        val opened = NativeControlHost.open(app,
          NativeControlDispatcher.Facts { NativePrivilegeFacts.augment(app, androidFacts.capture()) },
          NativeEnvironmentExecution(app, NativePrivilegeExecution(app, androidExecution)))
        if (epoch != desiredEpoch.get()) opened.close() else {
          host = opened
          observation = observer.scheduleWithFixedDelay({
            if (epoch == desiredEpoch.get()) runCatching {
              // Preparation is separate from the nonblocking facts reader and never prompts.
              ShizukuTransport.observeNativeDisplays(app)
            }
          }, 0L, 10L, TimeUnit.SECONDS)
          LogCollector.writeBootDiag(app, "native-control", "status=ready protocol=1")
        }
      } catch (failure: Exception) {
        reportStartFailure(app, failure)
      } catch (failure: LinkageError) {
        reportStartFailure(app, failure)
      }
    }
  }

  fun stop() {
    desiredEpoch.incrementAndGet()
    lifecycle.execute {
      observation?.cancel(true)
      observation = null
      host?.close()
      host = null
    }
  }

  private fun reportStartFailure(app: Context, failure: Throwable) {
    val code = failure.message?.takeIf { it.matches(Regex("[a-z][a-z0-9:-]{0,119}")) }
      ?: failure.javaClass.simpleName
    LogCollector.writeBootDiag(app, "native-control", "status=unavailable code=$code")
  }
}
