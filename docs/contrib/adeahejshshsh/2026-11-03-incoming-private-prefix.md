# 来件白名单不再放行本应用私有目录（2026-11-03，issue #1353）

## 现象

`MainActivity` 是 `exported="true"` 的 VIEW/SEND 入口，`FileIncoming.SAFE_PREFIXES` 里却带着
`file:///data/user/0/com.dsharnessmobile.shell/` 与 `file:///data/data/com.dsharnessmobile.shell/`。
任意已安装应用构造一条指向本应用私有目录的 `ACTION_VIEW`，壳侧前缀校验通过 → `copyIn()` 把该文件
拷进来件工作区 → `enqueuePending()` 交给引擎侧 `dsh-android-file-open`，后者**强制新会话**并把路径
作为未发送草稿交给模型。零权限、零交互。

`res/xml/file_paths.xml` 的注释写明「绝不映射 `filesDir/home/.dsh` 其余部分（含 `.credentials.yaml`
/ `deepseek-key.txt` 等机密）」——FileProvider 那条出口堵了，来件这条入口没堵。

## 真因

`file://` 方案**不携带任何读授权**，壳侧也拿不到调用方身份：`getCallingPackage()` 只在 Activity
入口可用，而 `FileIncoming.validate()` 只看到 URI 字符串。于是「白名单里有私有目录前缀」等价于
「谁都能读私有目录」——判据看着是路径白名单，实际是**把 exported 入口当成了可信调用方**。

内部流程从来不需要这条前缀：拍照等壳侧自产来件已经持有 `File`，走 `processIncomingPath()`，
不经过 URI 校验。白名单里那两条私有前缀是为「将来可能」留的，实际零调用方（`grep` 全仓只有
`SAFE_PREFIXES` 自身命中）。

## 修法

`FileIncoming.SAFE_PREFIXES` 删掉两条私有目录前缀，只留外部世界的真实路径：`content://`
（系统分享主路径）与共享存储 `file:///storage/emulated/0/`、`file:///sdcard/`。代码注释把
「为什么不能放私有目录」写进原地，避免下一个人以「内部流程要用」为由加回来。

契约用例 `W3ShellContractTest.incomingExternalWhitelistExcludesPrivateDirs` 锁死这条面：
白名单里出现 `/data/data/` 或 `/data/user/0/` 即红，同时断言 `content://` 与共享存储仍在、
`processIncomingPath(File)` 入口仍在（壳侧自产来件有路可走）。

## 复验

- `node scripts/check-kotlin-comments.mjs` → PASSED（无嵌套块注释）。
- `node scripts/check-code-map.mjs` → PASSED（`FileIncoming.kt` 锚点按 +10 行手钉，未刷基线）。
- **Kotlin 单测未在本机跑**：本机没有 Android SDK/Gradle，`W3ShellContractTest` 由 CI 执行。
  本机用同判据脚本（逐条对应 `incomingExternalWhitelistExcludesPrivateDirs` 的五个断言）对源码求值：
  改前 2 条红（两条私有前缀），改后 5 条全绿。
- **未做设备验证**：本机无模拟器（`127.0.0.1:16416/16384` 不可达），也装不了包（无 SDK）。
  真机/模拟器上应复验的两件事写在 PR 的「请求验证」卡里。
