package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 工作区目录选择能力闸（[WorkspacePickGate]）的判据测试。
 *
 * 缺陷背景见 [WorkspacePickGate] 类注释：权限判据在 pick 入口、只覆盖 API>=30，
 * 路径映射零判断，于是「没权限」被翻译成合法路径交给引擎，由引擎 realpath 抛 EACCES，
 * 英文原串上屏，用户点「重新选择」必然再失败。
 *
 * ## 本类必须能红（两条负控，缺一不可）
 *  1. **删掉能力探测** → [probeWritableWinsOverMissingPermission] 与
 *     [grantedButUnwritableIsNotProceed] 必红。前者证明「探到可写就放行」，后者证明
 *     「探不到就不放行」；两条方向相反，删掉 probe 只能同时满足一条。
 *  2. **把 probe 写成恒 true（过度拦截的反面：恒放行）** → [probeWritableWinsOverMissingPermission]
 *     仍绿但 [grantedButUnwritableIsNotProceed] 红。
 *  3. **把判据改回只看 isExternalStorageManager** → [api29UsesRuntimePermissionNotAllFilesAccess] 红
 *     （API 29 上那条路径永远拿不到 All Files Access）。
 *
 * ## 为什么用注入的 sdkInt
 * 直接读 Build.VERSION.SDK_INT 会让三分支里只有一条能在 JVM 上跑到，另两条只能靠真机——
 * 这正是本仓「判据只在真机上才被验证」的老问题。注入之后三条分支全部可判。
 */
class WorkspacePickGateTest {

  private fun shared() = WorkspacePickGate.SHARED_STORAGE_ROOT + "/Dsh 进化"

  // ── 三分支：结论 ────────────────────────────────────────────────────────────

  /** API>=30 无 All Files Access：引导「所有文件访问」。 */
  @Test
  fun api30WithoutAllFilesAccessNeedsTheSpecialPermission() {
    val verdict = WorkspacePickGate.evaluate(
      sdkInt = 33,
      permissionGranted = WorkspacePickGate.storagePermissionGranted(33, { false }, { false }),
      sharedStoragePath = WorkspacePickGate.isSharedStoragePath(shared()),
      probeWritable = false,
    )
    assertEquals(WorkspacePickVerdict.NEED_ALL_FILES_ACCESS, verdict)
    assertEquals(
      WorkspacePickRoute.ALL_FILES_ACCESS_SCREEN,
      WorkspacePickGate.routeOf(verdict, 33),
    )
  }

  /** API 29 无运行时 WRITE：弹运行时授权，**不得**引导到 11+ 才有的页面。 */
  @Test
  fun api29UsesRuntimePermissionNotAllFilesAccess() {
    val granted = WorkspacePickGate.storagePermissionGranted(
      29,
      hasAllFilesAccess = { false },
      hasWritePermission = { false },
    )
    assertFalse("API 29 不得把 All Files Access 当门槛", granted)
    val verdict = WorkspacePickGate.evaluate(
      sdkInt = 29,
      permissionGranted = granted,
      sharedStoragePath = true,
      probeWritable = false,
    )
    assertEquals(WorkspacePickVerdict.NEED_RUNTIME_STORAGE, verdict)
    assertEquals(
      WorkspacePickRoute.RUNTIME_PERMISSION_DIALOG,
      WorkspacePickGate.routeOf(verdict, 29),
    )
  }

  /** API 29 已授运行时 WRITE：不读 All Files Access（该 API 在 29 上不存在）。 */
  @Test
  fun api29GrantedRuntimeWriteDoesNotConsultAllFilesAccess() {
    var allFilesConsulted = false
    val granted = WorkspacePickGate.storagePermissionGranted(
      29,
      hasAllFilesAccess = { allFilesConsulted = true; false },
      hasWritePermission = { true },
    )
    assertTrue(granted)
    assertFalse("API<=29 不得触碰 isExternalStorageManager（越级 API）", allFilesConsulted)
  }

  /** API 30+ 已授 All Files Access：不读运行时 WRITE（该权限在 30+ 上无实际意义）。 */
  @Test
  fun api30GrantedAllFilesAccessDoesNotConsultRuntimeWrite() {
    var writeConsulted = false
    val granted = WorkspacePickGate.storagePermissionGranted(
      33,
      hasAllFilesAccess = { true },
      hasWritePermission = { writeConsulted = true; false },
    )
    assertTrue(granted)
    assertFalse(writeConsulted)
  }

  // ── 负控：两个方向 ──────────────────────────────────────────────────────────

  /**
   * **负控 A（防过度拦截）**：权限位全为假，但探测真的写进去了 → 必须放行。
   *
   * 这一条是本仓翻过车的方向：判据只看权限名，就会把「其实能写」的目录拦下来。
   * 删掉 probe（改成恒 false / 恒按权限判）→ 本用例红。
   */
  @Test
  fun probeWritableWinsOverMissingPermission() {
    val verdict = WorkspacePickGate.evaluate(
      sdkInt = 33,
      permissionGranted = false,
      sharedStoragePath = true,
      probeWritable = true,
    )
    assertEquals(WorkspacePickVerdict.PROCEED, verdict)
    assertEquals(WorkspacePickRoute.PROCEED, WorkspacePickGate.routeOf(verdict, 33))
  }

  /**
   * **负控 B（防漏拦截）**：权限位为真但探测失败 → 不得放行，且**不给**授权按钮。
   *
   * 这条对应真机现场：用户以为授权了，实际写不进去；再弹「去授权」是无解的引导
   * （授权页显示已授予）。故结论是 BLOCKED_UNWRITABLE，路线是「重新选择」。
   * 把 probe 删掉（改成恒 true）→ 本用例红。
   */
  @Test
  fun grantedButUnwritableIsNotProceed() {
    val verdict = WorkspacePickGate.evaluate(
      sdkInt = 33,
      permissionGranted = true,
      sharedStoragePath = true,
      probeWritable = false,
    )
    assertEquals(WorkspacePickVerdict.BLOCKED_UNWRITABLE, verdict)
    assertEquals(
      WorkspacePickRoute.CHOOSE_AGAIN,
      WorkspacePickGate.routeOf(verdict, 33),
    )
  }

  /** 不可写的结论不得给「去授权」：授权已经够了，那个按钮按了没用。 */
  @Test
  fun unwritableNeverOffersAGrantButton() {
    for (sdk in listOf(26, 29, 30, 33, 35)) {
      val route = WorkspacePickGate.routeOf(WorkspacePickVerdict.BLOCKED_UNWRITABLE, sdk)
      assertEquals("sdk=" + sdk, WorkspacePickRoute.CHOOSE_AGAIN, route)
      assertEquals(
        "sdk=" + sdk + " 不可写时主按钮必须是「重新选择」，不能是「去授权」",
        WorkspacePickGate.primaryActionLabel(WorkspacePickRoute.CHOOSE_AGAIN, true),
        WorkspacePickGate.primaryActionLabel(route, true),
      )
      assertTrue(
        "sdk=" + sdk,
        WorkspacePickGate.primaryActionLabel(route, true) !=
          WorkspacePickGate.primaryActionLabel(WorkspacePickRoute.ALL_FILES_ACCESS_SCREEN, true),
      )
    }
  }

  // ── 路径可用面 ──────────────────────────────────────────────────────────────

  @Test
  fun sharedStoragePathRecognition() {
    assertTrue(WorkspacePickGate.isSharedStoragePath("/storage/emulated/0/Dsh 进化"))
    assertTrue(WorkspacePickGate.isSharedStoragePath("/storage/emulated/0"))
    assertFalse("带 .. 的路径必须拒", WorkspacePickGate.isSharedStoragePath("/storage/emulated/0/../0/x"))
    assertFalse("content 树不是真实路径", WorkspacePickGate.isSharedStoragePath("content://com.android.externalstorage.documents/tree/primary%3ADsh"))
    assertFalse("SD 卡不在接受面内", WorkspacePickGate.isSharedStoragePath("/storage/1B0E-3C2F/work"))
    assertFalse("私有目录不是共享存储", WorkspacePickGate.isSharedStoragePath("/data/user/0/com.dsharnessmobile.shell/files/x"))
    assertFalse(WorkspacePickGate.isSharedStoragePath(null))
    assertFalse(WorkspacePickGate.isSharedStoragePath(""))
  }

  @Test
  fun unsupportedPathIsBlockedRegardlessOfPermission() {
    for (granted in listOf(true, false)) {
      val verdict = WorkspacePickGate.evaluate(
        sdkInt = 33,
        permissionGranted = granted,
        sharedStoragePath = false,
        probeWritable = false,
      )
      assertEquals(WorkspacePickVerdict.BLOCKED_UNSUPPORTED_PATH, verdict)
      assertEquals(
        WorkspacePickRoute.CHOOSE_AGAIN,
        WorkspacePickGate.routeOf(verdict, 33),
      )
    }
  }

  // ── 真实写探测 ──────────────────────────────────────────────────────────────

  /** 可写目录：探测为真，且不留残留文件。 */
  @Test
  fun probeSucceedsOnWritableDirectoryAndLeavesNoResidue() {
    val dir = Files.createTempDirectory("dsh-probe-ok").toFile()
    try {
      assertTrue(WorkspacePickGate.probeWritable(dir))
      val residue = dir.listFiles()?.filter { it.name.startsWith(WorkspacePickGate.PROBE_PREFIX) } ?: emptyList()
      assertTrue("探测不得留下残留：" + residue.map { it.name }, residue.isEmpty())
    } finally {
      dir.deleteRecursively()
    }
  }

  /** 不存在的目录：探测为假（不是抛异常）。 */
  @Test
  fun probeFailsOnMissingDirectory() {
    val missing = File(Files.createTempDirectory("dsh-probe-missing").toFile(), "not-created")
    assertFalse(WorkspacePickGate.probeWritable(missing))
  }

  /** 目标是一个文件而不是目录：探测为假。 */
  @Test
  fun probeFailsWhenTargetIsAFile() {
    val dir = Files.createTempDirectory("dsh-probe-file").toFile()
    try {
      val file = File(dir, "plain.txt").apply { writeText("x") }
      assertFalse(WorkspacePickGate.probeWritable(file))
    } finally {
      dir.deleteRecursively()
    }
  }

  /** 历史残留（崩溃在探测中途）会被有界清掉，且不误删用户内容。 */
  @Test
  fun probeSweepsStaleProbeResidueOnly() {
    val dir = Files.createTempDirectory("dsh-probe-sweep").toFile()
    try {
      val userFile = File(dir, "用户的文件.txt").apply { writeText("keep me") }
      val stale = File(dir, WorkspacePickGate.PROBE_PREFIX + "stale").apply { writeText("x") }
      assertTrue(WorkspacePickGate.probeWritable(dir))
      assertFalse("残留探测文件必须被清掉", stale.exists())
      assertTrue("用户内容不得被碰", userFile.exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  // ── 文案：不得把引擎原串翻给用户 ────────────────────────────────────────────

  /**
   * 弹窗正文不得出现引擎侧英文原串或内部错误码。
   *
   * 真机现场原文 = `workspace create failed: workspace/invalid-path: cannot create a Workspace
   * at "/storage/emulated/0/Dsh 进化": EACCES: permission denied, realpath ...`。
   * 用户看到的必须是原因 + 下一步，不是这个。
   */
  @Test
  fun dialogCopyNeverLeaksEngineErrorText() {
    val path = shared()
    val forbidden = listOf(
      "workspace/invalid-path",
      "workspace create failed",
      "EACCES",
      "permission denied",
      "realpath",
      "cannot create a Workspace",
    )
    for (verdict in WorkspacePickVerdict.entries) {
      if (verdict == WorkspacePickVerdict.PROCEED) continue
      for (zh in listOf(true, false)) {
        val message = WorkspacePickGate.dialogMessage(verdict, path, zh)
        assertTrue("空文案：" + verdict + " zh=" + zh, message.isNotBlank())
        assertTrue(
          "正文必须回显用户选的目录：" + verdict,
          message.contains(path),
        )
        for (token in forbidden) {
          assertFalse(
            "正文泄漏引擎原串（" + token + "）：" + verdict + " zh=" + zh + " -> " + message,
            message.contains(token),
          )
        }
      }
    }
  }

  /** 需要授权的那两种结论，主按钮必须是「去授权」而不是「重新选择」。 */
  @Test
  fun grantableVerdictsOfferTheGrantButton() {
    assertEquals(
      WorkspacePickGate.primaryActionLabel(WorkspacePickRoute.ALL_FILES_ACCESS_SCREEN, true),
      WorkspacePickGate.primaryActionLabel(
        WorkspacePickGate.routeOf(WorkspacePickVerdict.NEED_ALL_FILES_ACCESS, 33),
        true,
      ),
    )
    assertEquals(
      WorkspacePickGate.primaryActionLabel(WorkspacePickRoute.RUNTIME_PERMISSION_DIALOG, true),
      WorkspacePickGate.primaryActionLabel(
        WorkspacePickGate.routeOf(WorkspacePickVerdict.NEED_RUNTIME_STORAGE, 29),
        true,
      ),
    )
    assertFalse(
      WorkspacePickGate.primaryActionLabel(WorkspacePickRoute.ALL_FILES_ACCESS_SCREEN, true) ==
        WorkspacePickGate.primaryActionLabel(WorkspacePickRoute.CHOOSE_AGAIN, true),
    )
  }

  /** 中英文案都必须存在（壳侧原生弹窗的双语铁律）。 */
  @Test
  fun copyExistsInBothLanguages() {
    for (verdict in WorkspacePickVerdict.entries) {
      if (verdict == WorkspacePickVerdict.PROCEED) continue
      val zh = WorkspacePickGate.dialogMessage(verdict, shared(), true)
      val en = WorkspacePickGate.dialogMessage(verdict, shared(), false)
      assertTrue(verdict.toString(), zh != en)
      // 英文正文里不得有中文。回显的用户目录本身可能是中文（真机现场就是「Dsh 进化」），
      // 那是用户数据不是文案，故用纯 ASCII 路径判语言面。
      val asciiPath = WorkspacePickGate.SHARED_STORAGE_ROOT + "/work"
      val enAscii = WorkspacePickGate.dialogMessage(verdict, asciiPath, false)
      assertTrue(
        verdict.toString() + " -> " + enAscii,
        enAscii.none { it.code in 0x4E00..0x9FFF },
      )
    }
    assertTrue(WorkspacePickGate.dialogTitle(true) != WorkspacePickGate.dialogTitle(false))
  }
}
