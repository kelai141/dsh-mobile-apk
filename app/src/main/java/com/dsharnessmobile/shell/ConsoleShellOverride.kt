package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 控制台 shell 的**设备验收入口**覆盖（debug 构建专用）。
 *
 * 为什么需要它：Linux 环境（bionilux 的 Debian guest）是否能在现有 node-pty 中继下工作，
 * 只有把控制台真正指向 Debian bash 才能验。此前控制台把 shell 写死为快照 bash，
 * 于是"交互式 Debian"这件事在设备上没有任何可执行入口——只能靠推断，不能靠事实。
 *
 * 边界（刻意做成这样）：
 *  - **只在 debug 变体生效**：release 永不读该文件（`BuildConfig.DEBUG` 恒 false），
 *    因此这条入口不可能进入用户路径，也不会成为"隐藏后门"。
 *  - **失败关闭**：文件内容非法一律返回 null 并回落快照 bash（默认行为不变）；
 *    但一旦解析成功而 PTY 中继不可用，控制台**报错**而不是静默退回 Termux——
 *    否则验收会变成"验的还是快照"的假绿。
 *  - 内容只声明"启动什么"，不含任何默认值猜测：shell 必须绝对路径，args 显式给出
 *    （默认 `-i` 由中继侧兜底，不在这里补），cwd/env 可选。
 *
 * 文件位置：`<filesDir>/console-shell-override.json`
 * 结构：
 * ```json
 * {
 *   "shell": "/data/user/0/<pkg>/files/linux-environment/rootfs/bin/bash",
 *   "args": ["-i"],
 *   "cwd": "/data/user/0/<pkg>/files/linux-environment/workspace",
 *   "env": { "BIONILUX_ROOTFS": "...", "TERM": "xterm-256color" }
 * }
 * ```
 * 但注意：bionilux 是 launcher 而不是 bash 本身，实际值是
 * `{"shell":".../bin/bionilux","args":["--rootfs","<rootfs>","--guest-cwd","<cwd>","/bin/bash","-i"]}`，
 * 这也是 [parse] 必须支持任意 argv 前缀的原因。
 */
internal data class ConsoleShellOverride(
  val shell: String,
  val args: List<String>,
  val cwd: String?,
  val env: Map<String, String>,
) {
  companion object {
    /** 覆盖文件在私有目录里的名字。 */
    const val FILE_NAME = "console-shell-override.json"

    private const val TAG = "ConsoleShellOverride"

    private val KNOWN_KEYS = setOf("shell", "args", "cwd", "env")

    /**
     * 纯解析：任何不合规输入返回 null（调用方回落默认 Termux 行为），从不抛。
     *
     * 严格拒绝未知键：这是验收用的窄接口，写错的键必须当场暴露，而不是被静默忽略后
     * 让人以为"配了却没生效"（那正是最耗时的一类排查）。
     */
    fun parse(json: String): ConsoleShellOverride? {
      val root = runCatching { JSONObject(json) }.getOrNull() ?: return null
      if (root.keys().asSequence().any { it !in KNOWN_KEYS }) return null

      val shell = root.optString("shell", "")
      if (!isSafeAbsolutePath(shell)) return null

      val argsValue = if (root.has("args")) root.opt("args") else JSONArray().put("-i")
      if (argsValue !is JSONArray) return null
      val args = ArrayList<String>(argsValue.length())
      for (i in 0 until argsValue.length()) {
        val item = argsValue.opt(i)
        if (item !is String || !isSafeArg(item)) return null
        args.add(item)
      }

      val cwd = when {
        !root.has("cwd") -> null
        root.opt("cwd") is String -> root.optString("cwd").takeIf { isSafeAbsolutePath(it) } ?: return null
        else -> return null
      }

      val env = LinkedHashMap<String, String>()
      if (root.has("env")) {
        val envValue = root.opt("env")
        if (envValue !is JSONObject) return null
        for (key in envValue.keys()) {
          if (!isSafeEnvKey(key)) return null
          val value = envValue.opt(key)
          if (value !is String || !isSafeEnvValue(value)) return null
          env[key] = value
        }
      }

      return ConsoleShellOverride(shell, args, cwd, env)
    }

    /**
     * 读取覆盖文件。release 变体（`debugBuild=false`）永远返回 null。
     *
     * @param debugBuild 由调用方传入以便单测；生产调用点用默认值。
     */
    fun resolve(context: Context, debugBuild: Boolean = BuildConfig.DEBUG): ConsoleShellOverride? {
      if (!debugBuild) return null
      val file = File(context.filesDir, FILE_NAME)
      if (!file.isFile) return null
      val raw = runCatching { file.readText(Charsets.UTF_8) }
        .onFailure { Log.w(TAG, "override unreadable: " + (it.message ?: it.javaClass.simpleName)) }
        .getOrNull() ?: return null
      val parsed = parse(raw)
      if (parsed == null) {
        // 文件在场但内容不合规：留一条日志，行为仍回落默认 shell。
        Log.w(TAG, "override ignored: invalid JSON contract at " + file.absolutePath)
      }
      return parsed
    }

    /** 把 args 编成中继认识的 JSON；中继只在非空时读取。 */
    fun argsJson(args: List<String>): String = JSONArray(args).toString()

    private fun isSafeAbsolutePath(value: String): Boolean =
      value.isNotEmpty() && value.startsWith("/") && !value.contains('\u0000')

    /** 参数里允许任意可见内容（bionilux 的 flag 可能带 '-'、'='），但禁止 NUL 截断。 */
    private fun isSafeArg(value: String): Boolean = !value.contains('\u0000')

    private fun isSafeEnvKey(key: String): Boolean =
      key.isNotEmpty() && !key.contains('=') && !key.contains('\u0000')

    private fun isSafeEnvValue(value: String): Boolean = !value.contains('\u0000')
  }
}
