# 0.2.2-rc.1 引擎 overlay：生成器 provenance 与逐条对账

> 结论先行：`scripts/snapshot-config/engine-overlay.json` 的 packages 面由**协调仓原生成器**派生（非手写）。
> 本文件记录**生成器版本与哈希、只读运行方式、输入真源、三段对账**、人工改动段的证据、**已并项的逐条核对**，
> 以及仍然未决的几项。本文件是审计记录，不替代登记表：数字以 overlay 实际内容与 §8 的复算命令为准。

## 0. 本文审计的对象

| 项 | 值 |
|---|---|
| 文件 | `scripts/snapshot-config/engine-overlay.json` |
| 当前工作树 sha256 | `521b5d9f1ea838d432ce75a3fcee2a528d4304c3accc414bee11477e54af8886` |
| 当前工作树字节 | 33,638 |
| 提交轨迹 | `82156b9e`（生成器派生 + pi-ai 1.3.0）→ `1a8ab9ac`（vendorTop 抬版/新增 + nested 退 lexical/补 zod）→ 其后工作树（`assemblyInventory.sourceCommit` 与 `comment` 收口，见 §5.4） |
| engineVersion / rootPackage | `0.2.2-rc.1` / `@deepseek-ai/dsh@0.2.2-rc.1` |
| packages / vendorTop / pins / nested 主机 / keepUnpublished / extraPresent | 378 / 71 / 1 / 10 / 4 / 7 |

## 1. 生成器 provenance

| 项 | 值 |
|---|---|
| 权威源 | 协调仓 `D:\coding\dsh-mobile`，commit `284799d975009cc88b6a638b641f273a7a127b1b` |
| 生成器 | `scripts/gen-engine-overlay.mjs` |
| 生成器 sha256 | `ad575bd978723d7c89795d9c68ac3cbac0ebe4c3a09948c4f045d95c491873f3` |
| 生成器规模 | 227 行 / 13,503 字节 |
| 运行方式 | 沙箱内**只读运行**（不修改生成器、不放宽其断言） |
| 运行命令 | `node scripts/gen-engine-overlay.mjs --engine 0.2.2-rc.1 --write` |

本仓**没有**这个文件，`generatedBy` 指向的就是协调仓那份 —— 这是既有约定，不是缺文件。
生成器只写五个键：`engineVersion`、`rootPackage`、`packages`、`keepUnpublished`、`generatedBy`；
`pins` / `vendorTop` / `nested` / `extraPresent` / `comment` / `requiredUpstreamPatches` / `assemblyInventory`
**一律不写**，因此这些段的人工改动必须在本文留证据（§4、§5）。

生成器自带三条硬断言（任一不满足即 exit 1，不会产出半成品）：`--engine` 必须是精确版本；
上游树 `git describe --tags` 必须等于 `contract.upstream.describe`；树内每个包 version 必须全等于 `--engine`。

## 2. 输入真源（全部可复算）

| 面 | 来源 | 数量 |
|---|---|---|
| 包清单 | tag `dsh-v0.2.2-rc.1` = commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` 的 `packages/**/package.json` | 381 个文件；`@deepseek-ai/*` 命名 **372** |
| 版本一致性 | 同上 | **0 个** version ≠ 0.2.2-rc.1 |
| 排除 | `TEST_ONLY` 6 + `PRIVATE_UNMOUNTED` 1（`dsh-ssh-helper-runtime`：private:true 且全树零引用） | 入表候选 **365** |
| 发布事实 | registry 精简元数据 `meta.versions['0.2.2-rc.1']` 逐名核验 | 365/365 有 tarball；**0 个 404、0 个网络失败** |
| 运行期闭合 | `npm install @deepseek-ai/dsh@0.2.2-rc.1` 实装（closure022） | 579 包 / `@deepseek-ai/*` 330 |
| 对照 | closure021（0.2.1-rc.3） | 548 包 / `@deepseek-ai/*` 306 |

### 2.1 blobless 克隆取 manifests（踩过的坑，别重踩）

```sh
git ls-tree -r --name-only <commit> packages/ | grep '/package.json$'   # 381，纯树元数据
git show <commit>:<path>                                               # 逐条惰性拉 blob，381 条约 44 秒
```

反例（均实测失败）：`git cat-file --batch` 在 partial clone 下**不触发**惰性拉取（381 个全 missing）；
`git checkout <commit> -- packages` 批量拉取报 `unable to read sha1 file` 且会把 index 弄脏。

## 3. packages 三段对账：349 → 378（+30 / −1 / 升版 338 / 不变 10）

数字取自 `git show e6bbdfd3:...` 与 `git show 82156b9e:...` 两份的集合差，可直接复算。

### 3.1 删除 1 条

| 包 | 判据 |
|---|---|
| `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` | 不在新树 `packages/`；新树**无任何包声明依赖它**；上游 web-app 行面同步删掉了这一行。**旧表仍登记它，不删会让反向面把「合法缺席」判红。** |

### 3.2 新增 30 条（全部 0.2.2-rc.1，全部 registry 有 tarball）

`official-bundles`、`tool-executor-native`、`tool-executor-ptc`、`client-ui-context-menu`、`client-ui-file-actions`、
`client-ui-file-drag`、`client-ui-action-cards`、`action-cards`、`message-quotes`、`plugin-detail`、`plugin-recommendations`、
`client-ui-plugin-recommendations`、`client-ui-creation-recommendations`、`creation-recommendations`、
`personalized-recommendations`、`deliverable-file-references`、`fs-patch`、`experimental-client-ui-forge`、
`experimental-client-ui-stats`、`experimental-forge`、`experimental-forge-github`、`experimental-forge-session`、
`experimental-forge-bundle`、`experimental-liveshare`、`experimental-liveshare-protocol`、`experimental-subagent-oar`、
`experimental-tool-subagent-oar`、`cua-bundle`、`tool-testkit`、`util-file-drag`
（均省略 `@deepseek-ai/dsh-` 前缀）。

### 3.3 升版 338 条

其中 `@deepseek-ai/dsh-*` **335** 条 0.2.1-rc.3 → 0.2.2-rc.1；另 3 条是**非 `packages/`** 的显式映射：

| 包 | 旧 → 新 | 真源 |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.5 → **4.1.0** | closure022 实装解析（树内声明 `workspace:~` ⇒ 发布即 `~4.1.0`，旧值不满足）；值经 `contract.cordis` 入表 |
| `@deepseek-ai/schemastery` | 3.18.5 → **3.19.0** | 同上（`contract.schemastery`） |
| `@deepseek-ai/dsh-web-frontend` | 0.2.1-rc.3 → **0.2.2-rc.1** | 生成器显式映射（= `--engine`） |

### 3.4 不变 10 条

`@deepseek-ai/node-addon-system@0.1.2`、`commander@15.0.0`、`got@14.6.6`、`js-yaml@4.3.2`、
`node-addon-require-builtin@0.1.9`，以及 `cordis-plugin-{group 1.0.5, hmr 1.0.20, include 1.0.10, loader 1.0.6, timer 1.1.7}`。
前五条的「不变」是实测结论（closure022 解析值与旧表一致）；**cordis-plugin 四条的「不变」仍未收口**，见 §5.6。

### 3.5 保留不删（易误判）

旧表里 43 条**不在 npm 安装闭包**的条目（browser-use / ssh / lsp / subagent-codex / client-web / sdk-client 等）
**仍在 `packages/` 树内**，生成器原样保留并抬版 —— 「不在闭包」不等于「上游删了」，不要手删。

## 4. 人工改动段与证据（生成器不管的部分）

### 4.1 pins：pi-ai 1.1.0 → **1.3.0**

上游 `dsh-llm-pi-ai` 与 `dsh-experimental-subagent-oar` 声明 `^1.3.0`，1.3.0 在范围内。
**pi 家族的判据（容易带错的一处）**：`pi-ai@1.3.0` 的 dependencies 实测为
`{openai 7.19.0, typebox 1.3.27, partial-json 0.1.7, @google/genai 2.21.0, http-proxy-agent 9.1.0,
@anthropic-ai/sdk 0.129.0, https-proxy-agent 9.1.0, @smithy/node-http-handler 4.12.1,
@earendil-works/pi-telemetry **1.3.0（精确钉）**, @aws-sdk/client-bedrock-runtime 3.1127.0}`。
「删 typebox、加 pi-schema」是 **1.5.0** 的动作，1.3.0 不是。⇒ **typebox 1.3.27 保留、pi-schema 不进 vendorTop**；
`@earendil-works/pi-schema` 在 registry 只有 `0.0.0-stage / 0.0.0 / 1.5.0` 三版，与 1.3.0 无引用关系。

### 4.2 requiredUpstreamPatches：pi-ai 1.1.0 → **1.3.0**

| 字段 | 值 | 证据 |
|---|---|---|
| `version` | 1.3.0 | registry 有该版本 |
| `sourceCommit` | `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` | 目标 tag 的 commit（旧条目写的是 rc.3 的 `1f81c04…`） |
| `patchSha256` | `d2ee86c4d257ca3f8a41c013307d739a90cb6d618fcac3a9099792e198ed5051` | 对落盘补丁实测 sha256 |
| `patchBytes` | 5,732 | 同上（旧补丁 4,477 B） |
| `patch` | `scripts/patches/upstream/pi-ai-1.3.0.patch` | 本仓实际落盘路径，补丁原文已在该处 |
| `sourcePath` | `patches/@earendil-works__pi-ai@1.3.0.patch` | **上游产物名**（旧条目同构），不是本仓路径 |
| `reason` | 已改写 | 1.3.0 的补丁除「删 streaming tool-call 参数增量解析」外，**新增 `openai-completions` 的 Gemini `thought_signature` 回放处理**（+多 hunk，5732 B vs 4477 B） |

`patch` / `patchBytes` 是相对旧结构**新增的两个字段**，用途：让「overlay 指向的补丁文件真的在本仓」可校验，
并让字节数与 sha256 同源可核对。二者均可对落盘文件复算，不是臆造事实。

## 5. 已并项与逐条核对（都已落盘，附核对结果）

### 5.1 已并 A：vendorTop 抬版 6 条

| 包 | 旧 | 现值 | 核对 | 判据 |
|---|---|---|---|---|
| `@deepseek-ai/cosmokit` | 1.8.6 | 1.9.0 | 一致 | closure022 顶层解析值变化（0.14.2 曾因 cosmokit 旧版缺 `createVolatile` 出设备事故） |
| `@earendil-works/pi-telemetry` | 1.1.0 | 1.3.0 | 一致 | `pi-ai@1.3.0` 的**精确钉**，1.1.0 不满足 |
| `compression` | 1.8.1 | 1.8.2 | 一致 | closure022 解析值 |
| `execa` | 10.0.1 | 10.2.1 | 一致 | closure022 解析值（0.14.2 因 execa 缺席出过 boot 崩） |
| `http2-wrapper` | 2.2.1 | 2.2.4 | 一致 | closure022 解析值 |
| `resolve.exports` | 2.0.3 | 2.0.4 | 一致 | closure022 解析值 |

### 5.2 已并 B：vendorTop 新增 8 条（vendorTop 63 → 71）

| 包 | 版本 | 引用者（0.2.2-rc.1 树内） |
|---|---|---|
| `acorn` | 8.19.0 | `dsh-ptc-runtime-node` |
| `acorn-walk` | 8.3.5 | `dsh-ptc-runtime-node` |
| `birpc` | 4.2.0 | `dsh-ptc-runtime-node` |
| `hosted-git-info` | 9.0.3 | `dsh-plugin-manager`、`dsh-plugin-market` |
| `lru-cache` | 11.5.3 | `hosted-git-info` |
| `rrule` | 2.8.1 | `dsh-util-time` |
| `shell-quote` | 1.12.0 | `dsh-experimental-forge-session` |
| `mime` | 4.1.2 | `dsh-util-file-drag`（新包；不在安装闭包，registry 最新，自身无依赖） |

判据：这 8 个在 closure022 存在、在 closure021 **不存在** ⇒ 基座树没有 ⇒ overlay 不补即 `ERR_MODULE_NOT_FOUND`
（与 0.14.6 `got` 事故同族）。其中 `acorn`/`acorn-walk`/`birpc`/`hosted-git-info`/`lru-cache`/`rrule` 的引用者
**都在挂载行面上**，属正向闭包会被打到的一类。
保留不动：`typebox@1.3.27`（pi-ai 1.3.0 仍需）、`@tanstack/react-virtual@3.14.10`（不在闭包，无改版证据）。

### 5.3 已并 C：nested 退 lexical（15→0）、补 zod×4（7→10 主机）

- **退**：`@deepseek-ai/dsh-client-ui-conversation` 的 15 条 lexical 族已移除（现该主机不在 nested 里）。
  判据：0.2.2-rc.1 全树 **0 个包声明 lexical**，npm 闭包里也完全没有 lexical ⇒ 宿主把编辑器搬进自身 bundle。
- **加**：`zod@4.4.3` 已嵌到 4 个**新**宿主 `dsh-action-cards`、`dsh-creation-recommendations`、
  `dsh-experimental-liveshare`、`dsh-plugin-recommendations`。
  判据：全树 74 个包**精确钉** `zod 4.4.3`（非 `^`），基座顶层 zod 是 4.6.7，npm 自己的解析就是把 4.4.3 嵌到这些包下；
  而 `build-snapshot-013.mjs` 的 `overlayExtract` 只对**原位替换**的包保留旧嵌套 `node_modules`，
  新包没有可继承的嵌套 ⇒ 不补就解析到 4.6.7。
- 现 nested 共 **10 主机 / 24 子项**；C-3「保持不动」的 6 主机逐条核对无变化：
  `dsh-acp`→`@agentclientprotocol/sdk 1.4.0`、`dsh-terminal-bash`→`@xterm/headless 6.0.0`、
  `dsh-otel`→`@opentelemetry/*` 0.222.0/2.11.0、`dsh-session-telemetry-otel`→`@opentelemetry/api-logs 0.222.0`、
  `dsh-webhook-github`→`@octokit/*` 6 条、`compression`→`debug 2.6.9`/`negotiator 0.6.4`（顶层是 1.1.0，必须嵌）/`ms 2.0.0`。

### 5.4 已并 D：两处不一致已收口（工作树，未提交）

| 位置 | 旧 | 现值 | 核对 |
|---|---|---|---|
| `assemblyInventory.sourceCommit` | `1f81c047fc48…`（rc.3） | `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` | 一致 |
| `comment`[3] | 「The complete Lexical family follows the official 0.49.0 source lock…」 | 「The Lexical family lock (0.49.0) is retired with 0.2.2-rc.1: no package in the pinned tree declares lexical…」 | 一致，且与 §5.3 不再矛盾 |

### 5.5 行面 diff（供 `contract.json` 的 rows/upstreamRows）

用**与门禁同款状态机**解析两份 commit 的 `cordis.patch.yml`：

| 文件 | 新增行 | 删除行 | 开关变化 |
|---|---|---|---|
| `packages/bundle/base/cordis.patch.yml`（96→97） | `dsh-tool-executor-native`、`dsh-tool-executor-ptc`[**disabled**] | `dsh-tool-subagent-control/list-agents` | `dsh-fs-observation-policy` enabled→**disabled** |
| `packages/bundle/web-app/cordis.patch.yml`（91→95） | `client-ui-file-actions`、`client-ui-context-menu`、`message-quotes`、`client-ui-file-drag`、`deliverable-file-references` | `client-ui-deepseek-model-label-1017` | 无 |

`fs-observation-policy` 被上游自己禁用**不等于**包可以删：它仍是 `dsh-fs-local` 的运行时依赖。

### 5.6 仍未收口（三项，均需人裁决）

1. **`@deepseek-ai/cordis-plugin-{group,include,loader,timer}` 仍是 rc.3 值**（1.0.5 / 1.0.10 / 1.0.6 / 1.1.7），
   而 closure022 的真实解析是 **1.1.0 / 1.1.0 / 1.1.0 / 1.2.0**；树内包声明的是 `workspace:~`，发布即 `~1.1.0`/`~1.2.0`。
   生成器只按 `contract.json` 写 `cordis`/`schemastery` 两条，所以这 4 条只能人工抬。
   `cordis-plugin-hmr` 无树内消费者、不在安装闭包（registry 有 1.1.0），维持 1.0.20 属口径选择。
2. **`@deepseek-ai/dsh-experimental-subagent-oar` → `@earendil-works/pi-coding-agent ^1.3.0` 不物化**：
   该包不在安装闭包，自身 21 条依赖（`quickjs-wasi 3.6.2`、`@silvia-odwyer/photon-node`、`pi-ai/pi-mcp/pi-tui/pi-codemode/pi-agent-core` 全套）。
   建议不补（experimental 行、不在挂载行面），但一旦挂载即 `ERR_MODULE_NOT_FOUND` —— 结论要写进登记面/known-gaps。
3. **基座里的 15 个 lexical 包**：若要从快照剔除，需加进 `slim.json` 的 `engineStalePackages`，
   否则反向面会因「包在树内但已无登记/无来源」判红。建议等首次快照跑门后再决定。

## 6. 门禁看得到 / 看不到的

`scripts/check-engine-overlay.mjs`（本版**未放宽、未改动**）能判：根包与 `packages`/`vendorTop`/`pins`/`nested` 的
版本精确一致；`keepUnpublished` 包在树内；反向面（快照内每个包要么已登记、要么闭包可达）；
**挂载行**的传递运行时依赖缺口；内置预设载体非空；`slim.json` 基座残留反向断言；vendor 面 license 登记。

它**看不到**两类，也正是 §5 那些第三方改动必须靠人判的原因：

1. **nested 缺席**：只断言「登记了就在」，新宿主缺嵌套副本不会被发现（§5.3 的 zod）；
2. **vendorTop 缺席/旧版**：正向闭包只覆盖挂载行的 `runtimeDeps`，而 `acorn`/`birpc`/`hosted-git-info`/`rrule`
   正是挂载行会拉到的第三方 —— 但它们只有**快照建出来**那一刻才会红（与 0.14.6 `got`、0.14.2 `execa`/`cosmokit` 同型）。

`keepUnpublished` 4 条（client-runtime / host-apiproxy / tool-subagent-report / node-addon-landlock-run）本版**不增不减**：
365 个候选全部有 tarball，0 条新增、0 条降级；它们不在新树是正常态（构建期只断言「基座树内存在」）。

`extraPresent` 7 条**不动**。复算：closure022 里「未登记且闭包不可达」的只有 5 个 Windows 原生变体
（`@img/sharp-win32-x64` / `@koromix/koffi-win32-x64` / `@vscode/ripgrep-win32-x64` /
`node-addon-require-builtin-win32-x64-msvc` / `sherpa-onnx-win-x64`）+ 根包 + `libreoffice-kit-win32-x64`，全是平台面；
Android 侧对应的 `@vscode/ripgrep-android-*` 与 `@img/sharp-wasm32` 沿用旧表。
`clsx`/`scheduler`/`@mistralai/mistralai`/`@opentelemetry/exporter-logs-otlp-http` 都不在 0.2.2-rc.1 闭包里（基座残留）：
**不要从 extraPresent 删**，删了反向面会把它们判成「无来源」。

### 6.1 本机预检实测（可跑的部分都跑了）

| 预检 | 结果 |
|---|---|
| `node -e "JSON.parse(require('fs').readFileSync('scripts/snapshot-config/engine-overlay.json','utf8'))"` | **OK** |
| 与旧版结构同构（20 个顶层键**同序**、逐键类型一致） | **通过** |
| `packages`/`vendorTop`/`pins`/`nested` 全部条目的 name 形状与 semver 形状 | **0 违例** |
| `keepUnpublished` 的 `name (version)` 形状 | **通过** |
| `requiredUpstreamPatches` 字段集是旧结构的**超集**（新增 `patch`/`patchBytes`） | **通过** |
| 内部自洽 `packages['@deepseek-ai/dsh-app-boot'] == engineVersion` | **通过**（0.2.2-rc.1） |
| **可构建性预检**：当前 overlay 的 **469 个唯一 name@version** 逐个查 registry | **0 不可解析**（0 name-404、0 version-missing、0 网络失败；10.4 秒 / 14 并发） |
| `node scripts/check-engine-overlay.mjs`（本机） | **跑不了**：`exit 2` + `用法: node scripts/check-engine-overlay.mjs <snapshot.tar.xz> [--manifest <engine-overlay.json>]` —— 本工作树**没有** `snapshot.tar.xz` 产物（`**/snapshot.tar.xz` 与 `.deploy-tmp/**/*.tar.xz` 均为空），而该门禁的全部断言都建立在快照的 tar 流上。**必须先 `node scripts/build-snapshot-013.mjs <abi>` 出快照才能跑**；这不是缺参数，是缺输入产物，不能当通过。 |

## 7. 未决点

- 即 §5.6 三项（cordis-plugin 4 条抬版、`pi-coding-agent` 是否物化、基座 lexical 是否清）。
- `contract.json` 的 `rows`/`upstreamRows` 三条（`tool-subagent-control/list-agents` 删除、
  `ui-deepseek-model-label-1017` 删除、`fs-observation-policy` enabled→disabled）需按 §5.5 同步改；
  同时 `contract.baseline`/`contract.upstream.*`/`contract.cordis`/`contract.schemastery` 必须与本 overlay 同批抬，
  否则 `check-contract` 判红或生成器直接 die。

## 8. 复算命令

```sh
# 生成器身份
git -C D:/coding/dsh-mobile rev-parse HEAD        # 284799d975009cc88b6a638b641f273a7a127b1b
sha256sum D:/coding/dsh-mobile/scripts/gen-engine-overlay.mjs
                                                  # ad575bd978723d7c89795d9c68ac3cbac0ebe4c3a09948c4f045d95c491873f3

# 包清单（纯树元数据，不拉 blob）
git -C .deploy-tmp/survey-022rc1/upstream-022 ls-tree -r --name-only \
  66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db packages/ | grep '/package.json$' | wc -l        # 381

# 三段对账（集合差，不用猜）
git show e6bbdfd3:scripts/snapshot-config/engine-overlay.json > /tmp/old.json
git show 82156b9e:scripts/snapshot-config/engine-overlay.json > /tmp/gen.json

# 行面 diff
git -C .deploy-tmp/survey-022rc1/upstream-022 show <commit>:packages/bundle/base/cordis.patch.yml
```

本轮查询缓存（可直接读，避免重跑网络/SSH）：
`.deploy-tmp/survey-022rc1/__up022_pkgjson_cache.json`（381 个上游 package.json 原文）、
`__closure021.json` / `__closure022.json`（安装闭包 name→{version,deps}）、
`__npm_meta022.json`（365 个候选的 registry 版本表）、`__nested022.json`、`__derived_packages.json`（§3 算法算出的 packages 面）。
