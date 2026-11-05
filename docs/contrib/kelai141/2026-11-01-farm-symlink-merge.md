# 共享农场符号链接在快照刷新时永不落地（0.14.10 P0）

## 现象（设备实证，不是推演）

设备 `127.0.0.1:16448`（MuMu，x86_64，Android 15），装 v0.14.9 双 ABI 产物后冷启：

```
dsh-plugin-subscriptions/lib/index.js 第 6 行：
  import { ProxyAgent, fetch as fetch$1 } from "undici";

设备上：
  ls /data/data/com.dsharnessmobile.shell/files/home/.dsh/profiles/node_modules/undici
  => No such file or directory

归档里（.deploy-tmp/build-/13-x86_64/snap-final2.tar.xz）：
  lrwxrwxrwx ... home/.dsh/profiles/node_modules/undici
      -> ../../../../usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici
```

**归档 farm 顶层 165 项 / 设备 187 项，差集恰为 1 项 = `undici`。**

## 真因：`mergeTree` 对符号链接裸 `return`

`SnapshotTransaction.mergeTree`（原第 1122 行起）的 `when` 第一支：

```kotlin
attrs.isSymbolicLink -> return      // 整个跳过
```

后果按「live 里有没有这一项」分两种，**两种都坏**：

- live 已有 → 悄悄留着上一代链接，看起来没事，**掩盖缺陷**；
- live 没有 → 这一项**永远不会被创建**。而 profiles 树其余部分（`profiles/web`）每轮都在合并，
  于是农场变成「部分新、部分缺」的混合体。

### 为什么能确定是「从未创建」而不是「被删」

同时存在 4 个相对目标链接，其中 3 个在设备上「在」：

| 链接 | 设备 |
|---|---|
| `@deepseek-ai/dsh-client-web` | PRESENT，mtime = 2026-10-31 03:05 |
| `@deepseek-ai/dsh-client-ui-slots` | PRESENT，mtime = 2026-10-31 03:05 |
| `@deepseek-ai/dsh-client-ui-primitives` | PRESENT，mtime = 2026-10-31 03:05 |
| `undici` | **MISSING** |

关键在两个 mtime：

```
profiles/node_modules   mtime = 2026-10-31 03:05   <- 上一代全量解压时间
profiles/web            mtime = 2026-11-01 14:05   <- 本次合并时间
```

那 3 个「在」的链接 mtime 也停在**上一代解压时间**，说明本路径从未写过它们；
`undici` 在两代归档里都存在（内容逐字相同），却只在第一次全量解压那一代落地过——
而它第一次出现的那一代，恰好就是被跳过的那一代。

## 修法（补齐，不覆盖）

```kotlin
links.isLink(staged) -> {
  if (SnapshotFs.exists(live) || links.isLink(live)) return@mergeTree
  val linkTarget = links.linkTargetOf(staged)
  live.parentFile?.let { SnapshotFs.createDirectories(it) }
  links.createLink(live, linkTarget)
  notes.add("农场链接补齐 " + staged.name)
}
```

三个刻意的选择：

1. **只补 live 不存在的项**，live 已有的一律不动。不做整目录替换——那会抹掉用户后加的农场包，
   比缺一个 `undici` 更坏。
2. **判据同时问 `SnapshotFs.exists` 与 `links.isLink`**。只问前者：悬空链接会被
   `File.exists()` 跟随成 false 而被覆盖（v0.10.7 重解压实锤过）；只问后者：普通目录/文件被判丢。
3. **建链失败向上抛**，与 `copyRecursivelyStrict` 同口径。静默跳过正是本缺陷的成因。

## 修的时候踩到两个假绿，都记下来

### 假绿一：夹具只登记在替身内存表里

`mergeTree` 靠 `staged.listFiles()` 枚举，只在替身里登记链接而不在磁盘落条目 ⇒
**枚举不到，用例空过**。表现是「用例 ② 通过」但其实什么都没测。
修法：夹具先写一个占位文件让枚举看得见，「它是链接」由替身回答。

### 假绿二：递归漏传接缝（这个是缺陷本体级别的）

`mergeTree` 目录分支的递归调用漏传 `links`：

```kotlin
mergeTree(child, File(live, child.name), notes, userFacingFiles, preserveCopy)  // 少了 links
```

后果：顶层问的是替身，深一层全部退回 `PRODUCTION_LINKS`。代码里看着到处都有
`links.isLink`，实际 farm 里真正要命的那些深层条目一次都没被问到。
**实测证据**：追踪输出里 `isLink` 只在 profiles/node_modules/web 这一层被问了 7 次，
`undici` 那层一次都没问。

这条的教训比缺陷本身更值得记：**接缝加了不等于判据接上了**。
「有接缝但无判别力」是本仓第 N 次出现，检查方法是打印替身被问到的键，
而不是看代码里有没有 `links.`。

## 回归用例

`app/src/test/java/com/dsharnessmobile/shell/FarmSymlinkMergeTest.kt`，3 条：

| 用例 | 判据 |
|---|---|
| `seedsFarmLinkThatLiveDoesNotHave` | 归档有 / 设备无 ⇒ 刷新后必须在场，且目标**逐字相同**（相对目标不得被解析成绝对路径） |
| `neverOverwritesFarmEntryThatLiveAlreadyHas` | live 已有（含用户后加的同名项 + live-only 项）⇒ 原样保留、不得重建 |
| `withoutLinkSeedingNoFarmEntryIsCreated` | 反证：staged 侧不是链接时不得凭空建链，证明用例 ① 判的是链接分支 |

夹具用记录型 `LinkPrimitives` 替身（本机 Windows 无建链权限，直接建链会静默跳过 = 假绿）。

## 复验

- `FarmSymlinkMergeTest` 3/3 通过（`--rerun-tasks` 强制真跑）
- `gradlew :app:testDebugUnitTest` 全量通过
- `check-code-map` / `check-kotlin-comments` / `check-release-gates` / `check-build-chain-abort` / `check-patch-mirror` 全 PASSED
