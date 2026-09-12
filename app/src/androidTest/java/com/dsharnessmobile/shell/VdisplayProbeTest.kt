package com.dsharnessmobile.shell

import android.content.Context
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * S3 建屏矩阵仪器测试（0.14.0 迭代「虚拟屏」线；对应 P0-6 / S-AC-12 / S-AC-13）。
 *
 * 为什么用 androidTest 而不是桥方法/Activity（Lead 裁决 A）：仪器测试天然跑在**目标应用进程与
 * 应用 UID** 下——这正是 P0-6 要测的调用者身份（建屏的 flag 闸门与调用者权限强相关）；且零产品面
 * 改动：不进 manifest、不碰桥面对称性门禁、不影响默认路径。
 *
 * 产物（两份，互为交叉证据）：
 *   ① 设备内文件：`filesDir/vdisplay-probe.json`（完整 JSON，用
 *      `adb shell run-as com.dsharnessmobile.shell cat files/vdisplay-probe.json` 取回）
 *   ② logcat：tag `dsh-probe`（紧凑 JSON，`adb logcat -d -s dsh-probe` 取回）
 *
 * 跑法：
 *   gradlew :app:assembleDebugAndroidTest
 *   adb -s 127.0.0.1:16416 shell am instrument -w -e class com.dsharnessmobile.shell.VdisplayProbeTest \
 *       com.dsharnessmobile.shell.test/androidx.test.runner.AndroidJUnitRunner
 *   # 反向自证（泄漏金丝雀）：
 *   adb ... am instrument -w -e class ... -e leak true ...
 *
 * 纪律：矩阵每次建屏后立即 release（在探针的 finally 里）；本测试额外断言
 * `displayCountAfter == displayCountBefore`（无显示泄漏）。`-e leak true` 会**故意**持有一个屏
 * 再释放，用来证明"计数断言有牙齿"（若计数不涨，说明断言是假绿）。
 */
@RunWith(AndroidJUnit4::class)
class VdisplayProbeTest {

  private val tag = "dsh-probe"

  @Test
  fun vdisplayMatrix() {
    val inst = InstrumentationRegistry.getInstrumentation()
    val ctx: Context = inst.targetContext
    val leakCanary = InstrumentationRegistry.getArguments().getString("leak") == "true"

    val report = JSONObject()
    report.put("device", JSONObject()
      .put("model", Build.MODEL)
      .put("sdkInt", Build.VERSION.SDK_INT)
      .put("release", Build.VERSION.RELEASE)
      .put("abis", Build.SUPPORTED_ABIS.joinToString(","))
      .put("fingerprint", Build.FINGERPRINT)
      .put("debuggable", BuildConfig.DEBUG))
    report.put("mode", if (leakCanary) "matrix+leak-canary" else "matrix")
    report.put("probeUid", android.os.Process.myUid())

    val matrix = VirtualDisplayProbe.runMatrix(ctx)
    report.put("matrix", matrix)
    if (leakCanary) report.put("leakCanary", leakCanaryStep(ctx))

    val pretty = report.toString(2)
    // ① 设备内文件（run-as 取回）
    val file = File(ctx.filesDir, "vdisplay-probe.json")
    runCatching { file.writeText(pretty) }
    // ② logcat（紧凑；logcat 单行上限约 4KB，故不写 pretty）
    Log.i(tag, "vdisplay-probe: " + report.toString())

    // 断言：矩阵跑通 + 无显示泄漏
    assertTrue("矩阵未跑通：" + matrix.optString("code"), matrix.optBoolean("ok"))
    assertEquals("建屏泄漏：after != before",
      matrix.getInt("displayCountBefore"), matrix.getInt("displayCountAfter"))
    val rows = matrix.getJSONArray("results")
    assertTrue("结果条目数 != 6", rows.length() == 6)
    // 主路正解必须建成（源文档 §6.1：PUBLIC|OWN_CONTENT_ONLY 不需要任何投影权限）
    val main = (0 until rows.length()).map { rows.getJSONObject(it) }
      .first { it.getString("key") == "public_own_content_touch" }
    assertTrue("主路正解组合未建成：" + main.optString("errorClass") + " " + main.optString("error"),
      main.optBoolean("created"))
    // 私有屏对照必须建成（S-AC-13 的建屏侧；其"无障碍看不见"由 P0-9 另验）
    val priv = (0 until rows.length()).map { rows.getJSONObject(it) }
      .first { it.getString("key") == "private_only" }
    assertTrue("私有屏对照未建成：" + priv.optString("errorClass") + " " + priv.optString("error"),
      priv.optBoolean("created"))

    if (leakCanary) {
      val canary = report.getJSONObject("leakCanary")
      assertTrue("金丝雀建屏失败，计数断言未被证明有牙齿：" + canary.optString("error"), canary.optBoolean("created"))
      assertTrue("金丝雀持有期间计数未上升——display 计数断言是假绿", canary.optBoolean("leakObserved"))
      assertEquals("金丝雀释放后计数未回落", canary.getInt("countBefore"), canary.getInt("countAfterRelease"))
    }
  }

  /**
   * 泄漏金丝雀：故意建一个屏并**持有**（不立即 release），观测 display 计数是否上升，再释放并观测回落。
   * 目的：证明 `displayCountAfter == displayCountBefore` 这条断言能检测到真实泄漏（否则它是假绿）。
   *
   * 注：flag 位值与 `VirtualDisplayProbe` 的本地位值一致（AOSP android.hardware.display.DisplayManager：
   * PUBLIC=1<<0、OWN_CONTENT_ONLY=1<<3；应用态不可见 @hide 常量，故此处同样用字面位值）。
   * @param ctx 目标应用上下文
   * @return 金丝雀结果 JSON
   */
  private fun leakCanaryStep(ctx: Context): JSONObject {
    val dm = ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    val out = JSONObject()
    val before = dm.displays.size
    out.put("countBefore", before)
    var vd: VirtualDisplay? = null
    try {
      vd = dm.createVirtualDisplay("dsh-vd-leak-canary", 320, 480, 160, null,
        (1 shl 0) or (1 shl 3))
      out.put("created", vd != null)
      val during = dm.displays.size
      out.put("countDuring", during)
      out.put("leakObserved", during > before)
    } catch (e: Throwable) {
      out.put("created", false)
      out.put("errorClass", e.javaClass.name)
      out.put("error", e.message ?: "")
    } finally {
      runCatching { vd?.release() }
      out.put("countAfterRelease", dm.displays.size)
    }
    return out
  }
}
