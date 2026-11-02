# 四家订阅提供商的推理回传

范围来自 [issue #1304](https://github.com/kelai141/dsh-mobile-apk/issues/1304) 正文、三条评论与本轮补充。最后的界面要求优先：**空摘要也保留普通「思考」折叠行**，有摘要则正常显示；不补造摘要。

## 数据与协议

沿用上游 `source.replayState`，不另建会话存储。`response.dshReasoningScope` 绑定实际解析出的提供商、API、模型、端点及账号身份摘要；`blocks[].dshSealed` 保存完整 Claude 块或带写出者身份的 Copilot 凭证。摘要留在普通 reasoning 内容，凭证只在 replay 元数据中。每个块独立保存，空文本不会丢掉密文。

| 路径 | 展示 | 回传 |
|---|---|---|
| Codex Responses | summary，允许空 | reasoning 的 id、summary、encrypted_content；省略 content，缺失 summary 写 `[]` |
| Grok Responses | summary/reasoning 文本，允许空 | 同上；只在终止事件返回密文时补回原块 |
| Claude Messages | thinking；omitted/redacted 为空 | 完整 thinking/redacted_thinking 块；保留 signature/data、空 thinking、display 和原顺序 |
| Copilot | reasoning_text/summary，允许空 | Chat Completions 原样保存并回传 reasoning_opaque；多个值分段保存，工具结果按段配对。Responses/Claude 模型走对应原生协议 |

[OpenAI 文档](https://developers.openai.com/api/docs/guides/reasoning)、[Claude 文档](https://platform.claude.com/docs/en/build-with-claude/thinking)与 [xAI 文档](https://docs.x.ai/developers/model-capabilities/text/reasoning)分别说明原生推理项和凭证的回传方式。不同 API 的签名不可混用，不把 Claude 块伪装成 Responses 密文，不增加跨协议转换依赖。

Copilot 的公开字段依据是微软官方客户端的 [ThinkingDataInMessage](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/thinking/common/thinking.ts) 与 [CopilotChatEndpoint](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/copilotChatEndpoint.ts)。`reasoning_opaque` 是完整不透明值，不能把不同段的值拼接。CAPI 每条消息一个值，因此分段序列化，并把各段工具结果放回对应调用之后；重复或缺失结果明确报错。字段清单探针只输出路径/类型，本轮没有把模拟结果写成真实账号观测。

Responses 每个工具步骤先排 reasoning，再排该步骤的其他内容，不把凭证移到另一工具批次。Claude 块保持原顺序。外来推理不转成 assistant 正文；切换账号、模型、API 或端点时剥离旧凭证并报告 `REASONING_SCOPE_MISMATCH`。旧历史无法确认归属时同样处理。JWT 使用 issuer/subject/tenant 保持刷新后的身份稳定；不透明 token 轮换会保守拒绝旧凭证并告警。

Chat Completions 收到未适配的 encrypted_content/signature 会明确报错。仅在 compat 明确要求 reasoning_content 时补缺省空格。诊断只导出字段路径和类型，不改写存储信封；损坏的信封报固定错误码，不回显原值。

## 长推理与界面

空摘要与非空摘要共用上游中英双语折叠组件。流式开始、结束和历史重载都保留行。密文不参与文本、HTML、属性或预览。

`onProviderStreamEvent` 调用既有 `idleWatchdog.pulse()`。真实后端事件即使没有可见摘要，也重新计时；不制造文字、虚假 token 或永久续命。完全无事件仍按配置超时，取消仍按原信号处理。长推理正控和去掉 pulse 的超时负控一起运行。

## 升级防线

实现为 `scripts/patches/data/reasoning-envelope-1304.mjs`；登记 id 为 `sealed-reasoning-1304`，依赖官方 streaming 补丁。所有文件先准备完整 plan，锚点缺失或重复即拒绝，不写半套补丁。已打标记但契约不完整也拒绝。UI 的一处双行锚点允许缩进差异，语句必须匹配且唯一。

两仓 PR Gate 从当前 contract.baseline 及对应 pi-ai 夹具读取版本，在独立目录安装依赖，运行负控和 HTTP/SSE 两轮回传。测试服务只在 `scripts/patches/tests/`，不注入快照。升级步骤：

1. 更新合同及 overlay，重新捕获真实构建夹具，不拿旧版本伪造输入。
2. 跑 `node scripts/probe-engine-anchors.mjs --fixtures` 与 `node scripts/check-patch-fixtures.mjs`。
3. 跑 reasoning 单测及集成测试；验证幂等、兼容变更、漂移、残缺标记与真实协议客户端。
4. 新增字段、改协议或上游吸收时审阅差异，更新适配或正式退役，不能跳过失败发版。

防线保证不兼容升级显式失败，不承诺未知上游改动自动兼容。

## 本轮验证范围

- 单测：存取后字节不变、顺序、身份隔离、空摘要、错误脱敏；删除回放/content:null/改位/截断负控。
- HTTP/SSE：四家与 Copilot 三种 API；两轮间经过 JSON 存取；终止事件补密文、摘要、未知密文字段和长推理负控。
- Android Node：调试模拟器热推实际运行时后运行同一协议套件，不依赖真实账号。
- WebView：实际加载的 AssistantMarkdown/ReasoningRow，临时挂载测试输入。CDP 验证空/非空行及 DOM 无凭证；ADB 竖屏中文、横屏英文点击展开并截图。这是组件与协议模拟验收，不冒充真实账号全会话验收。
- 用户明确允许公开协议模拟替代本轮真实账号测试。未验证真实订阅服务，未构建最终 APK；发布前须按候选流程重建、补验。

本地证据为 `.deploy-tmp/issue-1304/` 下的 unit.log、integration.log、device-wire.log、anchors.log、ui-02-en-landscape.png、ui-03-zh-portrait.png。截图只含测试摘要。

可审阅证据：[中文竖屏](evidence/reasoning-1304/zh-portrait.png)、[英文横屏](evidence/reasoning-1304/en-landscape.png)、[模拟字段清单](evidence/reasoning-1304/simulated-field-inventory.json)。
