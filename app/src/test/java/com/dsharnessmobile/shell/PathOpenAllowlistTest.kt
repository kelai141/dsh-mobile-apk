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

  @Test
  fun documentIdStaysInsideTheAuthorizedTree() {
    val root = "/storage/emulated/0/我的文档/dsh测试"
    val id = "primary:我的文档/dsh测试"
    assertEquals("$id/tests/hello world.txt", ChooserAllowlist.documentId("$root/tests/hello world.txt", root, id))
    assertEquals(id, ChooserAllowlist.documentId(root, root, id))
    assertEquals(null, ChooserAllowlist.documentId("$root-private/hello.txt", root, id))
    assertEquals(null, ChooserAllowlist.documentId("$root/hello.txt", root, "secondary:dsh测试"))
  }

  private val filesDir = File(System.getProperty("java.io.tmpdir"), "dsh-allow-files").canonicalFile
  private val cacheDir = File(System.getProperty("java.io.tmpdir"), "dsh-allow-cache").canonicalFile
  private val externalDocuments = File(System.getProperty("java.io.tmpdir"), "dsh-allow-documents").canonicalFile
  private val sharedRoot = File(System.getProperty("java.io.tmpdir"), "dsh-allow-emulated").canonicalFile

  /** 既有四条窄根（兼容断言）。 */
  private fun roots(): List<String> = FileIncoming.readerRoots(filesDir, externalDocuments)

  /** 扩展策略判定（硬黑名单永优先于允许根）。 */
  private fun allowed(path: File): Boolean = FileIncoming.isAllowedByExpandedPolicy(
    canonicalPath = path.canonicalPath,
    filesDir = filesDir,
    cacheDir = cacheDir,
    externalDocuments = externalDocuments,
    externalRoots = listOf(sharedRoot.canonicalPath),
  )

  @Test
  fun theFourNarrowRootsStillPass() {
    val expected = listOf("home/.dsh/workspaces", "home/tmp", "usr/bin")
      .map { File(filesDir, it).canonicalPath } + File(externalDocuments, "dshdata").canonicalPath
    assertEquals("基础四条根保持稳定", expected, roots())
    for (root in roots()) {
      assertTrue("允许根自身必须放行：" + root, allowed(File(root)))
      assertTrue("允许根的子路径必须放行：" + root, allowed(File(root, "a/b.txt")))
    }
  }

  @Test
  fun expandedUserDirectoriesPass() {
    assertTrue("Termux 用户主目录项目可分享", allowed(File(filesDir, "home/projects/demo/report.md")))
    assertTrue("usr/tmp 临时产物可分享", allowed(File(filesDir, "usr/tmp/build.zip")))
    assertTrue("外部存储 Download 目录可分享", allowed(File(sharedRoot, "Download/pr1832.bundle")))
    assertTrue("外部存储自定义用户目录可分享", allowed(File(sharedRoot, "我的文档/dsh测试/pic.png")))
    assertTrue("外部存储 DCIM 照片可分享", allowed(File(sharedRoot, "DCIM/Camera/shot.jpg")))
    assertTrue("外部存储根目录下的 Android/media（非私有沙盒）仍可分享", allowed(File(sharedRoot, "Android/media/photo.png")))
    assertTrue("原生拍照成品目录可分享", allowed(File(cacheDir, "attachments/shot.jpg")))
  }

  /**
   * issue #1571 核心红线：即使放开共享存储用户目录，第三方应用私有区、裸外部根与本应用私密凭据必须坚决拒绝。
   */
  @Test
  fun anotherAppsPrivateDirectoryAndSecretsAreHardDenied() {
    val victim = File(sharedRoot, "Android/data/com.example.other/files/token.db")
    assertFalse("别的应用 Android/data 私有区绝不能被交给系统选择器（#1571）", allowed(victim))
    assertFalse("Android/obb 绝不能放行", allowed(File(sharedRoot, "Android/obb/com.example/main.obb")))
    assertFalse("Android/sandbox 绝不能放行", allowed(File(sharedRoot, "Android/sandbox/secret")))
    assertFalse("外部存储根自身不得放行", allowed(sharedRoot))
    assertFalse("engine 凭据 .credentials.yaml 绝不能放行", allowed(File(filesDir, "home/.dsh/.credentials.yaml")))
    assertFalse("engine settings.yaml 绝不能放行", allowed(File(filesDir, "home/.dsh/settings.yaml")))
    assertFalse("Termux .ssh 私钥绝不能放行", allowed(File(filesDir, "home/.ssh/id_ed25519")))
    assertFalse("Termux .netrc 绝不能放行", allowed(File(filesDir, "home/.netrc")))
    assertFalse("Termux .git-credentials 绝不能放行", allowed(File(filesDir, "home/.git-credentials")))
    assertFalse("哪怕有 SAF 授权也不能绕过硬黑名单",
      ChooserAllowlist.isAllowedByPolicy(
        victim.canonicalPath,
        listOf(sharedRoot.canonicalPath),
        filesDir.canonicalPath,
        listOf(sharedRoot.canonicalPath),
      ))
  }

  /** 边界：前缀兄弟目录必须拒绝（裸 startsWith 会把 workspaces-evil 判成 workspaces 的子路径）。 */
  @Test
  fun siblingDirectoryWithSharedPrefixIsRefused() {
    val sibling = File(filesDir, "home-evil/x.txt")
    assertFalse("前缀兄弟目录必须拒绝（根 + 分隔符 才是边界）", allowed(sibling))
    assertTrue("前缀兄弟 .dsh-other 不应被 .dsh 黑名单误伤",
      allowed(File(filesDir, "home/.dsh-other/x")))
    assertTrue("home/.dsh/workspaces 必须豁免放行", allowed(File(filesDir, "home/.dsh/workspaces/p1/a.txt")))
    assertFalse("workspaces 前缀兄弟 workspaces-evil 在 .dsh 下必须拒绝",
      allowed(File(filesDir, "home/.dsh/workspaces-evil/secret.txt")))
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
