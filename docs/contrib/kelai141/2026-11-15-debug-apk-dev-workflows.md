# 云端调试包（dev）两条链：随机版本段 + release 绑定 versionCode + 反向形态断言

日期：2026-11-15
范围：`.github/workflows/build-apk-debug-arm64.yml`、`build-apk-debug-x86_64.yml`、`scripts/build-apk-debug.mjs`、`scripts/build-apk-debug.test.mjs`、`scripts/build-apk.mjs`（新增 `--emit-snapshot`）

## 需求与落地口径

需求原文：「构建 ARM 64 调试包 / 构建 x86-64 调试包，然后会自动打包可 dev 的包，版本名是随机 8 位 ascii 字符加 -dev，versioncode 自动取目前仓库 release 绑着的 versioncode 自动加一」。落地成两条 `workflow_dispatch` 手动链：

- `versionName = <当前树 gradle 的 versionName 基线>-<随机 8 位 [A-Za-z0-9]>-dev`；
- `versionCode = 已发布 release 绑定的 versionCode + 1`（v0.14.11 绑 70 ⇒ 调试包 71）。

## 踩到 / 差一步就踩到的坑

1. **「随机 8 位 ascii」不要按字面取 0x20-0x7e**。产物名会进 URL、adb 命令行、tar 成员名与 GHA artifact 名；空格、引号、`*` 只会制造转义事故，换不来熵。62 位字符集（`A-Za-z0-9`）已有约 2.18e14 组合，且不会让 `-PversionNameSuffix` 变成 shell 元字符。判据落在 `validateRandomPart()`：**恰好 8 位**，长度不对或带分隔符都拒（`-rc`/`-fx-N` 是版本语义的一部分，不能让随机段撞进去）。

2. **versionCode 的「当前仓库 release 绑着」有歧义，必须选一侧并硬失败**。两种读法：① 最新 release tag 那份 `app/build.gradle.kts` 的默认值（v0.14.11 = 70）；② 当前 `main` 的默认值（已是 80，留给 0.15.0 发布）。取 ① 才是需求要的语义（调试包要能盖住已发布版），取 ② 会让调试包的号恰好等于下一个正式版。**关键是解析不到时不许回落**——回落成 80 时日志全绿，只在装机时以 `INSTALL_FAILED_VERSION_DOWNGRADE` 或反向覆盖暴露。实现上 `bumpVersionCode()` 对空值/非正整数/越界全部抛错，`readVersionFactsFromTag()` 读不到 tag 或形态不对也抛错。

3. **调试包不能复用发布链的产物形态门禁**。`check-apk-form.mjs` 的判据是「不得含 `application-debuggable`」，而调试包**必须**含它。直接调它会恒红；把它删掉则「这是不是一个调试包」失去判定。做法是把同一条判据反过来断言（`evaluateDebugBadging()`：必须 debuggable + versionName/versionCode/包名逐字相符），并复用 `check-apk-form.mjs` 已导出的 `parseBadging()` —— 自己再写一份 badging 解析就是两个门禁两套语法。同理**不能**用 `build-apk-engine.mjs` 的 `verifyApks()`（它内含形态门禁），只调 `check-apk-signatures.mjs`。

4. **`check-snapshot-packages.mjs` 必须跑在注入之后**。它比对 `engine-overlay.json` / `plugin-dirs.json` 里的包是否真在 tar 里，而未注入的快照（`build-snapshot-013.mjs` 的产物）一个插件都没有 ⇒ 先跑必恒红，红的是「还没轮到注入」而不是快照有问题。已发布 release 的快照虽然是注入后的形态，但登记面在本 commit 又往前走了（实测 v0.14.11 快照缺 `@dsh-android/dsh-android-phone-control` 目录，而它在 main 上已登记），那一档同样不该用本判据——这正是 `--from-release` 打印「跳过覆盖对账」的理由。

5. **注入实现只能有一份**。调试包与发布包的插件树若各走一条装配路径，设备上只表现为「某个插件行为不一致」，没有任何一层会报红。故给 `scripts/build-apk.mjs` 加 `--emit-snapshot <out.tar.xz>`：在**注入后门禁全部通过之后、Gradle 之前**把快照交出来。位置是判据的一部分——放前面交出的是没验过的快照，放后面要白跑一遍 gradle。

6. **`set -o pipefail` 下不要写 `yes | sdkmanager`**。`yes` 被 SIGPIPE 终止返回 141，整条管道判失败：NDK 明明装上了却报错，报错点还不在 sdkmanager 上。runner 上 Android SDK 许可早已接受，直接 `sudo sdkmanager "ndk;<ver>"` 即可。

7. **版本真源不要抄进 yaml**。rustc 版本、NDK 版本、rust target 都在 `native/phone-control-core/build-config.json`；抄一份进 workflow 后，改了仓里的 ABI 表就表现为「runner 装了没人用的 target，真正要的那个缺席」，而报错落在 cargo 里。加了 `--print-facts`（只输出一行 JSON，stdout 只有 JSON）让 CI 从真源取。同理 `-PnativeControlAbis` 由 `--abi` 单点派生，不在 yaml 里写第二份 ABI 表。

8. **执行地图的两条锚点会被自己撞坏**。给 `build-apk.mjs` 头部加注释会把 `const market = externalNamed(...)` 从 :62 推到 :69，而 EXECUTION-MAP 里 4 处原文引用了 `:62#expect=...`，对不上就是 `bad-anchor-content`。`--allow-missing` 那条注释同时从 :304 推到 :312。判据是「去缩进后的规范化前缀」，改一处漏一处都会红。

## 证据

- `node --test scripts/build-apk-debug.test.mjs`：23 例全绿（随机段长度/字符集/注入 nextInt、versionCode +1 与「解析不到即抛」、versionName 与发布链同一套 `resolve-version-suffix`、产物名不被 `assetNameCandidates` 命中、ABI 交叉断言、产物形态正反控、GITHUB_OUTPUT 形态）。
- 受控负控三条（真实命令，全部按预期判红）：① arm64 快照 + `--abi x86_64` → `elf-check` exit 1（`ABI 不匹配：快照 node 实际 0xb7（aarch64）≠ x86_64`）；② 不存在的 `--release-tag v0.0.0-nope` → exit 1（`读不到 ... 的 app/build.gradle.kts`）；③ `--suffix 'bad part'` → exit 2（`必须是恰好 8 位 ASCII 字母或数字`）。
- `node scripts/check-workflow-input-injection.mjs`（15 份 workflow PASS）、`check-release-gates`（48 项声明门禁）、`check-retired-plugins`、`check-build-chain-abort` 全 PASS。
- `check-code-map.mjs`：在我改动的文件面上**零新增失败**（干净检出里 pristine HEAD 15 项 → 加改动 15 项，逐项 diff 为空）。
- **未做设备验证**：本链只产包不装设备。首次真机跑装后按 AGENTS.md §2.1 三层自行验收。
