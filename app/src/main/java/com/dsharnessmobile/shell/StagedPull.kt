package com.dsharnessmobile.shell

import java.io.File
import java.util.UUID

/**
 * 分块取回的**暂存落点**（issue #1600）。
 *
 * 缺陷形态：`pullFileInternal` 用 `FileOutputStream(target)` 边拉边写，写完即用。三条失败路径
 * （远端不可读、超出传输上限、catch 里的 lease.failed）都**不删**已写字节——模型拿到
 * `ok:false` + `offset:N`，而 `local` 路径上躺着一个看起来完整、实际被截断的文件。之后再打开
 * sqlite/apk 得到的是静默损坏的数据，而 `partial` 字段不会跟着文件走。
 *
 * 本类把「写到哪」与「什么时候可见」分开：
 *  - [begin] 给出一个同目录、唯一命名的暂存文件（UUID 后缀，两次并发取回不会互相踩）；
 *  - [commit] 在**全部字节都落盘之后**才经 [AtomicFileReplace.publish] 原子发布；
 *  - [discard] 是失败路径的唯一出口：删掉暂存文件，目标保持原样（旧内容或不存在）。
 *
 * 语义保证：目标文件要么是**上一次的完整内容**，要么是**这一次的完整内容**，不存在第三种。
 * 这条保证由 [commit] 的字节数复核与 [discard] 的清理共同维持，单测可直接打真实文件。
 */
internal class StagedPull private constructor(val target: File, val staging: File) {

  /** 已发布（commit 成功）后不再删暂存文件——它已经变成目标本身。 */
  private var published = false

  /**
   * 把暂存文件原子发布到目标。
   *
   * @param bytes 调用方确认已写入暂存的字节数（**必须**与暂存文件实际长度一致，否则不发布）。
   * @return true = 目标现在就是本次内容；false = 发布失败，目标保持原样（调用方须如实回报）。
   */
  fun commit(bytes: Long): Boolean {
    if (staging.length() != bytes) return false
    published = AtomicFileReplace.publish(staging, target)
    return published
  }

  /** 失败/早退路径的唯一收口：暂存文件不得留在用户目录里（它是半截文件，不是证据）。 */
  fun discard() {
    if (published) return
    runCatching { staging.delete() }
  }

  companion object {
    /**
     * 在目标同目录开一个暂存文件。
     *
     * 必须同目录：跨文件系统的 rename 不是原子的（[AtomicFileReplace.publish] 会退化成非原子
     * move，掉电后目标可能是半截）。父目录不存在时先建出来——与旧实现一致。
     */
    fun begin(target: File): StagedPull {
      target.parentFile?.mkdirs()
      val staging = File(target.parentFile, target.name + "." + UUID.randomUUID() + ".tmp")
      return StagedPull(target, staging)
    }
  }
}
