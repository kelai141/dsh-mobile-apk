package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files

/**
 * 运行时树的完整性判据（task-79 / Bug A）。
 *
 * ── 缺陷现场 ────────────────────────────────────────────────────────────────
 * 真机（小米 25079RPDCC / Android 36 / arm64，0.14.2-fx-1）反复出现：
 *   `direct exec denied, falling back to linker64` 后
 *   `CANNOT LINK EXECUTABLE ".../files/usr/bin/node": library "libz.so.1" not found`，
 *   最终 `boot failed: stage=process-died-during-boot`，每 4-10 秒一轮。
 *
 * 真因：旧判据只查 3 个条目（`usr/bin/node` / `dsh/lib/bin.js` / `profiles/web`）⇒
 * `usr/lib` 里的动态库**全部缺失**也判「运行时完整」⇒ 引擎被反复拉起、每次都在链接期死；
 * 且 `shouldDegradeRefresh` 因「live 完整」而放行降级启动 ⇒ 用户永久卡死。
 *
 * ── 判据来源（实测，不是拍脑袋）──────────────────────────────────────────────
 * 对发布快照 `readelf -d usr/bin/node`（WSL 实测，两个版本）：
 *   v0.14.2-fx-1 与 v0.14.0 的 DT_NEEDED **逐条完全相同**：
 *     libz.so.1 libcares.so libsqlite3.so libcrypto.so.3 libssl.so.3
 *     libicui18n.so.78 libicuuc.so.78 libc.so libm.so libdl.so libc++_shared.so
 * `libc` / `libm` / `libdl` 是 bionic 系统库（设备自带，快照里没有）⇒ **不计**；其余 8 条见 [REQUIRED_LIBS]。
 *
 * 为什么取全部 8 条而不是「挑几个代表形态」：只缺 `libcrypto.so.3` 的树同样必死，
 * 「挑代表」是够用不是充分；代价只是 8 次 stat。
 *
 * ── 符号链接口径（勿改成「绝对链接即缺失」）──────────────────────────────────
 * linker 按 `LD_LIBRARY_PATH` 里的**文件名**解析，所以：
 *   · 链接名在场即计在场；
 *   · 相对目标 ⇒ 本目录下有该条目即成立；
 *   · 绝对目标 ⇒ 必须以**本树 lib 目录的绝对路径**为前缀（历史坑：软链指向构建机路径）。
 * 实测：8 条里 4 条是相对链接（libz.so.1 / libsqlite3.so / libicui18n.so.78 / libicuuc.so.78），
 * 4 条是普通文件；按本规则在两个真快照上算出的**缺失条目数均为 0**（不假阳性）。
 *
 * ── 与 shouldDegradeRefresh 的交互（**不要改它**）──────────────────────────────
 * `SnapshotRefreshPolicy.shouldDegrade` 首行即 `if (!liveComplete) return false`。
 * 判据补齐后：**残缺树 ⇒ liveComplete=false ⇒ 降级启动被自动拒绝 ⇒ 走完整刷新**。
 * 这正是要的结果，且**无需改 shouldDegrade**（`RuntimeTreeTest` 钉住该交互）。
 */
internal object RuntimeTree {

  /** 运行时必需的非系统动态库（依据见类注释的 readelf 实测）。顺序无关，仅影响报错可读性。 */
  internal val REQUIRED_LIBS: List<String> = listOf(
    "libz.so.1",
    "libcares.so",
    "libsqlite3.so",
    "libcrypto.so.3",
    "libssl.so.3",
    "libicui18n.so.78",
    "libicuuc.so.78",
    "libc++_shared.so",
  )

  /** 基础 3 项的相对路径（旧判据口径，只加合取项、不动它们）。 */
  internal val BASE_ENTRIES: List<String> = listOf(
    "bin/node",
    "lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
  )

  /**
   * 探测原语（可注入）：默认走 [SnapshotFs] 的 NOFOLLOW 口径；测试传内存实现。
   *
   * 抽成接口而非直接调 SnapshotFs，是为了让「反证靠传参、不就地改生产源码」成为可能
   * （本仓既有范式：SnapshotTransaction 的 move/delete/ownerProbe/spaceCheck）。
   */
  internal interface Probe {
    /** 条目是否存在（**不跟随**链接，与 SnapshotFs.exists 同口径）。 */
    fun exists(file: File): Boolean
    /** 是否为符号链接。 */
    fun isLink(file: File): Boolean
    /** 链接目标原文（相对或绝对）；非链接返回 null。 */
    fun linkTarget(file: File): String?
  }

  /** 生产实现：与 SnapshotFs 逐条同口径。 */
  internal object FsProbe : Probe {
    override fun exists(file: File): Boolean = SnapshotFs.exists(file)
    override fun isLink(file: File): Boolean = SnapshotFs.isSymbolicLink(file)
    override fun linkTarget(file: File): String? = try {
      if (!Files.isSymbolicLink(file.toPath())) null
      else Files.readSymbolicLink(file.toPath()).toString()
    } catch (_: Throwable) {
      null
    }
  }

  /**
   * 绝对链接目标是否落在本树内（纯函数，JVM 可测）。
   *
   * 为什么不能只做一次 `target.startsWith(libDir.absolutePath)`：Android 上同一条路径有**两种拼写**——
   * `/data/user/0/<pkg>/...` 与 `/data/data/<pkg>/...`（互为软链）。快照里的绝对链接可能写成任一种，
   * 而 `filesDir.absolutePath` 返回的可能是另一种。只认一种会把**其实完好**的链接判成「树外」⇒
   * 判据过严 ⇒ 每次启动都判残缺 ⇒ 降级被拒 ⇒ **新的重抽取死循环**（Lead 反复警示的形态）。
   *
   * @param target 链接目标原文（调用方已确认以 `/` 开头）。
   * @param libDirPath 本树 lib 目录的绝对路径。
   * @param currentUser **当前进程所在的 Android 用户号**（issue #1234）。
   *   **必须由调用方注入**，不能从 [libDirPath] 反推：真机上这棵树的路径可能正写成 `/data/data/<pkg>`
   *   （user 0 的软链拼写），而进程其实跑在 user 10——从路径反推会得到 0，同用户守卫就永远不触发。
   *   这正是「判据看着有、实际不生效」的形态；单测因此能把「去掉守卫」判红。
   */
  internal fun absoluteTargetInsideTree(target: String, libDirPath: String, currentUser: Int): Boolean {
    // 分隔符统一在 [PrefixRelocation.sameUserEquivalent] 里做（JVM 单测跑在 Windows 上，File.absolutePath
    // 用 '\'；不统一会让同一判据在两种平台得出不同结论——「判据不可移植」的形态）。
    // issue #1234 根因二：「当前用户」= **这棵树自己所在的用户**（不额外要 Context：判据保持纯函数，JVM 可测）。
    // `/data/data/<pkg>` 就是 `/data/user/0/<pkg>` 的软链，这条等价**只在 user 0 成立**。user 10 的应用
    // 数据在 `/data/user/10/<pkg>`，把它当 `/data/data` 等价就是把路径指回 user 0 的那份安装
    // （跨用户 FUSE 隔离 ⇒ 读不到，正是 issue 里「自愈把路径指回 user 0」的形态）。
    // 判据本体复用 [PrefixRelocation.sameUserEquivalent]：同一份口径只写一处。
    return PrefixRelocation.sameUserEquivalent(target, libDirPath, currentUser)
  }

  /**
   * 缺失条目列表（空 = 完整）。**纯逻辑 + 注入探测**，JVM 可直接测。
   *
   * @param root 运行时树根（live = `files/usr`；stage = 暂存树的 `usr` 目录）。
   * @param profileDir 第三个基础项（`home/.dsh/profiles/web`）：
   *   live 树传 `<files>/home/.dsh/profiles/web`，stage 树传 `<stage>/home/.dsh/profiles/web`。
   *   **调用方必须传**——它不在 `usr` 之下，无法从 [root] 推出（旧判据把它与 usr 下的两项并列，
   *   这里保持同一判据口径，只是路径由调用方给出）。传 null 表示该层不适用（会记入日志的调用方自行区分）。
   * @param probe 探测原语。
   * @param currentUser 当前进程的 Android 用户号（issue #1234；缺省 0 = 单用户设备的历史口径）。
   *   缺省值让既有调用点零位移；**多用户路径必须显式传**，否则跨用户守卫退化成 user 0 口径。
   * @returns 可读的缺失条目名（含基础 3 项与动态库），供日志逐项打印。
   */
  internal fun missingEntries(
    root: File,
    profileDir: File?,
    probe: Probe = FsProbe,
    currentUser: Int = 0,
  ): List<String> {
    val missing = ArrayList<String>()
    for (rel in BASE_ENTRIES) if (!probe.exists(File(root, rel))) missing.add(rel)
    if (profileDir != null && !probe.exists(profileDir)) missing.add("home/.dsh/profiles/web")
    val libDir = File(root, "lib")
    for (lib in REQUIRED_LIBS) {
      val f = File(libDir, lib)
      if (!probe.exists(f)) { missing.add("lib/" + lib); continue }
      if (!probe.isLink(f)) continue
      val target = probe.linkTarget(f) ?: continue
      // 「绝对目标」必须用平台感知的判据：Android 上绝对路径以 '/' 开头，Windows 上以盘符开头（`D:\`）。
      // 只判 `startsWith("/")` 会把 Windows 风格绝对路径误当相对路径，于是去 lib 目录下找 `D:\...`，
      // 必然找不到 ⇒ 误报 dangling（本仓单测在 Windows 上跑，这条被实测抓出）。
      // `File(...).isAbsolute` 同时覆盖两种平台，且语义正是「这是不是绝对路径」。
      if (java.io.File(target).isAbsolute) {
        if (!absoluteTargetInsideTree(target, libDir.absolutePath, currentUser)) {
          missing.add("lib/" + lib + " (absolute link outside tree: " + target + ")")
        }
      } else if (!probe.exists(File(libDir, target))) {
        missing.add("lib/" + lib + " (dangling link -> " + target + ")")
      }
    }
    return missing
  }

  // ── (b) 链接失败自愈：识别 + 预算（task-79）────────────────────────────────

  /**
   * 引擎日志里是否出现**动态链接失败**签名（纯函数，可注入文本 ⇒ JVM 可直接测）。
   *
   * 真机原文（小米 25079RPDCC / Android 36 / arm64，0.14.2-fx-1）：
   *   `F linker  : CANNOT LINK EXECUTABLE "/data/user/0/.../files/usr/bin/node":
   *                library "libz.so.1" not found: needed by main executable`
   *
   * 为什么两种形态都要认：linker 的措辞随版本/路径变化——`CANNOT LINK EXECUTABLE` 是 linker64 的形态，
   * `library "X" not found` 是缺库的本质描述（某些机型只打后者）。只认一种会在部分机型上漏判。
   *
   * 收紧边界（避免误伤）：**必须同时**出现 `not found` 与 `library "..."`，或出现 `CANNOT LINK`。
   * 不能只匹配 `not found`——引擎日志里别处也会出现「not found」（例如插件查找失败），
   * 那会把「插件缺」误判成「运行时树损坏」而触发一次重抽取（白付一次全量刷新代价）。
   *
   * @param logText engine.log 的当拍内容（尾部即可）。
   * @returns true = 判定为运行时树损坏。
   */
  internal fun snapshotLinkFailure(logText: String?): Boolean {
    if (logText.isNullOrBlank()) return false
    if (logText.contains("CANNOT LINK")) return true
    val libNotFound = Regex("""library "[^"]+" not found""")
    return libNotFound.containsMatchIn(logText)
  }

  /**
   * 自愈预算：**每次 app 运行最多自愈一次**（Lead 裁决第 4 条）。纯判定，可注入。
   *
   * 为什么需要预算：删指纹 + 清账本会强制一次全量重抽取（设备实测 8-12 分钟）。若树已**永久**损坏
   * （例如安装包本身缺库、或存储坏块），无预算的自愈会变成「重抽取 → 再失败 → 再重抽取」的死循环，
   * 用户永远等不到可读的错误页。一次之后仍未恢复 ⇒ 说明不是「一次重抽取能修好」的损伤，
   * 应当停在错误页让人看见真因（并保留诊断包）。
   *
   * @param alreadyHealedThisRun 本次 app 运行是否已经自愈过一次。
   * @returns true = 允许执行「删指纹 + 清账本 + 重抽取」。
   */
  internal fun maySelfHeal(alreadyHealedThisRun: Boolean): Boolean = !alreadyHealedThisRun

  /** 损坏标记文件名（壳侧，**不被引擎的 redirectOutput 截断**——engine.log 每 spawn 截断，不能当账本）。 */
  internal const val DAMAGE_MARKER = ".runtime-tree-damaged"

  // ── issue #309：拒启取证的**证据分级**（决定要不要花掉那次重抽取）────────────────

  /**
   * 「一旦缺失即可确诊 live 树被外部改坏」的**确认项**（issue #309）。
   *
   * 分级为什么是必须的（直接来自 issue 的反向告诫）：`REQUIRED_LIBS` 只列了 `usr/bin/node` 的
   * 8 条 DT_NEEDED，**不含传递依赖** —— 作者实测缺的 `libicudata.so.78` 正是被 `libicuuc.so.78.3`
   * 需要的传递依赖，却不在表里。因此「`REQUIRED_LIBS` 里有一项不在」**不能**证明真缺件：
   * 它也可能是传递依赖造成的假阴性（即树其实是「不完整但近似原始」的可救态）。
   *
   * issue 原文据此明确要求「**不要贸然补全该表**」，否则闸门 A 更严、互锁会从「可人工救」升级为
   * 「只能清应用数据」。同一句话反推出的纪律就是这里的分级：
   *
   *   · 确认项（本表）——抽取过程的产物，只可能是「树被改坏 / 搬了一半」，重抽取必能复原；
   *   · `REQUIRED_LIBS` 成员——可能是传递依赖误报，**只记录不触发**。
   *
   * 代价是罕见的「只缺一个库、基础项俱全」的损伤不会自动恢复；但那正是 issue 里用户手动补链后
   * **闸门 B 接手救回**的形态（enginelog 里有 CANNOT LINK）——这条路本轮已经打通，不是死路。
   * 反过来若在这里放宽，误伤面是「每次启动白付一次 8-12 分钟全量抽取 + 抹掉现场」，明显更坏。
   */
  internal val START_RECOVERY_CONFIRMED_ENTRIES: List<String> = listOf(
    "bin/node",
    "lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
    "home/.dsh/profiles/web",
  )

  /**
   * 从 [missingEntries] 的输出里挑出**确认项**（纯函数，JVM 可测）。
   *
   * 只做等值匹配、不做前缀匹配：`missingEntries` 对链接异常会追加 ` (dangling link -> x)`
   * 一类后缀，而那条路径属于 `REQUIRED_LIBS` 面（低置信度），不应因后缀不同而被漏判为确认项。
   */
  internal fun confirmedDamage(missing: List<String>): List<String> =
    missing.filter { entry -> START_RECOVERY_CONFIRMED_ENTRIES.any { it == entry } }

  /**
   * 拒启恢复的**唯一闸门**（纯函数）：预算 + 证据分级，两条同时满足才允许花掉那次全量重抽取。
   *
   * 抽成纯函数是为了让反证靠传参（本仓既有范式），而不是靠读源码字符串：
   *   · `alreadyRecoveredThisRun = true` ⇒ 拒绝（预算，避免「重抽取 → 再失败 → 再重抽取」死循环）；
   *   · `confirmedMissing` 为空 ⇒ 拒绝（证据不足，只有低置信度条目命中，见上表注释）；
   *   · 两者都不满足 ⇒ 允许（本次运行第一次 + 有确诊缺失项）。
   *
   * 第三种输入是 issue #309 建议 3 的「手动入口」：`userForced = true` 放行**证据分级**这一关
   * （预算那一关**不**放行）。理由：低置信度条目命中时（例如只缺一个 REQUIRED_LIBS 成员，见
   * 上表注释）自动路径刻意不动作，但用户此刻看到的是「引擎起不来」——他点「安全模式启动」
   * 就是显式要求「重做运行时」。若连这一下都不给，用户仍只能靠壳侧终端手工补库（issue 现场
   * 正是如此），本 issue 的核心诉求「有出路」就没有兑现。反过来预算必须照旧：一次之后仍失败，
   * 说明不是一次重抽取能修的损伤，继续循环只会把用户困在解压页。
   *
   * @param confirmedMissing [confirmedDamage] 的结果。
   * @param alreadyRecoveredThisRun 本次 app 运行是否已经为「运行时树残缺」花过重抽取。
   * @param userForced 是否来自用户的显式动作（错误页按钮）。
   */
  internal fun allowStartRecovery(
    confirmedMissing: List<String>,
    alreadyRecoveredThisRun: Boolean,
    userForced: Boolean = false,
  ): Boolean = maySelfHeal(alreadyRecoveredThisRun) && (userForced || confirmedMissing.isNotEmpty())

  /**
   * 一个条目的现场描述（诊断用，不是判据）：存在性 + 大小 + mtime。
   *
   * 为什么连大小/mtime 一起记：issue 报障者的触发源是「一次误删 usr/lib 下 soname 符号链接的操作」，
   * 而重抽取会覆盖现场。事后要能回答「当时到底缺了什么、是什么时候被动的」，只能靠这条。
   */
  internal fun describeEntry(file: File): String =
    if (!file.exists()) "absent" else "present size=" + file.length() + " mtime=" + file.lastModified()
}
