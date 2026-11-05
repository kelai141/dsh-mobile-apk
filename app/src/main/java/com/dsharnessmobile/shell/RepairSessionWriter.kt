package com.dsharnessmobile.shell

import org.json.JSONArray
import org.json.JSONObject

/**
 * 会话快照的**单线程写盘器**（#1017）。
 *
 * 缺陷形态：`RepairActivity.saveCurrentSession()` 在**调用线程**上把 history+events 序列化
 * 并原子落盘，还会顺带重写 index.json 与做一次 prune 目录扫描。调用点里 onCreate 之后的
 * 自动开修、切会话、关模型面板、onDestroy 全在主线程——等于把整份会话 JSON 的序列化与
 * 文件 IO 压在首帧和交互路径上。
 *
 * 为什么不能简单扔进一个共享线程池：会话写入有**顺序语义**。切会话时是「先存旧会话、
 * 再加载新会话」，若允许两笔并发，旧快照可能后落盘覆盖新快照，用户看到的就是
 * 「切换会话后内容还是上一个会话的」。所以本类的契约是：
 *  1. **同一时刻只有一次写盘**：`writing` 标志保证任意两笔 save 不重叠，任何时刻盘上的
 *     内容都是某一笔完整快照，而不是两笔交错后的混合；
 *  2. **最新覆盖**：提交之间只保留最后一笔快照。每笔提交都是提交时刻的完整会话，
 *     丢掉被顶掉的旧快照是「更新的替换更旧的」，不是丢增量；
 *  3. **退出必须 flush**：`flush()` 等到最近一笔真正落盘；超时则在调用线程兜底写完，
 *     进程被回收（onDestroy）时不允许丢最后一笔；
 *  4. **失败隔离**：单笔写失败只记账，不阻塞后续快照落盘。
 *
 * 线程模型：`submit` 在锁内只换引用并（首次）起线程，O(1) 且不碰磁盘；真正的序列化与
 * 落盘发生在名为 `dsh-repair-session-writer` 的守护线程上，且**不持锁执行**——
 * 主线程提交时不会被在途写盘阻塞。
 */
internal class RepairSessionWriter(private val save: (RepairConversation) -> Unit) {

  // 必须用 java.lang.Object 的监视器：Any() 上不存在 wait/notifyAll。
  private val lock = java.lang.Object()
  private var pending: RepairConversation? = null
  private var writer: Thread? = null
  private var writing = false
  private var failure: Throwable? = null

  /** 提交一笔完整快照；立即返回，落盘在写线程上串行发生。 */
  fun submit(session: RepairConversation) {
    synchronized(lock) {
      pending = session
      if (writer == null) {
        val worker = Thread({ drain() }, THREAD_NAME).apply { isDaemon = true }
        writer = worker
        worker.start()
      }
      lock.notifyAll()
    }
  }

  /**
   * 等「此刻之前提交的所有快照」落盘。
   * 返回 true = 最新一笔已在盘上；false = 超时或写盘出错。
   * 超时且当前没有在途写盘时，在调用线程上把最后一笔同步写完（退出路径宁慢不丢）。
   */
  fun flush(timeoutMs: Long = DEFAULT_FLUSH_TIMEOUT_MS): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    synchronized(lock) {
      while (pending != null || writing || writer != null) {
        val remaining = deadline - System.currentTimeMillis()
        if (remaining <= 0) break
        try {
          lock.wait(remaining)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          break
        }
      }
      if (pending == null && !writing && writer == null) return failure == null
      // 兜底：只在没有在途写盘时取走最后一笔，避免与写线程交错成「旧覆盖新」。
      if (writing) return false
      val last = pending
      pending = null
      if (last == null) return failure == null
      return try {
        save(last)
        failure = null
        true
      } catch (error: Throwable) {
        failure = error
        false
      }
    }
  }

  /** 最近一次写盘失败；供诊断与测试断言，全部成功时为 null。 */
  internal fun lastFailure(): Throwable? = synchronized(lock) { failure }

  private fun drain() {
    while (true) {
      val snapshot: RepairConversation
      synchronized(lock) {
        val next = pending
        if (next == null) {
          if (writer === Thread.currentThread()) writer = null
          lock.notifyAll()
          return
        }
        pending = null
        writing = true
        snapshot = next
      }
      try {
        save(snapshot)
        // 成功一笔就清掉上一笔的失败：failure 描述的必须是**最近一笔**的结果，
        // 否则一次历史失败会让后续每次 flush 恒返回 false（退出判据失去意义）。
        synchronized(lock) { failure = null }
      } catch (error: Throwable) {
        // 一笔失败不能吞掉后续快照：每一笔都是完整会话，下一笔仍要落盘。
        synchronized(lock) { failure = error }
      } finally {
        synchronized(lock) {
          writing = false
          lock.notifyAll()
        }
      }
    }
  }

  private companion object {
    const val THREAD_NAME = "dsh-repair-session-writer"
    const val DEFAULT_FLUSH_TIMEOUT_MS = 2_000L
  }
}

/**
 * 会话数组的**结构化深拷贝**，用于在提交线程上取一份不会被后续改写污染的快照。
 *
 * 为什么不用「`toString()` 再 `JSONArray(...)` 解析回来」：那正是修前会话写盘路径上的
 * 序列化开销（整份历史过一次字符串再解析回来），而且它发生在提交线程上。递归拷贝是
 * O(元素数) 的结构复制，不产生整份字符串，于是真正的 `toString()` 与文件写都落到写线程。
 * 语义与旧实现一致：快照冻结的是**调用那一刻**的内容。
 */
internal object RepairSessionJson {
  fun copy(array: JSONArray): JSONArray {
    val result = JSONArray()
    for (index in 0 until array.length()) {
      when (val value = array.opt(index)) {
        is JSONObject -> result.put(copy(value))
        is JSONArray -> result.put(copy(value))
        else -> result.put(value)
      }
    }
    return result
  }

  private fun copy(source: JSONObject): JSONObject {
    val result = JSONObject()
    val keys = source.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      when (val value = source.opt(key)) {
        is JSONObject -> result.put(key, copy(value))
        is JSONArray -> result.put(key, copy(value))
        else -> result.put(key, value)
      }
    }
    return result
  }
}