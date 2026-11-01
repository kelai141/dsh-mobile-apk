# dsh-plugin-subscriptions（vendored）

本目录是第三方插件 **dsh-plugin-subscriptions@0.9.12** 的 vendored 副本。

| 项 | 值 |
| --- | --- |
| 上游仓库 | <https://github.com/V1ki/dsh-plugin-subscriptions> |
| 发行版 | npm `dsh-plugin-subscriptions@0.9.12`（tarball shasum `a3aff899f615cec19f56b4bf11026a6cbf696382`，integrity `sha512-OHW6LsNjmfQ7gFZ734Lbz9iVtrPeWAaQz2sAzSezNDgyNGpEBzvLufGhzwffh1VgWz2TW8AMJ/JpgBec5Lscrg==`） |
| 上游 gitHead | `b8023110864494acefc6f5963c2a197d85dda20c`（package.json 的 `gitHead` 字段；无对应 tag 时以此为准） |
| 许可 | MIT（原文见本目录 `LICENSE`，随快照分发，见下「MIT 许可原文保留位置」） |
| 解包体积 | 上游 npm 包 2,063,168 B / 143 文件；本目录裁掉源映射与类型声明后 **1,378,304 B / 68 文件**（见差异 #4） |
| 定位 | 把 ChatGPT(Codex)/Claude/Grok/Copilot 订阅当 LLM provider；OAuth 在 Settings → Subscriptions |

## 为什么 vendor（而不是直接依赖 npm 版本）

上游的依赖声明与本平台栈**已经错位**：它把 `undici` 声明在 `dependencies` 且钉 `^7.0.0`，而本仓快照的引擎树自带
`undici@8.11.2`。这说明该包大概率停在旧 DSH 上、不会跟随我们的升级节奏。若直接跟随它的版本声明，我们要么
物化一份 7.x（1.5 MB / 195 文件，且与引擎内那份并存、锁两个版本），要么靠 8.x 去顶 `^7`——后者是**改对方契约**：
等它真用到 7→8 的差异时，我们会得到「看起来能用」的假活。

因此取 vendored 路线：**拿进来自己维护，依赖对齐我们的栈**，协议与登录流程一字不改。

## 与上游的差异（逐条，均只动依赖与装配）

| # | 面 | 差异 | 理由 |
| --- | --- | --- | --- |
| 1 | `package.json` | 删除 `devDependencies`、`scripts`、`packageManager`、`pnpm` 四个字段 | 本仓只消费**已构建的** `lib/`（npm 发布产物），不在此目录编译或安装。保留这些字段只会让 `check-contract.mjs` 的版本钉与构建期工具链产生无意义漂移（实测：21 条 `@deepseek-ai/dsh-*` devDep 钉在 `0.2.1-rc.2`，与本仓基线 `0.2.1-rc.3` 不符） |
| 2 | `package.json` | `undici` 从 `dependencies: "^7.0.0"` 改为 `peerDependencies: ">=8.11.2"` | 由引擎提供同一份实例，不物化第二份（省 1.5 MB / 195 文件、省一份锁版本）。8.x 可用性见下「undici 7→8 判定」 |
| 3 | `package.json` | `@deepseek-ai/dsh-{attachment,home-paths,llm,tools,web}` 的 peer 区间收窄为精确 `0.2.1-rc.3`；`@deepseek-ai/cordis` → `4.0.5`，`@deepseek-ai/schemastery` → `3.18.5` | 上游写的是 `>=0.2.0-rc.2 \|\| >=0.2.1-0` 这类**过宽区间**。本仓的 `check-contract.mjs` §6 要求注入集内每个包的 dsh peer 必须等于运行时版本（过宽区间 = 未判兼容），且宽区间在 pre-release 语义下也可能误判满足。收窄到运行时版本是既有约定（对照 `vendor/dshmarketplace-plugin` 的同款处置） |
| 4 | 文件面 | 删除 `lib/client.js.map`（283,738 B）与全部 68 个 `*.d.ts`（279,316 B） | 与快照既有裁剪口径一致：`slim.json` 的 `sourcemapDelete`（全树 `.map`）与 `extensionDelete`（引擎子树 `.d.ts`）。二者在运行期零消费者——Node 执行 `lib/*.js`，源映射与类型声明不参与；`inject-all.py` 本来也只注入 `lib/**` 且排除 `.map`。留在 vendor 里只会让「仓库体积」与「快照体积」两套数字各说一套 |
| 5 | `lib/http.js`、`lib/index.js` | **代理面安全修（issue #1282）**：新增 `urlCredentials()`（从 URL userinfo 取凭据）与 `redactProxyUrl()`（剥掉 userinfo）；`proxyGetConfig` 回包不再带 URL 内嵌密码（直接剥掉而非打码），`passwordSet` 把 URL 内嵌密码也算作「已设置」；`normalizeConfig` 把 userinfo 提升为独立的 `username`/`password` 字段；`parseProxyUrl` 的错误文案改走 `redactProxyUrl` | 上游把密码当作配置里的一等字段，但**也接受**代理客户端通行的 `http://user:pass@host:port` 写法。后者的密码活在 `url` 里，于是同一条 `url` 被原样回给浏览器（页面输入框与状态行显示明文）、`passwordSet` 恒 `false`、校验失败的报错把整条 URL 连密码写进文案。属于**机密外泄**而非风格问题，故对上游运行时代码做最小改动；判据见 `scripts/subs-proxy-secrets.test.mjs`（随机串夹具 + 序列化后全舰搜索 0 命中） |
| 6 | `lib/translate/sse.js`、`lib/translate/{chat-completions,responses,anthropic}.js`、`lib/providers/common.js`、`lib/providers/{claude,codex,copilot,grok}.js` | **SSE 面加固（issue #1284）**：① `parseSse` 增加 `MAX_PENDING_CHARS`（8 MiB，推导见该常量注释：上限由「单个合法帧」决定，而单个合法帧的上界是仓库的 5 MiB 附件上限的 base64 形态，不是响应总长度），超限即失败关闭并报出实收长度；② `idleWatchdog` 把「字节进展」与「帧进展」拆成两个时钟，新增 `progress()`/`event()`/`snapshot()`/`stallReport()`，`TIMEOUT` 错误带上现场快照并可区分 `idle`（零字节，中止）/`trickling`（有字节无帧，不中止但可观测）/`healthy`；③ EOF 时派发未以空行收尾的最后一帧（SSE 规范允许这种收尾） | ① 一条不换行的响应流能把宿主内存吃光，而「空闲超时」这道防线正好被同一股流量关掉（每 chunk 重置）；② 没有可观测事实时「慢但在走」与「真卡住」无法区分，改计时器也无法验收；③ 服务端以「末帧不补空行」收尾是规范允许的，原实现让整轮对话报 `STREAM_CLOSED` 且文案指向网络。三项都只在构造字节流上复现，判据见 `scripts/subs-sse-limits.test.mjs` |
| 7 | `lib/client.js` | **竖屏可读性修（issue #1288 第 10、11 条）**：① 供应商卡标题前的状态点补 `aria-label`（新增 `dotState()` 三态映射 busy/linked/unlinked + 6 个文案键），颜色与尺寸**未改**；② 账号行溢出修：`accountHeader` 补 `minWidth:0` + `flexWrap:wrap`，`accountName` 补 `minWidth:0` + `overflowWrap:anywhere`，`accountRow` 补 `minWidth:0`。原本这三处都缺 flex 收缩，长邮箱与过期时间会把整页撞宽、`退出登录` 按钮被挤出卡片右边界 | ① 状态点本身有真实三态（黄=busy/绿=已登录/灰=未登录，见 `dotColor`），但它在无障碍树与肉眼上都只能靠颜色猜，用户报「看不懂这个点」；只是补语义，不改设计、不加图例。② 真因不是「文字太长」，是 flex 子项默认 `min-width:auto` 不可收缩 + 按钮 `flexShrink:0`，于是窄屏上整行按内容宽度铺开并撑宽容器（`scrollWidth > clientWidth`，整页可左右滑）。判据见 PR 正文 |

**未改动**：`lib/` 下运行时代码**除上表第 5、6 条所列代理面与 SSE 面外**逐字节保持上游（仅另删上表第 4 条的 `.map` / `.d.ts`）（含 provider 实现、OAuth 流程、token 存储路径 `~/.dsh/plugins/subscriptions/auth.json` 与其 0600 权限）、`cordis.patch.yml`、`README.md`、`LICENSE`。

## 我们删了什么、为什么

**删除了上游的第五家 provider（Google Antigravity）及其全部实现。**

| 面 | 具体删除 |
| --- | --- |
| 独立模块 | `lib/providers/antigravity.js`、`lib/providers/antigravity-oauth-client.js`、`lib/translate/antigravity.js`、`lib/translate/antigravity-schema.js`、`lib/translate/antigravity-thinking.js` |
| 打包副本 | `lib/index.js` / `lib/client.js` 内对应的 5 个 `//#region` 段（translate ×3 + oauth-client + provider）及其全部调用点 |
| 注册与能力声明 | `PROVIDER_IDS` 列表项、`providerIdSchema` 联合项、`Config.providers` 默认值、`models` 目录项、`PROVIDER_TOOLS` 项、适配器注册分支、OAuth flow/exchange 分支、用量抓取分支、配置 schema 段 |
| 客户端 | `ProviderAccountManager` 的 provider 列表项、`PROVIDER_NAMES` 显示名、用量徽标的按模型窗口逻辑、`usage-window-filter` 的模型可见性分支 |
| 文档 | `README.md` 的 provider 表行与相关段落 |

**为什么删（三条，按权重）**

1. **不发这个 provider**。本仓只需要 ChatGPT(Codex) / Claude / Grok / Copilot；Antigravity 不在产品盘子里，带进来只有维护成本。
2. **上游在这条路由里嵌入了 Google OAuth 应用级凭据**（客户端 ID + 客户端 Secret 两个常量，硬编码在 `antigravity-oauth-client` 段）。它们确实不是用户 token，但**放进本仓历史就等于我们永久背这个包袱**：GitHub Push Protection 会阻断每一次包含该提交历史的推送，后续只能靠「允许该 secret」或关闭仓库规则来维持——那是把安全闸门长期放宽去换一个我们本来就不需要的功能。
3. **不解除阻断、不改登录流程**。两条替代路径都被否掉：点 unblock 链接 = 把仓库规则长期放宽；改成纯配置注入 = 改动面最大且让该 provider 开箱不可用。

**影响面：其余四家 provider 不受影响**——Codex / Claude / Grok / Copilot 的模块、OAuth 流程、token 存储、用量抓取、客户端设置页全部保留原样；它们各自只有**公开 client_id**（PKCE/设备流的标准做法，无 secret），不属于需要裁剪的嵌入式凭据。

**追版注意**：上游若继续发 Antigravity，追版时必须重做本节裁剪，否则 Push Protection 会再次阻断。裁剪步骤：删上述 5 个模块 → 删 `lib/index.js`/`lib/client.js` 的对应 region → 清注册表/配置 schema/客户端列表 → `grep -ri antigravity` 归零。

## undici 7→8 判定（为什么 peer 到 8.11.2 是安全的）

插件实际用到的 undici API 只有两处导出、五种调用：

| 位置 | 用法 |
| --- | --- |
| `lib/http.js:16`、`lib/index.js:6` | `import { ProxyAgent, fetch as undiciFetch } from 'undici'` |
| `lib/http.js:197`、`lib/index.js:410` | `new ProxyAgent(url.toString())` —— **只传 URL 字符串** |
| `lib/http.js:216,293,427` | `agent.close().catch(...)` |
| `lib/http.js:362` | `fetch(url, { ...init, dispatcher })` |

`Agent` **不直接使用**（源码里两处 "Agent" 均为 `User-Agent` 注释）。

对照实测（node v24.17.0，undici 8.11.2 vs 7.30.1）：

- 导出面一致：`fetch` / `ProxyAgent` / `Agent` 均为 `function`；
- `ProxyAgent` 的 `#getUrl` 两版**逐字节相同**，字符串入参均受支持；8.x 新增的 `connectTimeout` / `proxyServername` 皆可选，不传即旧行为；
- `close()` 两版均返回 Promise；
- `dispatcher` 路由：8.11.2 实测通（本地假代理收到请求并回 `200 via-proxy`）；HTTPS 目标两版都走 `CONNECT`；
- engines：8.x 要求 `>=22.19.0`，设备 node 为 `v24.18.0` ✓。

**唯一的 7→8 语义差异**（`lib/dispatcher/proxy-agent.js`）：

- 7.x：`const { proxyTunnel = true } = opts` —— 默认**总是**隧道；
- 8.x：`const { proxyTunnel } = opts` + `shouldProxyTunnel(reqProto, t) = t === true \|\| reqProto !== 'http:'` —— 默认 **http 目标不隧道**、https 仍隧道。

插件**从不传** `proxyTunnel`，且全部请求目标为 https（Anthropic / ChatGPT / x.ai / GitHub Copilot），落到的分支两版等价。**逆转条件**：若日后要支持 http 代理目标，需显式传 `proxyTunnel: true`。

## 装配与解析（本仓侧如何让它跑起来）

- 注入：`scripts/plugin-dirs.json` 的 `externals` → `scripts/inject-all.py --external` → `home/.dsh/profiles/{web,headless}/node_modules/dsh-plugin-subscriptions/`；
- 挂载：`scripts/profile-web.cordis.patch.yml` 的 `- insert: { id: llm-subscriptions, name: dsh-plugin-subscriptions }`；
- 依赖解析：Node 从插件位置向上只能到达 `profiles/node_modules`（共享农场），到不了引擎树。故 `build-snapshot-013.mjs` 的「8a3b. profile 共享农场补齐」按 `PROFILE_SHARED_LINKS` **幂等**建相对链
  `home/.dsh/profiles/node_modules/undici -> ../../../usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici`；
  目标每次按 `ENGINE_NM_STAGE` 现算，引擎目录换代自动跟随。
- 门禁：`scripts/check-profile-undici-resolution.mjs`（从 profile 锚点 `require.resolve('undici')`，断言 ≥ 8.11.2、落在快照树内而非仓库根 devDependency、且来自引擎树；`--negative-control` 移走该链后必须判红）。

## MIT 许可原文保留位置

上游 MIT 许可**全文**随本目录分发于 `vendor/dsh-plugin-subscriptions/LICENSE`（1061 B），并经注入链进入快照
`home/.dsh/profiles/{web,headless}/node_modules/dsh-plugin-subscriptions/LICENSE`（`inject-all.py` 的
`EXT_INCLUDE_FILES` 显式包含 `LICENSE`，不会因裁剪而丢失）。

## client UI 切点（本轮不动，后续由我们自己的原生卡替代）

**本轮不改任何 client 代码**，上游设置页原样保留。切点如下，便于日后替换时分清归属：

| 面 | 路径 | 说明 |
| --- | --- | --- |
| 客户端 bundle 入口 | `lib/client.js`（由 `lib/client/index.js` 构建） | package.json `exports["./client"]` + `dsh.client.platform = "web"` |
| Settings 页主体 | `lib/client/SubscriptionsSection.js`（48,720 B） | 「订阅」卡片/入口的 DOM 与样式来源 |
| 账户管理/模型编辑 | `lib/client/ProviderAccountManager.js`、`ProviderModelEditor.js` | 与我们原生卡的对接面 |
| 用量徽标 | `lib/client/SubscriptionUsageBadge.js`、`usage-badge-preferences.js` | 侧栏徽标 |
| 样式 | `lib/client/provider-settings-styles.js` | 移动端布局适配的落点 |
| 客户端 RPC | `lib/client/subscriptions-rpc.js` | 与宿主半的 `auth/rpc.js` 对应 |

替换时的判定线：**上游 client 文件一旦被我们的原生卡取代，就应把对应文件从本目录删除并在本节登记**，
而不是留着两份同语义实现（「同一事实只写一处」）。宿主半（`lib/index.js`、`lib/providers/**`、`lib/auth/**`、
`lib/http.js`）不受该替换影响，继续复用。

## 追版须知

追版时按上表逐条重新判定差异是否仍需要（上游可能已自己修好）。逐字节比对的基准是
`npm pack dsh-plugin-subscriptions@<ver>` 的解包结果：除本文件「与上游的差异」表所列之外，其余文件应与上游一致。