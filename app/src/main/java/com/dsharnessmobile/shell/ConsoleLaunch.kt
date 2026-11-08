package com.dsharnessmobile.shell

import org.json.JSONArray
import org.json.JSONObject

/**
 * 启动描述（launch descriptor）：壳侧与 PTY 底层之间的**唯一契约**（ADR-0001）。
 *
 * 为什么需要它：此前 Debian 的启动参数散在 `DSH_CONSOLE_SHELL` / `DSH_CONSOLE_ARGS` /
 * `DSH_CONSOLE_CWD` 三个环境变量里，等于把「启动什么」耦合进了具体中继实现。换成原生 Rust PTY
 * 时，Linux 接入层就得跟着改一遍。现在壳侧只产一份描述，底层（今天的 node 中继、将来的 Rust PTY）
 * 只消费描述并 spawn，不解释、不补默认参数。
 *
 * 通道：单个环境变量 `DSH_CONSOLE_LAUNCH`（JSON）。cols/rows/prefix/nodePty 仍走各自环境变量，
 * 它们是传输参数，不属于“启动什么”。
 *
 * 结构：
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "shell": "/abs/path/to/launcher-or-shell",
 *   "argv": ["--rootfs", "<R>", "/bin/bash", "-i"],
 *   "cwd": "/abs/host/cwd",
 *   "env": { "TERM": "xterm-256color" },
 *   "unset": ["TERMUX__PREFIX"]
 * }
 * ```
 */
internal data class ConsoleLaunch(
  val shell: String,
  val argv: List<String>,
  val cwd: String?,
  val env: Map<String, String>,
  val unset: List<String>,
) {
  /** 序列化成底层认识的 JSON；字段省略规则固定，单测钉住。 */
  fun toJson(): String {
    val root = JSONObject()
    root.put("schemaVersion", SCHEMA_VERSION)
    root.put("shell", shell)
    root.put("argv", JSONArray(argv))
    cwd?.let { root.put("cwd", it) }
    if (env.isNotEmpty()) root.put("env", JSONObject(env))
    if (unset.isNotEmpty()) root.put("unset", JSONArray(unset))
    return root.toString()
  }

  companion object {
    const val SCHEMA_VERSION = 1
    const val ENV_KEY = "DSH_CONSOLE_LAUNCH"

    /** 默认：快照内的 Termux bash（交互式），cwd 交给底层按 HOME/usr 决定。 */
    fun ofDefault(shell: String): ConsoleLaunch =
      ConsoleLaunch(shell = shell, argv = listOf("-i"), cwd = null, env = emptyMap(), unset = emptyList())

    /** 覆盖条目（debug 验收入口）直接转成描述；字段已在 [ConsoleShellOverride.parse] 校验过。 */
    fun ofOverride(override: ConsoleShellOverride): ConsoleLaunch =
      ConsoleLaunch(
        shell = override.shell,
        argv = override.args,
        cwd = override.cwd,
        env = override.env,
        unset = override.unset,
      )
  }
}
