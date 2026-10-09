# RUNTIME-PATCHES.md — assets/patched/ 运行时补丁登记

> 职责：设备端完整覆盖资产与构建期补丁登记。活动构建期清单由 `scripts/patches/registry.json` 生成；运行 `node scripts/check-maintenance-docs.mjs --write` 更新，省略 `--write` 检查。§2 与历史重出章节的尺寸/hash 是旧批次记录；当前产物同源性与验收状态见对应版本阶段交接和最终产物证据。

## 1. 机制（EngineManager.kt）

- **路径速查**：解压根为filesDir（usr/home），目标包根由EngineManager.applyRuntimePatches构造；见 [源码入口](<dsh-mobile-apk/app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt#L1025-L1065>)。
- **触发时机**：每次startEngine真正spawn前调用applyRuntimePatches；快照刷新后重新比对，幂等。
- **覆盖式全量替换**：applyAssetPatch读取完整asset并整文件写入目标，不是delta/行级补丁。
- **内容指纹判定**：目标存在且contentEquals资产才跳过；固定marker不能替代字节对账，历史旧marker曾掩盖新资产。
- **目标包缺席即跳过**：目标父目录不存在时不落补丁（宁缺毋滥不留死覆盖）。
- ~~hashAdaptive~~（0.13.7fx-1 随 web-frontend-index.html 退役，理由见 §8）：曾用于让 patched 模板跟随引擎 dist 的 content-hash bundle 名；`adaptIndexHashes` 已随 asset 一起删除。
- applyAssetPatchAppend为历史备用，无当前调用方；不要把它当profile配置传输路径。

## 2. 文件逐项登记

目标根为快照内usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai；下表尺寸来自明确历史批次。注册入口现在为applyRuntimePatches，旧注册行号不再作为当前锚点。

| asset 文件（字节） | 目标快照路径（注册行） | 状态 | 作用 / 来源线索 |
|---|---|---|---|
| attachment-local-index.js（**47,937**，2026-09-24 按 0.1.7-rc.1 快照重建） | dsh-attachment-local/lib/index.js（applyRuntimePatches） | 生效 | 0.13.7 重出（引擎 0.1.5-rc.1）+ 0.14.2 随引擎 0.1.7-rc.1 换代重建（§7.4）+ 0.14.0 review C1：**与构建期 `attach-durable-F2` 逐字节同源**（F2 已扩为三件套：祖先 fsync 守卫 + 两处 link(2)→rename 回退 + unlink ENOENT 容忍）；内含图片归一化 2048 降采样上限（`DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 2048`）。补丁判定走内容指纹而非内嵌标记 |
| session-persistence-jsonl-index.js（**145,247**，2026-09-24 按 0.1.7-rc.1 快照重建） | dsh-session-persistence-jsonl/lib/index.js（applyRuntimePatches） | 生效 | 0.13.7 重出 + 0.13.8-b 追加 F5/F7（与构建期同源）+ 0.14.2 随引擎 0.1.7-rc.1 换代重建（§7.4）：两处 link(2) 站点带 EACCES/EPERM/ENOTSUP → rename 回退，发布独占语义由模块级 `dshMobileClaimExclusive/ReleaseClaim` 恢复（O_EXCL 占位 + 失败回收）。**0.14.0 review C1 实锤**：v0.14.0-preview 资产曾是「内联占位 + helper 占位」双占位坏版本（恒 EEXIST 恒 false，旧会话迁移永久失败并留 0 字节毒文件）——修复 = F7 补丁增加 v1→v2 收敛分支 + 本资产从快照重出 + 门禁升级为逐字节比对。行为回归 `scripts/patches/tests/{spj-migration-link-f5,publish-exclusive-reclaim}.test.mjs`（后者支持 `--asset` 直测资产本体） |
| fs-local-index.js（**47,793**，2026-09-26 由出厂态 fixture 经补丁链重建：F8 + B） | dsh-fs-local/lib/index.js（applyRuntimePatches） | 生效 | **0.14.1 重新入册**（apk issue #246）：`writeFileAtomic` 的 `createIfAbsent` 发布站点是全包唯一的 `link(2)` 调用，且该分支失败即抛、无任何回退 → Android 应用域恒拒 hardlink ⇒ 真机上 `write` 工具建不了任何新文件（覆盖已存在文件走 `rename`，正常）。与构建期 `fs-local-link-F8` 逐字节同源。**本资产是 0.13.3 退役资产的重新入册**——当年退役理由「上游 0.1.2-rc.1 已原生覆盖 rename 回退」对 `createIfAbsent` 站点不成立（0.1.5-rc.1 实测：全文仅此一处 `link` 调用，`EACCES`/`EPERM`/`ENOTSUP` 无任何处理）。补丁判定走内容指纹而非内嵌标记。行为回归 `scripts/patches/tests/fs-local-link-f8.test.mjs`（支持 `--asset` 直测资产本体） | **0.14.2 追加 `fs-local-digest-guard-B`**（版本守卫摘要 CAS 兜底）：资产必须同时含 F8+B 两个 marker，否则引擎启动时会把 B 覆盖回「只有 F8」的旧字节 ⇒ 真机上 B 等于没修（实测踩到：旧资产 43,405 B 与当时快照逐字节一致，门禁因快照陈旧而不响）。重建方式 = 取出厂态 fixture 按 registry 顺序施加该文件全部 engine 补丁（产物 47,793 B），**禁止手改**；门禁见 §7.5 |

已退役资产（不在 `assets/patched/`，`applyAssetPatch` 注册行同步移除，勿再引用）：`primitives-index.js`、`fs-local-index.js`（0.13.3 批退役，d377abc——link(2) 回退族改由构建期补丁承担；**0.14.1 已重新入册，见 §2 的 fs-local-index.js 行与 §7.1 的 `fs-local-link-F8`**——退役时该回退并未真正落到构建期补丁，`createIfAbsent` 站点成了覆盖空洞）；`web-frontend-index.html`（0.13.7fx-1 退役，§8）；`llm-deepseek-index.js`（rc.2 起遗留死资产，随重出批删除）。

## 3. 维护约定（硬约束）

1. **全量替换非 delta**：asset 必须是目标文件的完整拷贝（在原文件基础上改后整体入库）；不允许只存 diff 片段或手写残缺文件——applyAssetPatch 直接 writeBytes 整写，半截文件 = 引擎启动即崩。
2. **更新需随上游引擎对齐**：升级0.2.0-rc.2必须从对应原始文件重出三条资产，并施加该文件全部当前补丁，再与最终双ABI快照逐字节/全部marker或exact verifier对账；不能叠加旧asset。§7.4/7.5是历史证据，不是本轮已完成。
3. **禁止随手重生成**：内容指纹机制意味着 asset 与目标「看起来差不多但字节不同」就会触发重写——不得用本地构建产物/不同 minify 形态随手替换 asset；改动须走完整链路验证（引擎起得来、市场/会话/附件功能实测）。
4. **新增补丁**：applyAssetPatch 注册新条目 + 本表登记；优先评估上游新版本是否已修复（能不补则不补）。

## 4. 施加结果验证方法

- **日志锚点**（LogCollector/logcat，EngineManager.kt 内 Log.i/Log.w/Log.e）：
  - runtime patch applied/updated日志表示本次实际写入；精确函数锚点见本节源码入口。
  - runtime patch skipped (target package absent)表示目标缺席，按上游变更评估，不留死覆盖。
  - runtime patch asset missing表示打包遗漏，不是功能通过。
  - `index hash adaptation failed; keeping bundled patch`（hashAdaptive 已于 0.13.7fx-1 随 web-frontend-index.html 退役，见 §8；该日志行不再产生）。
- **产物抽验**：从 APK 内 assets/patched/ 取出与快照解压树目标文件做字节比对（contentEquals 同一判定）；发布链可用 `tar -xO` 抽验快照内目标文件（AGENTS.md 惯例）。
- **行为抽验**：剪贴板复制（primitives）、附件上传图片（attachment 2048 上限）、WebView 沉浸式与老内核插件列表（web-frontend）、会话持久化/文件工具（fs-local、session-persistence-jsonl）。

## 5. 机制演进史（改动前先读，防止重蹈）

| 事件 | 教训 / 产物 |
|---|---|
| v1→v2 asset 更新被跳过 | 固定 marker 字符串在目标文件更新后仍命中 → 新 asset 永不落盘；改为内容指纹判定（:404-405、:432-434） |
| 2026-08-23 前端审核 CRITICAL#4 | 引擎升级换 bundle hash → patched 模板旧引用 404 白屏；加 hashAdaptive（:435-438、:471-490） |
| v0.12.4（rc8）迁移批 | onImagePicked/describeImage/bundle-hardening/textzoom 四补丁删除（上游 rc.8 原生覆盖 + textzoom 功能取消）；textzoom 桥方法保留（:413-416） |
| rc.1 → rc.2 链路 | rc.1 丢 rename 回退 → fs-local/session-persistence-jsonl 两补丁补回；rc.2 原生捆绑 vision-exp → llm-deepseek 补丁退役为遗留资产（:399-425） |
| 0.14.1 文件写工具链路 | `write` 工具在 Android 上**建不了新文件**（`createIfAbsent` 的 `link(2)` 无回退，apk issue #246）→ fs-local 重新入册 + 构建期 `fs-local-link-F8`。教训：退役理由「上游已原生覆盖」必须**逐站点**核对，不能按文件整体判定——上游把回退加在替换路径上，而新增的独占创建路径又裸用了 `link(2)` |
| 目标包缺席语义 | 上游裁包（如某版本依赖图变动）时跳过而非报错/硬写，避免死覆盖（:440-446） |

## 6. 与协调仓 scripts/patches/ 的分工边界

**协调仓 `scripts/patches/`（apply-patches.mjs + registry.json + data/compat-map.json）是快照注入链的构建期补丁框架**，按 `scope` 分两路：
- `scope: vendor` 打 vendor 固化插件（dshmarketplace-plugin B/D + **U2 exact-route browser-session 鉴权**；dsh-undo-savepoint E1-E8 + **S1 safe 保留自有插件** + **U1 `/api/undo` connection/token 鉴权与 no-store**），在 `build-apk-013.ps1` 阶段施加；对应行为回归在 `scripts/patches/tests/{undo-route-auth,market-route-auth}.test.mjs`。
  - **2026-09-26 追版**：两个插件都追到上游新版（marketplace 0.1.5→0.1.7、undo 0.3.8→0.4.9）。已退役：marketplace A（上游 0.1.7 原生修 next 兜底）、marketplace C（上游 0.1.7 用 `installCheck==="passed"` 过滤掉不可安装条目）；新增 undo S1（safe 生成对齐壳侧 `SafeMode.kt`：只摘第三方、保留 `@dsh-android/*` 与全部 `disable` 行——上游原实现整份覆写会重开无鉴权的 `client-hmr` SSE）。详见各 vendor 的 `PATCHES.md` 与 `registry.json` 的 `retired` 段。undo 0.4.9 另有安全收益：`settings.yaml` 纳入脱敏（0.3.8 时代在快照范围内却不脱敏 ⇒ 明文进包）。
- `scripts/check-api-route-auth.mjs` 与 `api-route-auth-policy.json` 不属于运行时 asset：它们扫描所有 mobile-owned WebServer registration source，要求 protected guard 或窄公开白名单，并在本地/云端/CI/发布链接线。file-incoming 的 queue、claim、content、complete、clean 五个 exact route 均属于 protected 面；content 只接受进程内 ticket，不能返回源绝对路径。
- `scope: engine` 打引擎树内上游包，在 `build-snapshot-013.mjs` 0f 步施加并逐个复查 marker / exact verifier；当前活动清单见下方生成区。§7 的批次说明记录历史实现，不作为活动全集。

### 6.1 当前活动构建期补丁（registry 生成）

<!-- generated:active-registry:start -->
| 活动补丁 ID | scope | 目标 |
|---|---|---|
| `market-B` | undefined | `dshmarketplace-plugin/lib/index.js` |
| `market-D-server` | undefined | `dshmarketplace-plugin/lib/index.js` |
| `market-route-auth-U2` | undefined | `dshmarketplace-plugin/lib/index.js` |
| `market-D-client` | undefined | `dshmarketplace-plugin/lib/client.js` |
| `undo-E1` | undefined | `dsh-undo-savepoint/lib/client.js` |
| `undo-E2` | undefined | `dsh-undo-savepoint/lib/client.js` |
| `undo-E3` | undefined | `dsh-undo-savepoint/lib/client.js` |
| `undo-E4` | undefined | `dsh-undo-savepoint/lib/client.js` |
| `undo-E5` | undefined | `dsh-undo-savepoint/lib/client.js` |
| `undo-E6` | undefined | `dsh-undo-savepoint/lib/client.js` |
| `undo-E7` | undefined | `dsh-undo-savepoint/lib/client.js` |
| `undo-E8` | undefined | `dsh-undo-savepoint/lib/client.js` |
| `undo-safe-align-S1` | undefined | `dsh-undo-savepoint/lib/core.mjs` |
| `undo-safe-transaction-S2` | undefined | `dsh-undo-savepoint/lib/core.mjs` |
| `undo-api-auth-U1` | undefined | `dsh-undo-savepoint/lib/index.js` |
| `narb-android-N1` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/node-addon-require-builtin/lib/index.js` |
| `flock-android-F3` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system/lib/flock.js` |
| `attach-durable-F2` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js` |
| `spj-migration-link-F5` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` |
| `publish-exclusive-F7` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` |
| `fs-local-link-F8` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js` |
| `combo-probe-P1` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js` |
| `client-registry-scan-C4` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js` |
| `typert-registry-scan-C4` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-typert-loader/lib/index.js` |
| `perf-compile-cache-flush-N2` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| `boot-third-party-isolation-G3` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` |
| `external-draft-conversation-seam-J1` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` |
| `arkweb-resource-protocol-H1` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-resources/lib/client.js` |
| `reference-drill-F6` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-reference/lib/client.js` |
| `terminal-inspector-android-D1` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js` |
| `pi-upstream-streaming-020` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`<br>`usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`<br>`usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js`<br>`usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.js`<br>`usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`<br>`usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/pi-messages.js` |
| `mimo-thinking-toggle-056` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`<br>`usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` |
| `pi-toolcall-G2` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` |
| `fs-local-digest-guard-B` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js` |
| `ptc-argv-L1` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/index.js` |
| `ptc-android-native-A1` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/index.js`<br>`usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js` |
| `file-upload-restart-R1` | engine | `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-file-upload/lib/index.js` |

已退役登记：`market-A`、`market-C`、`atomic-stale-lock-F4`。历史章节保留退役前语义；活动状态以本表和 registry 为准。
<!-- generated:active-registry:end -->

**与本节 assets/patched/ 的分界**：同一份引擎文件的修复若能在构建期落地（随发行快照固化），优先走 `scope: engine`；运行时 asset 只承担「必须每次启动前覆盖」或「与引擎版本无关的壳侧定制」（见 §3-2）。已退役：pi-drift-F1（上游 0.1.5 原生 strict/deferred 校验）。**assets/patched/ 是设备端运行时补丁**——壳在每次引擎启动前对快照内上游引擎包做覆盖。两者层不同、目标不同、幂等机制不同（构建期 = registry 幂等标记；运行时 = 内容指纹），勿混用；构建期补丁登记见协调仓 scripts/patches/README.md 与 registry.json。

## 7. 0.13.7 重出（引擎 0.1.5-rc.1，2026-09-10）

约定不变（§3-2）：**从对应版本包文件改起，不从旧 asset 迭代**。生成器：协调仓
`.tmp-upgrade/rebuild-runtime-patches-015.mjs`（锚点缺失即抛错，绝不写半成品）。

| asset | 目标 | 本次 delta（相对 0.1.5-rc.1 原文件） |
|---|---|---|
| `attachment-local-index.js` | `dsh-attachment-local/lib/index.js` | F2 祖先 fsync 守卫（`ensureDurableDirectory` 里的 `syncDirectory(parent)`；与 `scripts/patches/` 构建期补丁同源）+ **两处** link(2)→rename 回退（`publishImmutableAlias` 的 `source`、`publishStagedObject` 的 `staged.path`——0.1.5 变量名已变，旧锚点 `temporary/target` 失效）+ `publishStagedObject` 主链 `unlink(staged.path)` 容忍 ENOENT |
| `session-persistence-jsonl-index.js` | `dsh-session-persistence-jsonl/lib/index.js` | import 行加 `rename` + **两处** link(2) 站点（`link(tmp, finalPath)` 的 materialize 站 + `publishCurrentExclusive` 的发布站）在 EACCES/EPERM/ENOTSUP 时改走 rename 回退（0.1.5 锚点仍在）。0.13.8-b 追加：`unlink` 导入 + 模块级小函数 `dshMobileClaimExclusive()` / `dshMobileReleaseClaim()`，两站共用（O_EXCL 占位独占 + rename 失败回收占位），与构建期 F7 同源 |
| `web-frontend-index.html` | `dist/index.html`（hashAdaptive） | 与 0.1.5 dist 模板同源；资产里的 hash 由壳侧 `adaptIndexHashes` 跟随引擎改写，无需人工维护 |
| ~~`llm-deepseek-index.js`~~ | — | **删除**：无 `applyAssetPatch` 调用点（rc.2 原生含 vision 后已成死资产，39KB） |

校验：三份资产均 `node --check`（ESM）通过；标记串 grep `dsh-mobile link->rename fallback`（两处）、
`dsh-mobile durable-walk guard`、`already consumed the staged file`；0.13.8-b 追加
`dsh-mobile exclusive publish (F7)` / `dshMobileClaimExclusive`（asset 重出后必须在场）。

**构建期**引擎补丁的锚点与行为回归：`build-snapshot-013.mjs` 0f 步施加后逐个复查 registry marker
（缺席即拒打包），F4 另有常驻行为测试 `node scripts/patches/tests/atomic-stale-lock.test.mjs`
（fixture = 0.1.5-rc.1 产物；`.deploy-tmp/` 下的临时预检脚本不入库，勿再引用）。

### 7.1 构建期引擎补丁历史与实现说明（活动状态见 §6.1）

- **reference-drill-F6（2026-09-11，apk #163）**：`dsh-client-ui-reference/lib/client.js` 的 `onPick` 判定由
  `fileKind === "directory" && action === "drill"` 改为 `... || document.documentElement.hasAttribute("data-dsh-mobile-form")`——
  手机上点目录行行体 = 下钻进子目录（上游只把下钻绑在行尾 chevron/Tab 上，手机上点不到，用户侧表现为「@ 只能选到第一层」）；
  桌面无 form 标记，行为逐字不变。多选勾选框由注入层 `ReferenceMenuEnhancer` 负责。

| 补丁 | 目标包 | 本次动作 |
|---|---|---|
| `attach-durable-F2` | `dsh-attachment-local/lib/index.js` | 与运行时 asset **同源**：附件祖先 fsync 对 Android 应用私有祖先（`/data/user/0`）EACCES 即止步。构建期补丁服务发布快照，运行时 asset 服务「快照刷新后重施加」——两者内容一致才不会互相回退 |
| `flock-android-F3` | `node-addon-system/lib/flock.js` | 0.1.5 新增的会话写锁只有 darwin/linux 预编译 → Android 上 `ERR_FLOCK_UNSUPPORTED_PLATFORM` 让整树 boot 失败；按上游 browser-worker 先例 stub 为立即成功（单进程宿主）+ 一次性告警 |
| ~~`atomic-stale-lock-F4`~~（已退役） | `dsh-atomic-write/lib/index.js` | 历史孤儿锁回收补丁已由上游吸收；retired 登记继续供应真产物夹具，`scripts/patches/tests/atomic-stale-lock.test.mjs` 验证上游回收行为。 |
| `fs-local-link-F8` | `dsh-fs-local/lib/index.js` | 文件写工具 `createIfAbsent` 发布的 `link(2)` 回退（apk issue #246）：Android 应用域恒拒 hardlink ⇒ `write` 工具建不了新文件。`EACCES`/`EPERM`/`ENOTSUP` 时改用 **O_EXCL 占位 + rename** 等价实现 no-replace（**不能裸用 rename**——那会静默覆盖并发创建者的文件，丢掉 `link` 的独占语义）：输家仍得 `EEXIST` 与同一 `cannot overwrite existing` 拒绝文案；`rename` 失败回收占位，防 0 字节残留让之后每次创建都输掉占位竞争。运行时 asset `fs-local-index.js` 与之**同源**。行为回归 `node scripts/patches/tests/fs-local-link-f8.test.mjs`（fixture = 0.1.5-rc.1 产物） |
| `spj-migration-link-F5` | `dsh-session-persistence-jsonl/lib/index.js` | 会话迁移发布（publishCurrentExclusive，v0→v3 必经）与 materialize 两处 link(2) 在 Android SELinux 拒 hardlink（EACCES/EPERM/ENOTSUP）时改用模块顶层 rename（apk #154）；运行时 asset `session-persistence-jsonl-index.js` 与之**同源**。行为回归 `node scripts/patches/tests/spj-migration-link-f5.test.mjs`（fixture = 0.1.5-rc.1 产物） |
| `publish-exclusive-F7` | `dsh-session-persistence-jsonl/lib/index.js` | 发布独占语义找回：F5 的 rename 回退会**静默替换**已存在目标 → O_EXCL 原子占位抽成模块级小函数，F5 两站共用（publish 站输家 return false；materialize 站输家抛 EEXIST），rename 失败一律 unlink 回收占位（防 0 字节残留让之后每次发布都输掉竞争）。依赖 F5，行为回归 `node scripts/patches/tests/publish-exclusive-reclaim.test.mjs`（apk #170 / FX-207.1+207.2） |
| ~~`boot-pending-G1`~~（0.14.2 撤销，不在册） | `dsh-app-boot/lib/index.js` | 非官方包 pending 降级为告警并继续启动（第三方插件 inject 了 client-only 服务 → 永久 pending → 整树 boot 失败）；FAILED 与官方包 pending 仍致命（0.13.5 W1b / apk #126 P3）。**0.14.2 追 0.1.7-rc.1 时撤销**：`requiredStartupEntryIds` 与本方行面无交集（要修的场景不存在），且 `const failures = [];` 锚点会误匹配 `auditStartupEntries` 的同名声明——维持「严禁重锚」；boot 期容错唯一真源改为 `boot-third-party-isolation-G3` |
| `pi-toolcall-G2` | `@earendil-works/pi-ai/dist/api/openai-completions.js` | 流式 tool_call 空名止血：出口丢弃空名调用（连其 tool result）+ arguments 保证非空；累加器把缺 index/id 的续块合并进唯一在途调用（0.13.5 W2 / apk #124） |
| ~~`perf-patch-reload-N1`~~（0.14.2 撤销，不在册） | `dsh-app-boot/lib/index.js` | 性能 A1：web 模板 `patchReload` 默认 live→startup（Android 无 live reload 收益，坑 19），并把 installation-owned 当前元组下**已显式写入**的旧默认 live 归一化（上游只在键缺失时写回模板默认，存量升级永不归一化）。**0.14.2 追 0.1.7-rc.1 时撤销**：rc.1 全仓 `patchReload` 零命中（源码 + 产物），reload 链改为常驻但空转的 `dsh-client-hmr`——机制整条消失，补丁无面可打；写半边 `scripts/lib/profile-seed.mjs` 同步由「seed 死键」改为「剥死键 + 断言 bundles 非空」 |
| `arkweb-resource-protocol-H1` | `dsh-client-resources/lib/client.js` | ArkWeb（HarmonyOS）令 `dsh-resource://<type>/...` 丢 hostname → 上游 `protocolOf()` 取不到 file provider、文件预览报资源服务不可用（apk #221）；补丁按地址文法局部恢复 type，标准 URL 与其他 scheme 行为不变。回归 `node scripts/patches/tests/arkweb-resource-protocol.test.mjs`；**仍需真实 ArkWeb + Chromium 设备验收** |
| `external-draft-conversation-seam-J1` | `dsh-client-ui-conversation/lib/client.js` | 外部文件草稿：向 ConversationController 补受控 `addFiles(sessionId, files)` seam，复用既有 `createDrafts` / InputHub `shell.addAttachments` / refusal release——不创建第二条上传路径、不自动发送、路径不进页面/模型。回归 `node scripts/patches/tests/external-draft-conversation-seam.test.mjs` |
| `perf-compile-cache-flush-N2` | `dsh/lib/bin.js` | 启动性能：Node 只在正常退出写 `NODE_COMPILE_CACHE`，而壳侧停引擎是有界宽限的 SIGTERM→SIGKILL、系统可整进程回收 → 换树后的新条目永远写不进去（设备实测 09-12 23:07 后零新增）。入口周期 flush（40s 首刷 + 5min）+ `exit` 兜底；不注册信号处理，不改任何命令退出语义。回归 `node scripts/patches/tests/compile-cache-flush-n2.test.mjs` |
| `narb-android-N1` | `node-addon-require-builtin/lib/index.js` | Android 无预编译 `node-addon-require-builtin` 绑定（npm 无 `-android-x64` 产物，上游 support-matrix 明写 has no published platform package）：0.1.7-rc.1 的 `dsh-app-boot` 新增该依赖（0.1.5 夹具零命中），real 设备 `boot-fail.log` 连记 4 轮 `host preparation failed / No usable native binding found for node-addon-require-builtin-android-x64` ⇒ 引擎 boot 期硬崩。修法：`createEntryApi` 顶层调用包 try/catch（失败即 `api = undefined` + 一次性告警），三个导出函数在 `api` 缺席时回落 `require(moduleId)`——壳侧本就以 `--expose-internals` 起 node（EngineManager.kt:1036 argv 第二项），该 flag 恰好暴露 rc.1 `internalModules()` 需要的五个 `internal/modules/*`，与内置模块同一实现，不是「假装成功」。行为回归 `node scripts/patches/tests/narb-native-fallback-n1.test.mjs`（11 项，含 `--expose-internals` 子进程真跑回落） |
| `combo-probe-P1` | `dsh-client-modules/lib/index.js` | 把 compose 探针送进产品内，并在既有 Loader settle barrier 批量发布启动 graph：构造器仍产生同 shape/rev 的空 graph，启动期 Fiber dirty 合并，在 connection ready continuation 前 compose 完整图；构造时已有 rows 最多先同步一次、settle 再一次（≤2），settle 后运行期 add/remove 与 HMR 保持即时语义。只主线程安装（worker 的 calls=0 TOTAL 不得冒充真读数）；每次 compose 返回时立即输出累计 TOTAL，从同一 C4 monitor 读取当次 p99/样本数，保持壳 tail 与 last-row 解析时序。phase 独立使用四阶段 allowlist Map 聚合、固定 250ms unref timer 收口，后续事件不重置 deadline；字段区分 wall-clock 耗时、observations 与 forwardedCallbacks。phase 不改变 TOTAL/C4 采样窗口；不新增快照成员。回归 `scripts/patches/tests/combo-probe-p1.test.mjs` 覆盖空图、分批 activation、ready 顺序、compose/TOTAL 即时对应、phase 边界与固定 deadline、运行期/HMR。壳 `LogCollector` 另缓存 LISTEN 前读数并在 markListen 关联，用于避免 C6 -1。完整二进制设备预算仍须真实复跑。`provenance` 见 `scripts/patches/registry.json` 的 `combo-probe-P1` |
| `client-registry-scan-C4` | `dsh-client-modules/lib/index.js` | flush 内按名称索引 Loader rows，错误回调后失效；复用 nearestPackage 本次已解析 manifest。保留构造同步聚合失败、settle/Web ready 顺序、运行期 add/remove 与 HMR；回归 `client-registry-scan-c4.test.mjs`、联合 `combo-probe-p1.test.mjs`。 |
| `typert-registry-scan-C4` | `dsh-typert-loader/lib/index.js` | 同步 flush 单次索引已挂接名称，错误回调后失效；异步 manifest 完成后继续使用 live Loader 判定，防消失的条目误注册。显式包、激活失败及运行期撤销保留；回归 `typert-registry-scan-c4.test.mjs`。 |
| `boot-third-party-isolation-G3` | `dsh-app-boot/lib/index.js` | 第三方插件 boot 期失败隔离：`boot()` 经隔离式挂载器挂 root include，失败条目若属**用户自装**（非 `@deepseek-ai/*` / `@dsh-android/*` / 出货具名插件）则加 `disabled:true` 后重试并点名列出被跳过的插件；官方/出厂插件失败、不可识别失败、或超过上限 8 个仍响亮失败。真因：用户自装插件 import 期抛错在 `mountRootInclude` 就抛出，`boot-pending-G1` 的锚点 `assertEntriesActivated` 结构上不可达。真源见 `scripts/patches/registry.json` 的 `boot-third-party-isolation-G3`；回归 `node scripts/patches/tests/boot-third-party-isolation-g3.test.mjs` |
| `file-upload-restart-R1` | `dsh-client-file-upload/lib/index.js` | Agent resolver 单槽注册改为**同槽覆盖**（2026-09-28 模拟器 5556 实锤）：cordis `Fiber._reload` 的顺序是「先执行新实例 body、再 `_unload()` 释放旧 effect」，故 session-controller 因 `agent-default-model` 条目被改写而重启时，新 `SessionController` 构造里的 `ctx.effect(() => ctx.fileUploads.registerAgentResolver(...))` 撞上上游的 already-registered 守卫 → 新 fiber 判 FAILED、服务永久缺席（切一次默认模型即触发，客户端恒报 `session/control: active Service "sessionController" is unavailable`）。修法只去掉守卫、保留身份判据的 disposer（旧 fiber 的 disposer 不会清掉新注册）；仍只有一个槽。真源见 `scripts/patches/registry.json` 的 `file-upload-restart-R1` |
| `mimo-thinking-toggle-056` | `dsh-llm-pi-ai/lib/index.js` + `@earendil-works/pi-ai/dist/api/openai-completions.js` | Issue #56：开放显式 `thinkingFormat=mimo`；仅精确官方 MiMo profile 或用户显式 compat 生成 off/low 二态映射，选择器显示“关闭思考/开启思考”，默认开启。Completions serializer 将状态编码为 `thinking.type=disabled|enabled`，不发送 `reasoning_effort`；保留 assistant 多轮 `reasoning_content`。固定 DSH 0.2.0-rc.2 / pi-ai 0.87.1 锚点；行为回归 `scripts/patches/tests/mimo-thinking-toggle-056.test.mjs`。 |


### 7.1a 0.14.3 新增/变更补丁与构建钩子（源码在场，未执行）

| 补丁/文件 | 真实目标与职责 | 登记 / 回归状态 |
|---|---|---|
| [ptc-android-native-A1](<dsh-mobile-apk/scripts/patches/ptc-android-native-A1.mjs>) | dsh-ptc-runtime-node@0.2.0-rc.2的host lib/index.js及child lib/process.js；Android trusted linker64→TERMUX__PREFIX/bin/node前缀，heap仅本次NODE_OPTIONS，host/child精确native allowlist，model JS env仍null-prototype空对象 | registry/apply-patches已接A1并requires L1；exact双文件verifier及additionalTargets/targetMarkers在场。source-copy fixture与 [A1测试](<dsh-mobile-apk/scripts/patches/tests/ptc-android-native-A1.test.mjs>) 已写、未运行。 |
| [pi-upstream-streaming-020](<dsh-mobile-apk/scripts/patches/pi-upstream-streaming-020.mjs>) | raw pi-ai@0.87.1覆盖会丢官方pnpm patch；精确恢复anthropic-messages、bedrock-converse-stream、mistral-conversations、openai-completions、openai-responses-shared、pi-messages六个dist/api JS | [官方patch副本](<dsh-mobile-apk/scripts/patches/upstream/pi-ai-0.87.1.patch>)固定SHA b9bcce474fb2ac44633dff0fa722816a5bff5451b4575d5874035ea14ba70a4f，完整六文件plan先验证后缓存写，严格上下文、幂等、无fuzzy。G2 requires streaming020。 |
| ptc-argv-L1 | host heap参数移出argv，经本次NODE_OPTIONS；A1重整launch前缀，不能只保留L1并假称Android已可启动 | registry仍在场，A1 requires L1；旧fixture通过不能证明target0.2双文件通过。 |
| terminal-inspector-android-D1 | dsh-subprocess-local的runner-launch-B2zsQ1Dz（按targetDiscovery发现版本bundle）；createProcessInspector把android归入既有Linux分支，其它平台throw不放宽 | registry在场；版本重锚/最终bundle核实由父构建完成，不推断0.2已验收。 |
| atomic-stale-lock-F4 | dsh-atomic-write | registry自0.1.7-rc.2已移入retired：上游原生takeOverExitedLock吸收孤儿锁语义；0.14.3仍不施加，历史§7.1行不是当前登记。 |

A1只适配native启动，不提供process confinement provider，不改policy/approval/sandbox默认。有效danger-full-access沿既有授权直跑；read-only/workspace-write缺provider仍sandbox-unavailable，不能自动downgrade/root或把自动审批当full-access。

统一runner已读取多文件实现，source-build reconcile-engine-patch-copies展开所有additionalTargets、对逻辑目标运行exact verifier后复制到同包pnpm物理副本，最终source snapshot检查复用同一口径。普通build-snapshot-013的post-apply已改为再次调用统一runner --check --scope engine，成功日志明确包含全部companion与exact upstream verifier；不会把streaming020说明marker当源码literal。apply前capture-only留目标原始fixture字节用于外部回归，不执行测试。本source/doc任务未运行任何构建/检查。

三条runtime asset当前仍为历史目标的完整文件；0.14.3尺寸/hash/同源结论留空待实际重出与终包对账，不虚构测量。所有新增补丁文件、官方patch与0.2 fixture均登记于 [执行地图覆盖账本](<dsh-mobile-apk/docs/AGENTS/EXECUTION-MAP.md>)。

镜像纪律（0.13.8 PR-A1 起）：本仓 `scripts/patches/**` 是协调仓权威源的**逐字节镜像**（云端
自包含构建检出本仓），`scripts/check-patch-mirror.mjs` 在两仓 CI 与构建链强制比对——
改补丁必须双树同批，单边演进即拒打包/拒合并（apk #171 的教训）。

F3/F4 只影响引擎内部（无 WebView/壳侧定制面），快照固化即可，无需运行时 asset 每次启动重写；F2 的
运行时侧由既有 attachment asset 承担——**两处必须同源**。

### 7.2 0.13.8-b：F7 资产重出 + A1 出厂 profile seed（2026-09-12）

**F7 资产重出（已完成 2026-09-12）**：F7 进了构建期快照，但
`session-persistence-jsonl-index.js` 是**每次启动整文件覆盖**的运行时 asset → 不重出就等于没修。
**当前状态：已重出，138,025 B，sha256 `BDAEF25C049368BB2415D8DADD14A2A2BE8ADB0DECDE0BE59961149415B7CA33`；**
`node scripts/check-runtime-assets.mjs x86_64 --require` = 核对组合 3 / SKIP=0；asset 内
`dshMobileClaimExclusive` 3 处（1 定义 + 2 站调用）、`dshMobileReleaseClaim` 2 处、materialize marker 1 处，`node --check` 通过。
重出前的只读重演记录（留档，防再犯）：

- 重出前 asset 字节 = **136,136**（更早的 §2 表内记 138,991 亦失真）；施加 F7 后 = **138,025**；
- **两路同源已核**：把「当前 asset」与「快照 tar 里抽出的同名文件」分别只施加 F7，输出**字节一致**
  （sha256 `BDAEF25C049368BB2415D8DADD14A2A2BE8ADB0DECDE0BE59961149415B7CA33`）。

重出步骤（临时根，勿直接改产品代码）：

```powershell
$root = '.deploy-tmp\asset-regen'
$dst = Join-Path $root 'usr\lib\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item 'dsh-mobile-apk\app\src\main\assets\patched\session-persistence-jsonl-index.js' (Join-Path $dst 'index.js') -Force
node scripts\patches\apply-patches.mjs $root --apply --scope engine --only publish-exclusive-F7
Copy-Item (Join-Path $dst 'index.js') 'dsh-mobile-apk\app\src\main\assets\patched\session-persistence-jsonl-index.js' -Force
```

重出后核对：`node scripts/check-runtime-assets.mjs x86_64 --require`（组合数 3、SKIP=0）与
`Select-String -Path <asset> -Pattern 'dshMobileClaimExclusive' | Measure-Object`（= 3：1 定义 + 2 站调用）。
**门禁盲区（已登记）**：`check-runtime-assets.mjs` 只比 registry marker，而 F7 的 marker 未随本次收紧 →
陈旧 asset 仍会 PASS；建议随重出把 F7 的 registry marker 收紧为 `dsh-mobile exclusive materialize (F7)`。

### 7.3 0.14.0 review C1：资产「逐字节同源」判据与重出手册修订（2026-09-15）

**背景**：v0.14.0-preview 发布包的 `session-persistence-jsonl-index.js`（138,025 B，`BDAEF25C…`）是
F7 v1 双占位形态（内联 `open("wx")` 占位后又调 helper 占位 → 同一路径恒 EEXIST → `publishCurrentExclusive`
恒 false）。旧判据只比 marker，两个 marker 在场 → 门禁全绿；`publish-exclusive-reclaim.test.mjs` 又只对
合成 fixture 施加补丁，测不到已分叉的资产本体。

**修订后的口径（三件套）**：

1. **判据 = 资产 ↔ 快照同路径文件逐字节一致**（`check-runtime-assets.mjs`）：sha256 双方打印、不同即红；
   并对资产本体跑行为回归（`publish-exclusive-reclaim.test.mjs --asset <asset>`）。
2. **重出手册（取代 §7.2 的「旧资产上叠补丁」路径）**：
   ```powershell
   # 从当次构建的快照 tar 直接抽出（不经过任何中间资产；两层同源由字节比对守）
   node .deploy-tmp/regen-assets.mjs   # 临时脚本：tar -xJOf <member> > assets/patched/<asset>
   node scripts/check-runtime-assets.mjs x86_64 --require
   ```
   行尾：`.gitattributes` 已给 `app/src/main/assets/patched/*.js` 加 `-text`（autocrlf 不再把 LF 检出成
   CRLF，否则逐字节门禁在别的机器必假红且引擎每次启动都触发整文件覆盖）。
3. **补丁侧收敛**：`publish-exclusive-F7` 的 `check` 显式排除 v1 形态（`const claim = await open(currentPath, "wx")`），
   `apply` 先整体切除旧内联块（含多余缩进，保证收敛输出与快照构建逐字节一致）再走 v2 注入——任何树上的
   v1 残留都会被修复而不是被判为「已应用」。

**构建期同步扩充**：`attach-durable-F2` 由「祖先 fsync 守卫」扩为三件套（+ 两处 link(2)→rename 回退 +
unlink ENOENT 容忍），与 attachment 资产逐字节同源——此前这三处 delta 只在运行时资产里，快照缺，逐字节
判据上线后会直接判红。

**A1 出厂 profile seed（性能 §7.2 A1）**：出厂 `home/.dsh/profiles/{web,headless}/package.json` 由
构建链 `scripts/lib/profile-seed.mjs` 写入 `dsh.profile.patchReload = "startup"`（`build-snapshot-013.mjs`
在 settings seed 之后调用；dev 档用 `DSH_PROFILE_PATCH_RELOAD=live` 覆写）；存量升级由引擎树补丁
`perf-patch-reload-N1` 归一化。归档后 `check-perf-instrumentation.mjs --require` 复核产物内该键值
（P-AC-01：发布档 startup / dev 档 live）。

### 7.4 0.14.2 追上游 0.1.7-rc.1：三条运行时资产按 rc.1 快照重建 + 构建期补丁重锚（2026-09-24/25）

**引擎换代 = 三条运行时资产全部重出，这是硬动作不是可选项。** 资产是「每次启动整文件覆盖」的运行时补丁，
与构建期同源补丁必须逐字节一致（§3-2、§7.3 三件套）；引擎从 0.1.5-rc.1 换到 0.1.7-rc.1 后旧资产与
新风树不同源，沿用等于把上一代修复盖上新一代文件。

| asset | 重建前字节 | 重建后字节（2026-09-25 ls 实测） | 依据 |
|---|---|---|---|
| `attachment-local-index.js` | 47,321 | **47,937** | 从 0.1.7-rc.1 快照 tar 直接抽出 |
| `session-persistence-jsonl-index.js` | 137,514 | **145,247** | 同上 |
| `fs-local-index.js` | 41,407 | **43,405** → **47,793**（0.14.2 追加 B，见 §7.5） | 同上 |

重建提交 `fix(assets): 运行时补丁资产按 rc.1 快照重建（三条全部不同源，引擎换代后必做）`（apk 侧 22815f8）。
门禁 `node scripts/check-runtime-assets.mjs x86_64 --require` 按 §7.3 的「资产 ↔ 快照同路径文件逐字节一致」
口径核验，不是只比 marker。

**构建期补丁面（`scope: engine`，0.14.2 现数 15 条，见 §7.1）**：

- **新增 `narb-android-N1`**：见 §7.1 行。npm 上 `node-addon-require-builtin` 只发 darwin/linux/win32，
  无 android 产物 ⇒ 回落 `require(moduleId)`；壳侧本就以 `--expose-internals` 起 node
  （`EngineManager.kt:1036` argv 第二项），该 flag 恰好暴露 rc.1 `internalModules()` 需要的五个
  `internal/modules/*`。设备实测证据是 `boot-fail.log` 连记 4 轮
  `No usable native binding found for node-addon-require-builtin-android-x64`（引擎 boot 期硬崩，
  不是「静默禁用插件」）。fixture 与回归见 §7.1 行。
- **重锚 2 条**：`boot-third-party-isolation-G3`（`mountRootInclude(..., binName)` 第 5 参漂移，`binName` 一路透传）、
  `perf-compile-cache-flush-N2`（根包不再 `import { readFileSync } from "node:fs"`，锚改末条顶层 import）。
  唯一可信锚点判据 = `node scripts/probe-engine-anchors.mjs`（按 overlay 的 (包名, 版本) 回读构建期同一批
  未打补丁 tgz）；**不要用 stage 目录**（本轮实测它停在 0.1.2-rc.1），**也不要用测试夹具**（0.1.5 时代写死在
  目录名里，真树断 9 条而 16 个补丁测试全绿）。
- **撤销 6 条**（各带「收益是否还在」的证据，不是「锚点找不到就删」）：`perf-patch-reload-N1`（rc.1 全仓
  `patchReload` 零命中，机制整条消失）、`boot-pending-G1`（场景不存在 + 锚点会误匹配同名声明，严禁重锚）、
  `combo-single-lazy-A5`（上游已原生满足且取舍更温和）、`combo-cache-A3`（同机同批 rc.1 字节实测：上游
  boot 路径 44 ms vs A3 查表 129 ms，**净亏**）、`combo-parallel-C3`（分片对象随 A3 一起消失）、
  `combo-lazy-A4`（2026-09-25 退役，理由见下条）。
  连带清掉写半边：`scripts/lib/combo-precompute.mjs`、`inject-all.py --combo-cache-delta`、
  两条构建链的 precompute 调用；`scripts/check-combo-cache.mjs` 反向改造成「死缓存回流门禁」。
- **`combo-lazy-A4` 退役（2026-09-25，用户指令「该退役的退役」）**：上游 0.1.7 已原生惰性化 combo
  载荷（`dsh/packages/client/modules/README.md`「creates combo descriptors without building response
  bodies」；`src/index.ts:384 lazyBody`）。同一 0.1.7-rc.1 基线离线 A/B 实测：**裸树启动期只有 2 次**
  compose（空表 2.27ms + 真记录 3.97ms），A4 臂 1 次 5.79ms——总量同量级（A4 宣称的「9-14 次 × 1.8-3.1s
  收敛为 1 次」在当前上游架构下结构性无对象），而 A4 把那次 compose 从构造期挪到**首个图读者**
  （= 首个页面请求路径，TTFB 侧，实测 HTTP−LISTEN 竖屏 557ms / 横屏 1472ms）⇒ 位置为负。成本是
  1 个 engine 补丁 + 7 个脆弱锚点 + P1 的 `requires` 依赖。证据：`.deploy-tmp/retire-sweep/REPORT.md`
  §3.1.2/§3.1.3。落地：registry 31 → **30 条**，`apply-patches.mjs` IMPLS 移除其实现（`ensureComposed` /
  `composeDirty` 全符号），`combo-probe-P1` 的 `requires` 随之清空（P1 自身保留——它仍被 check-boot-budget
  的 C2/C4/C6 消费）。回归 `scripts/patches/tests/combo-lazy-a4.test.mjs` 就地改写成「撤销不变量守卫」。
  **连带修 `scripts/check-boot-budget.mjs` 的两条 C5 门禁缺陷**：① `[perf] boot singles=` 解析正则缺 `-1`
  分支（P1 在计数缺席时故意写 `singles=-1`）⇒ 对设备真值恒不可判定；② 正向对照原先只认已撤销的 A5
  计数器 `globalThis.__dshMobileComboLazyStats`，A5 退役后它无任何生产者 ⇒「恒 0」永不构成证据。现改为
  直驱产品内单条服务路径（断言 200 + 载荷含 id + 两次 `body()` 同一 promise），C5 判据改三态
  （0 / >0 / 缺席），既不恒绿也不恒红。C3「compose ≤ 2」阈值**不放宽**（裸树正是 2 次，仍可满足）。

**0.14.5 启动重组降载（在 P1 内实现，不恢复 A4）**：首批真机 0.14.4 的 C3 实读为同一 registry 八次真实 `flush.changed → compose`，不是探针重复或多实例。源码 `dsh/` 只读；新增 P1 patch 在已有 `loader.await()` settle 屏障收敛启动期 dirty Fiber，保持构造时空 graph 的 rev/hash，完整 graph 在 web connection ready continuation 前发布。若已有条目先 active，保留原同步首 flush，之后启动 dirty 一次性合并（最多两次）；settle 后 HMR/add/remove 仍立即生效。行为 fixture 覆盖空图、三批延迟 activation、未丢 Fiber、ready 顺序、次数和运行期即时更新。每条 TOTAL 在 compose 返回时立即采同一 event-loop histogram 并同步输出，保持 C4/LogCollector last-row 语义；启动 phase 诊断以固定阶段 Map 聚合，最多四行，首事件后的 250ms 固定窗口收口，不会延迟 TOTAL 或改变 histogram。当前集成 0.14.5 APK 的 C3=2 通过；五次冷启动 C4 均为 157.7–217.1ms/17–25 samples，超过 100ms 预算；C2、C5/C5+（显式指定设备 probe 文件）、C6 通过。新增 phase 行记录构造 flush、loader settle wall time、延迟启动 flush 与首次 settle 后 compose start；离线 fixture 已通过，修正后的诊断 patch 尚待重建进 APK 与设备测量，目前不能断言 C4 根因已定位或修复。

**引擎 overlay 追版**（`scripts/snapshot-config/engine-overlay.json`，2026-09-25 现数）：
`vendorTop` 17 → **36** 条（+19：`execa` 及其依赖闭包、`@sec-ant/readable-stream`、
`@sindresorhus/merge-streams`、`get-stream`、`human-signals`、`is-plain-obj`、`is-stream`、
`is-unicode-supported`、`npm-run-path`、`parse-ms`、`pretty-ms`、`signal-exit`、
`strip-final-newline`、`unicorn-magic`、`which-command`、`yoctocolors` 等）；
`@deepseek-ai/cosmokit` **1.8.3 → 1.8.5**；补登记 `@xterm/headless` **6.0.0** 与
`@xterm/addon-serialize` **0.14.0**（嵌套段 `nested` 仍 5 条，`packages` 313 条）；
许可清单 `engine-overlay-licenses.json` 41 → **59** 条（新增项全部非 copyleft：MIT/Apache-2.0）。

**profile 显式禁用上游 `office-to-pdf` 行**（`scripts/profile-web.cordis.patch.yml:167`，
`- id: office-to-pdf` + `disabled: true`）：rc.1 的 web-app bundle 新增该行（0.1.5 零命中），它运行时依赖
`@deepseek-ai/libreoffice-kit`，而该依赖在本平台**无条件不可用**——`platformTarget()` 只认
darwin/win32/linux-glibc，Android 下 `process.platform` 为 android ⇒ `resolveEngine()` 落到
`if (platform !== linux) throw new Error(Unsupported LibreOfficeKit host: android-x64)`；152 MB 的
`-wasm` 引擎同样被该 platform 判据挡掉，补依赖买不到任何能力。不禁该行的后果不是缺能力而是
**boot 阶段崩**（`Cannot find package` 指向 `@deepseek-ai/libreoffice-kit`，设备实测）。上游对「没有转换器」的
既定降级路径就是 UI 的 unavailable 指引 ⇒ 禁行 = 用上游自己的降级面。凭据成对：
`scripts/check-engine-overlay.mjs:117` 的 `RUNTIME_MISSING_OK` 登记了同一条
（`@deepseek-ai/libreoffice-kit`，:128），两处必须同进同出；逆转条件 = 出现 Android 上真能跑的引擎实现。

**版本号**：`app/build.gradle.kts:35` `versionCode` 40 → **41**，:40 `versionName` 0.14.1 → **0.14.2**。

### 7.5 0.14.2：资产必须覆盖同源补丁全部 marker（快照无关判据，2026-09-26）

**现象**：B（`fs-local-digest-guard-B`）加入后，`assets/patched/fs-local-index.js` 仍是只有 F8 的 43,405 B，
而当时快照也是同一份旧产物 ⇒ `check-runtime-assets` 的**逐字节判据判绿**（资产与快照确实同源）。
但引擎每次启动都用该资产整份覆盖运行树 ⇒ **B 在真机等于没修**（覆盖回只有 F8 的字节）。

**为什么旧判据抓不到**：逐字节比对只证「两条路一致」，不证「两条路都含新补丁」。
快照是补丁加入**之前**构建的时候，资产与它一致反而是**共同缺失**，门禁无从分辨。

**新增判据（快照无关）**：对每个资产，取 registry 里 target 指向同一文件、`scope: engine` 且带 `marker` 的**全部**条目，
断言资产正文含每一条的 marker。缺任一条即判红并点名 `asset + 补丁 id + marker 原文`。
这条不依赖快照在场，所以「加了补丁但忘了同步资产」在**构建前**就会被抓住。

**配套**：字节不同源时的诊断改为**方向感知**——
- 快照缺 marker 而资产齐 ⇒ 报「快照陈旧」，并**禁止** `--write` 回写（回写会把补丁从资产里抹掉，比不修更坏），正确修法是重建快照；
- 资产缺 marker ⇒ `--write` 从快照回写资产仍是对的。

**重建方式（禁止手改）**：取出厂态 fixture（`scripts/patches/tests/fixtures/dsh-fs-local-0.1.7-rc.2/lib/index.js`），
按 registry 顺序施加该文件全部 engine 补丁：

```sh
node scripts/patches/apply-patches.mjs <stage> --apply --scope engine --only fs-local-link-F8,fs-local-digest-guard-B
# applied 2/2 → 产物 47,793 B → 覆盖 assets/patched/fs-local-index.js
```

**管线自证**：只施加 F8（不带 B）可**逐字节复现**原 43,405 B 资产（sha256 `368e382cc71c…`），
证明产物确由该 fixture 经补丁链生成，F8+B 版即其正确超集。

### 7.6 0.14.5 C4 实耗与最小修复（2026-10-06）

受控 wrapper 的计时含诊断开销：client 构造
flush 193 次扫描、38,021 行，entry 迭代49.8ms；metadata38.6ms，其中 locate28.1ms、nearest19.6ms；
bundle55份10.8MB读取17.6ms，compose9.4ms。typert 首 flush193次 qualifies、24,181行，qualify41.5ms，
整轮118.4ms。CPU样本还定位到本方模型能力自动补给初次 descriptor 与最终 signature 的两次
全量 settings.describe，与离线目录解析堆在同一 turn。修复由上述两条 scan 补丁和插件异步
pass checkpoint 共同组成；完整自动补给行为见 `plugins/dsh-model-capability/README.md`。

实际对照使用同一同步 TOTAL/C4 monitor：仅 client scan 五轮为126.4/13、114.4/12 FAIL，
76.1/11、88.9/12、93.5/10 PASS；再加 typert scan 仍有147.2/13、110.6/13、116.6/14 FAIL。
三项一起热推后的五次独立冷启动为90.6/13、79.9/11、89.9/13、88.7/14、84.0/11，
C1–C6/C5正向对照全部PASS且SKIP=0，C3均2，WebView CDP五轮39/39；ADB实际点按菜单并以
Android Back关闭后仍在MainActivity，MiMo选择保留。未改100ms预算、samples>=10或采样窗口。
原始预算、计时与截图在协调仓 `.deploy-tmp/refactor/c4-rootcause/`。

这些结果证明该 runtime 热推组合的本轮行为与预算；当前已安装APK仍是此前phase包，不能写成
新APK完成验收。临时CPU/wrapper诊断原件需恢复并核验hash；最终发布必须重新生成快照/全链APK
并完成集成三层验收。首次constructor TOTAL的样本为0、deferred返回前尚未采到其同步阻塞，因此
不能把phase wall time直接当C4 p99；更早debounce TOTAL的统计窗口不同，也不能拿来作性能归因。

## 8. 0.13.7fx-1：web-frontend-index.html 退役（2026-09-11）

**实测（从 0.13.7 发布快照 out/v0.13.7/snapshot-x86_64.tar.xz 抽出对比）**：引擎自带的
usr/.../dsh-web-frontend/dist/index.html 与 asset 除行尾（CRLF vs LF）外逐字相同，bundle 引用
（index-DuF6ti6g.js / index-DPX2bQLO.css）也就是 npm 包 0.1.5-rc.1 发布件自带的那套。
因此运行时那一步只是把同样的内容按 CRLF 再写一遍（写一次后内容指纹才收敛），**没有任何行为增量**。

**退役的直接动因（坑 64）**：adaptIndexHashes 的 hash 字符集 `-([A-Za-z0-9]{8})\.(js|css)` 跟不上
npm 现包的写法（index-Df-65__b.js：带 `-`、9 字符）。一旦引擎 dist 不是这份 asset 对应的构建，
改写失败就原样写回旧引用 → index.html 指向不存在的 bundle（白屏）。补丁的价值此前已随 viewport-fit 消失
（Android WebView 上 env(safe-area-inset-*) 恒 0，系统栏避让已由壳侧 inset 通道承担；ES2022 polyfill
由 dsh-host-web-compat 注入，覆盖面更大）。

**改动面**：删 assets/patched/web-frontend-index.html；EngineManager.applyRuntimePatches() 去掉该行；
applyAssetPatch 去掉 hashAdaptive 形参与 adaptIndexHashes 函数；本文件 §1/§2/§3 同步。
