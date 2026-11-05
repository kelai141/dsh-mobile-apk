package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1367 回归：修复助手的备份必须**可读**、仍不可写。
 *
 * 缺陷形态：`write` 为被覆盖的文件留备份并回传 backup id，系统提示词也承诺「write 会备份」，
 * 但 `ensureAllowed` 对所有 `/repair-backups/` 路径一律拒绝 ⇒ `read` / `list` 既不能枚举也不能读取
 * ⇒ bash 不可用时（正是修复助手存在的场景）模型没有任何回滚路径。
 */
class RepairBackupAccessTest {

  private val backupFile = "/data/user/0/com.dsharnessmobile.shell/files/" +
    RepairTools.BACKUP_DIR + "/settings.yaml.20261104-101500"
  private val backupDir = "/data/user/0/com.dsharnessmobile.shell/files/" + RepairTools.BACKUP_DIR
  private val normalFile = "/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/settings.yaml"

  @Test
  fun `备份文件与备份目录允许读取`() {
    assertFalse("备份文件必须可读（否则没有回滚路径）", backupWriteDenied(backupFile, write = false))
    assertFalse("备份目录必须可枚举", backupWriteDenied(backupDir, write = false))
  }

  @Test
  fun `备份仍然拒绝写入`() {
    assertTrue("备份文件不得被改写", backupWriteDenied(backupFile, write = true))
    assertTrue("备份目录不得被写", backupWriteDenied(backupDir, write = true))
  }

  @Test
  fun `普通路径两个方向都不受影响`() {
    assertFalse(backupWriteDenied(normalFile, write = true))
    assertFalse(backupWriteDenied(normalFile, write = false))
  }

  @Test
  fun `名字里含 repair-backups 但不构成路径段的目录不算备份面`() {
    // 只认「/repair-backups/」路径段或以其结尾；`my-repair-backups-notes.txt` 这种不应被拦。
    assertFalse(backupWriteDenied("/data/user/0/pkg/files/my-repair-backups-notes.txt", write = true))
  }

  @Test
  fun `ensureAllowed 必须走这条判据，且拒绝文案说明只读`() {
    val src = File(File("src/main/java/com/dsharnessmobile/shell"), "RepairTools.kt").readText()
      .lineSequence()
      .filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") }
      .joinToString("\n")
    assertTrue("ensureAllowed 必须调用 backupWriteDenied", src.contains("if (backupWriteDenied(path, write)) {"))
    assertFalse(
      "不得回到「一律拒绝」的旧形态",
      src.contains("path.contains(\"/repair-backups/\") || path.endsWith(\"/repair-backups\")"),
    )
    assertTrue("拒绝文案必须说明只允许读取", src.contains("修复备份目录只允许读取"))
  }
}
