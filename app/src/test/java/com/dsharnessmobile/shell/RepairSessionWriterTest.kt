package com.dsharnessmobile.shell

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1017：会话落盘挪到写线程之后，**顺序语义**必须仍然成立。
 *
 * 把序列化与文件 IO 移出主线程会引入本仓最怕的一类回归：「切换会话后旧数据覆盖新数据」。
 * 切会话的调用序列是「先存旧会话、再加载新会话」，若两笔写盘可以并发或乱序，旧快照可能
 * 后落盘盖掉新快照。本类用真实线程钉住 [RepairSessionWriter] 的五条契约：
 *  1. 同一时刻只有一次写盘（不重叠）；
 *  2. 最新覆盖：flush 后盘上内容 = 最后提交的那笔；
 *  3. flush 会等到在途提交真正落盘（退出不丢最后一笔）；
 *  4. 单笔失败不阻塞后续快照；
 *  5. 空转时不 panic（无提交也能 flush）。
 */
class RepairSessionWriterTest {

  private fun conversation(id: String): RepairConversation = RepairConversation(
    id = id,
    title = id,
    history = JSONArray().put(JSONObject().put("role", "user").put("content", id)),
    events = JSONArray(),
  )

  @Test
  fun `writes never overlap and the last submitted snapshot wins`() {
    val concurrent = AtomicInteger(0)
    val maxConcurrent = AtomicInteger(0)
    val written = Collections.synchronizedList(mutableListOf<String>())
    val writer = RepairSessionWriter { session ->
      val now = concurrent.incrementAndGet()
      maxConcurrent.updateAndGet { previous -> if (now > previous) now else previous }
      Thread.sleep(5)
      written += session.id
      concurrent.decrementAndGet()
    }
    for (index in 1..20) writer.submit(conversation("c" + index))
    assertTrue("flush 必须等到最后一笔落盘", writer.flush(10_000))
    assertEquals("任意时刻只允许一笔在写（并发写会让旧快照盖掉新快照）", 1, maxConcurrent.get())
    assertEquals("flush 之后盘上必须是最新提交的那笔", "c20", written.last())
  }

  @Test
  fun `flush waits for an in flight write instead of returning early`() {
    val landed = AtomicBoolean(false)
    val writer = RepairSessionWriter { _ ->
      Thread.sleep(60)
      landed.set(true)
    }
    writer.submit(conversation("slow"))
    assertTrue("flush 必须返回 true", writer.flush(10_000))
    assertTrue("flush 返回时那笔必须真的已经落盘（退出不丢最后一笔）", landed.get())
  }

  @Test
  fun `a failed write does not stop later snapshots`() {
    val saved = Collections.synchronizedList(mutableListOf<String>())
    val writer = RepairSessionWriter { session ->
      if (session.id == "boom") throw IllegalStateException("disk full")
      saved += session.id
    }
    writer.submit(conversation("boom"))
    assertFalse("失败必须被记账", writer.flush(10_000))
    writer.submit(conversation("next"))
    assertTrue("后续快照仍要能落盘（每笔都是完整会话）", writer.flush(10_000))
    assertTrue("后续快照必须真的写下去", saved.contains("next"))
  }

  @Test
  fun `flushing without any submission succeeds`() {
    val writer = RepairSessionWriter { _ -> throw AssertionError("不该有写盘") }
    assertTrue(writer.flush(1_000))
  }

  @Test
  fun `the disk write runs off the submitting thread`() {
    val submitter = Thread.currentThread().name
    var writeThread: String? = null
    val latched = CountDownLatch(1)
    val writer = RepairSessionWriter { _ ->
      writeThread = Thread.currentThread().name
      latched.countDown()
    }
    writer.submit(conversation("threaded"))
    assertTrue(latched.await(10, TimeUnit.SECONDS))
    assertEquals("落盘必须在专用写线程上", "dsh-repair-session-writer", writeThread)
    assertFalse("落盘不得在提交线程上", writeThread == submitter)
    writer.flush(10_000)
  }
  @Test
  fun `flush never writes concurrently with the write already in flight`() {
    // 守的是「旧数据覆盖新数据」的真实入口：写线程正在写 A 时，flush 若在调用线程上
    // 再写 B，两笔交错后盘上的内容既不是 A 也不是 B。
    // 判据（确定性，不依赖时序）：等写线程真的进入 save 之后，超时 flush 必须报 false，
    // 且全程并发写数恒为 1、每笔快照只写一次。
    val inFlight = CountDownLatch(1)
    val release = CountDownLatch(1)
    val calls = AtomicInteger(0)
    val concurrent = AtomicInteger(0)
    val maxConcurrent = AtomicInteger(0)
    val writer = RepairSessionWriter { _ ->
      val now = concurrent.incrementAndGet()
      maxConcurrent.updateAndGet { previous -> if (now > previous) now else previous }
      calls.incrementAndGet()
      inFlight.countDown()
      release.await(10, TimeUnit.SECONDS)
      concurrent.decrementAndGet()
    }
    writer.submit(conversation("first"))
    assertTrue("写线程必须真的开始写", inFlight.await(10, TimeUnit.SECONDS))
    assertFalse("写盘仍在途时 flush 必须报 false（不得假装已落盘）", writer.flush(80))
    // 在途期间再提交一笔：不允许把在途的写挤成并发写。
    writer.submit(conversation("second"))
    assertEquals("flush 超时兜底不得与在途写盘并发", 1, maxConcurrent.get())
    release.countDown()
    assertTrue("放行后 flush 必须成功", writer.flush(10_000))
    assertEquals("全程任意时刻只允许一笔在写", 1, maxConcurrent.get())
    assertEquals("每笔快照只写一次", 2, calls.get())
  }
}
