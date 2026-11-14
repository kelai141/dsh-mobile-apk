package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * prepareEnvironment 的纯 JVM 行为：固定三键、原值信任、写前授权、每步复核、失败不重放。
 *
 * 全部通过构造 seam 注入，不触设备、不碰输入法、不跑 Gradle。
 */
class NativeEnvironmentExecutionTest {

  /** 记录每一次 argv，并按「设置当前值」的语义回答 get / put。 */
  private class FakeSettings(
    var values: MutableMap<String, String>,
    var failGet: (String) -> Boolean = { false },
    var failPut: (String) -> Boolean = { false },
    var unknownPut: (String) -> Boolean = { false },
  ) : NativeEnvironmentExecution.SettingsChannel {
    val argv = mutableListOf<List<String>>()
    val gateSeen = mutableListOf<Boolean>()

    override fun run(argv: Array<String>, gate: (() -> Boolean)?): JSONObject {
      this.argv += argv.toList()
      if (gate != null) gateSeen += gate()
      val key = argv.getOrNull(3).orEmpty()
      return when (argv.getOrNull(1)) {
        "get" -> if (failGet(key)) incomplete() else ok(values[key] ?: "null")
        "put" -> when {
          unknownPut(key) -> incomplete()
          failPut(key) -> ok("", exit = 1)
          else -> { values[key] = argv[4]; ok("") }
        }
        else -> incomplete()
      }
    }

    private fun ok(stdout: String, exit: Int = 0) = JSONObject().put("ok", exit == 0)
      .put("code", if (exit == 0) "shizuku-controller-completed" else "shizuku-controller-failed")
      .put("executed", "yes").put("stdout", stdout).put("exitCode", exit)

    private fun incomplete() = JSONObject().put("ok", false).put("code", "shizuku-controller-unknown")
      .put("executed", "unknown").put("noReplay", true).put("exitCode", -1)
  }

  private class FakeStore(initial: Map<String, String> = emptyMap()) : NativeEnvironmentExecution.OriginalStore {
    val values = LinkedHashMap(initial)
    var failRemember = false
    override fun trusted(key: String): String? = values[key]
    override fun remember(key: String, original: String): Boolean {
      if (failRemember) return false
      values[key] = original
      return true
    }
    override fun forget(key: String) { values.remove(key) }
  }

  private val next = object : NativeControlDispatcher.Platform {
    override fun implements(plan: JSONObject) = false
    override fun execute(callId: String, plan: JSONObject, args: JSONObject,
      refreshFacts: () -> Boolean, authorize: () -> Boolean) =
      CompletableFuture.completedFuture(JSONObject().put("code", "next-should-not-run"))
  }

  /** 下游适配器：记录被交给它的计划，并回一个可辨认的回执。 */
  private class RecordingNext(private val supports: (JSONObject) -> Boolean = { true }) :
    NativeControlDispatcher.Platform {
    val implemented = mutableListOf<String>()
    val executed = mutableListOf<String>()
    override fun implements(plan: JSONObject): Boolean {
      val ok = supports(plan)
      if (ok) implemented += plan.optString("operation")
      return ok
    }
    override fun execute(callId: String, plan: JSONObject, args: JSONObject,
      refreshFacts: () -> Boolean, authorize: () -> Boolean): CompletableFuture<JSONObject> {
      executed += plan.optString("operation")
      return CompletableFuture.completedFuture(JSONObject().put("ok", true)
        .put("code", "delegated-" + plan.optString("operation")).put("executed", "yes"))
    }
  }

  private fun plan(args: JSONObject = JSONObject(), overrides: (JSONObject) -> Unit = {}): JSONObject =
    JSONObject().put("operation", "prepareEnvironment").put("target", "controlMemory")
      .put("backend", "shizuku").put("epoch", "5").put("args", args).also(overrides)

  private fun execute(
    settings: FakeSettings,
    store: NativeEnvironmentExecution.OriginalStore = FakeStore(),
    ready: Boolean = true,
    factsOk: Boolean = true,
    dispatchOk: () -> Boolean = { true },
    clock: () -> Long = { 0L },
    deadlineMs: Long = 20_000L,
    authorize: () -> Boolean = { true },
    request: JSONObject = plan(),
    callId: String = "env-1",
  ): JSONObject {
    val adapter = NativeEnvironmentExecution(next, settings, { ready }, store,
      NativeEnvironmentExecution.DispatchCheck { dispatchOk() }, deadlineMs, clock)
    return adapter.execute(callId, request, request.optJSONObject("args") ?: JSONObject(),
      { factsOk }, authorize).get(20, TimeUnit.SECONDS)
  }

  private fun settingsWithDefaults() = FakeSettings(linkedMapOf(
    "window_animation_scale" to "1.0",
    "transition_animation_scale" to "1.0",
    "animator_duration_scale" to "1.0",
  ))

  @Test fun onlyTheRustControlMemoryPlanBelongsToThisAdapter() {
    val adapter = NativeEnvironmentExecution(next, settingsWithDefaults(), { true }, FakeStore(),
      { true })
    assertTrue(adapter.implements(plan()))
    assertFalse("别的操作不归这里", adapter.implements(plan().put("operation", "state")))
    assertFalse("别的目标不归这里", adapter.implements(plan().put("target", "privilegedShell")))
    assertFalse("不是 shell 通道", adapter.implements(plan().put("backend", "local")))
    assertFalse("带屏幕的计划不归这里", adapter.implements(plan().put("screenId", "real")))
    // 下游声称支持时，本适配器必须如实转述（包装器不能把别的操作挡在外面）。
    val downstream = RecordingNext()
    val wrapper = NativeEnvironmentExecution(downstream, settingsWithDefaults(), { true }, FakeStore(),
      { true })
    for (other in listOf(
      plan().put("operation", "state"),
      plan().put("operation", "click").put("target", "androidScreen").put("screenId", "real")
        .put("displayId", 0),
      plan().put("operation", "shExec").put("target", "privilegedShell"),
    )) {
      assertTrue("下游支持的 " + other.optString("operation") + " 不得被包装器挡住",
        wrapper.implements(other))
    }
    assertFalse("下游不支持的计划也不得被包装器凭空放行",
      NativeEnvironmentExecution(RecordingNext { false }, settingsWithDefaults(), { true }, FakeStore(),
        { true }).implements(plan().put("operation", "click").put("screenId", "real")))
  }

@Test fun ordinaryPlansAreDelegatedToNextExactlyOnceUnchanged() {
    val downstream = RecordingNext()
    val settings = settingsWithDefaults()
    val adapter = NativeEnvironmentExecution(downstream, settings, { true }, FakeStore(), { true })
    val click = JSONObject().put("operation", "click").put("target", "androidScreen")
      .put("backend", "a11y").put("screenId", "real").put("displayId", 0)
      .put("epoch", "9").put("generation", "4")
    val args = JSONObject().put("x", 12).put("y", 34)
    var gates = 0
    var refreshes = 0
    val reply = adapter.execute("click-1", click, args, { refreshes++; true }, { gates++; true })
      .get(10, TimeUnit.SECONDS)

    // 回执必须原样来自下游，包装器不得改写或重新包装。
    assertTrue(reply.toString(), reply.getBoolean("ok"))
    assertEquals("delegated-click", reply.getString("code"))
    assertEquals(listOf("click"), downstream.executed)
    // 委托时不得替下游消耗授权门，也不得擅自刷新事实。
    assertEquals("包装器不得消耗下游的授权门", 0, gates)
    assertEquals("包装器不得替下游刷新事实", 0, refreshes)
    // 本适配器自己的 settings 通道一次都不该被碰。
    assertTrue("普通操作不得触发 settings 调用", settings.argv.isEmpty())
  }

  @Test fun unknownOperationsGoToNextWithoutTouchingTheShell() {
    // 下游只认 click：未知操作连下游都不支持 ⇒ 包装器也不得放行。
    val downstream = RecordingNext { it.optString("operation") == "click" }
    val settings = settingsWithDefaults()
    val adapter = NativeEnvironmentExecution(downstream, settings, { true }, FakeStore(), { true })
    val unknown = JSONObject().put("operation", "notARealOperation").put("target", "controlMemory")
    assertFalse(adapter.implements(unknown))
    // 不支持也要如实交给下游判定，包装器不得自己编一个结论。
    val reply = adapter.execute("unknown-1", unknown, JSONObject(), { true }, { true })
      .get(10, TimeUnit.SECONDS)
    assertEquals("delegated-notARealOperation", reply.getString("code"))
    assertEquals(listOf("notARealOperation"), downstream.executed)
    assertTrue("未知操作不得触发 settings 调用", settings.argv.isEmpty())

    // prepareEnvironment 名字像、但目标/后端不符时同样不属于本适配器，照样委托。
    val lookalike = plan().put("target", "privilegedShell")
    assertFalse(adapter.implements(lookalike))
    adapter.execute("lookalike-1", lookalike, JSONObject(), { true }, { true }).get(10, TimeUnit.SECONDS)
    assertEquals(listOf("notARealOperation", "prepareEnvironment"), downstream.executed)
    assertTrue("冒充的 prepareEnvironment 不得写系统设置", settings.argv.isEmpty())

    // 反证：下游支持的 click 会被 implements 认领，且不会误判成本适配器自己的操作。
    val click = JSONObject().put("operation", "click").put("target", "androidScreen").put("screenId", "real")
    assertTrue(adapter.implements(click))
    assertEquals(listOf("click"), downstream.implemented)
  }

@Test fun wrapperSourceKeepsOtherAdaptersReachable() {
    val source = listOf(
      java.io.File("src/main/java/com/dsharnessmobile/shell/nativecontrol/NativeEnvironmentExecution.kt"),
      java.io.File("app/src/main/java/com/dsharnessmobile/shell/nativecontrol/NativeEnvironmentExecution.kt"),
    ).first { it.isFile }.readText()
    // implements 必须同时看「自己认不认」与「下游认不认」：只认 own 会把所有其它操作挡在包装器之外。
    assertTrue(source.contains("override fun implements(plan: JSONObject): Boolean = isEnvironment(plan) || next.implements(plan)"))
    // 真正的拦截点只有 execute 的第一行，且必须原样转给 next。
    assertTrue(source.contains("if (!isEnvironment(plan)) return next.execute(callId, plan, args, refreshFacts, authorize)"))
    // 不能有第二处「非本适配器就拒绝」的提前返回。
    assertFalse(source.contains("override fun implements(plan: JSONObject): Boolean = isEnvironment(plan)\n"))
  }

  @Test fun allThreeFixedKeysAreReadThenWrittenAndReadBack() {
    val settings = settingsWithDefaults()
    val reply = execute(settings)
    assertTrue(reply.toString(), reply.getBoolean("ok"))
    assertEquals("environment-prepared", reply.getString("code"))
    assertEquals("yes", reply.getString("executed"))
    // 固定 argv：settings get/put global <key> ...，不接受别的命令形态。
    val commands = settings.argv.map { it.drop(1) }
    assertEquals(listOf(
      listOf("get", "global", "window_animation_scale"),
      listOf("get", "global", "transition_animation_scale"),
      listOf("get", "global", "animator_duration_scale"),
      listOf("put", "global", "window_animation_scale", "0"),
      listOf("get", "global", "window_animation_scale"),
      listOf("put", "global", "transition_animation_scale", "0"),
      listOf("get", "global", "transition_animation_scale"),
      listOf("put", "global", "animator_duration_scale", "0"),
      listOf("get", "global", "animator_duration_scale"),
    ), commands)
    assertTrue("argv 必须是绝对 settings 路径", settings.argv.all { it[0] == "/system/bin/settings" })
    assertTrue("三项都必须置 0", settings.values.values.all { it == "0" })
  }

  @Test fun originalsAreSavedBeforeWritingAndOnlyTrusted() {
    val store = FakeStore()
    val reply = execute(settingsWithDefaults(), store)
    assertTrue(reply.toString(), reply.getBoolean("ok"))
    assertEquals("1.0", store.trusted("window_animation_scale"))
    assertEquals("1.0", store.trusted("transition_animation_scale"))
    assertEquals("1.0", store.trusted("animator_duration_scale"))

    // 不可信原值（shell 的 null 文字 / 非数字 / 越界形态）：一项都不写。
    for (bad in listOf("null", "abc", "1.0.0", "-1", "1e3", "0.00001")) {
      val settings = FakeSettings(linkedMapOf("window_animation_scale" to "1.0",
        "transition_animation_scale" to bad, "animator_duration_scale" to "1.0"))
      val refused = execute(settings, FakeStore())
      assertFalse(bad, refused.getBoolean("ok"))
      assertEquals("environment-original-untrusted", refused.getString("code"))
      assertEquals("no", refused.getString("executed"))
      assertTrue("没有可信原值不得写任何一项：" + bad, settings.argv.none { it.getOrNull(1) == "put" })
    }
  }

  @Test fun repeatedDisableKeepsTheFirstTrustedOriginal() {
    val settings = settingsWithDefaults()
    val store = FakeStore()
    assertTrue(execute(settings, store).getBoolean("ok"))
    // 第二次：当前值已经是 0，但记录里的真原值必须保留，不能被覆盖成 0。
    assertTrue(execute(settings, store, callId = "env-2").getBoolean("ok"))
    assertEquals("1.0", store.trusted("window_animation_scale"))
    assertTrue(settings.values.values.all { it == "0" })
  }

  @Test fun disableAfterAUserChangeRemembersTheNewValueNotTheStaleOne() {
    val store = FakeStore()
    val first = settingsWithDefaults()
    val firstReply = execute(first, store, callId = "env-a")
    assertTrue("第一次关闭失败：" + firstReply, firstReply.getBoolean("ok"))
    assertEquals("1.0", store.trusted("window_animation_scale"))

    // 用户自己把三项改回 2.0，然后再让模型准备一次环境。
    val second = FakeSettings(linkedMapOf(
      "window_animation_scale" to "2.0",
      "transition_animation_scale" to "2.0",
      "animator_duration_scale" to "2.0",
    ))
    val secondReply = execute(second, store, callId = "env-b")
    // 连续立即调用：worker 提交窗口若把第二次判成忙，这里会拿到 environment-busy。
    assertTrue("第二次关闭失败：" + secondReply, secondReply.getBoolean("ok"))
    assertTrue(second.values.values.all { it == "0" })
    // 记录必须跟着用户的选择走，否则 restore 会把过期旧值写回去。
    assertEquals("2.0", store.trusted("window_animation_scale"))
    assertEquals("2.0", store.trusted("transition_animation_scale"))
    assertEquals("2.0", store.trusted("animator_duration_scale"))

    val restored = execute(second, store, request = plan(JSONObject().put("restore", true)), callId = "env-c")
    assertEquals("environment-restored", restored.getString("code"))
    assertTrue(second.values.values.all { it == "2.0" })
  }

  @Test fun writeRequiresTheConsumedGateAndPerStepDispatchRecheck() {
    var gates = 0
    val settings = settingsWithDefaults()
    val denied = execute(settings, authorize = { gates++; false })
    assertFalse(denied.getBoolean("ok"))
    assertEquals("authorize-denied", denied.getString("code"))
    assertEquals("no", denied.getString("executed"))
    assertTrue("被拒时一项都不写", settings.argv.none { it.getOrNull(1) == "put" })

    // 复核在第一次写之后失效：必须立刻停，后面的项不再写。
    var checks = 0
    val partialSettings = settingsWithDefaults()
    val partial = execute(partialSettings, dispatchOk = { checks++; checks <= 1 })
    assertFalse(partial.toString(), partial.getBoolean("ok"))
    assertEquals("environment-dispatch-lost", partial.getString("code"))
    assertEquals("unknown", partial.getString("executed"))
    assertTrue("已经写过东西就不能说没执行", partial.getBoolean("noReplay"))
    assertEquals("只允许写第一项", 1, partialSettings.argv.count { it.getOrNull(1) == "put" })
  }

  @Test fun factsRefreshAndDeadlineStopFurtherWrites() {
    val noFacts = settingsWithDefaults()
    val stopped = execute(noFacts, factsOk = false)
    assertFalse(stopped.getBoolean("ok"))
    assertEquals("environment-dispatch-lost", stopped.getString("code"))
    assertTrue("事实刷新失败时一项都不写", noFacts.argv.none { it.getOrNull(1) == "put" })

    // 超预算：读原值时就已经过期 ⇒ 不写、不说执行过。
    val slow = settingsWithDefaults()
    var now = 0L
    val expired = execute(slow, clock = { now.also { now += 100L } }, deadlineMs = 50L)
    assertFalse(expired.toString(), expired.getBoolean("ok"))
    assertEquals("environment-deadline", expired.getString("code"))
    assertEquals("no", expired.getString("executed"))
    assertTrue("超预算不得写", slow.argv.none { it.getOrNull(1) == "put" })
  }

  @Test fun partialWriteAndReadbackMismatchAreUnknownWithoutRetry() {
    val unknown = settingsWithDefaults()
    // 第二个 put 回执不完整：已经写了第一项 ⇒ 结果不明，且不得自动重试。
    unknown.unknownPut = { it == "transition_animation_scale" }
    val reply = execute(unknown)
    assertFalse(reply.toString(), reply.getBoolean("ok"))
    assertEquals("environment-write-unknown", reply.getString("code"))
    assertEquals("unknown", reply.getString("executed"))
    assertTrue(reply.getBoolean("noReplay"))
    assertEquals("失败后不得重试：每项最多一次 put",
      1, unknown.argv.count { it.getOrNull(1) == "put" && it.getOrNull(3) == "transition_animation_scale" })

    // 回读不一致：同样按 unknown 收尾，不重放。
    val mismatch = FakeSettings(linkedMapOf("window_animation_scale" to "1.0",
      "transition_animation_scale" to "1.0", "animator_duration_scale" to "1.0"))
    val adapter = NativeEnvironmentExecution(next, NativeEnvironmentExecution.SettingsChannel { argv, _ ->
      if (argv[1] == "put" && argv[3] == "window_animation_scale") {
        JSONObject().put("ok", true).put("executed", "yes").put("stdout", "").put("exitCode", 0) // 没真的变
      } else mismatch.run(argv, null)
    }, { true }, FakeStore(), { true }, 20_000L, { 0L })
    val bad = adapter.execute("env-x", plan(), JSONObject(), { true }, { true }).get(20, TimeUnit.SECONDS)
    assertFalse(bad.toString(), bad.getBoolean("ok"))
    assertEquals("environment-readback-mismatch", bad.getString("code"))
    assertEquals("unknown", bad.getString("executed"))
  }

  @Test fun readFailureWritesNothingAndChannelMustBeShell2000() {
    val failing = FakeSettings(linkedMapOf("window_animation_scale" to "1.0"), failGet = { true })
    val reply = execute(failing)
    assertFalse(reply.getBoolean("ok"))
    assertEquals("environment-read-failed", reply.getString("code"))
    assertEquals("no", reply.getString("executed"))
    assertTrue(failing.argv.none { it.getOrNull(1) == "put" })

    val unready = settingsWithDefaults()
    val refused = execute(unready, ready = false)
    assertFalse(refused.getBoolean("ok"))
    assertEquals("shizuku-unavailable", refused.getString("code"))
    assertEquals("no", refused.getString("executed"))
    assertTrue("未配置时连读都不做", unready.argv.isEmpty())
  }

  @Test fun restoreOnlyTouchesValuesWeStillOwn() {
    val store = FakeStore(mapOf(
      "window_animation_scale" to "1.0",
      "transition_animation_scale" to "1.5",
      "animator_duration_scale" to "1.0",
    ))
    // 用户后来自己把 transition 改成了 0.5：那一项不得被覆盖。
    val settings = FakeSettings(linkedMapOf(
      "window_animation_scale" to "0",
      "transition_animation_scale" to "0.5",
      "animator_duration_scale" to "0",
    ))
    val reply = execute(settings, store, request = plan(JSONObject().put("restore", true)), callId = "env-r")
    assertTrue(reply.toString(), reply.getBoolean("ok"))
    assertEquals("environment-restored", reply.getString("code"))
    assertEquals("1.0", settings.values["window_animation_scale"])
    assertEquals("0.5", settings.values["transition_animation_scale"])
    assertEquals("1.0", settings.values["animator_duration_scale"])
    assertNull("恢复过的键清掉记录", store.trusted("window_animation_scale"))
    assertNull("用户改过的键也清掉记录", store.trusted("transition_animation_scale"))
    val data = reply.getJSONObject("data")
    assertEquals(2, data.getInt("restored"))
    assertEquals(1, data.getJSONArray("skipped").length())
  }

  @Test fun restoreWithoutTrustedOriginalsDoesNothing() {
    val settings = FakeSettings(linkedMapOf("window_animation_scale" to "0"))
    val empty = execute(settings, FakeStore(), request = plan(JSONObject().put("restore", true)))
    assertTrue(empty.getBoolean("ok"))
    assertEquals("environment-nothing-to-restore", empty.getString("code"))
    assertEquals("no", empty.getString("executed"))
    assertTrue("没有可信原值不得写", settings.argv.none { it.getOrNull(1) == "put" })
    // 即便存储里有一个形态不可信的值，也不能拿它去写系统设置。
    val untrusted = FakeStore(mapOf("window_animation_scale" to "null"))
    val refused = execute(settings, untrusted, request = plan(JSONObject().put("restore", true)))
    assertEquals("environment-nothing-to-restore", refused.getString("code"))
    assertTrue(settings.argv.none { it.getOrNull(1) == "put" })
  }

  @Test fun restoreIsAllOrNothingWhenUserChangedEveryValue() {
    val store = FakeStore(mapOf(
      "window_animation_scale" to "1.0",
      "transition_animation_scale" to "1.0",
      "animator_duration_scale" to "1.0",
    ))
    val settings = FakeSettings(linkedMapOf(
      "window_animation_scale" to "2.0",
      "transition_animation_scale" to "2.0",
      "animator_duration_scale" to "2.0",
    ))
    val reply = execute(settings, store, request = plan(JSONObject().put("restore", true)))
    assertTrue(reply.toString(), reply.getBoolean("ok"))
    assertEquals("environment-user-modified", reply.getString("code"))
    assertEquals("no", reply.getString("executed"))
    assertTrue("用户改过的值一项都不动", settings.argv.none { it.getOrNull(1) == "put" })
    assertTrue("记录已无用，清空", store.values.isEmpty())
  }

  @Test fun restoreHonoursAuthorizationAndDispatchRecheck() {
    val store = FakeStore(mapOf("window_animation_scale" to "1.0"))
    val deniedSettings = FakeSettings(linkedMapOf("window_animation_scale" to "0"))
    val denied = execute(deniedSettings, store, request = plan(JSONObject().put("restore", true)),
      authorize = { false })
    assertEquals("authorize-denied", denied.getString("code"))
    assertEquals("no", denied.getString("executed"))
    assertTrue(deniedSettings.argv.none { it.getOrNull(1) == "put" })

    val lostSettings = FakeSettings(linkedMapOf("window_animation_scale" to "0"))
    val lost = execute(lostSettings, store, request = plan(JSONObject().put("restore", true)),
      dispatchOk = { false })
    assertEquals("environment-dispatch-lost", lost.getString("code"))
    assertEquals("no", lost.getString("executed"))
    assertTrue("复核失败时不得写", lostSettings.argv.none { it.getOrNull(1) == "put" })
  }

  @Test fun argsAcceptOnlyOptionalBooleanRestore() {
    val settings = settingsWithDefaults()
    val bad = execute(settings, request = plan(JSONObject().put("restore", "yes")))
    assertFalse(bad.getBoolean("ok"))
    assertEquals("invalid-restore", bad.getString("code"))
    assertEquals("no", bad.getString("executed"))
    assertTrue(settings.argv.isEmpty())
    // 缺省 = false = 关闭动画。
    val implied = execute(settingsWithDefaults(), request = plan())
    assertTrue(implied.getBoolean("ok"))
    assertEquals("environment-prepared", implied.getString("code"))
  }

  @Test fun thereIsNoInputMethodOrKeyboardLogicInThisAdapter() {
    val source = listOf(
      java.io.File("src/main/java/com/dsharnessmobile/shell/nativecontrol/NativeEnvironmentExecution.kt"),
      java.io.File("app/src/main/java/com/dsharnessmobile/shell/nativecontrol/NativeEnvironmentExecution.kt"),
    ).first { it.isFile }.readText()
    for (forbidden in listOf("Settings.Secure", "DEFAULT_INPUT_METHOD", "InputMethodManager",
      "input_method", "ime ", "IME", "AdbKeyboard", "showSoftInput")) {
      assertFalse("prepareEnvironment 不得含输入法逻辑：" + forbidden, source.contains(forbidden))
    }
    // 只允许三键，且只有 settings get/put 两种 argv 形态。
    assertEquals(listOf("window_animation_scale", "transition_animation_scale", "animator_duration_scale"),
      NativeEnvironmentExecution.KEYS)
    assertTrue(source.contains("\"get\", \"global\""))
    assertTrue(source.contains("\"put\", \"global\""))
  }
}
