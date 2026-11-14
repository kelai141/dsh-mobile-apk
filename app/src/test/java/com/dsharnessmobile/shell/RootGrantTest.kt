package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 「AI root 权限」授权门（issue #262 方案 A）的决策回归。
 *
 * 纯决策与执行面源码契约；SharedPreferences/Activity 薄壳不进 JVM 测试。
 * 0.14.3：Shizuku-root 与显式授权的应用 su 是替代路径，不是叠加条件。
 *  - Shizuku 路径只认真实通道 uid==0，应用 su 路径只认显式授权；
 *  - 打开前必须先过免责确认门（0.14.7 起同意绑定免责声明**内容**版本，不是 versionCode）；
 *  - 关闭永远允许（撤销不是需要资格的动作）。
 */
class RootGrantTest {

  private fun decision(
    channelUid: Int,
    consentRevision: Int,
    currentRevision: Int = RootGrant.DISCLAIMER_REVISION,
    wantOn: Boolean = true,
    rootGranted: Boolean = false,
    granted: Boolean = false,
  ): JSONObject? = RootGrant.decision(
    channelUid = channelUid,
    rootGranted = rootGranted,
    granted = granted,
    consentRevision = consentRevision,
    currentRevision = currentRevision,
    wantOn = wantOn,
  )

  @Test
  fun `root channel with valid consent allows turning on`() {
    assertNull(decision(channelUid = 0, consentRevision = RootGrant.DISCLAIMER_REVISION))
  }

  @Test
  fun `non-root channel without alternate su is refused even with consent`() {
    // 通道身份 ≠ 设备是否 root：uid 2000（Shizuku 以 ADB 启动）与读不到（-1）都算非 root，
    // 假绿（已 root 设备上按设备判据放行）是 issue 点名的缺陷形态。
    for (uid in listOf(2000, -1, 10241)) {
      val refusal = decision(channelUid = uid, consentRevision = RootGrant.DISCLAIMER_REVISION)
      assertNotNull("uid=$uid 必须拒绝", refusal)
      assertEquals(RootGrant.CODE_NOT_ROOT_CHANNEL, refusal!!.opt("code"))
    }
  }

  @Test
  fun `missing or stale disclaimer revision is refused on root channel`() {
    // 从未同意（0 / 负数）一律 fail-closed——这是免责门唯一不能松的一条。
    for (never in listOf(-1, 0)) {
      val refusal = decision(channelUid = 0, consentRevision = never)
      assertNotNull("rev=$never 必须拒绝", refusal)
      assertEquals(RootGrant.CODE_CONSENT_REQUIRED, refusal!!.opt("code"))
    }
    // 落后于当前免责声明内容版本 ⇒ 失效（只有「内容变了」才重新确认，见下一条反证用例）。
    val stale = decision(
      channelUid = 0,
      consentRevision = RootGrant.DISCLAIMER_REVISION - 1,
      currentRevision = RootGrant.DISCLAIMER_REVISION,
    )
    assertNotNull(stale)
    assertEquals(RootGrant.CODE_CONSENT_REQUIRED, stale!!.opt("code"))
  }

  /**
   * 反证用例（用户实测缺陷的钉子）：用户实测「root 免责声明每次更新怎么都会掉」——
   * 旧实现把同意绑在 BuildConfig.VERSION_CODE 上，每次版本号 +1 就清掉同意并连带关开关。
   * 判据里不得再出现 versionCode：本用例对同一份同意扫遍整段「版本号区间」，全员有效。
   */
  @Test
  fun `apk upgrade keeps consent because it is bound to the disclaimer revision not the version code`() {
    val revision = RootGrant.DISCLAIMER_REVISION
    assertTrue("同意当前免责声明版本必须有效", RootGrant.consentValidFor(revision, revision))
    for (apkVersionCode in listOf(-1, 0, 1, 100, 101, Int.MAX_VALUE)) {
      // decision 根本不接收 versionCode：这里显式扫一遍「升级序列」也必须放行。
      assertNull(
        "APK versionCode=$apkVersionCode 的升级不得清掉同意",
        decision(channelUid = 0, consentRevision = revision),
      )
      assertTrue(
        "APK versionCode=$apkVersionCode 的升级不得让开关失效",
        RootGrant.effectiveGrant(true, revision, revision),
      )
    }
    // 免责声明内容更新（revision +1）才是唯一要求重新确认的触发器。
    assertFalse(RootGrant.consentValidFor(revision, revision + 1))
    assertNotNull(
      decision(channelUid = 0, consentRevision = revision, currentRevision = revision + 1),
    )
  }

  /**
   * 迁移策略（0.14.7）的**真值驱动**用例：断言必须真的驱动迁移函数
   * [RootGrant.migratedConsentRevision]，而不是复述字面量（"legacy > 0" 恒真等于没测）。
   * 迁移是本次修复里最容易出错的一段（用户抱怨的正是「同意总掉」）：
   *  - 老键 consentVersionCode `> 0`（旧语义 = 当时的 APK versionCode）⇒ 记为已同意当前 revision；
   *  - 新键 consentRevision `> 0` ⇒ 已权威，原样返回（幂等，绝不被旧键覆盖）；
   *  - 两键都非正数 ⇒ 0（从未同意 / 已撤销，fail-closed）；
   *  - 迁移结果必须真的能过同意门与授权门（否则「保住同意」只是中间值好看）。
   */
  @Test
  fun `legacy consent migration keeps any consenting user but fails closed on zero`() {
    val rev = RootGrant.DISCLAIMER_REVISION

    // 1) 老用户同意过（任何正数旧值都算，与它等于哪个版本号无关）：迁到当前 revision。
    for (legacy in listOf(1, 42, 100, 999, Int.MAX_VALUE)) {
      assertEquals("legacy=$legacy 必须迁成当前 revision", rev, RootGrant.migratedConsentRevision(0, legacy))
    }

    // 2) 从未同意 / 已撤销（0 或脏负数）：迁移不得凭空造出同意。
    for (legacy in listOf(-1, 0)) {
      assertEquals("legacy=$legacy 不得被认成同意", 0, RootGrant.migratedConsentRevision(0, legacy))
    }

    // 3) 幂等：新键已有值即权威，迁移不得用旧键覆盖它（否则用户回退旧版再升级会被旧值改写）。
    for (stored in listOf(1, rev, rev + 5, Int.MAX_VALUE)) {
      assertEquals("新键已权威，不得被旧键覆盖", stored, RootGrant.migratedConsentRevision(stored, 100))
    }

    // 4) 撤销后（setConsent(false) 双键清零）再读不得复活——两键皆非正数，恒为 0。
    assertEquals("撤销态不得被迁移复活", 0, RootGrant.migratedConsentRevision(0, 0))

    // 5) 迁移结果必须真的过门：同意门 + 授权门都成立（不是「中间值好看」）。
    for (legacy in listOf(1, 100, 999)) {
      val migrated = RootGrant.migratedConsentRevision(0, legacy)
      assertTrue("legacy=$legacy 迁移后必须过同意门", RootGrant.consentValidFor(migrated, rev))
      assertTrue("legacy=$legacy 迁移后必须过授权门", RootGrant.effectiveGrant(true, migrated, rev))
    }

    // 6) 安全属性不许放松：撤销态（0）依然开不了。
    assertFalse(RootGrant.consentValidFor(0, rev))
    assertFalse(RootGrant.effectiveGrant(true, 0, rev))
  }

  @Test
  fun `turning off is always allowed regardless of channel or consent`() {
    assertNull(decision(channelUid = 2000, consentRevision = 0, wantOn = false))
    assertNull(decision(channelUid = -1, consentRevision = 0, wantOn = false))
    assertNull(decision(channelUid = 0, consentRevision = 0, wantOn = false))
    assertNull(decision(channelUid = 0, consentRevision = RootGrant.DISCLAIMER_REVISION, wantOn = false, rootGranted = false))
  }

  @Test
  fun `root transports are alternatives not cumulative requirements`() {
    assertNull(decision(channelUid = 0, consentRevision = RootGrant.DISCLAIMER_REVISION, rootGranted = false))
    assertNull(decision(channelUid = -1, consentRevision = RootGrant.DISCLAIMER_REVISION, rootGranted = true))
    assertNull(decision(channelUid = 2000, consentRevision = RootGrant.DISCLAIMER_REVISION, rootGranted = true))
    assertNotNull(decision(channelUid = -1, consentRevision = RootGrant.DISCLAIMER_REVISION, rootGranted = false))
    assertEquals(RootGrant.CODE_CONSENT_REQUIRED,
      decision(channelUid = -1, consentRevision = RootGrant.DISCLAIMER_REVISION - 1, rootGranted = true)!!.opt("code"))
  }

  @Test
  fun `effective execution grant rejects absent revoked and stale consent`() {
    // 判据 = granted && 同意值 > 0 && 同意值 >= 当前要求的免责声明版本。
    // 与旧语义的关键差别：不再要求「同意值 == 当前值」，因此 APK 升级（版本号变化但
    // revision 不变）不会让开关失效。
    for (required in listOf(-1, 0, 1, 100)) {
      for (granted in listOf(false, true)) {
        for (consent in listOf(-1, 0, 1, 99, 100, 101)) {
          assertEquals("grant=$granted consent=$consent required=$required",
            granted && consent > 0 && consent >= required,
            RootGrant.effectiveGrant(granted, consent, required))
        }
      }
    }
    // 反证：同意值高于当前 revision（例如用户回滚到旧版 APK）不得失效，否则回滚又掉一次。
    assertTrue(RootGrant.effectiveGrant(true, RootGrant.DISCLAIMER_REVISION + 3, RootGrant.DISCLAIMER_REVISION))
  }

  /**
   * Root 诊断通道是独立面：选定身份后就那一条，**没有**「不可用就升级到 root」或跨通道重放。
   *
   * 旧实现靠 `ShellOps.canFallbackBeforeDispatch` 在 Shizuku 与 su 之间挑路径，ShellOps 退役后
   * 这条判据没有生产引用。这里改为钉住替代它的两条事实：①身份在派发前选定且只有一次派发；
   * ②gate 拒绝与身份不符都按「没执行」结算，不触发任何回退（不削弱 uid 0/2000 的分离）。
   */
  @Test
  fun `root diagnostics pick one identity and never promote or replay`() {
    val file = listOf(
      File("src/main/java/com/dsharnessmobile/shell/nativecontrol/NativePrivilegeExecution.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/nativecontrol/NativePrivilegeExecution.kt"),
    ).firstOrNull { it.isFile } ?: throw AssertionError("找不到 NativePrivilegeExecution.kt")
    val diagnostics = file.readText()
    // 单一身份选择：root 只走 su，shell 只走 Shizuku；没有第二条路径、没有循环重试。
    assertTrue(diagnostics.contains("if (root && RootAccess.isGranted(context) && RootAccess.suPath() != null)"))
    assertTrue(diagnostics.contains("ShizukuTransport.runNativeDiagnostic(context, command, if (root) 0 else 2000, gate)"))
    assertFalse("不得按错误码回退到另一条通道", diagnostics.contains("canFallbackBeforeDispatch"))
    assertFalse(diagnostics.contains("ShellOps."))
    assertFalse(diagnostics.contains("while ("))
    assertTrue("选定身份后必须再复核实际身份",
      source("ShizukuTransport.kt").contains("put(\"code\", \"shizuku-identity-changed\")"))
    // 授权拒绝是确定没执行：不重试、也不升级身份。
    assertTrue(diagnostics.contains("!permitted.get() -> \"no\""))
    assertTrue(diagnostics.contains("RootAccess.suAcknowledgement(result)"))
  }

  @Test
  fun `refusals carry guidance`() {
    // 结构化拒绝必须带人话 guidance（页面直接展示，不静默）。
    val refusal = decision(channelUid = 0, consentRevision = 0)
    assertTrue(refusal!!.optString("guidance").isNotBlank())
    assertEquals(false, refusal.opt("ok"))
  }

  // ── 源码契约：门的接线不得被无声拆除 ────────────────────────────

  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).firstOrNull { it.isFile }?.readText()?.lineSequence()?.filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")
  }?.joinToString("\n") ?: throw AssertionError("找不到源码 $name")

  private fun body(name: String, signature: String): String {
    val text = source(name)
    val start = text.indexOf(signature)
    if (start < 0) throw AssertionError("找不到成员 $name: $signature")
    val next = Regex("(?m)^  (?:(?:private|internal|override) )?fun ")
      .find(text, start + signature.length)?.range?.first ?: text.length
    return text.substring(start, next)
  }

  private fun assertBefore(text: String, first: String, second: String) {
    val a = text.indexOf(first)
    val b = text.indexOf(second)
    assertTrue("$first 必须在 $second 前，且两处都必须在执行代码中", a >= 0 && b > a)
  }

  @Test
  fun enableRequiresEitherTransportAndCurrentConsentRegardlessOfOldSwitch() {
    val required = RootGrant.DISCLAIMER_REVISION
    for (uid in listOf(-1, 0, 2000, 10241)) {
      for (su in listOf(false, true)) {
        for (oldGrant in listOf(false, true)) {
          for (consent in listOf(-1, 0, required - 1, required, required + 1)) {
            val refusal = decision(uid, consent, currentRevision = required, rootGranted = su, granted = oldGrant)
            val expectedCode = when {
              uid != 0 && !su -> RootGrant.CODE_NOT_ROOT_CHANNEL
              consent <= 0 || consent < required -> RootGrant.CODE_CONSENT_REQUIRED
              else -> null
            }
            assertEquals("uid=$uid su=$su oldGrant=$oldGrant consent=$consent",
              expectedCode, refusal?.optString("code"))
            assertNull(decision(uid, consent, currentRevision = required, wantOn = false, rootGranted = su, granted = oldGrant))
          }
        }
      }
    }
  }

  @Test
  fun allShizukuCommandSurfacesAreFencedAndGatedBeforeDispatch() {
    val ready = body("ShizukuTransport.kt", "private fun readyService(")
    assertBefore(ready, "if (applyGate) rootGateRefusal(context)", "ensureBound(context, requestPermission, ignoreGranted)")
    assertBefore(ready, "if (pv < ShizukuUserServiceBridge.PROTOCOL_VERSION)", "configureIfNeeded(context)")
    assertBefore(ready, "configureIfNeeded(context)", "if (applyGate) actualIdentityRefusal(context, remote)")
    assertBefore(ready, "actualIdentityRefusal(context, remote)", "return remote to null")
    for (name in listOf("runShell", "pullFile", "pushFile", "removeRemote", "runController")) {
      val entry = body("ShizukuTransport.kt", "fun $name(")
      assertTrue("$name 必须在命令 fence 内调用对应内部入口",
        entry.contains("= RootExecutionFence.command(context) {") && entry.contains(name + "Internal(context,"))
    }
    val controller = body("ShizukuTransport.kt", "private fun runControllerInternal(")
    // Controller uses the same pre-bind, v4-ack and actual-identity gateway already checked above.
    assertBefore(controller, "readyService(context)", "lease.beforeRpc(remote)")
    assertTrue("Controller must not bypass the common acknowledged gateway", !controller.contains("ensureBound(context)"))
    assertBefore(controller, "lease.beforeRpc(remote)", "remote.exec(argv,")
  }

  /**
   * 反证用例（静态面，与上面那条动态反证同源）：同意判据里**不得再出现 versionCode**，
   * 并必须显式存在「免责声明内容修订」常量。把 versionCode 加回判据 = 复活用户实测缺陷。
   */
  @Test
  fun consentGateNeverReadsTheApkVersionCodeAndBindsTheDisclaimerRevision() {
    val data = body("RootGrant.kt", "fun consentValidFor(")
    assertTrue(
      "同意判据只允许看「>0 且覆盖当前 revision」",
      data.contains("revision > 0 && revision >= requiredRevision"),
    )
    val decisionBody = body("RootGrant.kt", "fun decision(")
    assertTrue(decisionBody.contains("if (!consentValidFor(consentRevision, currentRevision))"))
    assertTrue("决定权不得再读 BuildConfig.VERSION_CODE", !decisionBody.contains("VERSION_CODE"))
    val grant = body("RootGrant.kt", "fun isGranted(")
    assertTrue("isGranted 的授权位必须过同意判据", grant.contains("consentRevision(context)"))
    assertTrue("isGranted 不得再读 BuildConfig.VERSION_CODE", !grant.contains("VERSION_CODE"))
    val stateBody = body("RootGrant.kt", "fun state(")
    assertTrue("state 不得再读 BuildConfig.VERSION_CODE", !stateBody.contains("VERSION_CODE"))
    assertTrue("consentValid 由同一判据派生", stateBody.contains("consentValidFor(revision, DISCLAIMER_REVISION)"))
    // 兼容面：旧字段名必须留在读面里（页面与桥对称门禁读它们）。
    assertTrue(stateBody.contains(""".put("consentVersionCode", revision)"""))
    assertTrue(stateBody.contains(""".put("currentVersionCode", DISCLAIMER_REVISION)"""))
    // 迁移判据必须落在**纯函数**里（可被真值驱动），薄壳只负责读写键。
    val migration = body("RootGrant.kt", "internal fun migratedConsentRevision(")
    assertTrue("新键为正即权威且幂等", migration.contains("storedRevision > 0") && migration.contains("return storedRevision"))
    assertTrue("老键为正即认成已同意", migration.contains("legacyVersionCode > 0"))
    assertTrue("迁移只用 >0 判定，不得比 versionCode", !migration.contains("VERSION_CODE"))
    val shell = body("RootGrant.kt", "private fun consentRevision(")
    assertTrue("必须保留旧键的只读读取", shell.contains("KEY_CONSENT_VC") && shell.contains("KEY_CONSENT_REV"))
    assertTrue("薄壳必须委托纯函数", shell.contains("migratedConsentRevision(stored, legacy)"))
    assertTrue("薄壳不得自己读 versionCode", !shell.contains("VERSION_CODE"))
    // 文案与判据必须同源：常量是唯一的「要求重新确认」触发器。
    assertTrue(RootGrant.DISCLAIMER_REVISION >= 1)
  }

  @Test
  fun v4ConfigurationAcknowledgementBindsExactAppIdentityBeforeReady() {
    // 协议号随新增事务前进（4 = configure 面，5 = 原生输入面）；断言钉住「至少覆盖 v4 语义」，
    // 而不是钉住某个具体数字，避免每次加事务都要改这条防回归。
    val version = Regex("const val PROTOCOL_VERSION = (\\d+)")
      .find(source("ShizukuUserService.kt"))?.groupValues?.get(1)?.toIntOrNull()
    assertTrue("服务端协议版本必须 >= 4（v4 的 configure/repair 语义不可回退）", version != null && version >= 4)
    val configure = body("ShizukuTransport.kt", "private fun configureIfNeeded(")
    assertBefore(configure, "remote.protocolVersion() < ShizukuUserServiceBridge.PROTOCOL_VERSION", "remote.configure(uid, root)")
    assertBefore(configure, "remote.configure(uid, root)", "val ack = remote.configuration()")
    for (check in listOf("""ack.getBoolean("ok")""", """ack.getInt("appUid", -1) == uid""",
      """ack.getString("appDataDir") == root""",
      """ack.getInt("protocolVersion", -1) >= ShizukuUserServiceBridge.PROTOCOL_VERSION""")) {
      assertBefore(configure, check, "if (valid) configuredForAge = age")
    }
    assertTrue("未确认或异常不得记为就绪", configure.contains("false"))
  }

  @Test
  fun onlyFixedNativeOwnershipMaintenanceMayBypassAiGate() {
    val text = source("ShizukuTransport.kt")
    assertEquals(2, Regex("""readyService\((context|app), applyGate = false""").findAll(text).count())
    val repair = body("ShizukuTransport.kt", "fun repairOwnership(")
    assertBefore(repair, "RootExecutionFence.maintenance", "readyService(context, applyGate = false, requestPermission = false, ignoreGranted = true)")
    assertBefore(repair, "configureIfNeeded(context)", "remote.repairOwnership(path, maxEntries)")
    // 探测面那处豁免必须**只绑定、不执行**（2026-10-03 加：绕过不可信的客户端权限预检才能真正判通道）
    val probeEnv = body("ShizukuTransport.kt", "private class SystemRootProbeEnv(")
    assertTrue(probeEnv.contains("readyService(app, applyGate = false, requestPermission = false, ignoreGranted = true)"))
    assertTrue(!probeEnv.contains("remote.exec(") && !probeEnv.contains("repairOwnership("))
    val direct = body("ShizukuTransport.kt", "internal fun autoHealOwnershipDirect(")
    // 2026-10-01：探测与残留租约清算移到 fence 之前（fence 入口会被残留租约挡住）；修复派发本体仍在 fence 内。
    assertTrue(direct.contains("return RootExecutionFence.maintenance(context) {"))
    assertTrue(direct.contains("""java.io.File(app.applicationInfo.dataDir, "files")"""))
  }

  @Test
  fun effectiveCurrentConsentFeedsBothPrebindAndActualIdentityGates() {
    val grant = body("RootGrant.kt", "fun isGranted(")
    assertTrue(grant.contains("= effectiveGrant("))
    assertTrue(grant.contains("KEY_GRANTED") && grant.contains("consentRevision(") && grant.contains("DISCLAIMER_REVISION"))
    val state = body("RootGrant.kt", "fun state(")
    // E1：读面不再重复求值——先算一次 granted，再放进 JSON；语义仍是「已授权且同意有效」。
    assertTrue(state.contains("val granted = effectiveGrant(storedSwitch(context), revision, DISCLAIMER_REVISION)"))
    assertTrue(state.contains(""".put("granted", granted)"""))
    assertFalse("读面不得再逐字段重复求值", state.contains(""".put("granted", isGranted(context))"""))
    assertTrue(body("ShizukuTransport.kt", "internal fun rootGateRefusal(").contains("RootGrant.isGranted(context)"))
    val actual = body("ShizukuTransport.kt", "private fun actualIdentityRefusal(")
    assertTrue(actual.contains("dispatchIdentity(context, remote).second"))
    val identity = body("ShizukuTransport.kt", "private fun dispatchIdentity(")
    assertTrue(identity.contains("remote.uid()") && identity.contains("!RootGrant.isGranted(context)"))
    assertTrue(identity.contains("uid != 0 && uid != 2000"))
  }

  @Test
  fun suModelDispatchIsFencedAndConsumesEffectiveAiConsentBeforeProcessStart() {
    val entry = body("RootAccess.kt", "fun execRoot(")
    assertTrue(entry.contains("RootExecutionFence.command(context) {"))
    assertTrue(entry.contains("requireAiGrant = true"))
    val dispatch = body("RootAccess.kt", "private fun execPrivileged(")
    assertBefore(dispatch, "if (!isGranted(context))", "ProcessBuilder(su,")
    assertBefore(dispatch, "if (requireAiGrant && !RootGrant.isGranted(context))", "ProcessBuilder(su,")
    val repair = body("RootAccess.kt", "fun repairOwnership(")
    assertTrue(repair.contains("= RootExecutionFence.maintenance"))
  }

  @Test
  fun consentRevokeAndReconsentNeedNoRootAndCannotReviveExpiredGrant() {
    val consent = body("RootGrant.kt", "fun setConsent(")
    assertBefore(consent, "val keepGranted = isGranted(app)", "putBoolean(KEY_GRANTED, keepGranted)")
    // 安全属性不许放松：取消勾选仍然**立即撤销同意并同时关闭开关**（用户指定语义）。
    assertTrue(consent.contains("putInt(KEY_CONSENT_REV, 0).putInt(KEY_CONSENT_VC, 0)"))
    assertTrue(consent.contains("putBoolean(KEY_GRANTED, false)"))
    // 勾选侧：记录的是免责声明内容版本，不是 versionCode（绑版本号正是被修的缺陷）。
    assertTrue(consent.contains("putInt(KEY_CONSENT_REV, DISCLAIMER_REVISION)"))
    assertTrue(consent.contains("""put("ok", true)"""))
    assertTrue("同意记录不是资格探测或 root 执行", !consent.contains("decision(") &&
      !consent.contains("RootAccess.requestGrant(") && !consent.contains("RootAccess.isGranted("))
  }

  @Test
  fun nativeUiRepairSubmitsSingleFlightAndRootGrantReadsSharedSettlement() {
    val bridge = body("AndroidBridge.kt", "fun repairRootOwnership(")
    assertTrue(bridge.contains("RootOwnershipJobs.request(app)"))
    assertTrue("UI 桥不能等 Binder 维护完成", !bridge.contains("runBlocking(") && !bridge.contains("autoHealOwnership("))
    assertTrue(body("RootGrant.kt", "fun state(").contains(""".put("ownership", RootOwnershipJobs.state(context))"""))
    val request = body("RootOwnershipJobs.kt", "fun request(")
    assertTrue(request.contains("val started = start(context)"))
    assertTrue(request.contains("\"repair-started\"") && request.contains("\"repair-running\""))
    assertTrue(!request.contains("await(") && !request.contains("join("))
  }

  /**
   * 免责文档必须在 APK assets 里真实存在（LocalDocs 登记表指向的路径打包漏了 = 白屏，
   * fail-closed 的 missing-asset 分支只有用户真打开时才会暴露——打包期就该钉住）。
   */
  @Test
  fun `disclaimer asset exists in the apk`() {
    val asset = listOf(
      File("src/main/assets/docs/root-disclaimer.html"),
      File("app/src/main/assets/docs/root-disclaimer.html"),
    ).firstOrNull { it.isFile }
    assertNotNull("assets/docs/root-disclaimer.html 必须随包（issue #262 免责门）", asset)
    assertTrue("免责声明不能是空文档", (asset!!.length() > 1024L))
  }

  // ── 回包形状契约（2026-09-30 用户实测：撤销同意显示「失败：原因未在本版登记」）─────

  /**
   * [RootGrant.setConsent] 的回包必须带 `ok: true`：页面结算（settleLinkCall）只认
   * `ok === true`，缺字段会把已成功的写入渲染成失败。持久化面无法在 JVM 直测
   * （SharedPreferences 需要 Context），以源码契约钉住形状——与包名同源契约同款。
   */
  @Test
  fun `setConsent answer carries ok true`() {
    val source = listOf(
      File("src/main/java/com/dsharnessmobile/shell/RootGrant.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/RootGrant.kt"),
    ).firstOrNull { it.isFile }
      ?: throw AssertionError("找不到 RootGrant.kt")
    val text = source.readText()
    val body = Regex("fun setConsent[\\s\\S]*?\\n  \\}")
      .find(text)?.value ?: throw AssertionError("找不到 setConsent 函数体")
    assertTrue(
      "setConsent 的 return 必须显式 put(\"ok\", true)——页面结算只认 ok===true",
      body.contains("put(\"ok\", true)"),
    )
  }

  /**
   * [RootGrant.setGranted] 的拒绝回包必须同时带 `reason`（= code）：人话翻译只读 reason
   * （user-copy.ts 的 CALL_REASON 唯一真源），只带 code 会落「未在本版登记」兜底。
   */
  @Test
  fun `setGranted refusal carries reason for the copy table`() {
    val source = listOf(
      File("src/main/java/com/dsharnessmobile/shell/RootGrant.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/RootGrant.kt"),
    ).firstOrNull { it.isFile }
      ?: throw AssertionError("找不到 RootGrant.kt")
    val text = source.readText()
    val body = Regex("fun setGranted[\\s\\S]*?\\n  \\}")
      .find(text)?.value ?: throw AssertionError("找不到 setGranted 函数体")
    assertTrue(
      "拒绝分支必须 put(\"reason\", ...)——CALL_REASON 表按 reason 翻译",
      body.contains("put(\"reason\""),
    )
  }
}
