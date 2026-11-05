package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * issue #1600 回归：shPull 的失败路径不得留下同名半截文件。
 *
 * 缺陷形态：`pullFileInternal` 用 `FileOutputStream(target)` 边拉边写，三条失败路径（远端不可读、
 * 超出传输上限、catch）都不删已写字节。模型拿到 `ok:false` + `offset:N`，而 `local` 路径上躺着
 * 一个看起来完整、实际被截断的文件——之后打开 sqlite/apk 得到的是静默损坏的数据。
 *
 * 判据全部打在 [StagedPull] 的真实文件行为上（TemporaryFolder，无 mock）：
 *  1. 未 commit 就 discard：目标**不存在**，且暂存文件也没了（不留垃圾）；
 *  2. 未 commit 就 discard：目标**已存在时保持原值**（旧内容不得被半截内容覆盖）；
 *  3. commit 的字节数复核：暂存长度与声明字节不符时**拒绝发布**，目标保持原样；
 *  4. 正控：commit 成功后目标就是本次内容，且暂存文件已被搬走（不再单独存在）。
 *
 * 判别力：把实现改回「直写 target」时，用例 1/2/3 全部变红（目标会出现/被截断）。
 */
class StagedPullTest {

  @get:Rule
  val tmp = TemporaryFolder()

  private fun target(): File = File(tmp.root, "files/home/pulled.bin")

  @Test
  fun discardingWithoutCommitNeverCreatesTheTarget() {
    val target = target()
    val staged = StagedPull.begin(target)
    staged.staging.writeBytes(ByteArray(10) { 7 })
    assertFalse("暂存阶段目标不得出现（这正是半截文件的来源）", target.exists())

    staged.discard()
    assertFalse("失败路径不得留下目标文件", target.exists())
    assertFalse("暂存文件必须被清掉（不留垃圾）", staged.staging.exists())
  }

  @Test
  fun discardingWithoutCommitKeepsThePreviousContent() {
    val target = target().apply { parentFile.mkdirs(); writeText("完整旧内容") }
    val staged = StagedPull.begin(target)
    staged.staging.writeText("半截新内容")

    staged.discard()
    assertEquals("失败路径必须保持上一次的完整内容", "完整旧内容", target.readText())
    assertFalse("暂存文件必须被清掉", staged.staging.exists())
  }

  @Test
  fun commitRefusesWhenTheStagedLengthDoesNotMatchTheClaimedBytes() {
    val target = target().apply { parentFile.mkdirs(); writeText("旧") }
    val staged = StagedPull.begin(target)
    staged.staging.writeBytes(ByteArray(4))

    assertFalse("字节数不符时不得发布（否则又是一份静默截断的文件）", staged.commit(99))
    assertEquals("拒绝发布时目标保持原样", "旧", target.readText())
    staged.discard()
    assertFalse(staged.staging.exists())
  }

  @Test
  fun committingPublishesTheCompleteContentAndRemovesTheStagingFile() {
    val target = target()
    val staged = StagedPull.begin(target)
    val body = ByteArray(1024) { (it % 251).toByte() }
    staged.staging.writeBytes(body)

    assertTrue("字节数相符时必须发布成功", staged.commit(body.size.toLong()))
    assertTrue("目标必须出现", target.isFile)
    assertEquals("目标内容必须逐字节等于本次取回内容", body.size.toLong(), target.length())
    assertTrue(target.readBytes().contentEquals(body))
    assertFalse("暂存文件不得残留（它已经被搬成目标）", staged.staging.exists())
    // commit 之后再 discard 是空操作：它已经是目标本身了，绝不能再删。
    staged.discard()
    assertTrue("发布后 discard 不得删掉目标", target.isFile)
  }
}
