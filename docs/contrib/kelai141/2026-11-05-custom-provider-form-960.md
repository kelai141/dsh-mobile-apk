# 自定义模型提供商表单的三个陷阱（#960）

同一个面「设置 → 模型 → 添加模型提供商 → 自定义模型 API」上的三条缺陷，同一个 PR 逐条修。
三条都不是文案问题，是**取数路径与 DOM 语义**问题，所以都落在构建期引擎补丁上（不改上游源码树）。

## 现象与真因（逐条）

### 高：「获取可用模型」拉的是内置目录，不是自定义端点

复现：填 API 地址 `https://d1api.xin/v1`、协议 `openai-completions`、密钥，点「获取可用模型」，
弹出 193 条与本端点无关的内置条目（`amazon.nova` / `zai.glm-5` / `xai.grok-4.7` …）。

真因在 `dsh-llm-pi-ai` 的 `discoverModels` 第一段：

```js
if (request.provider !== void 0) {
  const installed = catalogModels(request.provider);
  if (installed.size > 0) return [...installed.values()].map(...)
}
if (request.baseURL === void 0 || request.baseURL.length === 0) throw new LlmError(...)
```

只要请求带了 provider、且该 provider 在 pi-ai 内置目录里，就直接返回整份目录，**baseURL 根本不会被用到**。
实测 pi-ai 1.1.0 的 `amazon-bedrock` 恰好 **193** 条，与 issue 里的条数一致。

注意 UI 侧的形状本来是对的：`CustomProviderCard` 给 `ModelListEditor` 的 probe 是
`{ settingsNs, baseURL, api, apiKey }`，**没有 provider 字段**。所以修在适配器这一层：
「显式给了 baseURL 就端点优先」，任何调用方都不会再踩同一个坑。

### 中：「添加模型」未点时已有提示，但输入行为 0

`CustomProviderCard` 的 `models` 初值是 `[]`，行只在点「添加模型」时
`onChange([...models, { id: "" }])` 才出现；而提示语 `hint` 的判据是
「`ready === false` 且其余字段都合法」⇒ `t("customNeedsModels")`。
于是「没有行」和「字段没填」被当成同一件事，提示先于任何输入出现。

issue 给的是二选一，选**初态就渲染第一行**：只藏提示会把「按 aria-label 填进零高隐藏节点、
DOM 读得回值但 state 里没有」留在原地，而那条才是用户真正会踩的坑。

连带面（同一逻辑改动，不可拆）：初态那一行是**占位**。用户若直接点「获取可用模型」→「添加所选」，
`adoptPicked` 会把 models 全部收进 `byId` 再 onChange，占位空行会被一起带过去 ⇒ 模型 1 恒报
「模型 ID 不能为空」、提交按钮永远 disabled。所以采纳时按 id 非空过滤。

### 中：三个 `section[aria-label="模型目录"]` 重名

`ModelListEditor` 的 section 一律 `"aria-label": t("models")`。而「添加提供商」卡片里
catalog 面板与 custom 面板**同时挂载**（隐藏的那个只有 `hidden` 属性，节点仍在 DOM 与无障碍树里），
加上已配置 provider 的行，同屏就有多个同名 section。隐藏面板里的「API 地址」「API 密钥」「模型 ID 1」
与当前面板完全重名 ⇒ 按 label 定位必错，读屏也分不清在编辑哪一个。

修法：label 追加归属标识（`t("models") + " · " + (provider ?? t("customTag"))`），
并给隐藏面板补 `aria-hidden`，把它移出无障碍树。不改 `t("models")`——那是全页共用的词条。

## 判据与负控

三条判据都打在**产物语义**上，不是源码文本切片；每条都配一个负控（把实现改回缺陷形态，判据必须变红）。

| 缺陷 | 判据 | 负控实测 |
|---|---|---|
| A 高 | 注入桩 fetch，断言请求 URL 恰为 `{baseURL}/models`，返回的是端点自己的模型；端点 500 时抛错并点名端点 | 退回 provider 优先：fetch 调用 **0 次**、结果 **193 条**内置目录、端点模型不在其中 |
| B 中 | 真实 DOM 渲染后量「模型输入框数」与「提示语」是否一致 | 初值退回 `[]`：**0 行** + 提示 `customNeedsModels` 在场 |
| C 中 | 同屏所有已渲染 section 的 `aria-label` 互不相同；隐藏面板已带 `aria-hidden` | label 退回裸 `t("models")`：唯一性判据立刻为假 |

实测（修前 → 修后）：

- A：`fetch calls: [] → ["https://d1api.xin/v1/models"]`；`193 条内置目录 → 端点返回的 1 条`
- B：`modelInputs 0 → 1`；提示 `customNeedsModels → model 1: modelIdRequired`
- C：`sections ["models","models"] → ["models · customTag"]`；隐藏面板 `aria-hidden=false → true`

## 为什么用构建期补丁而不是改上游

目标包 `dsh-client-ui-settings-models` 与 `dsh-llm-pi-ai` 都在引擎 overlay 里（`scripts/snapshot-config/engine-overlay.json`），
随快照固化，所以走 `scope: engine` 补丁：`apply-patches.mjs` 的 `IMPLS` 表 + `registry.json`，
锚点「恰好命中 1 处」否则拒写回，幂等（重复施加字节不变），半补丁状态拒绝写回。

夹具从**构建期同一批 tgz**捕获（`probe-engine-anchors.mjs --fixtures`），与快照引擎树逐字节同源。
本次新增 `dsh-client-ui-settings-models-0.2.1-rc.3` 夹具（该包此前不在基线夹具集里）。

## 复验

```powershell
node scripts/check-code-map.mjs
node scripts/check-release-gates.mjs
node scripts/check-kotlin-comments.mjs
node scripts/check-patch-fixtures.mjs
node scripts/check-patch-mirror.mjs --self
node --test scripts/patches/tests/custom-provider-form-960.test.mjs
cd dsh-client-ui-responsive; npx vitest run tests/custom-provider-form-960.spec.tsx --environment jsdom
```

未做设备验证：本条未跑模拟器三层验收（代码层已过；CDP 层与 ADB 用户实际体验层未做）。
