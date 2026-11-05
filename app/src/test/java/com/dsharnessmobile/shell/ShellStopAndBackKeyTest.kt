package com.dsharnessmobile.shell

import android.view.KeyEvent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1601 / #1612 的**行为**判据（真实线程 + 真值表，不是源码文本切片）。
 *
 * 这两条缺陷的判据此前只能落在「源码里有 join / 有 KEYCODE_BACK」这类形态断言上——形态在、
 * 语义不对时照样全绿（例如 join 超时写成 0、BACK 判定写成 ACTION_DOWN 才算）。
 * 把判定抽成 [WorkerJoin] / [OverlayBackKey] 之后，判据可以打在真实可观测行为上。
 */
class ShellStopAndBackKeyTest {

  // ── issue #1601：停机必须真的等到执行线程离开 ────────────────────────────────

  /** 反证：线程还在跑时必须报 false（旧形态「只翻标志位就返回」在这里恒为 true）。 */
  @Test
  fun reportsStillRunningWhenTheWorkerOutlivesTheBound() {
    val release = java.util.concurrent.CountDownLatch(1)
    val worker = Thread { release.await() }
    worker.isDaemon = true
    worker.start()
    try {
      val done = WorkerJoin.joinQuietly(worker, 50)
      assertFalse("线程仍在跑时不得报「已停干净」（issue #1601）", done)
      assertTrue("等待必须有界：50ms 上界到点即返回", worker.isAlive)
    } finally {
      release.countDown()
      worker.join(2_000)
    }
  }

  /**
   * 正控 + 判别力：线程会在 150ms 后自己结束，[WorkerJoin] 必须**真的等**到它结束再报 true。
   *
   * 这条是「只翻标志位就返回」的克星：旧形态立刻返回 false（线程还活着），而「等了但没等到」
   * 的形态会报 false。只有真等且等到了才会 true，且耗时必然 >= 线程的存活时间。
   */
  @Test
  fun waitsForAWorkerThatIsAboutToExit() {
    val worker = Thread { Thread.sleep(150) }
    worker.isDaemon = true
    worker.start()
    val started = System.nanoTime()
    val done = WorkerJoin.joinQuietly(worker, 5_000)
    val elapsedMs = (System.nanoTime() - started) / 1_000_000
    assertTrue("必须等到线程真的结束并报 true（issue #1601）", done)
    assertTrue("必须真的等过（实测 " + elapsedMs + "ms，旧形态恒为 0）", elapsedMs >= 100)
    assertFalse("等到了就不该还活着", worker.isAlive)
  }

  /** 已经退出的线程 / 从未启动（null）都视为已结束，不得把一次成功等待拖成超时。 */
  @Test
  fun reportsStoppedForAnAlreadyFinishedWorker() {
    val worker = Thread { }
    worker.isDaemon = true
    worker.start()
    worker.join(2_000)
    assertTrue("线程已退出必须报 true", WorkerJoin.joinQuietly(worker, 50))
    assertTrue("从未启动（null）视为已结束", WorkerJoin.joinQuietly(null, 50))
  }

  /** 停机路径上的等待不得把「当前线程就是执行线程」变成 2 秒卡顿。 */
  @Test
  fun waitingOnItselfReturnsImmediately() {
    val started = System.nanoTime()
    assertTrue("自己等自己直接视为已结束", WorkerJoin.joinQuietly(Thread.currentThread(), 2_000))
    val elapsedMs = (System.nanoTime() - started) / 1_000_000
    assertTrue("不得真的等满上界（实测 " + elapsedMs + "ms）", elapsedMs < 500)
  }

  // ── issue #1612：面板展开期间返回键必须能收起面板 ───────────────────────────

  /** 真值表：只有 BACK 的 ACTION_UP 收起；按下不动作，其它键一律不拦。 */
  @Test
  fun onlyBackKeyReleaseCollapsesThePanel() {
    assertTrue("BACK 抬手必须收起", OverlayBackKey.shouldCollapse(KeyEvent.KEYCODE_BACK, KeyEvent.ACTION_UP))
    assertFalse("BACK 按下不得收起（与系统语义一致）",
      OverlayBackKey.shouldCollapse(KeyEvent.KEYCODE_BACK, KeyEvent.ACTION_DOWN))
    assertFalse("HOME 不得被面板吞掉",
      OverlayBackKey.shouldCollapse(KeyEvent.KEYCODE_HOME, KeyEvent.ACTION_UP))
    assertFalse("回车不得被面板吞掉（输入法/编辑依赖它）",
      OverlayBackKey.shouldCollapse(KeyEvent.KEYCODE_ENTER, KeyEvent.ACTION_UP))
  }
}
