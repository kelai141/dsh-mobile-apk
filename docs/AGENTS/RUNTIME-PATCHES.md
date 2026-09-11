# RUNTIME-PATCHES.md — assets/patched/ 运行时补丁登记

> 职责：`app/src/main/assets/patched/` 六文件的权威登记——消费方 `EngineManager.applyRuntimePatches()`（EngineManager.kt:409-430），逐文件目标快照路径/作用/来源线索与维护约定。行号、字节数 2026-09-05 当场 grep/ls 实测。

## 1. 机制（EngineManager.kt）

- **路径速查**：快照解压根 = `filesDir`（usr/ + home/）；dshPkgs = `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`（EngineManager.kt:410）；webDist = `dshPkgs/dsh-web-frontend/dist`（:411）；资产源 = APK 内 `assets/patched/`，经 `context.assets.open(asset)` 读取（:447-452）。
- **触发时机**：每次 `startEngine` 前调用（EngineManager.kt:554）——首启解压后、以及每次快照刷新/重解压后自动重施加（幂等）。
- **覆盖式全量替换**：`applyAssetPatch`（:439-462）把 asset 字节整文件写入目标，**非 delta/非行级补丁**——asset 即目标文件的完整修改版拷贝。
- **内容指纹判定**：目标已存在且字节与 asset 完全一致（contentEquals，:454）才跳过；不用固定 marker 字符串——v1→v2 升级时旧 marker 曾导致更新后的 asset 被误跳过（:404-405、:432-434 注释实锤）。快照刷新覆盖目标后指纹失配 → 自动重施加。
- **目标包缺席即跳过**：目标父目录不存在时不落补丁（:443-446，如包被上游裁出依赖图，宁缺毋滥不留死覆盖）。
- **hashAdaptive（仅 web-frontend-index.html）**：引擎 dist/index.html 引用 content-hash 的 bundle 名（`/assets/index-<hash>.js`）；引擎升级 → hash 变化 → patched 模板指向旧 hash 会 404 白屏。`adaptIndexHashes`（:471-490）先从引擎现存 index.html 提取当前 hash，再替换 patched 模板中的旧引用（同 stem/同 ext、hash 不同才替换；提取失败原样返回——宁不注入不写坏）。2026-08-23 前端审核 CRITICAL#4 落地。
- 另有 append 式辅助 `applyAssetPatchAppend`（:493-505，marker 幂等追加，历史上用于 cordis.patch.yml 场景）——当前无调用方，仅保留备用。

## 2. 六文件逐项登记

目标根 = 快照内 `usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（dshPkgs，EngineManager.kt:410）。asset 字节数为 ls 实测。

| asset 文件（字节） | 目标快照路径（注册行） | 状态 | 作用 / 来源线索 |
|---|---|---|---|
| primitives-index.js（299,131） | dsh-client-ui-primitives/lib/index.js（:417-418） | 生效 | WebView 剪贴板兜底：navigator.clipboard 在 Android 被拒（NotAllowedError）时的 fallback 逻辑（EngineManager.kt:396） |
| attachment-local-index.js（41,295） | dsh-attachment-local/lib/index.js（:419-420） | 生效 | Android sepolicy 禁 link(2) → copyFile 回退 + EACCES 容忍（:397）；内含图片归一化 2048 降采样上限（文件内 `DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 2048`，行 786；`config.normalizedImageMaxDimension ?? 2048`，行 880）。注意：文件内未发现 `ORIGINAL` 字样标记——补丁判定走内容指纹而非内嵌标记 |
| web-frontend-index.html（679） | dsh-web-frontend/dist/index.html（:421-422，唯一 hashAdaptive=true） | **当前为内容同源空转** | 0.13.7 重出后该 asset 就是 0.1.5 dist 模板的逐字拷贝（仅 bundle hash 不同，壳侧 hashAdaptive 会跟随引擎改写），因此 applyAssetPatch 的内容指纹判定直接跳过它（无 applied 日志）。**历史职责已由别处接管**：viewport-fit=cover 在 Android WebView 上本就无效（env(safe-area-inset-*) 恒 0，见坑 49），系统栏避让改由壳侧推 `--dsh-android-system-top` + 注入层 `--dsh-mobile-top-inset` 承担；ES2022 polyfill（Object.hasOwn/Array.at/replaceAll/randomUUID 等）由 dsh-host-web-compat 的 POLYFILLS 在服务端注入，覆盖面更大。**待办**：确认无回归后退役该 asset 与对应 applyAssetPatch 注册行（本轮为控制构建轮次未动）。 |
| session-persistence-jsonl-index.js（58,909） | dsh-session-persistence-jsonl/lib/index.js（:426-427） | 生效 | link(2) 回退同族：dsh 0.1.1-rc.1 丢掉了 rc.8 的 EACCES/EPERM/ENOTSUP → rename 回退，Android 应用域 sepolicy 禁 link(2)，按 rc.8 形态全文件覆盖补回（:401-403） |
| fs-local-index.js（38,777） | dsh-fs-local/lib/index.js（:428-429） | 生效 | 同上 link(2) 回退族，作用于 dsh-fs-local 包（:401-403） |
| llm-deepseek-index.js（38,909） | 无 applyAssetPatch 调用 | 在场未启用 | 旧 rc.1 模型目录覆盖补丁的遗留资产：dsh 0.1.1-rc.2 已原生捆绑 deepseek-v4-flash-vision-exp（含修正后的图片请求序列化），原生文件不再触碰（:399-400、:423-425）；rc8 迁移批同步移除了 onImagePicked/describeImage/bundle-hardening/textzoom 补丁（:413-416，textzoom 桥方法保留但功能面取消）。升级引擎版本时先核对其是否仍属遗留，避免误启用 |

## 3. 维护约定（硬约束）

1. **全量替换非 delta**：asset 必须是目标文件的完整拷贝（在原文件基础上改后整体入库）；不允许只存 diff 片段或手写残缺文件——applyAssetPatch 直接 writeBytes 整写，半截文件 = 引擎启动即崩。
2. **更新需随上游引擎对齐**：六个 asset 对应 dsh 0.1.1-rc.2 的包版本。升级快照内引擎版本时必须：① 逐文件核对上游是否已原生包含同等修复（能删则删，llm-deepseek/rc8 为先例）；② 重出 asset 从对应版本包文件改起，不从旧 asset 迭代；③ web-frontend-index.html 的 bundle 引用有 hashAdaptive 兜底，但 polyfill/viewport 逻辑需人工复核。
3. **禁止随手重生成**：内容指纹机制意味着 asset 与目标「看起来差不多但字节不同」就会触发重写——不得用本地构建产物/不同 minify 形态随手替换 asset；改动须走完整链路验证（引擎起得来、市场/会话/附件功能实测）。
4. **新增补丁**：applyAssetPatch 注册新条目 + 本表登记；优先评估上游新版本是否已修复（能不补则不补）。

## 4. 施加结果验证方法

- **日志锚点**（LogCollector/logcat，EngineManager.kt 内 Log.i/Log.w/Log.e）：
  - `runtime patch applied/updated: <asset> -> <target>`（:458）= 本次实际写入；
  - `runtime patch skipped (target package absent): <asset>`（:444）= 目标包被上游裁掉，按 §3-4 评估；
  - `runtime patch asset missing: <asset>`（:450）= asset 缺失（打包遗漏，需查 APK assets）；
  - `index hash adaptation failed; keeping bundled patch`（:487）= hashAdaptive 提取失败，按「宁不注入不写坏」回退，需人工核对引擎 index 引用。
- **产物抽验**：从 APK 内 assets/patched/ 取出与快照解压树目标文件做字节比对（contentEquals 同一判定）；发布链可用 `tar -xO` 抽验快照内目标文件（AGENTS.md 惯例）。
- **行为抽验**：剪贴板复制（primitives）、附件上传图片（attachment 2048 上限）、WebView 沉浸式与老内核插件列表（web-frontend）、会话持久化/文件工具（fs-local、session-persistence-jsonl）。

## 5. 机制演进史（改动前先读，防止重蹈）

| 事件 | 教训 / 产物 |
|---|---|
| v1→v2 asset 更新被跳过 | 固定 marker 字符串在目标文件更新后仍命中 → 新 asset 永不落盘；改为内容指纹判定（:404-405、:432-434） |
| 2026-08-23 前端审核 CRITICAL#4 | 引擎升级换 bundle hash → patched 模板旧引用 404 白屏；加 hashAdaptive（:435-438、:471-490） |
| 2026-09-11 旧会话迁移 EACCES（issue #154） | asset 只覆盖 `materialize` 的 `link(tmp, finalPath)`，漏了 `publishCurrentExclusive` 的 `link(staged, currentPath)`；0.13.7 格式升 v3 后旧会话首次打开必经迁移发布 → 全部旧会话 EACCES 打不开。教训：**link(2) 回退要按调用点逐一清点**，不能只补历史锚点 |
| v0.12.4（rc8）迁移批 | onImagePicked/describeImage/bundle-hardening/textzoom 四补丁删除（上游 rc.8 原生覆盖 + textzoom 功能取消）；textzoom 桥方法保留（:413-416） |
| rc.1 → rc.2 链路 | rc.1 丢 rename 回退 → fs-local/session-persistence-jsonl 两补丁补回；rc.2 原生捆绑 vision-exp → llm-deepseek 补丁退役为遗留资产（:399-425） |
| 目标包缺席语义 | 上游裁包（如某版本依赖图变动）时跳过而非报错/硬写，避免死覆盖（:440-446） |

## 6. 与协调仓 scripts/patches/ 的分工边界

**协调仓 `scripts/patches/`（apply-patches.mjs + registry.json + data/compat-map.json）是快照注入链的构建期补丁框架**，按 `scope` 分两路：
- `scope: vendor` 打 vendor 固化插件（dshmarketplace-plugin A-D、dsh-undo-savepoint E1-E7），在 `build-apk-013.ps1` 阶段施加；
- `scope: engine` 打引擎树内上游包（attach-durable-F2 附件祖先 fsync 守卫、flock-android-F3 node-addon-system 无 Android 预编译的 stub、atomic-stale-lock-F4 孤儿写锁回收、boot-pending-G1、pi-toolcall-G2），在 `build-snapshot-013.mjs` 0f 步施加并逐个复查 marker。

**与本节 assets/patched/ 的分界**：同一份引擎文件的修复若能在构建期落地（随发行快照固化），优先走 `scope: engine`；运行时 asset 只承担「必须每次启动前覆盖」或「与引擎版本无关的壳侧定制」（见 §3-2）。已退役：pi-drift-F1（上游 0.1.5 原生 strict/deferred 校验）。**assets/patched/ 是设备端运行时补丁**——壳在每次引擎启动前对快照内上游引擎包做覆盖。两者层不同、目标不同、幂等机制不同（构建期 = registry 幂等标记；运行时 = 内容指纹），勿混用；构建期补丁登记见协调仓 scripts/patches/README.md 与 registry.json。

## 7. 0.13.7 重出（引擎 0.1.5-rc.1，2026-09-10）

约定不变（§3-2）：**从对应版本包文件改起，不从旧 asset 迭代**。生成器：协调仓
`.tmp-upgrade/rebuild-runtime-patches-015.mjs`（锚点缺失即抛错，绝不写半成品）。

| asset | 目标 | 本次 delta（相对 0.1.5-rc.1 原文件） |
|---|---|---|
| `attachment-local-index.js` | `dsh-attachment-local/lib/index.js` | F2 祖先 fsync 守卫（`ensureDurableDirectory` 里的 `syncDirectory(parent)`；与 `scripts/patches/` 构建期补丁同源）+ **两处** link(2)→rename 回退（`publishImmutableAlias` 的 `source`、`publishStagedObject` 的 `staged.path`——0.1.5 变量名已变，旧锚点 `temporary/target` 失效）+ `publishStagedObject` 主链 `unlink(staged.path)` 容忍 ENOENT |
| `session-persistence-jsonl-index.js` | `dsh-session-persistence-jsonl/lib/index.js` | import 行加 `rename` + **两处** EACCES/EPERM/ENOTSUP → rename 回退：① `link(tmp, finalPath)`（`materialize` 路径，0.1.5 锚点仍在）；② **`link(staged, currentPath)`（`publishCurrentExclusive`，迁移/新代的原子发布）**——②此前漏打：0.13.7 起旧会话 `v0→v3` 迁移必经此路径 → 升级后**全部旧会话打不开**（EACCES，issue #154）；本次补齐 |
| `web-frontend-index.html` | `dist/index.html`（hashAdaptive） | 与 0.1.5 dist 模板同源；资产里的 hash 由壳侧 `adaptIndexHashes` 跟随引擎改写，无需人工维护 |
| ~~`llm-deepseek-index.js`~~ | — | **删除**：无 `applyAssetPatch` 调用点（rc.2 原生含 vision 后已成死资产，39KB） |

校验：三份资产均 `node --check`（ESM）通过；标记串 grep `dsh-mobile link->rename fallback`、
`dsh-mobile durable-walk guard`、`already consumed the staged file`。

**构建期**引擎补丁的锚点与行为回归：`build-snapshot-013.mjs` 0f 步施加后逐个复查 registry marker
（缺席即拒打包），F4 另有常驻行为测试 `node scripts/patches/tests/atomic-stale-lock.test.mjs`
（fixture = 0.1.5-rc.1 产物；`.deploy-tmp/` 下的临时预检脚本不入库，勿再引用）。

### 7.1 同时落在构建期的引擎树补丁（scope=engine，不走 assets/patched/）

| 补丁 | 目标包 | 本次动作 |
|---|---|---|
| `attach-durable-F2` | `dsh-attachment-local/lib/index.js` | 与运行时 asset **同源**：附件祖先 fsync 对 Android 应用私有祖先（`/data/user/0`）EACCES 即止步。构建期补丁服务发布快照，运行时 asset 服务「快照刷新后重施加」——两者内容一致才不会互相回退 |
| `flock-android-F3` | `node-addon-system/lib/flock.js` | 0.1.5 新增的会话写锁只有 darwin/linux 预编译 → Android 上 `ERR_FLOCK_UNSUPPORTED_PLATFORM` 让整树 boot 失败；按上游 browser-worker 先例 stub 为立即成功（单进程宿主）+ 一次性告警 |
| `atomic-stale-lock-F4` | `dsh-atomic-write/lib/index.js` | 孤儿 `<file>.lock` 回收（pid 已消失 + 二次核验一致才删，每次获取最多一次）；行为回归 `node scripts/patches/tests/atomic-stale-lock.test.mjs` |

F3/F4 只影响引擎内部（无 WebView/壳侧定制面），快照固化即可，无需运行时 asset 每次启动重写；F2 的
运行时侧由既有 attachment asset 承担——**两处必须同源**。
