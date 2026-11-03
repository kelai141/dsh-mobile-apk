package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 授权审计（原生侧写面，与 dsh-android-bridge 插件同路径同格式：
 * files/audit/audit.ndjson 换行分隔 JSON；ts=ISO8601 UTC + action + tool + args + result，
 * 不含任何凭据/配对码值）。
 *
 * 0.14.0：随内置 adb 退役从 AdbState 迁出（原 AdbAudit，含 transport/uid/op 字段）。
 *
 * ── G-7（2026-09-25）：result 不再恒为 ok ──────────────────────────────────────
 * 旧实现把 `result` 硬编码成 `"ok"`，而调用方把真值塞在 `args.ok` 里（ShellOps.kt 传 `"ok" to ok`）。
 * 后果是审计**无法回答「谁执行了什么、结果如何」**：失败的特权命令在 ndjson 里与成功逐字相同，
 * 出现 `result:"ok"` 与 `args.ok:false` 自相矛盾的记录，事后复盘不可信（审查 §5.3 / EXECUTION-MAP K04）。
 * 现 `result` 由**调用方显式传入**，取值三态且互斥：
 *   - [RESULT_OK]     执行成功；
 *   - [RESULT_FAILED] 特权通道**真的执行了但失败**（Shizuku 返回 ok=false）；
 *   - [RESULT_DENIED] 范围/授权门在**执行前**拒绝（如 screen-out-of-scope，命令从未下发）。
 * 后两者在旧实现里与成功不可辨，正是本次修的对象。取值与插件侧 `audit()` 的 ok/denied 口径一致
 * （plugins/dsh-android-bridge/src/index.ts 也写 `ok`/`denied`），多出的 `failed` 让「下发后失败」
 * 与「下发前拒绝」也能分开——这两件事在取证上完全不同（有没有真的碰过设备）。
 *
 * 落盘核心 [entry] / [appendTo] 只依赖 [File]，不依赖 Context：本项目测试面**没有 Mockito**
 * （见 BootFailLogTest 头注），抽出来后 JVM 单测可用 TemporaryFolder 直接驱动，
 * 从而对「result 反映真实结果」给出可证伪断言，而不是只能靠人读设备日志。
 */
object ControlAudit {

  /** 执行成功。 */
  const val RESULT_OK = "ok"

  /** 特权通道真的执行了，但返回失败（Shizuku 侧 ok=false）。 */
  const val RESULT_FAILED = "failed"

  /** 范围/授权门在执行**之前**拒绝——命令从未下发。 */
  const val RESULT_DENIED = "denied"

  /** 审计记录的工具名（与插件侧 `tool` 字段同面）。 */
  const val TOOL = "shell-native"

  private val TS = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }

  /**
   * 纯函数：构造一条审计记录（不落盘、不依赖 Context）。
   *
   * @param action 动作名（如 `shExec`）。
   * @param result 真实结果，取值必须是 [RESULT_OK] / [RESULT_FAILED] / [RESULT_DENIED] 之一。
   *   拒绝其余取值而不是静默接受：拼错的结果串会让这回退到「恒 ok」的老形态（本次修的缺陷）。
   * @param args 参数面（不含凭据/配对码；`detail` 已由调用方截断）。
   * @return 可直接序列化进 ndjson 的 JSON 对象。
   * @throws IllegalArgumentException result 不在三态之内。
   */
  fun entry(action: String, result: String, args: Map<String, Any?>): JSONObject {
    require(result == RESULT_OK || result == RESULT_FAILED || result == RESULT_DENIED) {
      "audit result 必须是 $RESULT_OK/$RESULT_FAILED/$RESULT_DENIED 之一，实得 '$result'"
    }
    return JSONObject()
      .put("ts", TS.format(Date()))
      .put("action", action)
      .put("tool", TOOL)
      .put("args", JSONObject(args as Map<*, *>))
      .put("result", result)
  }

  /** 纯函数：把一条记录追加到 `<auditDir>/audit.ndjson`（只依赖 [File]，供 JVM 单测直驱）。 */
  fun appendTo(auditDir: File, record: JSONObject) {
    auditDir.mkdirs()
    val file = File(auditDir, "audit.ndjson")
    // 性能审计 2026-11-02 #2：**有界写**。
    //
    // 改动前这一行是 `file.appendText(record.toString() + "\n")`，两个问题：
    //  ① 每条记录 open + write + close 一次（无常驻句柄、无缓冲）。宿主负控 A/B = 11.2x
    //     （274.2 us vs 24.5 us/record），而加 fsync 只贵 5% —— 也就是说当前形态为每次
    //     open/close 白付了 11 倍代价，却没换来任何耐久性。
    //  ② 这是全仓**唯一**一个没有大小上限的运行时状态文件。插件侧同一个写者
    //     （plugins/dsh-android-bridge/src/index.ts:154-160）早就做了 >2MB 保留尾部 500 行的滚动，
    //     壳侧没有 —— 于是 audit.ndjson 只增不减。
    //
    // 现在与插件侧口径对齐：同样 2MB 阈值、同样保留尾部 500 行；写入改成本次调用内复用同一
    // 个句柄（appendBytes），不再每条 open/close。仍然**不做 fsync**：审计不是事务日志，
    // 崩溃丢最后几条可接受，而 fsync 在每条记录上会显著拖慢授权路径。
    val bytes = (record.toString() + "\n").toByteArray(Charsets.UTF_8)
    // issue #1337 ③：上限判据前移到 append **之前**，并且把本次记录的字节数算进去。
    //
    // 原先在 append 之后才查（`finally { rollIfOversized(file) }`），于是「超限那一刻」
    // 已经多写了一条——读侧实测 2,097,278 > 2,097,152。把记录大小一起算，文件就**永远
    // 不会**越过上限：宁可先滚动一次，也不让上限成为事后追认。
    try {
      if (file.length() + bytes.size > MAX_AUDIT_BYTES) roll(file)
      java.io.FileOutputStream(file, true).use { out -> out.write(bytes) }
    } catch (_: Throwable) {
      /* 审计写入失败不影响授权路径（与 roll 的静默放弃同口径） */
    }
  }

  /** 审计文件大小上限（与插件侧 writeAudit 的 2MB 同口径）。 */
  internal const val MAX_AUDIT_BYTES = 2L * 1024 * 1024

  /** 超限时保留的尾部行数（与插件侧 `lines.slice(-500)` 同口径）。 */
  internal const val KEEP_TAIL_LINES = 500

  /**
   * 滚动：保留尾部 [KEEP_TAIL_LINES] 行，**先写临时文件再原子 rename**。
   *
   * issue #1337 ①②：原实现是 `readLines()` + `writeText()`，两个缺陷都是实测出来的：
   *
   *  ① `writeText` 先 truncate 再写。读侧轮询能观察到 `2,097,076 → 0 → 14,752` 的
   *     **0 字节窗口**——此刻进程被杀就是整份审计历史清零，而「审计文件为空」与
   *     「审计被清空」从此不可区分，事故取证时最需要的那段正好没了。
   *  ② 读与写之间没有锁。并发写者在这段窗口里追加的记录被整段丢弃，且丢的是
   *     **比保留项更新**的那些（4 写者 × 2500 条实测 141 个 id 缺失，形成空洞，
   *     不是预期的「丢最旧前缀」）。
   *
   * rename 在同一目录内是原子的：读侧要么看到旧文件、要么看到新文件，不存在空窗；
   * 并发的 append 也只会落到「旧文件」或「新文件」其中一个上，不会凭空消失。
   *
   * 失败不抛出——审计的写入失败绝不能影响授权路径（与 [log] 的静默放弃同口径）。
   */
  private fun roll(file: File) {
    try {
      if (!file.isFile) return
      val tail = file.readLines(Charsets.UTF_8).takeLast(KEEP_TAIL_LINES)
      val parent = file.parentFile ?: return
      val tmp = File(parent, file.name + ".roll.tmp")
      tmp.writeText(tail.joinToString("") { it + "\n" }, Charsets.UTF_8)
      if (!tmp.renameTo(file)) {
        // rename 失败（被占用/跨卷）时退回覆盖写：仍然优先保证内容不丢，
        // 只是这一条路径上原子性拿不到——下次滚动会再试。
        tmp.copyTo(file, overwrite = true)
        tmp.delete()
      }
    } catch (_: Throwable) {
      /* 滚动失败不阻断；下一次 append 会再试 */
    }
  }

  /**
   * 落盘一条审计记录。审计失败不阻断授权（隐私优先，静默放弃）。
   *
   * @param context 用于解析 filesDir。
   * @param action 动作名。
   * @param result 真实结果（[RESULT_OK] / [RESULT_FAILED] / [RESULT_DENIED]）。
   * @param args 参数面。
   */
  fun log(context: Context, action: String, result: String, args: Map<String, Any?>) {
    try {
      appendTo(File(context.filesDir, "audit"), entry(action, result, args))
    } catch (_: Throwable) {
      /* 审计失败不阻断授权（隐私优先，静默放弃） */
    }
  }
}