package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1571 的行为判据：**「把这个路径交给别的应用」的允许面不得是整个外部存储根**。
 *
 * 缺陷形态：`PathOpen.isChooserAllowedFor` 的允许面是「四条窄根 **并上** 整个外部存储根」，
 * 而三个 `@JavascriptInterface`（`openFileExternal` / `shareFile` / `openPathChooser`）的门禁
 * 只要求顶层帧是引擎 origin；`BridgeOriginGuard` 又明确为「同源 HTML artifact 预览帧」放行桥。
 * 于是模型生成的一段 artifact HTML 调
 * `shareFile("/storage/emulated/0/Android/data/<别的应用>/files/token.db")` 就会弹系统分享面板
 * （第一项通常是聊天工具），`openFileExternal` 更直接把文件交给外部阅读器并授予读权限。
 *
 * 判据为什么落在这里：`PathOpen.isChooserAllowedFor` / `FileIncoming.isReaderAllowed` 都要
 * `MainActivity`（JVM 单测里 `activity.filesDir` 与 `Environment.getExternalStorageDirectory()`
 * 都是默认值 null，断言会变成「因为拿不到而恒真」）。允许面的**全部判定**就是「规范化路径是否
 * 落在允许根之下」，所以生产侧把它抽成 [FileIncoming.readerRoots] +
 * [FileIncoming.readerAllowedBy] + [ChooserAllowlist]，本文件驱动这两层真实实现：
 *  - 正控：四条窄根及其子路径必须放行（修不得变成「谁都打不开」）；
 *  - 负控：外部存储根下的第三方目录必须拒绝——把「并上外部存储根」那一支加回来即变红。
 */
class PathOpenAllowlistTest {

  private val filesDir = File(System.getProperty("java.io.tmpdir"), "dsh-allow-files").canonicalFile
  private val externalDocuments = File(System.getProperty("java.io.tmpdir"), "dsh-allow-documents").canonicalFile

  /** 生产根表（与 FileIncoming.isReaderAllowed 同一个生成函数）。 */
  private fun roots(): List<String> = FileIncoming.readerRoots(filesDir, externalDocuments)

  /** 允许面判定（与 FileIncoming.isReaderAllowed 同一个判定函数）。 */
  private fun allowed(path: File): Boolean = FileIncoming.readerAllowedBy(roots(), path.canonicalPath)

  @Test
  fun theFourNarrowRootsStillPass() {
    val expected = listOf("home/.dsh/workspaces", "home/tmp", "usr/bin")
      .map { File(filesDir, it).canonicalPath } + File(externalDocuments, "dshdata").canonicalPath
    assertEquals("允许根表必须恰好是这四条（多一条就等于放宽）", expected, roots())
    for (root in roots()) {
      assertTrue("允许根自身必须放行：" + root, allowed(File(root)))
      assertTrue("允许根的子路径必须放行：" + root, allowed(File(root, "a/b.txt")))
    }
  }

  /**
   * 缺陷本体：外部存储根下的第三方目录。修前 `/storage/emulated/0` 整支并进允许面 ⇒ 放行。
   *
   * 负控：把「并上外部存储根」那一支加回 `PathOpen.isChooserAllowedFor`（或让
   * [ChooserAllowlist.permitted] 接受外部存储根），本用例立刻变红。
   */
  @Test
  fun anotherAppsPrivateDirectoryUnderSharedStorageIsRefused() {
    val sharedRoot = File(System.getProperty("java.io.tmpdir"), "dsh-allow-emulated").canonicalFile
    val victim = File(sharedRoot, "Android/data/com.example.other/files/token.db")
    assertFalse("别的应用私有区绝不能被交给系统选择器（#1571 的触发样例）", allowed(victim))
    assertFalse("外部存储根自身也不得放行", allowed(sharedRoot))
    assertFalse("外部存储根下的普通目录也不得放行", allowed(File(sharedRoot, "DCIM/x.jpg")))
  }

  /** 边界：前缀兄弟目录必须拒绝（裸 startsWith 会把 workspaces-evil 判成 workspaces 的子路径）。 */
  @Test
  fun siblingDirectoryWithSharedPrefixIsRefused() {
    val sibling = File(filesDir, "home/tmp-evil/x.txt")
    assertFalse("前缀兄弟目录必须拒绝（根 + 分隔符 才是边界）", allowed(sibling))
    assertFalse("workspaces 的前缀兄弟同样拒绝", allowed(File(filesDir, "home/.dsh/workspaces-evil/x")))
  }

  @Test
  fun userGrantedDirectoryBecomesAnAllowedRoot() {
    // 修法口径：外部存储不再是**无条件**允许面，但用户经系统目录选择器亲手授予过的目录仍然放行
    // （外部工作区走的就是这条：persistedUriPermissions 是可核对的事实，不是「整台设备」）。
    val sharedRoot = File(System.getProperty("java.io.tmpdir"), "dsh-allow-emulated").canonicalFile
    val granted = File(sharedRoot, "Download/my-project").canonicalPath
    // 生产侧 grantedRoots 只收 POSIX 绝对路径（Android 上恒成立；JVM 单测跑在 Windows 上，
    // 路径形如 C:\... 会被正确过滤掉——那是**平台事实**，不是判据）。所以这里直接构造
    // 「已授予的根 + 四条窄根」的根表来驱动判定，授权目录的过滤契约另由
    // contentUrisNeverBecomePathRoots 覆盖。
    val withGrant = roots() + granted
    assertTrue("用户授予的目录必须放行", ChooserAllowlist.permitted(File(granted, "a.txt").canonicalPath, withGrant))
    assertFalse("授予目录之外的兄弟目录仍必须拒绝",
      ChooserAllowlist.permitted(File(sharedRoot, "Download/other/a.txt").canonicalPath, withGrant))
  }

  @Test
  fun contentUrisNeverBecomePathRoots() {
    // resolvePickedPath 对非 primary 卷回 content:// 原串；那种串不是文件系统路径，
    // 放进 canonical 前缀比较里等于白占一位，还会掩盖真正的问题。
    val granted = ChooserAllowlist.grantedRoots(
      listOf("content://com.android.externalstorage.documents/tree/1234%3Aabcd", "  ", "/storage/emulated/0/x", "/storage/emulated/0/x"),
    )
    assertEquals("只保留绝对路径且去重", listOf("/storage/emulated/0/x"), granted)
  }

  @Test
  fun emptyInputsAreRefusedNotCrashed() {
    assertFalse(ChooserAllowlist.permitted("", roots()))
    assertFalse("空根表一律拒绝（fail-closed）", ChooserAllowlist.permitted("/a/b", emptyList()))
    assertFalse("空白根被忽略", ChooserAllowlist.permitted("/a/b", listOf("", "   ")))
    assertTrue("拿不到任何根时根表为空而不是抛", FileIncoming.readerRoots(null, null).isEmpty())
  }
}
