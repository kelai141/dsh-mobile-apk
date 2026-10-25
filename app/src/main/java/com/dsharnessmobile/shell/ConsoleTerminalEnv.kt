package com.dsharnessmobile.shell

import java.io.File

/**
 * 控制台子进程的终端环境变量，以及快照里 terminfo / vim 运行库的定位（issue：内置终端跑不了 TUI）。
 *
 * ── 为什么需要这个对象 ────────────────────────────────────────────────────────
 * 快照里的 ncurses 与 vim 把运行期数据目录**编译期写死**成 Termux 前缀：
 * `strings libncursesw.so.6.5` 给出 `/data/data/com.termux/files/usr/share/terminfo`，
 * vim 同理给出 `.../share/vim`。本应用域是 `com.dsharnessmobile.shell`，该路径不存在。
 * 快照 relocate 之后数据本身都在（terminfo 有 40 个条目、xterm 系齐全），
 * 但**没有任何一层把它接成环境变量**——于是 `termux-change-repo` / `top` / `vim`
 * 分别报 `TERM environment variable not set.`、`terminals database is inaccessible`、
 * `E1187: Failed to source defaults.vim`。缺的不是数据，是这条接线。
 *
 * ── 判据（设备实测，2026-10-25，MuMu x86_64）─────────────────────────────────
 * 2x2x2 归因矩阵：只补 TERM 只能把报错换成 `terminals database is inaccessible`；
 * 只给 PTY 同样不够；**TERMINFO 是三要素里的硬门槛**，三者齐备 dialog 才完整渲染。
 * 因此 [terminalEnv] 必须同时给出 TERM + TERMINFO + VIMRUNTIME，
 * 缺任何一个都会退回可复现的失败态。
 */
internal object ConsoleTerminalEnv {

  /** 终端类型。选 xterm-256color：快照 terminfo 里有同名条目，且 dialog/vim/top 都认它。 */
  const val TERM = "xterm-256color"

  /** 真彩能力标记。缺失时部分程序退化成 8 色，不影响可用性，但没必要丢。 */
  const val COLORTERM = "truecolor"

  /**
   * 由快照前缀派生终端环境变量。
   *
   * 只返回**存在**的目录对应的变量：terminfo 缺失时不给 TERMINFO，让程序按自身默认查找
   * （报错原样上屏，比指向一个不存在的目录更容易诊断）。
   *
   * @param prefix 快照 usr 目录（含 bin/、lib/、share/）。
   * @param vimRuntimeDir 可选的 vim 运行库目录名解析器，便于测试注入。
   * @return 需要叠加到 ProcessBuilder 环境上的键值对。
   */
  fun terminalEnv(
    prefix: File,
    vimRuntimeDir: (File) -> String? = ::detectVimRuntime,
  ): Map<String, String> {
    val env = linkedMapOf(
      "TERM" to TERM,
      "COLORTERM" to COLORTERM,
    )
    val terminfo = File(prefix, "share/terminfo")
    if (terminfo.isDirectory) env["TERMINFO"] = terminfo.absolutePath
    // VIMRUNTIME 只有 vim 消费；缺失时不给，vim 会按自身默认路径再试一次。
    vimRuntimeDir(prefix)?.let { env["VIMRUNTIME"] = File(prefix, "share/vim/$it").absolutePath }
    return env
  }

  /**
   * 定位 `$PREFIX/share/vim/vim<NN>` 这一层（版本号随 vim 包变动，不能写死）。
   *
   * @param prefix 快照 usr 目录。
   * @return 目录名（如 `vim92`），不存在时返回 null。
   */
  fun detectVimRuntime(prefix: File): String? {
    val root = File(prefix, "share/vim")
    val dirs = root.listFiles() ?: return null
    return dirs.filter { it.isDirectory && it.name.startsWith("vim") }
      .map { it.name }
      .sorted()
      .lastOrNull()
  }
}
