package com.dsharnessmobile.shell

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * tester 独立验证：0.14.6 功能 C（更新检查 arm64 误报修复）。
 *
 * 本文件**不复用** dev-update 的 UpdateCheckerTest.kt（职责分离：那是实现方的自测）。
 * 用例全部由 tester 从 SPEC-0.14.6 C1-C4 与验收判据自行推导，重点是**反例**：
 *  - 反例 1：兼容命名不得放宽架构校验（arm64 设备 + 只有 x86_64 资产必须拒绝）。
 *  - 反例 2：任何非 ABI 原因（网络 / 限流 / 解析 / 发布数据）都不得被说成「没有该 ABI 资产」。
 *  - 反例 3：缺失 tag_name 必须归 PARSE，不能退化成「assets 为空」。
 *  - 反例 4：assets 字段缺席、含 null 元素、超时等形态都不得抛未分类异常。
 * 判定层是纯函数，走 UpdateChecker.classifyLatestBody / classifyTransportFailure，
 * 不依赖真机与网络 —— 真机部分另见 .deploy-tmp/tester 的 adb 证据。
 */
class IndependentUpdateCheckerTest {

  private val ARM64_DEVICE = listOf("arm64-v8a", "armeabi-v7a", "armeabi")
  private val X86_DEVICE = listOf("x86_64", "arm64-v8a", "x86")
  private val DL = "https://github.com/kelai141/dsh-mobile-apk/releases/download/t/"

  /** 用真实 GitHub 响应形态造 body（字段名与 api.github.com 一致；tag 为 null 时不写该字段）。 */
  private fun body(tag: String?, assetNames: List<String>): String {
    val arr = JSONArray()
    for (n in assetNames) {
      val asset = JSONObject().put("name", n).put("browser_download_url", DL + n).put("size", 123L)
      if (n.endsWith(".apk")) asset.put("digest", "sha256:" + "a".repeat(64))
      arr.put(asset)
    }
    val o = JSONObject().put("assets", arr)
    if (tag != null) o.put("tag_name", tag)
    return o.toString()
  }

  // -- C4 回归：版本比较语义不得因本次修复而变 ----------------------------------
  @Test
  fun versionComparisonSemanticsUnchanged() {
    assertTrue(UpdateChecker.isNewer("v0.14.6", "0.14.5-fx-2"))
    assertFalse(UpdateChecker.isNewer("v0.14.5-fx-2", "0.14.5-fx-2"))
    // fx 修订号属于比较链，不得被当预发布后缀剥掉
    assertTrue(UpdateChecker.isNewer("v0.14.5-fx-3", "0.14.5-fx-2"))
    assertFalse(UpdateChecker.isNewer("v0.14.5-fx-1", "0.14.5-fx-2"))
    // 白名单后缀（rc / preview / SN）不参与比较
    assertFalse(UpdateChecker.isNewer("v0.14.5-rc.1", "0.14.5"))
    assertFalse(UpdateChecker.isNewer("v0.14.6-SN-1-13", "0.14.6"))
  }

  /**
   * 与**本机当前版本同版**的 tag —— 由 BuildConfig 运行时派生，**不写死**。
   *
   * tester 自纠（第 4 次，2026-10-11）：我第一版把 "v0.14.6" 硬编码成「更新版」，
   * 而当轮候选自身的 versionName 恰好升到了 0.14.6，于是 isNewer 判 false => 期望 Available 却得 UpToDate，
   * 两条用例假红。**这正是 Lead 提醒过的「硬编码版本号是脆弱点」**（他自己也因同类问题被拦过一次）。
   * 现在一律从 [UpdateChecker.currentVersion] 派生：同版用例用当前版本，更新用例用严格更大的版本。
   */
  private val currentTag: String get() = "v" + UpdateChecker.currentVersion()

  /** 严格大于当前版本的 tag：把首段抬到 99（对任何 0.x / 1.x 都成立，且不依赖具体版本号）。 */
  private fun strictlyNewerTag(): String {
    val cur = UpdateChecker.currentVersion()
    val parts = cur.split(".").toMutableList()
    parts[0] = "99"
    return "v" + parts.joinToString(".")
  }

  /** 该 tag 对应的真实资产清单形态（字段名与 GitHub API 一致）。 */
  private fun realLatestAssetNames(tag: String): List<String> = listOf(
    "dsh-android-dsh-client-ui-responsive-0.3.3.tgz",
    "dsh-mobile-apk-v${tag.removePrefix("v")}-arm64.apk",
    "dsh-mobile-apk-v${tag.removePrefix("v")}-x86_64.apk",
    "MANIFEST.txt",
    "snapshot-arm64.tar.xz",
  )

  // -- 正例：真实 latest 形态（arm64 资产名为 -arm64.apk）必须命中 ---------------
  @Test
  fun realLatestNamingIsMatched() {
    // 与本机同版 => 命中资产后唯一可观察结果是 UpToDate（未命中会走 Failed）
    val same = UpdateChecker.classifyLatestBody(body(currentTag, realLatestAssetNames(currentTag)), ARM64_DEVICE, "arm64")
    assertTrue("同版 tag（" + currentTag + "）命中资产后应判 UpToDate，实得 " + same, same is UpdateChecker.CheckResult.UpToDate)
    // 严格更新的版本号（同一命名口径）=> 必须 Available 且选中 -arm64 那一件
    val newerTag = strictlyNewerTag()
    val newer = UpdateChecker.classifyLatestBody(body(newerTag, realLatestAssetNames(newerTag)), ARM64_DEVICE, "arm64")
    assertTrue("更高版本（" + newerTag + "）+ -arm64 命名必须命中，实得 " + newer, newer is UpdateChecker.CheckResult.Available)
    assertEquals("dsh-mobile-apk-v${newerTag.removePrefix("v")}-arm64.apk", (newer as UpdateChecker.CheckResult.Available).name)
  }

  // -- 历史口径：-arm64-v8a 也要命中（线上曾翻转，两个口径都真实存在）-----------
  @Test
  fun historicalArm64V8aNamingIsMatched() {
    // 版本号同样运行时派生，避免「候选升版即假红」
    val newerTag = strictlyNewerTag()
    val v = newerTag.removePrefix("v")
    val hist = body(newerTag, listOf("dsh-mobile-apk-v$v-arm64-v8a.apk", "dsh-mobile-apk-v$v-x86_64.apk"))
    val r = UpdateChecker.classifyLatestBody(hist, ARM64_DEVICE, "arm64")
    assertTrue("历史 -arm64-v8a 口径必须命中，实得 " + r, r is UpdateChecker.CheckResult.Available)
    assertEquals("dsh-mobile-apk-v$v-arm64-v8a.apk", (r as UpdateChecker.CheckResult.Available).name)
  }

  // -- 反例 1（核心）：兼容命名不得放宽架构校验 ---------------------------------
  @Test
  fun arm64DeviceMustRejectX8664OnlyRelease() {
    val x86Only = body("v9.9.9", listOf("dsh-mobile-apk-v9.9.9-x86_64.apk", "snapshot-x86_64.tar.xz"))
    val r = UpdateChecker.classifyLatestBody(x86Only, ARM64_DEVICE, "arm64")
    assertTrue("arm64 设备只有 x86_64 资产时必须拒绝，实得 " + r, r is UpdateChecker.CheckResult.Failed)
    assertEquals(UpdateChecker.CheckResult.FailureKind.NO_COMPATIBLE_APK, (r as UpdateChecker.CheckResult.Failed).kind)
  }

  @Test
  fun x86DeviceMustRejectArm64OnlyRelease() {
    val armOnly = body("v9.9.9", listOf("dsh-mobile-apk-v9.9.9-arm64.apk", "dsh-mobile-apk-v9.9.9-arm64-v8a.apk"))
    val r = UpdateChecker.classifyLatestBody(armOnly, X86_DEVICE, "x86_64")
    assertTrue("x86_64 设备只有 arm64 资产时必须拒绝，实得 " + r, r is UpdateChecker.CheckResult.Failed)
    assertEquals(UpdateChecker.CheckResult.FailureKind.NO_COMPATIBLE_APK, (r as UpdateChecker.CheckResult.Failed).kind)
  }

  /** 反例 1 加强版：同 tag 同时存在两族资产时，各自选中本族的包。 */
  @Test
  fun compatibilityNeverSelectsOtherArchitecture() {
    val both = body("v9.9.9", listOf("dsh-mobile-apk-v9.9.9-arm64.apk", "dsh-mobile-apk-v9.9.9-x86_64.apk"))
    val arm = UpdateChecker.classifyLatestBody(both, ARM64_DEVICE, "arm64")
    val x86 = UpdateChecker.classifyLatestBody(both, X86_DEVICE, "x86_64")
    assertEquals("dsh-mobile-apk-v9.9.9-arm64.apk", (arm as UpdateChecker.CheckResult.Available).name)
    assertEquals("dsh-mobile-apk-v9.9.9-x86_64.apk", (x86 as UpdateChecker.CheckResult.Available).name)
  }

  // -- 反例 2：非 ABI 原因不得说成「没有该 ABI 资产」 ---------------------------
  @Test
  fun emptyAssetsIsReleaseDataBrokenNotAbiMissing() {
    val r = UpdateChecker.classifyLatestBody(body("v9.9.9", emptyList()), ARM64_DEVICE, "arm64")
    assertTrue(r is UpdateChecker.CheckResult.Failed)
    assertEquals(UpdateChecker.CheckResult.FailureKind.RELEASE_DATA_BROKEN, (r as UpdateChecker.CheckResult.Failed).kind)
  }

  @Test
  fun nonApkAssetsAreReleaseDataBroken() {
    val onlyTgz = body("v9.9.9", listOf("snapshot-arm64.tar.xz", "MANIFEST.txt"))
    val r = UpdateChecker.classifyLatestBody(onlyTgz, ARM64_DEVICE, "arm64")
    assertEquals(UpdateChecker.CheckResult.FailureKind.RELEASE_DATA_BROKEN, (r as UpdateChecker.CheckResult.Failed).kind)
  }

  @Test
  fun malformedJsonIsParseFailureNotAbiMissing() {
    val r = UpdateChecker.classifyLatestBody("not-json-at-all", ARM64_DEVICE, "arm64")
    assertTrue(r is UpdateChecker.CheckResult.Failed)
    assertEquals(UpdateChecker.CheckResult.FailureKind.PARSE, (r as UpdateChecker.CheckResult.Failed).kind)
    assertFalse(
      "解析失败不得被说成没有该架构的包",
      (r as UpdateChecker.CheckResult.Failed).reason.contains("没有适配本机"),
    )
  }

  /** 反例 3：缺 tag_name 必须归 PARSE，不能退化成「assets 为空 / 没有 ABI 资产」。 */
  @Test
  fun missingTagNameIsParseFailure() {
    val noTag = body(null, listOf("dsh-mobile-apk-v9.9.9-arm64.apk"))
    val r = UpdateChecker.classifyLatestBody(noTag, ARM64_DEVICE, "arm64")
    assertEquals(UpdateChecker.CheckResult.FailureKind.PARSE, (r as UpdateChecker.CheckResult.Failed).kind)
  }

  /** 反例 4：assets 字段缺席（null）必须被安全处理。 */
  @Test
  fun absentAssetsFieldIsHandledSafely() {
    val r = UpdateChecker.classifyLatestBody(JSONObject().put("tag_name", "v9.9.9").toString(), ARM64_DEVICE, "arm64")
    assertEquals(UpdateChecker.CheckResult.FailureKind.RELEASE_DATA_BROKEN, (r as UpdateChecker.CheckResult.Failed).kind)
  }

  /** 反例 4b：assets 里夹着 null 与无名条目时不得整条崩掉，且仍能命中有效资产。 */
  @Test
  fun weirdAssetElementsAreSkipped() {
    val valid = JSONObject()
      .put("name", "dsh-mobile-apk-v9.9.9-arm64.apk")
      .put("browser_download_url", "https://x/y.apk")
      .put("size", 1)
      .put("digest", "sha256:" + "a".repeat(64))
    val weird = JSONObject()
      .put("tag_name", "v9.9.9")
      .put("assets", JSONArray().put(JSONObject.NULL).put(JSONObject().put("size", 1)).put(valid))
      .toString()
    val r = UpdateChecker.classifyLatestBody(weird, ARM64_DEVICE, "arm64")
    assertTrue("夹 null/无名条目时仍应命中有效资产，实得 " + r, r is UpdateChecker.CheckResult.Available)
  }

  // -- C1：限流 / HTTP 分类 -----------------------------------------------------
  @Test
  fun rateLimitClassificationIsHonest() {
    assertTrue(UpdateChecker.isRateLimited(429, null, null))
    assertTrue(UpdateChecker.isRateLimited(403, "0", null))
    assertTrue(UpdateChecker.isRateLimited(403, "57", "30"))
    // 普通 403（滥用拦截）不得说成限流
    assertFalse(UpdateChecker.isRateLimited(403, "57", null))
    assertFalse(UpdateChecker.isRateLimited(403, null, null))
    assertFalse(UpdateChecker.isRateLimited(500, "0", null))

    val limited = UpdateChecker.classifyHttpFailure(429, true)
    assertEquals(UpdateChecker.CheckResult.FailureKind.RATE_LIMITED, limited.kind)
    val plain = UpdateChecker.classifyHttpFailure(403, false)
    assertEquals(UpdateChecker.CheckResult.FailureKind.API_HTTP, plain.kind)
    assertEquals(UpdateChecker.CheckResult.FailureKind.API_HTTP, UpdateChecker.classifyHttpFailure(502, false).kind)
    // 限流文案必须显式排除「本机架构」误读
    assertTrue(limited.reason.contains("架构"))
  }

  // -- C1：传输异常分类 ---------------------------------------------------------
  @Test
  fun transportFailureClassification() {
    assertEquals(
      UpdateChecker.CheckResult.FailureKind.NETWORK,
      UpdateChecker.classifyTransportFailure(java.net.UnknownHostException("api.github.com")).kind,
    )
    assertEquals(
      UpdateChecker.CheckResult.FailureKind.NETWORK,
      UpdateChecker.classifyTransportFailure(java.net.SocketTimeoutException("timeout")).kind,
    )
    assertEquals(
      UpdateChecker.CheckResult.FailureKind.PARSE,
      UpdateChecker.classifyTransportFailure(org.json.JSONException("bad json")).kind,
    )
    assertEquals(
      UpdateChecker.CheckResult.FailureKind.UNKNOWN,
      UpdateChecker.classifyTransportFailure(RuntimeException("weird")).kind,
    )
    for (e in listOf<Throwable>(
      java.net.UnknownHostException("x"), java.net.SocketTimeoutException("x"),
      org.json.JSONException("x"), RuntimeException("x"),
    )) {
      val reason = UpdateChecker.classifyTransportFailure(e).reason
      assertFalse("非 ABI 原因不得归因架构：" + reason, reason.contains("没有适配本机"))
    }
  }

  // -- C1：ABI 识别失败必须是独立归类，不得借「无 arm64 资产」顶罪 --------------
  @Test
  fun unreadableAbiIsItsOwnFailureKind() {
    val good = body("v9.9.9", listOf("dsh-mobile-apk-v9.9.9-arm64.apk"))
    val r = UpdateChecker.classifyLatestBody(good, emptyList(), "")
    assertEquals(UpdateChecker.CheckResult.FailureKind.ABI_UNSUPPORTED, (r as UpdateChecker.CheckResult.Failed).kind)
  }

  // -- C3：设备 ABI 选择语义（MuMu 翻译层不得被判成 arm64）---------------------
  @Test
  fun abiSelectionRegression() {
    assertEquals("x86_64", UpdateChecker.abiFrom(listOf("x86_64", "arm64-v8a", "x86")))
    assertEquals("arm64", UpdateChecker.abiFrom(listOf("arm64-v8a", "armeabi-v7a")))
    assertEquals("x86_64", UpdateChecker.abiFrom(listOf("x86", "x86_64")))
  }

  // -- C4：缺件不得被「已是最新」掩盖 ------------------------------------------
  @Test
  fun releaseGapIsNotMaskedByUpToDate() {
    val r = UpdateChecker.classifyLatestBody(body("v0.14.5-fx-2", emptyList()), ARM64_DEVICE, "arm64")
    assertTrue("空资产不得被压成 UpToDate", r is UpdateChecker.CheckResult.Failed)
  }

  // -- 缺下载地址：发布未完成的独立归因 ----------------------------------------
  @Test
  fun assetWithoutDownloadUrlIsReleaseDataBroken() {
    val noUrl = "{\"tag_name\":\"v9.9.9\",\"assets\":[{\"name\":\"dsh-mobile-apk-v9.9.9-arm64.apk\",\"browser_download_url\":\"\",\"size\":1}]}"
    val r = UpdateChecker.classifyLatestBody(noUrl, ARM64_DEVICE, "arm64")
    assertEquals(UpdateChecker.CheckResult.FailureKind.RELEASE_DATA_BROKEN, (r as UpdateChecker.CheckResult.Failed).kind)
  }

  // -- 反例 5：候选名必须绑定本机 ABI 家族，不得把异构名混进候选 ---------------
  @Test
  fun candidateNamesAreFamilyScoped() {
    val arm = UpdateChecker.assetNameCandidates("v1.2.3", "arm64")
    assertTrue(arm.all { it.contains("arm64") })
    assertFalse("arm64 候选里不得出现 x86_64", arm.any { it.contains("x86_64") })
    val x86 = UpdateChecker.assetNameCandidates("v1.2.3", "x86_64")
    assertTrue(x86.all { it.contains("x86_64") })
    assertFalse("x86_64 候选里不得出现 arm64", x86.any { it.contains("arm64") })
    // 主口径 = 发布链产物名（第一个），这是本地落盘名与旧断言依赖的契约
    assertEquals("dsh-mobile-apk-v1.2.3-arm64.apk", UpdateChecker.assetName("v1.2.3", "arm64"))
  }

  // ── 本轮重构（task-4）的独立反证：多源确认链 + MANIFEST 摘要 ──────────────────────
  //
  // 下面这些用例由 tester 独立推导，不复用实现方的样本文件；重点是**反例**：
  //  - 反例 6：任一/全部源失败时，绝不允许出现 UpToDate（"查不到"不是"没有新版"）。
  //  - 反例 7：MANIFEST 里没有可识别的 apk 行 => 解析失败，不得退化成"没有本机架构的包"。
  //  - 反证 8：摘要缺失时拒绝产生可安装更新。

  /** 一档源的最小可测形态（[UpdateChecker.SourceProbe] 是 internal 的，测试与实现同模块）。 */
  private fun down(host: String) = UpdateChecker.SourceProbe.Unreachable(java.net.UnknownHostException(host))

  @Test
  fun everySourceFailingNeverYieldsUpToDate() {
    // 要点：这条用例的失败形态覆盖"全部/部分"两档，且当前版本取得足够高（任何 tag 都比它低），
    // 于是"若实现偷偷返回 UpToDate"一定被抓住，不会被版本比较的巧合掩盖。
    val allDown = listOf<Pair<String, () -> UpdateChecker.SourceProbe>>(
      "gh-proxy" to { down("gh-proxy.com") },
      "ghfast" to { down("ghfast.top") },
      "github" to { down("github.com") },
      "pages" to { down("kelai141.github.io") },
      "ghproxy.net" to { down("ghproxy.net") },
      "api" to { down("api.github.com") },
    )
    val r = UpdateChecker.runChain(allDown, ARM64_DEVICE, "arm64", "99.99.99")
    assertTrue("六档全挂时不得说已是最新，实得 " + r, r is UpdateChecker.CheckResult.Failed)

    // 只有数据类失败（没有连接失败）同样不得 UpToDate，且必须归到"服务/数据"侧而不是"网络"。
    val dataFailures = listOf<Pair<String, () -> UpdateChecker.SourceProbe>>(
      "pages" to {
        UpdateChecker.SourceProbe.Rejected(
          UpdateChecker.CheckResult.FailureKind.PARSE,
          "检查失败：更新接口返回的内容无法解析（可能被网络中间页替换）——请稍后重试",
        )
      },
    )
    val r2 = UpdateChecker.runChain(dataFailures, ARM64_DEVICE, "arm64", "99.99.99") as UpdateChecker.CheckResult.Failed
    assertEquals(UpdateChecker.CheckResult.FailureKind.PARSE, r2.kind)
    assertFalse("数据失败不得被说成架构问题", r2.reason.contains("没有适配本机"))
  }

  @Test
  fun manifestWithoutVersionedApkIsParseFailure() {
    // 只有非 apk 行 => 判不出版本号 => 必须抛（调用方归 PARSE），绝不能当成"没有本机架构的包"。
    val noApk = "00000000000000000000000000000000000000000000000000000000000000aa  notes.md  12\n"
    assertThrows(IllegalArgumentException::class.java) { UpdateChecker.parseManifest(noApk) }
  }

  @Test
  fun missingDigestRejectsInstallableUpdate() {
    // 摘要缺失时不得生成可安装更新，避免把下载后校验降级为仅比对文件大小；
    // 空串会被读成"提供了值但校验失败"，那是另一回事（也更容易被静默吞掉）。
    val facts = UpdateChecker.LatestFacts("v99.0.0", mapOf("dsh-mobile-apk-v99.0.0-arm64.apk" to 1L), emptyMap())
    val r = UpdateChecker.classifyFacts(facts, ARM64_DEVICE, "arm64", "0.13.0") as UpdateChecker.CheckResult.Failed
    assertEquals(UpdateChecker.CheckResult.FailureKind.RELEASE_DATA_BROKEN, r.kind)
  }

  @Test
  fun manifestDigestReachesAvailableAndIsLowercase() {
    // 摘要必须以小写十六进制进入 Available：下游直接拿它和实际文件比对，
    // 大小写差异会让校验误判失败（"文件坏了"的假警报）。
    val manifest = listOf(
      "38E8421BE56A96323893BCC80286203749FF806FB140F185C883F6CC5512C049  apk/dsh-mobile-apk-v99.0.0-arm64.apk  1",
      "13DD5991A6C2EBFE0598451EA348DC1B162EFFA24BC1780AC5E293B20FCAA072  apk/dsh-mobile-apk-v99.0.0-x86_64.apk  1",
    ).joinToString("\n")
    val r = UpdateChecker.classifyFacts(UpdateChecker.parseManifest(manifest), ARM64_DEVICE, "arm64", "0.13.0")
    assertEquals(
      "38e8421be56a96323893bcc80286203749ff806fb140f185c883f6cc5512c049",
      (r as UpdateChecker.CheckResult.Available).sha256,
    )
  }

  @Test
  fun mirrorTableIsFourInContractOrder() {
    // 顺序即回退优先级；条数与顺序都必须与下载站 MIRROR_TEMPLATES 一致（门禁另有一条逐字比对）。
    assertEquals(4, UpdateChecker.MIRROR_PREFIXES.size)
    assertEquals("https://github.com/", UpdateChecker.MIRROR_PREFIXES[0])
    assertEquals("https://gh-proxy.com/https://github.com/", UpdateChecker.MIRROR_PREFIXES[1])
    assertEquals("https://ghfast.top/https://github.com/", UpdateChecker.MIRROR_PREFIXES[2])
    assertEquals("https://ghproxy.net/https://github.com/", UpdateChecker.MIRROR_PREFIXES[3])
  }
}
