package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #682 回归：exported 的 MainActivity 不再受理任何「按 action 分发的特权动作」。
 *
 * 缺陷形态：launcher Activity 是 exported 的，设备上任意应用可构造显式组件 intent 冒充
 * `ACTION_UPDATE` / `ACTION_RETRY_ENGINE`——清掉持久修复闸门（`RepairState.beginUserRetry`
 * 的契约「explicit user retry is the only way past the persistent gate」被绕过）或进入
 * 无兜底的 `runUpdate` 路径。「manifest 未声明 action」不构成边界：显式组件 intent 不检查
 * manifest 声明。
 *
 * 修法：重试改走进程内一次性标志（`pendingSelfRetry`，外部应用摸不到；置位方仅
 * RepairActivity）；`ACTION_UPDATE` 的 adb 触发入口直接移除（`runUpdate` 定义保留、无调用点）。
 * 静态判据守缺陷形态（与 [AdbKeyboardContractTest] 同口径：守形态，不守实现细节）。
 *
 * 反证（本类必须能红）：把 onCreate/onNewIntent 的 action 分发分支加回去，或让
 * RepairActivity 改回用 intent.action 载荷，对应用例立刻失败。
 */
class MainActivityPrivilegeEntryTest {

  /** 仓根（测试工作目录可能是 app/ 或仓根；按 settings.gradle.kts 向上找）。 */
  private fun repoFile(rel: String): File {
    var dir: File? = File(".").absoluteFile
    while (dir != null) {
      if (File(dir, "settings.gradle.kts").isFile) return File(dir, rel)
      dir = dir.parentFile
    }
    throw AssertionError("找不到仓根（settings.gradle.kts），工作目录 = " + File(".").absolutePath)
  }

  private fun shellSource(name: String): String =
    repoFile("app/src/main/java/com/dsharnessmobile/shell/$name").readText()

  /** 去掉注释行（注释里提到 action 字符串不算命中——与本仓静态门禁同口径）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun mainActivityHasNoPrivilegedActionDispatchLeft() {
    val code = codeOnly(shellSource("MainActivity.kt"))
    assertFalse("ACTION_UPDATE 的分发/常量必须移除（#682：exported launcher 无法区分调用方）", code.contains("ACTION_UPDATE"))
    assertFalse("ACTION_RETRY_ENGINE 的分发/常量必须移除（#682）", code.contains("ACTION_RETRY_ENGINE"))
    assertTrue("重试入口必须走一次性进程内标志", code.contains("consumePendingSelfRetry()"))
    assertTrue("标志消费必须读后即清", code.contains("pendingSelfRetry = false"))
  }

  @Test
  fun repairActivityIsTheOnlySetterOfTheRetryFlag() {
    val repair = codeOnly(shellSource("RepairActivity.kt"))
    assertTrue("RepairActivity 必须置位一次性标志（进程内，外部应用摸不到）", repair.contains("MainActivity.pendingSelfRetry = true"))
    assertTrue("置位后仍要拉起启动页（原 UX 不变）", repair.contains("startActivity(intent)"))
    val main = codeOnly(shellSource("MainActivity.kt"))
    assertFalse("MainActivity 只许消费、不得自行置位（否则外部可达面又回来了）", main.contains("pendingSelfRetry = true"))
  }

  @Test
  fun retryFlagIsVolatileOneShotField() {
    val main = codeOnly(shellSource("MainActivity.kt"))
    assertTrue("标志必须 @Volatile（onCreate 与 onNewIntent 可能跨实例可见）", main.contains("@Volatile"))
    assertTrue("标志必须可被 RepairActivity 跨实例读到（internal 可见性）", Regex("internal var pendingSelfRetry").containsMatchIn(main))
  }
}
