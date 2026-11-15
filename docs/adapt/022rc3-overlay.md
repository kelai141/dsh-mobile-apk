# 0.2.2-rc.3 引擎 overlay：人工段复核与逐条对账

> 结论先行：`scripts/snapshot-config/engine-overlay.json` 的 **packages 面**由协调仓原生成器派生（非手写，本文件不重复审计）；
> 本文件记录 **人工段**（`pins` / `vendorTop` / `vendorTopNote` / `nested` / `extraPresent` / `keepUnpublished` /
> `requiredUpstreamPatches` / `assemblyInventory` / `comment`）在 rc.3 的逐条复核结论、改动依据与仍然未决的项。
> **本文件不代表快照已重建**：本轮不构建快照、不跑测试，overlay 的实际落位必须等
> `node scripts/build-snapshot-013.mjs <abi>` 之后由 `scripts/check-engine-overlay.mjs` 验证（§7）。

## 0. 本文审计的对象

| 项 | 值 |
|---|---|
| 文件 | `scripts/snapshot-config/engine-overlay.json` |
| 工作树字节 / sha256 | 36,106 / `08ea7ccbf72ac761306c21d9fe4cf73cc4206f010f0e9a11a10a5b269cb1c771` |
| engineVersion / rootPackage | `0.2.2-rc.3` / `@deepseek-ai/dsh@0.2.2-rc.3` |
| packages / vendorTop / pins / nested 主机 / nested 子项 / keepUnpublished / extraPresent | 380 / **78** / 1 / 10 / 24 / 4 / 7 |
| 顶层键数（与 rc.1 同序） | 20 |
| 上游目标 | tag `dsh-v0.2.2-rc.3` = commit `38a6a5c965aa99ab525161efb7cc5cf1fe62fced` |

## 1. 生成器 provenance

| 项 | 值 |
|---|---|
| 权威源 | 协调仓 `D:\coding\dsh-mobile`，commit `284799d975009cc88b6a638b641f273a7a127b1b` |
| 生成器 | `scripts/gen-engine-overlay.mjs` |
| 生成器 sha256 | `ad575bd978723d7c89795d9c68ac3cbac0ebe4c3a09948c4f045d95c491873f3` |
| 生成器规模 | 227 行 / 13,503 字节（与 rc.1 轮**同一个文件**，未改动） |
| 只写的键 | `engineVersion` / `rootPackage` / `packages` / `keepUnpublished` / `generatedBy` |

本仓**没有**这个文件，`generatedBy` 指向的就是协调仓那份——既有约定，不是缺文件。
生成器**不写** `pins` / `vendorTop` / `vendorTopNote` / `nested` / `extraPresent` / `comment` /
`requiredUpstreamPatches` / `assemblyInventory`，所以这些段的一切改动都必须在本文件留证据（§4、§5）。

## 2. 输入真源（全部可复算）

| 面 | 来源 | 数量 |
|---|---|---|
| 包清单 | tag `dsh-v0.2.2-rc.3` 的 `packages/**/package.json` | 383 个文件；去掉 9 个无 `name` 的私有/测试面后 **374** 个 `@deepseek-ai/*` 命名 |
| 版本一致性 | 同上 | **0 个** version ≠ 0.2.2-rc.3 |
| tree diff vs rc.1 | 集合差 | 新增 11 / 删除 9（两侧同名同源，见 §3） |
| 运行期闭包 | `.deploy-tmp/closure/package-lock.json`（450,237 B，`closure-rc3`） | 659 个顶层名 |
| 独立复核 | 真实 `npm install @deepseek-ai/dsh@0.2.2-rc.3`（`.deploy-tmp/rc3-overlay-audit/npmprobe`） | 670 包 / 587 顶层 / exit 0 |
| 上游锁 | rc.3 `pnpm-lock.yaml` | 用作「上游自己的解析值」对照 |
| 基座实测 | `base/base-usr-arm64.tar.xz`（68,959,460 B）解出的引擎树 | 430 个顶层目录（429 个真包）；引擎根 `@deepseek-ai/dsh@0.1.1-rc.2` |

基座归档本轮**未改动**（最后一次提交是 `cf05fe66`），因此「基座里有什么」是稳定事实：
基座顶层 `zod` 是 **4.4.3**（arm64 与 x86_64 各一份、无嵌套副本），`koffi` 3.1.5、`sharp` 0.35.3、
`open` 11.0.1、`picomatch` 4.0.5、`fflate` 0.8.3。

## 3. packages 三段对账：378 → 380（+11 / −9 / 抬版 357 / 不变 12）

数字取自 `git show HEAD:scripts/snapshot-config/engine-overlay.json` 与工作树的集合差，可直接复算。
**本段是生成器产物，本轮未手改**；此处只做对账记录。

### 3.1 新增 11 条（全部 0.2.2-rc.3）

| 包（省略 `@deepseek-ai/`） | 第三方运行时依赖 | 挂载行面 |
|---|---|---|
| `dsh-agent-team` | `zod 4.6.6` | 是 |
| `dsh-client-ui-account-notifications` | 无 | 是 |
| `dsh-client-ui-agent-team` | 无 | 是 |
| `dsh-mcp-manager` | `zod 4.6.6` | 是 |
| `dsh-office-kit` | `zod 4.6.6` + 惰性 `@deepseek-ai/libreoffice-kit` | 是 |
| `dsh-tool-agent-team` | 无 | 是 |
| `dsh-deepseek-chat-import` | `fflate ^0.8.2`、`zod 4.6.6` | 否 |
| `dsh-error` | 无 | 否 |
| `dsh-terminal-panel` | 无 | 否 |
| `dsh-tool-office` | 无 | 否 |
| `dsh-util-ripgrep` | `@vscode/ripgrep ^1.18.0` | 否 |

这 11 条**在两棵树里都存在**（不改名、不拆包），所以登记即正确；第三方依赖面见 §5.2 与 §5.4。

### 3.2 删除 9 条

`dsh-api-account-controller`、`dsh-deepseek-account-platform`、`dsh-experimental-agent-team`、
`dsh-experimental-agent-team-profile`、`dsh-experimental-client-ui-agent-team`、
`dsh-experimental-tool-agent-team`、`dsh-office-to-pdf`、`dsh-web-search-exa`、`dsh-web-search-perplexity`。

判据（三条同时成立，逐条实测）：**①** 不在 rc.3 `packages/` 树；**②** rc.3 全树**零个包**声明它们
（`dependencies`/`optionalDependencies`/`peerDependencies`/`devDependencies` 全扫）；**③** 不在 rc.3 npm 闭包。
不删会让反向面把「合法缺席」判红。

### 3.3 抬版 357 条 + 不变 12 条

357 条的形态只有一种：`0.2.2-rc.1 → 0.2.2-rc.3`。
不变的 12 条是**非 `packages/` 树内版本**的显式映射：`@deepseek-ai/cordis@4.1.0`、
`cordis-plugin-{group 1.1.0, hmr 1.0.20, include 1.1.0, loader 1.1.0, timer 1.2.0}`、
`@deepseek-ai/schemastery@3.19.0`、`@deepseek-ai/node-addon-system@0.1.2`、
`commander@15.0.0`、`got@14.6.6`、`js-yaml@4.3.2`、`node-addon-require-builtin@0.1.9`。
这 12 条在 rc.3 的 **npm 闭包里解析值与旧表逐条一致**（例外只有 `commander` 闭包给 15.1.0，
但上游 `pnpm-lock.yaml` 是 15.0.0、快照走锁文件口径，且 rc.1 轮已按同口径定过）⇒ 维持不变。

## 4. 人工段改动（本轮实际修改的行）

### 4.1 `vendorTop`：77 → 78，新增 `zod: "4.6.6"`

| 项 | 内容 |
|---|---|
| 插入位置 | `vendorTop` 末位（`yoctocolors` 之后，保持字典序） |
| 真因 | **基座版本落伍，不是缺包**。rc.3 全树 76 个包把 `zod` 精确钉成 `4.6.6`（**一条 `^` 都没有**；rc.1 的 74 个声明者是「64 个精确 `4.4.3` + 10 个 `^4.4.3`」）；其中 **49 个在挂载行面上**。基座顶层只有 `zod@4.4.3` 且无任何嵌套副本，overlay 不给值就解不到 4.6.6。 |
| 为什么放顶层而不是 49 个 `nested` | npm 真实布局是「顶层 4.6.7 + 每宿主嵌 4.6.6」。顶层 4.6.7 只服务三家：`zod-to-json-schema`（`^3.25.28 \|\| ^4`）、`@mistralai/mistralai`（`^3.25.0 \|\| ^4.0.0`）、`@modelcontextprotocol/sdk`（`^3.25 \|\| ^4.0`）——而 **4.6.6 同样满足这三个 range**。顶层钉 4.6.6 一次性对齐 49 条挂载行与 4 条 nested 宿主，且不破坏那三家。 |
| 为什么不选 4.6.7（闭包值） | 闭包 4.6.7 来自 npm 的重解析结果，而上游 `pnpm-lock.yaml` 解析的是 **4.6.6**；且 76 个包精确钉 4.6.6，钉 4.6.7 会让 49 条挂载行的精确钉**不满足**。 |

### 4.2 `nested`：4 条 zod `4.4.3 → 4.6.6`

| 宿主 | 旧 | 新 | 真因 |
|---|---|---|---|
| `dsh-action-cards` | 4.4.3 | **4.6.6** | rc.3 该包 `dependencies.zod` 是精确钉 `4.6.6`；它是 rc.3 **新包**（基座里没有），`build-snapshot-013.mjs` 的 `overlayExtract` 只对**原位替换**的包保留旧嵌套 `node_modules`，新包没有可继承的嵌套 ⇒ 不补就解析到顶层 |
| `dsh-creation-recommendations` | 4.4.3 | **4.6.6** | 同上 |
| `dsh-experimental-liveshare` | 4.4.3 | **4.6.6** | 同上 |
| `dsh-plugin-recommendations` | 4.4.3 | **4.6.6** | 同上 |

这 4 条是「上一轮把 zod 补进这些宿主时留的旧值」：rc.1 全树钉 `4.4.3`，rc.3 全树钉 `4.6.6`。
本轮 `nested` 的**主机数与子项数都不变**（10 / 24），只改这 4 个值。
其余 20 个子项逐条复核后不动（§5.3）。

### 4.3 `assemblyInventory.sourceCommit` 与 `requiredUpstreamPatches[0].sourceCommit`：`66491b05…` → `38a6a5c9…`

语义判定（这是本轮唯一需要「先证明字段含义再改」的一处）：

- `assemblyInventory.sourceCommit` 记录的是**核对这些行时所用的上游提交**，不是「行最初登记时的提交」。
  依据：字段名是 `sourceCommit`（不是 `addedIn`/`registeredAt`），它与同层的 `rows`/`excludedReason`
  是**同一次核对**的产物；rc.1 轮把该值从 rc.3 的 `1f81c04…` 改成 rc.1 的 `66491b05…`（见
  `docs/adapt/022rc1-overlay.md` §5.4），说明它在历史上就是**随核对轮次滚动**的，而不是一次性历史锚点。
  ⇒ 本轮改成 `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`（rc.3 的 tag commit）。
- `requiredUpstreamPatches[0].sourceCommit` 同轮一起改：该补丁在 rc.1 与 rc.3 两个 commit 上是
  **同一个 blob**（`git rev-parse` 两处都是 `111e09dc…`，LF 归一后 5,632 B / sha256 `4e1c90fd…`），
  所以「补丁本体」没变，变的只是「这一轮核对的是哪个上游提交」。

两个字段的取值区别必须记住，不能互相"修正"：`patchSha256` = `d2ee86c4…` 是**本仓 CRLF 检出**的身份
（`git cat-file --filters` 与 `-p` 两条路径实测一致，5,732 B）；上游 blob 的 `4e1c90fd…` 是 LF 归一后的身份，
也是 rc.3 `pnpm-lock.yaml` 第 14 行的 `patch_hash`。两者是同一补丁的两层表示，不是不一致。

### 4.4 `vendorTopNote`：追加 rc.3 段

追加内容（一段，不改既有历史段）：条数 77 → 78 的原因；两类判据的实测结论（「上游下限高过钉值」0 条、
「钉的包在上游消失了」0 条，含 5 条例外的逐条定性）；新增 zod 的完整理由（§4.1）；
以及 `@deepseek-ai/libreoffice-kit` 为何仍不登记（§5.4）。

### 4.5 `comment`

本轮由并行的适配工作一并更新（工程面同步做，非本文独有）：

- `comment[0]`：rc.1 + `66491b05…` → rc.3 + `38a6a5c9…`，并加上 `docs/adapt/022rc3-overlay.md` 指针；
- `comment[3]`（Lexical 退休）：补充「re-confirmed on 0.2.2-rc.3」。实测依据：rc.3 全树只有
  `dsh-client-ui-conversation` 的 **devDependencies** 里还有 6 条 `@lexical/*`/`lexical`（与 rc.1 逐字段相同），
  `dependencies` 里 0 条，npm 闭包里 0 条，上游 `patches/` 里的 `lexical@0.49.0.patch` 已被删除（现 12 个补丁）。

## 5. 复核后**决定不改**的部分（逐类给判据）

### 5.1 `pins`：`@earendil-works/pi-ai` 维持 `1.3.0`

- rc.3 `pnpm-lock.yaml` 解析 `@earendil-works/pi-ai` = **`1.3.0`**（带 `patch_hash`），不是 1.5.x；
- rc.3 树内 `dsh-llm-pi-ai` 与 `dsh-experimental-subagent-oar` 声明 `^1.3.0`——与 rc.1 同一条 range，未变；
- npm 闭包给 1.5.2 是**重解析副作用**：rc.2/rc.3 的 `dsh-agent` 钉 `@earendil-works/pi-coding-agent ^1.5.2`，
  它把 pi 家族整体抬到 1.5.x，而 npm 接受 `^1.3.0`。快照不走 npm 重解析，走 overlay 物化。
- 1.3.0 的 `dependencies` 实测为 `{openai 7.19.0, typebox 1.3.27, partial-json 0.1.7, @google/genai 2.21.0,
  http-proxy-agent 9.1.0, @anthropic-ai/sdk 0.129.0, https-proxy-agent 9.1.0, @smithy/node-http-handler 4.12.1,
  @earendil-works/pi-telemetry 1.3.0（精确钉）, @aws-sdk/client-bedrock-runtime 3.1127.0}`
  ——「删 typebox、加 pi-schema」是 1.5.0 的动作。⇒ `typebox 1.3.27` 保留、`pi-schema` 不进 vendorTop。
- 由此 `@earendil-works/pi-telemetry` 也必须留在 **1.3.0**（pi-ai 1.3.0 的精确钉），不能跟闭包抬到 1.5.2。

### 5.2 `vendorTop` 其余 76 条：逐条核过，不动

两类判据（与 `vendorTopNote` 同源，此处给数）：

| 判据 | 结论 |
|---|---|
| **上游下限高过钉值** | **0 条**。全 78 条里只有 2 条的引用方 range 不接受当前钉值：`@anthropic-ai/sdk 0.129.0`（`subagent-claude-code` 要 `0.93.0`）、`undici 8.11.2`（`experimental-subagent-oar` 要 `8.10.2`）。这两个引用方**都不在挂载行面上**，且 rc.1 轮即如此，不是本轮引入。 |
| **钉的包在上游消失了** | **0 条**。原有 77 条在 rc.3 npm 闭包顶层实测 **72 条逐字一致**；5 条例外：不在闭包 3 条（`typebox@1.3.27` 是 pi-ai 精确钉、`@tanstack/react-virtual@3.14.10` 与 `mime@4.1.2` 在 rc.3 全树只有 devDependencies/零引用，与 rc.1 同类）、版本不同 2 条（`@earendil-works/pi-telemetry` 闭包 1.5.2 但 pi-ai 1.3.0 钉 1.3.0；`@eslint-community/regexpp` 闭包 4.12.3 但上游锁是 4.12.2）。两侧的共同点是**闭包值不是我们要的安装值**。 |
| **有无消费者** | 78 条里只有 `@tanstack/react-virtual` 在**最终快照**里零声明者（rc.3 全树也只有 devDependencies 声明它，与 rc.1 逐字相同）。保留理由：rc.1 轮已按同口径定过、且它是 `dsh-client-ui-trajectory` 等包 devDependencies 的精确钉，删掉要单独立项。 |

**删除候选（不删，供裁决）**：从挂载行面（206 行）出发按运行时依赖做 BFS，有 25 条 vendorTop 条目
不可达——其中 21 条从**任何** rc.3 树内包出发都不可达：
`@earendil-works/pi-telemetry`（pi-ai 1.3.0 精确钉，属**必需**）、`@keyv/serialize`、`@sindresorhus/is`、
`@tanstack/react-virtual`、`@types/http-cache-semantics`、`byte-counter`、`cacheable-lookup`、
`cacheable-request`、`decompress-response`、`form-data-encoder`、`http-cache-semantics`、`http2-wrapper`、
`keyv`、`lowercase-keys`、`mimic-response`、`normalize-url`、`p-cancelable`、`quick-lru`、
`resolve-alpn`、`responselike`、`type-fest`。
这批是 rc.1 轮为 `got@14.6.6` 的**完整传递闭包**物化的（`vendorTopNote` 首段有据），rc.3 的 got 仍在
但闭包 shape 变了。**只列不删**：删除要证明「设备上没有这条解析路径」，本轮无设备证据。

### 5.3 `nested` 其余 20 个子项：全部对得上，不动

| 宿主 | 子项 | rc.3 声明 | 结论 |
|---|---|---|---|
| `dsh-acp` | `@agentclientprotocol/sdk 1.4.0` | `1.4.0`（精确钉） | 一致 |
| `dsh-terminal-bash` | `@xterm/headless 6.0.0` | `^6.0.0` | 一致 |
| `dsh-webhook-github` | `@octokit/` 6 条 | 直接只声明 `^14.2.0`；其余 5 条是传递钉 | 一致（`@octokit/webhooks@14.2.0` 实测依赖 `@octokit/request-error ^7.0.0`、`@octokit/webhooks-methods ^6.0.0`、`@octokit/openapi-webhooks-types 12.1.0`；registry 解析链与本表逐条相同） |
| `compression` | `debug 2.6.9` / `negotiator 0.6.4` / `ms 2.0.0` | rc.3 树**无此包的 &lt;dependencies&gt; 语义**（它不在 `packages/`，是 vendorTop 的第三方） | 一致：`compression@1.8.2` 实测 `debug 2.6.9`/`negotiator ~0.6.4`/`ms 2.0.0`（`~0.6.4` 与顶层 `negotiator 1.1.0` 不同 ⇒ 必须嵌） |
| `dsh-otel` | `@opentelemetry/*` 8 条 `0.222.0`/`2.11.0` | 直接声明 6 条（`sdk-metrics`/`sdk-trace` 是传递） | 一致：基座只有 `0.220.0`/`2.9.0` ⇒ 必须嵌 |
| `dsh-session-telemetry-otel` | `@opentelemetry/api-logs 0.222.0` | `0.222.0` | 一致 |

### 5.4 `@deepseek-ai/libreoffice-kit`：**不登记**（本轮明确不动）

- 它现在是 `dsh-office-kit`（rc.3 新包、**已挂载**）的依赖。但 `dsh-office-kit` 对它是
  **`import type` + 惰性 `import.meta.resolve`**，产物 `lib/index.js` 的 import 里没有它，
  missing 分支降级成 `OfficeKitError('unavailable')` ⇒ boot 阶段不解析，**不会启动崩**。
- 门禁侧：`scripts/check-engine-overlay.mjs` 的 `RUNTIME_MISSING_OK` 已按同一理由豁免它
  （与 `scripts/profile-web.cordis.patch.yml` 的说明同源，本轮由适配工作一并更新）。
- 登记它的**连带成本**：`libreoffice-kit@0.2.3` 精确钉 `saxes 6.0.0` / `fflate 0.8.2` / `fontkit 2.0.4`
  （+ optional `koffi 3.1.1`）。基座 `saxes`/`fontkit` **不存在**、`fflate` 是 **0.8.3**（与其精确钉 0.8.2 不符）
  ⇒ 要登记就得连带把三条全链物化，属另一层决策（且照旧解不到能跑的引擎）。
- 因此本轮**不加**这条，把它列入 §8 待裁决。

### 5.5 `extraPresent`：7 条**全留**

逐条做了「删掉它会不会判红」的负控（用基座实测清单 + overlay 重建快照的顶层包集合）：

| 条目 | 删掉后未登记且闭包不可达 | 结论 |
|---|---|---|
| `@img/sharp-wasm32` | 是 | 必需（构建期创建，见 `slim.json.orphanGlobalNodePackages`） |
| `@mistralai/mistralai` | 是 | 必需：基座 `pi-ai@0.82.1` 是它唯一声明者，而 pi-ai 被 pin 成 1.3.0（声明里已无它）⇒ 它变成无来源的基座残留 |
| `@opentelemetry/exporter-logs-otlp-http` | 是 | 必需（基座顶层残留） |
| `@vscode/ripgrep-android-arm64` / `-x64` | 是 | 必需（构建期 `RGPKG` 产出） |
| `clsx` / `scheduler` | 是 | 必需（基座顶层残留，零消费者） |

### 5.6 `keepUnpublished`：4 条**不增不减**

| 条目 | 基座里在吗 | rc.3 树里有吗 | registry 有 rc.3 版吗 |
|---|---|---|---|
| `@deepseek-ai/dsh-client-runtime (0.1.1-rc.2)` | 在（`0.1.1-rc.2`） | 无 | 否（最新就是 0.1.1-rc.2） |
| `@deepseek-ai/dsh-host-apiproxy (0.1.1-rc.2)` | 在 | 无 | 否 |
| `@deepseek-ai/dsh-tool-subagent-report (0.1.1-rc.2)` | 在 | 无 | 否 |
| `@deepseek-ai/node-addon-landlock-run (0.1.1)` | 在 | 无 | 否 |

语义仍是「**未挂载的基座历史残留**」：名字曾在上游存在、版本是基座那一代，rc.3 既不发布也不消费。
两者都成立才配留在这张表里（若哪天上游重新发布同名包，构建期断言会把它顶回来）。

### 5.7 `assemblyInventory.rows`：9 条语义**全部仍然成立**

逐条核了 rc.3 三份 `cordis.patch.yml` + preset 文件：

- `otel` 在 `packages/bundle/base/cordis.patch.yml`（enabled 基础服务）；
- `ui-settings-session-log` / `schedule` / `ui-schedule` / `entry-customization` 在 web-app bundle；
- `desktop-product-telemetry` / `product-analytics` 在 web-app bundle 且**上游自己带 `disabled: !!js …` 条件**（我们另加 `disabled: true`）；
- `time-context` / `tool-schedule` **所在地变了**：从 web-app 主 bundle 移到
  `packages/bundle/web-app/presets/{standard,ptc,cordis}.patch.yml`（三份都在，行号 `standard`:19/38、
  `ptc`:19/38、`cordis`:22/41）。rc.1 与 rc.3 这三个文件的 id 集合与行号**逐字相同** ⇒ 只是"我家 profile 从哪个文件读"的变化，
  语义不变，故 `rows` 的 9 条文案与本轮的 `excludedReason` 都**不改**（实测：
  `rows` 与 `excludedReason` 与 HEAD 逐字节相同）。

## 6. 门禁看得到 / 看不到的

`scripts/check-engine-overlay.mjs`（本版**未放宽、未改动**）能判：根包与 `packages`/`vendorTop`/`pins`/`nested` 的
版本精确一致；`keepUnpublished` 包在树内；反向面（快照内每个顶层包要么已登记、要么由已登记包经
`dependencies`+`optionalDependencies`+`peerDependencies` 闭包可达）；**挂载行**的**传递**运行时依赖缺口
（逐条打印完整引用链）；内置预设载体非空；`slim.json` 基座残留反向断言；vendor 面 license 登记比对。

它**看不到**三类，也正是本轮那些改动必须靠人判的原因：

1. **nested 缺席**：只断言「登记了就在」，新宿主缺嵌套副本不会被发现（§4.2 的 4 条 zod 正是这一类）；
2. **顶层版本落伍**：`[pkg]` 只比「在场 + 版本 == 登记值」，**登记值本身错没错它不判**。
   rc.3 的 zod 就是这一类：`vendorTop` 不给值，基座 4.4.3 在场、门禁全绿，而 49 条挂载行要 4.6.6；
3. **vendorTop 的传递闭包**：正向闭包只覆盖挂载行的 `runtimeDeps` 缺口，不判「物化了但版本不对」。

反向面复算（本轮实测，模型 = 基座实测清单 − `slim.json` 两个剔除面 + overlay 顶层替换 + 构建期产物，
再按门禁同款的 `dependencies`+`optional`+`peer` BFS）：顶层 **682** 个包 / 登记 469 / 闭包可达 772 / **无来源 0**。
——注意这条只在我这个模型里成立；**真值要等快照建出来**（§7）。

## 7. 本机预检实测（能跑的都跑了）

| 预检 | 结果 |
|---|---|
| `JSON.parse`（整文件） | **OK** |
| 顶层键数与顺序 | 20 个，与 HEAD **同序** |
| 全部条目的 semver 形状（packages/vendorTop/pins/nested 共 483 条） | **0 违例** |
| 内部自洽 `packages['@deepseek-ai/dsh-app-boot'] == engineVersion` | **通过**（0.2.2-rc.3） |
| `assemblyInventory.rows` / `excludedReason` 与 HEAD 逐字节相同 | **通过**（§5.7） |
| `patchBytes` / `patchSha256` 对落盘文件复算 | `5732` / `d2ee86c4…` —— **一致** |
| `node scripts/check-engine-overlay.mjs` | **未跑，缺快照产物**：本工作树没有 `snapshot.tar.xz`，该门禁的全部断言都建立在快照 tar 流上。**不能当通过。** |
| 快照构建 / 设备验证 / 单元测试 | **均未做**（本轮按指令不构建、不跑测试） |

## 8. 未决点（需裁决）

1. **`@deepseek-ai/libreoffice-kit@0.2.3` 是否登记**（§5.4）。要不要为了「Office 转换在设备上给
   unavailable 而不是模块缺失」把 `libreoffice-kit` + `saxes 6.0.0` + `fontkit 2.0.4` + `fflate 0.8.2`
   四条一起物化？现口径是不登记（`RUNTIME_MISSING_OK` 豁免），代价是设备上这条能力永远走降级分支。
2. **vendorTop 的 20 条 got 传递闭包残留**（§5.2 候选清单）。rc.3 的 `got` 闭包 shape 已变，这批条目
   在最终快照里零消费者。删不删需要一次设备证据（「这些解析路径设备上不会被走到」），本轮无证据，**只列不删**。
3. **`@tanstack/react-virtual@3.14.10`** 在最终快照里零声明者（rc.3 全树只有 devDependencies 声明）。
   留（现状）还是删，属口径选择；删之前要先确认 `dsh-client-ui-trajectory` 的构建产物不再需要它。
4. **`zod` 顶层钉 4.6.6 与 npm 闭包 4.6.7 的差**（§4.1）。本轮按「上游锁 + 76 个精确钉」选 4.6.6。
   若将来有包只接受 `4.6.7`，这条要重新裁决。
5. **`assemblyInventory.rows` 是否要为 `time-context`/`tool-schedule` 的所在地变化补一句**（§5.7）。
   本轮判「语义不变、不补」，若评审要求可读性更强，可在 `rows` 的两条文案里各加一句"rc.3 起在 presets/*.patch.yml"。
6. **`zod` 未登记进 `scripts/snapshot-config/engine-overlay-licenses.json`**。门禁的 license 断言是「登记了就比对、没登记就跳过」（`check-engine-overlay.mjs` 里的 `if (expected !== undefined)`），所以不登记**不会判红**；但 `vendorTop` 现在有 21 条未登记（含本轮新增的 `zod`，以及 rc.1 轮新增的 `acorn`/`birpc`/`rrule` 等），属既有缺口。补登记要先从 tgz 实测 license 字段，本轮未做（不在授权改动面内）。

## 9. 复算命令

```sh
# 生成器身份（协调仓只读）
git -C D:/coding/dsh-mobile rev-parse HEAD                       # 284799d975009cc88b6a638b641f273a7a127b1b
sha256sum D:/coding/dsh-mobile/scripts/gen-engine-overlay.mjs    # ad575bd9…1873f3

# 上游身份
git -C .deploy-tmp/survey-022rc3/upstream-022 rev-parse HEAD      # 38a6a5c9…62fced
git -C .deploy-tmp/survey-022rc3/upstream-022 describe --tags --exact-match HEAD   # dsh-v0.2.2-rc.3

# packages 三段对账（集合差，不用猜）
git show HEAD:scripts/snapshot-config/engine-overlay.json > /tmp/old.json

# 补丁的两层身份
git -C .deploy-tmp/survey-022rc3/upstream-022 rev-parse HEAD:patches/@earendil-works__pi-ai@1.3.0.patch  # 111e09dc…
sha256sum scripts/patches/upstream/pi-ai-1.3.0.patch             # d2ee86c4…（CRLF 检出，5732 B）
grep -n "pi-ai@1.3.0" .deploy-tmp/survey-022rc3/upstream-022/pnpm-lock.yaml   # patch_hash 4e1c90fd…

# rc.3 的 zod 精确钉统计（76 个包，0 条 ^）
git -C .deploy-tmp/survey-022rc3/upstream-022 grep -c '"zod": "4.6.6"' HEAD -- 'packages/**/package.json'

# 基座顶层 zod（4.4.3，无嵌套副本）
tar -xJOf base/base-usr-arm64.tar.xz   usr/lib/node_modules/@deepseek-ai/dsh/node_modules/zod/package.json | grep '"version"'
```

本轮查询缓存（可直接读，避免重跑网络/解包）都在 `.deploy-tmp/rc3-overlay-audit/`：
`base-disk.json`（基座 430 个顶层包的 name/version/deps/optional/peer/nested 实测快照）、
`rc3-pkgjson.json`（374 个上游 manifest）、`rc1-pkgjson.json`（372 个，用于 rc.1↔rc.3 对比）、
`mounted.json`（206 行挂载集）、`npmprobe/`（真实 npm 安装的 670 包布局）。
