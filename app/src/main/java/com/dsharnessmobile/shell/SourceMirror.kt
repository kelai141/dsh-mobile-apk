package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * 软件源（apt）的清单、解析与落盘判据——内置控制台换源功能的纯逻辑部分。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────────
 * 用户在移动端换源只能敲 sed 或跑 termux-change-repo，后者在内置控制台里必然失败
 * （无 TERM、terminfo 路径不可达、无 PTY）。所以换源改由壳侧直接做：**它本来就不需要 PTY**。
 *
 * ── 落盘对象（设备实测确认）──────────────────────────────────────────────────
 * apt: $PREFIX/etc/apt/sources.list（实体文件，apt.conf 的 Dir::Etc::sourcelist 指向它）
 *      与 $PREFIX/etc/termux/chosen_mirrors（符号链接，pkg 据此决定后续选哪个源）。
 *
 * ── 为什么必须双写 ────────────────────────────────────────────────────────────
 * 只写 sources.list 时，用户下一次 pkg update/install 会走 pkg 的
 * 「不存在 → default + 全部镜像」分支**随机重选并覆盖**（设备实测：aliyun 被换成
 * mirror.mephi.ru）。同时把 chosen_mirrors 指到同一个镜像文件后，实测保持不漂。
 */
internal object SourceMirror {

  /** 镜像分组目录名（快照 etc/termux/mirrors/ 下的目录）。 */
  const val GROUP_CHINESE_MAINLAND = "chinese_mainland"

  /**
   * 用户在 App 里能选的镜像。file 是 etc/termux/mirrors/<group>/<file> 的文件名。
   *
   * 只列国内可达性高的几个；未列出的镜像用户仍可在控制台用 pkg 自选，
   * 这里不追求穷举（数据随 Termux 仓库变动，穷举必然很快过期）。
   */
  enum class Mirror(val file: String, val labelZh: String, val labelEn: String) {
    TUNA("mirrors.tuna.tsinghua.edu.cn", "清华 TUNA", "Tsinghua TUNA"),
    USTC("mirrors.ustc.edu.cn", "中科大 USTC", "USTC"),
    ALIYUN("mirrors.aliyun.com", "阿里云", "Alibaba Cloud"),
    SJTU("mirror.sjtu.edu.cn", "上海交大", "SJTU"),
    // 设备实测（0.14.9 真机）：Termux 快照里这份片段叫 mirrors.nju.edu.cn（带 s），
    // 写成 mirror.nju.edu.cn 会让 fragmentFile 找不到文件，循环到这一档就报
    // 「运行时里找不到该镜像的配置片段，无法切换」——换源卡死在南京大学这一档。
    NJU("mirrors.nju.edu.cn", "南京大学", "Nanjing University"),
    ZJU("mirrors.zju.edu.cn", "浙江大学", "Zhejiang University"),
  }

  /**
   * 从 Termux 的镜像片段里取出 MAIN= 的 URL。
   *
   * 片段是被 source 的 shell 代码（形如 MAIN="https://.../termux-main"，另有 WEIGHT/ROOT/X11），
   * 因此只做行解析、**不执行**它：App 里没有任何理由为了读一行 URL 去跑 shell。
   *
   * @param fragment 镜像片段全文。
   * @return MAIN 的 URL；找不到或不是 http(s) 时返回 null。
   */
  fun parseMainUrl(fragment: String): String? {
    for (line in fragment.lineSequence()) {
      val trimmed = line.trim()
      // 跳过注释：片段里的注释也含 URL 字样（如 "Mirror by ..."），先剔掉再匹配。
      if (trimmed.isEmpty() || trimmed.startsWith("#")) continue
      if (!trimmed.startsWith("MAIN=")) continue
      val value = trimmed.removePrefix("MAIN=").trim().trim('"', '\'')
      if (value.startsWith("https://") || value.startsWith("http://")) return value
      return null
    }
    return null
  }

  /**
   * 生成 sources.list 的内容（单行，与 pkg 写入格式一致）。
   *
   * @param mainUrl 镜像 MAIN URL。
   * @return deb <url> stable main 加换行。
   */
  fun sourcesListContent(mainUrl: String): String = "deb $mainUrl stable main\n"

  /**
   * 定位某个镜像片段文件。
   *
   * @param prefix 快照 usr 目录。
   * @param mirror 目标镜像。
   * @return 片段文件；不存在时返回 null。
   */
  fun fragmentFile(prefix: File, mirror: Mirror): File? {
    val f = File(prefix, "etc/termux/mirrors/$GROUP_CHINESE_MAINLAND/${mirror.file}")
    return if (f.isFile) f else null
  }

  /**
   * 从当前 sources.list 反推正在使用的镜像（用于 UI 显示当前值）。
   *
   * @param sourcesList sources.list 文件。
   * @return 命中的镜像；不在已知清单里时返回 null（UI 应显示原始 URL 而不是猜）。
   */
  fun currentMirror(sourcesList: File): Mirror? {
    val text = runCatching { sourcesList.readText() }.getOrNull() ?: return null
    val host = text.lineSequence()
      .firstOrNull { it.trimStart().startsWith("deb ") }
      ?.split(Regex("\\s+"))
      ?.getOrNull(1)
      ?: return null
    return Mirror.entries.firstOrNull { host.contains(it.file) }
  }

  /**
   * 原子替换一个文本文件（同目录临时文件 + 改名）。
   *
   * 为什么必须原子：sources.list 半写会让 apt 直接解析失败，且此时用户既没了旧源也没了新源。
   * 权限口径来自设备实测：run-as 下 umask 是 000，直接写会得到 666 的文件，
   * 因此这里显式收紧到 600（与出厂文件一致）。
   *
   * @param target 目标文件。
   * @param content 完整新内容。
   */
  fun replaceAtomically(target: File, content: String) {
    val dir = target.parentFile ?: error("no parent for " + target.absolutePath)
    val temp = File.createTempFile("." + target.name + "-", ".tmp", dir)
    try {
      temp.writeText(content)
      temp.setReadable(false, false)
      temp.setReadable(true, true)
      temp.setWritable(false, false)
      temp.setWritable(true, true)
      // 必须用 NIO 的 ATOMIC_MOVE + REPLACE_EXISTING：File.renameTo 在目标已存在时
      // 于部分平台（Windows JVM、个别文件系统）返回 false，而 Linux 上通常静默成功——
      // 只测 Linux 会漏掉这个分支（单测在宿主 JVM 上就会红）。
      Files.move(
        temp.toPath(),
        target.toPath(),
        StandardCopyOption.ATOMIC_MOVE,
        StandardCopyOption.REPLACE_EXISTING,
      )
    } finally {
      Files.deleteIfExists(temp.toPath())
    }
  }

  /**
   * 符号链接原语。抽成可注入的形式与仓内既有做法一致（SnapshotFs 的 move/delete 同样注入）：
   * 建软链在部分宿主平台需要特权（Windows 未开开发者模式时报"客户端没有所需的特权"），
   * 单测若直连系统 API 就只能跳过这些用例——而它们守的恰恰是"双写"这条硬约束。
   */
  interface LinkPrimitives {
    fun isSymbolicLink(path: java.nio.file.Path): Boolean
    fun readSymbolicLink(path: java.nio.file.Path): java.nio.file.Path
    fun deleteIfExists(path: java.nio.file.Path): Boolean
    fun createSymbolicLink(link: java.nio.file.Path, target: java.nio.file.Path): java.nio.file.Path

    /** 原子换链：把临时链接移动到位（覆盖旧链接/文件）。崩溃窗口内要么旧链在、要么新链在。 */
    fun moveAtomic(from: java.nio.file.Path, to: java.nio.file.Path)
  }

  /** 生产实现：直连 NIO。 */
  val PRODUCTION_LINKS: LinkPrimitives = object : LinkPrimitives {
    override fun isSymbolicLink(path: java.nio.file.Path) = Files.isSymbolicLink(path)
    override fun readSymbolicLink(path: java.nio.file.Path) = Files.readSymbolicLink(path)
    override fun deleteIfExists(path: java.nio.file.Path) = Files.deleteIfExists(path)
    override fun createSymbolicLink(link: java.nio.file.Path, target: java.nio.file.Path) =
      Files.createSymbolicLink(link, target)
    override fun moveAtomic(from: java.nio.file.Path, to: java.nio.file.Path) {
      Files.move(from, to, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
  }

  /**
   * 把 chosen_mirrors 指向指定镜像片段（符号链接，不存在则创建、存在则替换）。
   *
   * @param prefix 快照 usr 目录。
   * @param mirror 目标镜像。
   * @param links 链接原语（生产用 [PRODUCTION_LINKS]）。
   */
  fun writeChosenMirror(prefix: File, mirror: Mirror, links: LinkPrimitives = PRODUCTION_LINKS) {
    // 相对链接：快照目录可能被整体搬迁，绝对链接会断。
    writeChosenTarget(prefix, File(GROUP_CHINESE_MAINLAND, mirror.file).toString(), links)
  }

  /**
   * 把 chosen_mirrors 指到任意相对目标（文件名形式如 chinese_mainland/<mirror>）。
   *
   * 原子性：旧实现 delete→create 之间存在崩溃窗口——chosen_mirrors 缺失时 pkg 的
   * 下一次 update 会走「不存在 → default + 全部镜像」随机重选并覆盖 sources.list
   * （本文件头部实测过的漂移形态），恰是换源功能要防的事。现改为临时链接 + 原子 move。
   *
   * @param targetRelative 相对 etc/termux/ 的目标（如 chinese_mainland/mirrors.tuna.tsinghua.edu.cn）。
   */
  fun writeChosenTarget(prefix: File, targetRelative: String, links: LinkPrimitives = PRODUCTION_LINKS) {
    val dir = File(prefix, "etc/termux")
    val link = File(dir, "chosen_mirrors")
    val staging = File(dir, ".chosen_mirrors.swap")
    links.deleteIfExists(staging.toPath())
    links.createSymbolicLink(staging.toPath(), File(targetRelative).toPath())
    try {
      links.moveAtomic(staging.toPath(), link.toPath())
    } finally {
      links.deleteIfExists(staging.toPath())
    }
  }

  /** 读出 chosen_mirrors 的原始相对目标（如 chinese_mainland/mirrors.tuna…；非软链/缺失返回 null）。 */
  fun readChosenTarget(prefix: File, links: LinkPrimitives = PRODUCTION_LINKS): String? = runCatching {
    val link = File(prefix, "etc/termux/chosen_mirrors")
    if (links.isSymbolicLink(link.toPath())) links.readSymbolicLink(link.toPath()).toString() else null
  }.getOrNull()

  /**
   * 读出 chosen_mirrors 指向的镜像文件名。
   *
   * @param prefix 快照 usr 目录。
   * @param links 链接原语。
   * @return 链接目标的最后一段（如 mirrors.tuna.tsinghua.edu.cn）；不是软链或读不到时返回 null。
   */
  fun readChosenMirror(prefix: File, links: LinkPrimitives = PRODUCTION_LINKS): String? {
    val link = File(prefix, "etc/termux/chosen_mirrors")
    val target = runCatching {
      if (links.isSymbolicLink(link.toPath())) {
        // 用 Path 的 fileName 取最后一段，不要对字符串做 substringAfterLast("/")：
        // 链接目标在 Android 上是 "chinese_mainland/mirrors.tuna..."，但宿主 JVM（Windows）
        // 的 Path.toString() 用的是反斜杠——按 "/" 切会整串返回（单测实测踩到）。
        links.readSymbolicLink(link.toPath()).fileName?.toString()
      } else null
    }.getOrNull() ?: return null
    return target
  }
}
