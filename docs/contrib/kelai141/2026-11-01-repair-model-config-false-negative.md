# 修复助手读不到模型：marker 当读取开关、三 id 白名单（两处假阴性）

引擎能用、修复助手说「没有可用模型」——同一份 `files/home/.dsh` 下两个读取方给出相反结论。
这类误判比真缺配置更危险：用户会按提示去重复配置，越配越乱。

## 现象

- 引擎连续两次启动失败后拉起修复助手，进入「模型」时提示「DSH 尚无可用模型配置」/「未读到可用模型」，
  于是助手既不能选模型也无法开始修复。
- 用户的配置其实在：
  1. `files/home/.dsh/settings.yaml` 里有 provider、模型与 `apiKeyEnv`，`.credentials.yaml` 里有对应 key；
  2. 或者用户在「设置 -> 模型」里自己加过一条 OpenAI 兼容 provider / 订阅型 provider。
- 两个现场分别由下方夹具 A/A2 与 B 复现（单元层）；设备层本轮未跑，结论以夹具与源码判据为准。

## 真因一：把迁移标记当成「以后别读这个文件」的开关

旧实现是 `if (!File(dsh, "settings.yaml.imported").isFile) { 读 settings.yaml }`。

`settings.yaml.imported` 由引擎迁移时写下，它只证明**曾经迁过**，既不证明迁移目标现在还在，
也不证明用户的 provider 都搬进了 patch。于是「引擎没完成迁移就死了」这种最需要修复助手的现场
（marker 在、`profiles/web/cordis.patch.yml` 缺失或只含非模型键）两边都不读，候选数为 0。

#924 之后它被放宽成「patch 层没有候选时才回落读 settings.yaml」（来源状态 `skipped-legacy` /
`fallback-used` 就是这一版的产物）。这仍是同一个误判的弱化版：只要 patch 层碰巧产出一条候选——
哪怕是用户根本没在用的路由——`settings.yaml` 里真正被选中的那条就再也不读了。
两代写法的共同错误是**让别的证据决定旧文件读不读**，而不是让它无条件铺底。

## 真因二：provider 发现按三条插件 id 白名单

旧实现只认 `llm-pi-ai` / `llm-deepseek` / `agent-default-model`，名单外条目的 config 整条丢弃。

可「设置 -> 模型」里加的自定义 OpenAI 兼容 provider、订阅型 provider、用户自装的 llm 插件
都是**独立插件 id**。配置明明能拼出「路由 + 至少一个模型 + baseURL + 可解析凭据」，
却因为 id 不在名单里被当成不存在。

## 为什么是假阴性，而不是「没配置」

- 判据是「引擎能用、助手说不能用」：两条路径读同一个 `home`，引擎照常调模型，助手零候选。
  这说明读取方与引擎对「哪些条目算 provider」的判据不一致，不是用户少配了东西。
- 两种误判的修法完全相反：真缺配置要用户写配置；假阴性要改读取方。把「读不到」当成「没配置」
  写进文案，用户永远修不好。
- 交叉情景最致命：marker 在场 + patch 有候选 -> `settings.yaml` 整层不读 -> 用户选中的路由消失，
  助手拿一条陌生路由去修，界面上仍是「没有可用模型」。两个根因叠在一起时，症状与「配置全空」同形。

## 修法

1. **settings.yaml 永远铺底**：`buildLayer` 第一件事就是无条件读 `.dsh/settings.yaml`，
   随后 patch 层（bundle patches -> `profiles/web/cordis.patch.yml` -> `.dsh/cordis.patch.yml`）
   按插件 id 深合并覆盖它。marker 不再参与读取，条件回落的机械整块删除。
   来源状态里的 `skipped-legacy` / `fallback-used` 随之不再产出；`RepairModelNotice`
   仍保留这两条文案，只为容错旧版 APK 共享出来的 evidence 文件。
2. **泛化 provider 发现**：不再看 id。任何条目只要能拼出 baseURL + 至少一个模型 + 可解析凭据
   （`apiKeyEnv` / `apiKeyRef` / `tokenEnv` / `tokenRef` 引用，或 `apiKey` / `token` /
   `accessToken` 字面量），就是候选；拼不出来就不是 provider（persona、locale 之类）。
   `providers` 映射形态与扁平形态都认。没有 baseURL 不猜端点——猜错等于给用户一条注定失败的候选。

## 证据形态

- **单元夹具 A**（`markedMigrationDoesNotHideACustomProviderThatOnlyLivesInSettingsYaml`）：
  marker 在、配置只在 `settings.yaml` -> 必须读到候选，来源表 `settings.yaml=parsed`。
- **单元夹具 A2**（`markedMigrationStillTreatsSettingsYamlAsACandidateSourceEvenWhenPatchesYieldSomething`）：
  marker 在 **且** patch 层确实有候选 -> `settings.yaml` 里用户选中的路由仍须在且默认模型可用。
  这一条专门钉「按候选数回落」的残留。
- **单元夹具 B**（`customProviderPluginIdIsDiscoveredWithoutAWhitelist`）：
  `@user/dsh-llm-openai-compat` 这类名单外 id -> 必须成为候选。
- **反面判据（源码扫描，`RepairModelEvidenceTest`）**：`RepairModelConfig.kt` 的代码路径不得再出现
  `settings.yaml.imported`（把 marker 接回来即红）；`buildLayer` 必须有无条件的
  `readInto(sink, File(dsh, "settings.yaml"))` 且排在所有 patch 之前；不得再有 `includeLegacy`、
  不得再产出 `fallback-used` / `skipped-legacy`；同时 `layer.custom` 仍被 `resolve` 遍历、
  `addGeneric(` 仍在——防止「删回落」时把泛化面顺手删掉。
- **设备类**（`RepairModelFallbackDeviceTest` / `RepairUiFallbackDeviceTest`）：社群现场必须读到模型
  且 `settings.yaml=parsed`；patch 与 settings 同 id 时深合并覆盖、其余键仍在；删掉 `settings.yaml`
  的对照组必须零候选并记 `missing`。这两类不在 JVM 上跑。

## 边界与未覆盖面

- 本轮改的是读取层，修复助手的文案表（`RepairModelNotice`）未改；两个历史状态仍可映射，
  旧 evidence 文件共享出来时不会掉进「格式无法解析」。
- 引擎侧迁移逻辑没动：`settings.yaml` 仍会在引擎完成迁移后被删除。「无条件铺底」只是让读取方
  不再自己判断要不要读，不是让旧文件复活；配置真源仍是 patch。
- 设备层两个 instrumentation 类本轮未跑（需要真机/模拟器）。JVM 单测结论以 PR 门禁输出为准，
  本文只记判据形态，不代填结论。
