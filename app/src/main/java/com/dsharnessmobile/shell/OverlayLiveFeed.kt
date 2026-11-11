package com.dsharnessmobile.shell

import android.os.FileObserver
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/** live 流消费协作类（会话维）：FileObserver 监听 home/.dsh/.live.ndjson 逐行 drain 事件分发
 *  （turn_start/tool_call/tool_result/turn_end）+ android_* 自动化避让（F7）+ debug 合成 pending 注入。 */
class OverlayLiveFeed(private val svc: OverlayService) {

  companion object {
    /** 单次 drain 读取上限（#178 契约：生产者 bridge 每行一次 appendFileSync、行长硬上限
     *  240/160 字符；256KB 内必含整行边界，溢出部分因按消费量推进而自然留到下一轮）。 */
    private const val LIVE_READ_CAP_BYTES = 256 * 1024
  }

  private var watcher: FileObserver? = null
  private var readOffset = 0L

  /** 服务 onDestroy 联动（原 watcher?.stopWatching()）。 */
  fun stopWatcher() {
    watcher?.stopWatching()
  }

  private fun liveFile(): File = File(File(svc.filesDir, "home/.dsh"), ".live.ndjson")

  fun startWatcher() {
    val dir = File(svc.filesDir, "home/.dsh")
    if (!dir.exists()) dir.mkdirs()
    readOffset = liveFile().takeIf { it.exists() }?.length() ?: 0L
    watcher = object : FileObserver(dir.absolutePath, FileObserver.MODIFY or FileObserver.CREATE) {
      override fun onEvent(event: Int, path: String?) {
        if (path == ".live.ndjson") drainLive()
        else if (path == ".overlay-test-pending" &&
          (svc.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
          // 调试注入（debuggable 包）：run-as 写 question|approval|clear 到该文件 → 合成 pending。
          // am start-service 通道被跨用户 binder 权限拦死，文件通道复用本 watcher 零新权限。
          try {
            val v = File(dir, ".overlay-test-pending").readText().trim()
            svc.main.post {
              val eventId = "test-" + System.currentTimeMillis()
              when (v) {
                // 0.13.3 W3 帧形：合成 $events waterfall 副本（eventId/agentId 字段）
                "approval" -> svc.panel.pendingApprovals[eventId] = PendingApproval(eventId, svc.activeSessionId, "bash", "rm -rf build/ 需要审批（debug 注入）")
                "question" -> {
                  val items = org.json.JSONArray("""[{"id":"q1","header":"简单问题1","question":"现在是白天还是晚上？","options":[{"label":"白天","description":"现在不在晚上"},{"label":"晚上","description":"现在是晚上"}],"multiSelect":false},{"id":"q2","header":"简单问题2","question":"要重试 TLS 同步吗（debug 注入）？","options":[{"label":"立即重试"},{"label":"稍后"}],"multiSelect":false}]""")
                  svc.panel.pendingQuestions[eventId] = PendingQuestion(eventId, svc.activeSessionId, items)
                }
                else -> { svc.panel.pendingApprovals.clear(); svc.panel.pendingQuestions.clear() }
              }
              svc.panel.onPendingChanged()
            }
          } catch (_: Exception) {}
        }
      }
    }.apply { startWatching() }
    drainLive()
  }

  /**
   * live 行消费（0.13.8 #178 行边界修复）：只消费到最后一个 `\n`，偏移按**消费量**推进——
   * 原实现 `readOffset = len` 把未消费的截断部分/半行一并跳过（偏移记账 ≠ 消费量）；
   * 多字节截断与半行随「找不到换行就不推进」自然消失。CAP 提为具名常量并写明契约
   * （生产者 bridge 每行一次 appendFileSync、行长硬上限 240/160 字符）。
   */
  private fun drainLive() {
    val f = liveFile()
    if (!f.exists()) return
    val lines = ArrayList<String>()
    try {
      RandomAccessFile(f, "r").use { raf ->
        val len = raf.length()
        if (len < readOffset) readOffset = 0 // 文件被轮转重建
        if (len > readOffset) {
          raf.seek(readOffset)
          val buf = ByteArray((len - readOffset).toInt().coerceAtMost(LIVE_READ_CAP_BYTES))
          raf.readFully(buf)
          val text = String(buf, Charsets.UTF_8)
          val lastNewline = text.lastIndexOf('\n')
          if (lastNewline < 0) return // 半行：等下次补齐，偏移不动
          val consumable = text.substring(0, lastNewline)
          readOffset += lastNewline + 1 // 只推进到已消费边界（非 len）
          for (line in consumable.split("\n")) {
            val t = line.trim()
            if (t.isNotEmpty()) lines.add(t)
          }
        }
      }
    } catch (_: Exception) {
      return
    }
    if (lines.isEmpty()) return
    svc.main.post {
      var changed = false
      for (line in lines) {
        try {
          val j = JSONObject(line)
          // v2 聚合层入口：先转发原始事件（含旧实现不消费的 k=think / k=text），
          // 再走下面的旧消费逻辑——两套 UI 各自决定怎么用，互不干扰（开关只允许一套窗口存在）。
          svc.liveSink?.invoke(liveEventOf(j))
          when (j.optString("k")) {
            // 注：turn_start 分支删除（bridge 0.1.4 起退役该行，lib 里仅剩注释——#178 取证确认死代码）
            "tool_call" -> {
              val s = j.optString("s", "")
              // 会话感知：仅当事件属于当前目标会话（或尚无目标）才置忙，
              // 避免其它会话/陈旧行的 tool_call 让 busy 永久卡死（#2）。
              if (svc.activeSessionId.isEmpty() || s == svc.activeSessionId) {
                // 0.13.8 #178-⑤：tool_call 续期乐观忙态（= now）而非清零——
                // 45s 兜底退化为「45s 内无任何 live 活动」，live 唯一回退恢复有效。
                svc.optimisticBusyAt = System.currentTimeMillis()
                if (!svc.sessionBusy) { svc.sessionBusy = true; svc.turnStartedAt = System.currentTimeMillis() }
                // 块H-A1：任一 tool_call = 新一轮已开始 → 清除上一轮的完成位（否则 A 轮完成后
                // B 轮进行中仍显示「已完成」，详档 §3.1 硬性 2）。
                svc.onTurnStart()
                svc.toolCount++
                // 模板化显示（用户拍板）：live 行自带 name + args（bridge 0.1.1 已在产）——
                // 思考=Deep diving 扫光；调工具=工具类型+概览。
                svc.currentToolName = j.optString("name", "")
                svc.currentToolSummary = toolSummary(j.optString("args", ""))
                // ADB-F7 自动化避让（2026-09-05 真机实测）：android_* 工具（ADB 语义控制）
                // 执行期间面板会挡住被控 App 的坐标命中区（「点列表第2条实点面板」）——
                // 识别到自动化工具调用即自动收起面板；不自动恢复（用户点球重开），
                // 避免恢复动作与下一发自动化点击竞态。
                // S2-13：自动收起必须**有说明**。旧实现静默把面板收掉：用户正看着面板，
                // 它自己消失了，既不知道是谁干的、也不知道还能不能回来（而且此刻面板已不可见，
                // 写状态行也没人看得到——所以用 Toast：它在面板收起后仍然可见）。
                if (svc.currentToolName.startsWith("android_") && svc.expanded) {
                  svc.hidePanel()
                  svc.notifyAutoCollapsedForAutomation()
                }
                // 0.13.8 G1-2（缺陷 B-2）：状态写入统一走 deriveHalo 唯一权威
                svc.setHalo(svc.deriveHalo())
                changed = true
              }
            }
            "tool_result" -> {
              val s = j.optString("s", "")
              // 工具结束 → 回「思考」显示（Deep diving 扫光），概览清空。
              if (svc.activeSessionId.isEmpty() || s == svc.activeSessionId) {
                svc.currentToolName = ""; svc.currentToolSummary = ""
                svc.optimisticBusyAt = System.currentTimeMillis() // 0.13.8 #178-⑤：活动即续期
                changed = true
              }
            }
            "turn_end" -> {
              val s = j.optString("s", "")
              // 任何一次 turn/end 都取消忙碌（当前会话 end 或引擎兜底 end）。
              if (svc.activeSessionId.isEmpty() || s == svc.activeSessionId) {
                svc.optimisticBusyAt = 0L
                svc.sessionBusy = false
                svc.toolCount = 0
                svc.currentToolName = ""; svc.currentToolSummary = ""
                // 块H-A1 语义标签来源（详档 §3.1）：`ok` 只给布尔（且旧实现曾恒 false），
                // `kind` 才是权威语义。二者都必须读：
                //   kind 在场 → 映射为「已完成」/失败类标签（失败不得伪装成完成）；
                //   只有 ok   → true→「已完成」/false→「结果未知」（不得把失败当成功）；
                //   都缺      → 不置位，交给权威信号 api-session/status 的默认文案。
                val kind = j.optString("kind", "")
                val label = when {
                  kind.isNotEmpty() -> turnEndLabel(kind)
                  j.has("ok") -> if (j.optBoolean("ok", false)) "已完成" else "结果未知"
                  else -> ""
                }
                if (label.isNotEmpty()) svc.onTurnEnd(s, label)
                // 0.13.8 G1-2（缺陷 B-2）：turn_end 同时清理该会话的待答/待审批
                // （轮次已结束，pending 必然过期——原实现只回白光环，卡片永挂）；
                // 光环走 deriveHalo 唯一权威（不再直接 IDLE 绕过 PENDING）。
                svc.panel.dropPendingFor(s)
                svc.setHalo(svc.deriveHalo())
                changed = true
              }
            }
            // 注：提问/审批不走 live 文件——rpcId 只存在于引擎 mux WebSocket 下行帧，
            // 由 MuxClient 直连接收（见 OverlayPanel.handleMuxFrame），POST /api/respond 应答。
          }
        } catch (_: Exception) {
        }
      }
      if (changed) svc.renderPanelOnly()
      svc.updateBallOnly()
    }
  }

  /** 工具参数 JSON → 一行概览（bash=命令 / search=查询 / read·edit=路径；兜底取首个字符串值）。 */
  private fun toolSummary(argsJson: String): String = toolSummaryOf(argsJson)

  /**
   * live 行 → [LiveEvent]（**顶层纯映射**，字段全部来自既有行，不做业务判断）。
   *
   * 为什么单独抽出来：v2 聚合层要按 kind 分流，而「哪种行带哪个字段」是线格式知识，
   * 只应存在于消费侧这一处；散进多个 when 分支就必然漂移（旧实现里 turn_end 的 ok/kind
   * 双读就是一次真实漂移的修法）。
   */
  private fun liveEventOf(j: JSONObject): LiveEvent {
    val kind = j.optString("k")
    return LiveEvent(
      kind = kind,
      sessionId = j.optString("s", ""),
      callId = j.optString("callId", ""),
      name = j.optString("name", ""),
      summary = toolSummary(j.optString("args", "")),
      text = if (kind == LiveEvent.KIND_TEXT || kind == LiveEvent.KIND_THINK) j.optString("sum", "") else "",
      turnKind = j.optString("kind", ""),
      atMs = j.optLong("t", System.currentTimeMillis()),
    )
  }
}

/**
 * 工具参数 JSON → 一行概览（**顶层纯函数**，JVM 可直接测）。
 *
 * 为什么抽出来（0.14.1 批 3 / P3-4）：旧实现里这一行是 `take(24)` 硬截断，于是
 * `rm -rf /data/loca` 这样被截断的命令**看起来是一条完整命令**——用户据此判断
 * 「AI 正在跑什么」会得出错误结论（审查档 §4.4）。截断现在必须自己说出来（附 `…`），
 * 而「必须附省略号」这条判据只有在纯函数上才可断言（形态类缺陷靠设备实报太贵）。
 *
 * 顺序即取值优先级：先按已知参数名（命令/查询/模式/路径…）取，再兜底取首个字符串值，
 * 都没有就退化成整个 JSON 的截断形态。
 *
 * @param argsJson - 工具调用的参数 JSON 串。
 * @param max - 概览最大字符数（含省略号）。
 * @returns 单行概览；参数为空串时返回空串（调用方据此不渲染概览行）。
 */
internal fun toolSummaryOf(argsJson: String, max: Int = 24): String {
  if (argsJson.isBlank()) return ""
  return try {
    val o = JSONObject(argsJson)
    val key = listOf("command", "query", "pattern", "file_path", "path", "file", "url", "cmd")
      .firstOrNull { o.has(it) && !o.optString(it).isBlank() }
    val raw = when {
      key != null -> o.optString(key)
      else -> {
        var first = ""
        for (k in o.keys()) { val v = o.opt(k); if (v is String) { first = v; break } }
        if (first.isBlank()) o.toString() else first
      }
    }
    UserCopy.truncateWithEllipsis(raw.replace(Regex("\\s+"), " ").trim(), max)
  } catch (_: Exception) {
    UserCopy.truncateWithEllipsis(argsJson.replace(Regex("\\s+"), " ").trim(), max)
  }
}
