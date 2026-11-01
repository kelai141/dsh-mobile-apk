window.__ModuleLoader__.load({ id: "dsh-plugin-subscriptions", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);
let __deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
__deepseek_ai_dsh_client_ui_primitives = __toESM(__deepseek_ai_dsh_client_ui_primitives);
let react_dom = require("react-dom");
react_dom = __toESM(react_dom);

//#region src/client/locales.ts
/** Copy dictionaries for the Subscriptions settings section. */
/** English strings (the key-set source of truth for this pair). */
const en = {
	accountsManage: "Manage",
	accountsTitle: "Manage {provider}",
	subscriptionDisplayName: "Subscription display name",
	subscriptionDisplayNameHint: "Used in the quota bar and subscription headings. Leave blank for the default.",
	modelDisplayName: "Model display name",
	modelDisplayNameHint: "Leave blank for the original name. Reasoning effort stays separate.",
	displayNameReset: "Restore default",
	claudePromptCacheTtl: "Prompt cache lifetime",
	claudePromptCacheTtlHint: "How long Anthropic keeps the conversation cache after its last use. Cache reads cost the same either way; a one-hour cache write costs 2× base input instead of 1.25×. Applies from the next turn.",
	claudePromptCacheTtlDefault: "Follow config ({ttl})",
	claudePromptCacheTtl5m: "5 minutes",
	claudePromptCacheTtl1h: "1 hour",
	accountsHint: "Choose which accounts serve pooled LLM requests. Pool exclusion applies only to LLM routing, not tools or session-wide isolation.",
	accountsLoading: "Loading accounts…",
	accountsLoadFailed: "Could not load account settings: {message}",
	accountsSaveFailed: "Could not save changes: {message}",
	accountsEmpty: "No connected accounts. Add an account on the provider card first.",
	accountsAlias: "Alias (optional)",
	accountsPoolEnabled: "Include in the LLM account pool",
	accountsIndependent: "Show an independent entry in the model picker",
	accountsIndependentHint: "Independent LLM routes use only this account, with no fallback to another account. This does not isolate tools or the whole session.",
	accountsModels: "Pool model allowlist",
	accountsModelsAll: "All models",
	accountsModelsCount: "{count} selected",
	accountsModelsHint: "Applies only to pooled LLM routing, not independent entries. An empty selection allows no models. Turning off pool participation keeps this selection for later.",
	accountsModelsAutomatic: "Allow all models, including future models",
	accountsNoModels: "No models reported for this account.",
	accountsCatalogUnavailable: "Model discovery is currently unavailable. Saved model selections are preserved.",
	modelsPartialSave: "Some reasoning defaults were saved. Remaining changes are still in the draft; retry to finish.",
	modelsEdit: "Edit model list",
	modelsHint: "Configure model visibility, default reasoning effort, subagent speed, context and tools here; Save changes below submits them together with the account settings. Hidden models remain usable by existing sessions; tool changes apply to new sessions.",
	modelsAutomatic: "Automatically show all models, including new models",
	modelsSelectAll: "Select all",
	modelsSelectNone: "Clear selection",
	modelsContext: "Context (tokens)",
	modelsContextBounds: "Default {default} · Maximum {max}",
	modelsContextHint: "Leave blank to follow the provider. The requested window is capped by the account’s advertised maximum; account pools use the smallest member window. This controls local history and compaction, not the API’s capacity.",
	modelsContextInvalid: "Enter a positive whole number of tokens for {model}.",
	modelsSubagentSpeed: "Subagent default speed",
	modelsSubagentSpeedHint: "Applies to subsequent subagent requests using this model, regardless of the parent model. Main conversations keep their own Speed setting. Fast requires model support.",
	modelsTools: "Provider tools",
	modelsToolsHint: "Changes apply only to sessions created after saving. Existing sessions keep their tools. Shared tools remain available if any supporting provider is enabled.",
	modelsImage: "Image generation",
	modelsVideo: "Video generation",
	modelsSearch: "X search",
	modelsWebSearch: "Web search",
	modelsSave: "Save changes",
	modelsUnavailable: "Currently unavailable",
	nav: "Subscriptions",
	intro: "Log a subscription provider in or out. Login opens the provider’s authorization page in a new tab; headless setups can paste the callback URL or code instead.",
	unavailable: "Connection unavailable; subscription status cannot be loaded.",
	checking: "Checking…",
	loginInProgress: "Login in progress…",
	notLoggedIn: "Not logged in",
	loggedInCount: "{count} account(s) connected",
	clientVersion: "CLI {version} · {source}",
	clientVersionNpm: "latest on npm",
	clientVersionLocal: "local CLI",
	clientVersionFallback: "built-in",
	clientVersionConfig: "configured",
	clientVersionHint: "Requests present this CLI version, and newer models may require a recent one. It is the latest release on npm, or the local CLI / built-in version while npm is unreachable. Refreshing the model list checks again.",
	accountExpires: "expires {date}",
	defaultBadge: "Default",
	setDefault: "Set as default",
	addAccount: "Add account",
	addAccountOAuth: "Browser authorization",
	addAccountKeychain: "Import Claude Code",
	addAccountHint: "Browser authorization signs in whichever account the browser currently uses — switch accounts there first (or use an incognito window with the manual code below) to add a different one.",
	login: "Log in",
	cancel: "Cancel",
	logout: "Log out",
	providerDotBusy: "Busy: an operation is running",
	providerDotLinked: "Signed in",
	providerDotUnlinked: "Not signed in",
	logoutAccountConfirm: "Log out {account} of {provider}?",
	manualSummary: "Browser flow not working? Paste the callback URL or code",
	manualPlaceholder: "Paste the callback URL or code",
	submit: "Submit",
	loginMissingUrl: "login answered without an authorizeUrl",
	deviceCodePrompt: "Enter this code on the GitHub verification page:",
	deviceCodeCopy: "Copy code",
	deviceCodeCopied: "Copied",
	deviceCodeOpenPage: "Open GitHub verification page",
	usageTitle: "Usage",
	usageRefresh: "Refresh",
	usageLoading: "Loading usage…",
	usageEmpty: "No usage windows reported.",
	usageNoVisibleModels: "No quota windows match the selected models.",
	usageError: "Usage lookup failed: {message}",
	usageSession: "5-hour window",
	usageWeekly: "Weekly",
	usageWindow: "Window",
	usageResets: "resets {date}",
	usagePlan: "Plan: {plan}",
	resetCreditsTitle: "Usage limit resets",
	resetCreditsAvailable: "{count} available",
	resetCreditsError: "Usage limit resets unavailable: {message}",
	resetUseButton: "Use…",
	resetUseChecking: "Checking…",
	resetUseGuard: "You can use this reset when weekly usage reaches at least 80%.",
	resetUseRestart: "Reset details are missing. Restart DSH, reload this page, then refresh usage.",
	resetUseRefresh: "Refresh usage to verify current limits and reset availability.",
	resetUseReady: "Use this reset — the earliest-expiring credit. Confirmation required.",
	resetUseConfirmTitle: "Confirm full reset",
	resetUseWarning: "This consumes one credit and resets weekly + 5-hour limits. This interface cannot undo it. Confirmation expires in 60 seconds.",
	resetUseAcknowledge: "I understand that one credit will be consumed.",
	resetUseConfirm: "Consume 1 reset",
	resetUseSuccess: "Reset confirmed. Usage refreshed.",
	resetCreditFull: "Full reset",
	resetCreditExpires: "Expires {date}",
	resetCreditExpiryUnknown: "Expiry date unavailable",
	modelDefaultsTitle: "Default reasoning effort",
	modelDefaultsHint: "The model picker preselects this level when you switch to the model; models without levels always follow the provider.",
	modelDefaultsFollowProvider: "Follow provider",
	modelDefaultsNoLevels: "{count} model(s) advertise no reasoning levels and always follow the provider.",
	modelDefaultsLoading: "Loading models…",
	modelDefaultsLoadFailed: "Failed to load models: {message}",
	modelDefaultsRetry: "Retry",
	modelDefaultsRefresh: "Refresh model lists (all subscriptions)",
	modelDefaultsSaving: "Saving…",
	modelDefaultsSaveFailedNamed: "Save failed for {model}: {message}",
	modelDefaultsSummary: "{total} model(s) · {configured} overridden",
	modelDefaultsSummaryNone: "{total} model(s) · following the provider",
	modelDefaultsSummaryEmpty: "No model advertises reasoning levels",
	modelDefaultsFilterPlaceholder: "Filter models",
	modelDefaultsFilterEmpty: "No model matches “{query}”.",
	modelDefaultsNoModels: "This provider reports no models.",
	modelDefaultsNoAccount: "No connected accounts. Connect one on the provider card first.",
	modelDefaultsDiscoveryFailed: "Model discovery failed or timed out. Use Refresh to try again.",
	generating: "Generating image…",
	image: "image",
	viewImage: "View image",
	viewImageNamed: "View {name}",
	imageLoading: "Loading…",
	imageLoadFailed: "Retry",
	imagePreview: "Image preview",
	imageClose: "Close",
	generatingVideo: "Generating video…",
	videoLoading: "Loading video…",
	videoLoadFailed: "Video failed to load: {message}",
	usageBadgeTitle: "Subscription usage",
	usageBadgeDisplay: "Status-bar quota display",
	usageBadgeDisplayRecent: "Current / most recent subscription only",
	usageBadgeDisplayHidden: "Hidden",
	usageBadgeDisplayHint: "Saved automatically in this browser. At most one subscription is shown; non-subscription models keep the most recent subscription selected in this view, or show nothing. Hiding does not affect usage details here.",
	usageBadgeDisplaySaveFailed: "Could not save the display preference. Check browser storage permissions.",
	usageBadgeCurrent: "current",
	usageBadgeModelCount: "{count} model quotas",
	usageBadgeModelUnavailable: "Current model quota unavailable",
	usageBadgeMoreWindows: "More quota windows ({count})",
	speed: "Speed",
	speedStandard: "Standard",
	speedStandardDescription: "Default speed",
	speedFast: "Fast",
	speedFastDescription: "1.5x speed, more usage",
	commandFast: "Switch the Codex speed tier (Standard/Fast)",
	commandFastUnavailable: "The current model has no fast tier; /fast only works on Codex models whose catalog advertises one",
	proxyTitle: "Proxy",
	proxyStatusNone: "Plugin proxy disabled — using DSH network settings.",
	proxyStatusEnabled: "Enabled · {url}",
	proxyStatusError: "Config error: {message}",
	proxyConfigure: "Configure…",
	proxyDialogTitle: "Proxy settings",
	proxyDialogClose: "Close",
	proxyEnabled: "Route subscription requests through a proxy",
	proxyDisabledHint: "Proxy off: requests go out directly",
	proxyUrl: "Proxy URL",
	proxyUrlPlaceholder: "http://localhost:7890",
	proxyUrlHint: "HTTP or HTTPS proxy only (Clash/mihomo, v2rayN…); socks is not supported.",
	proxyUsername: "Username (optional)",
	proxyUsernamePlaceholder: "Proxy username",
	proxyPassword: "Password",
	proxyPasswordPlaceholder: "Leave blank to keep the saved password",
	proxyClearPassword: "Clear the saved password",
	proxyBypass: "Bypass hosts",
	proxyBypassPlaceholder: "127.0.0.1, localhost, *.example.com",
	proxyBypassHint: "Comma-separated hostnames that skip this plugin proxy and use DSH network settings.",
	proxyTest: "Test",
	proxyTesting: "Testing…",
	proxyTestOk: "OK · HTTP {status} · {ms} ms",
	proxyTestOkDirect: "OK (DSH network settings) · HTTP {status} · {ms} ms",
	proxyTestFail: "Failed: {message}",
	proxySave: "Save",
	proxyCancel: "Cancel",
	proxySaving: "Saving…",
	proxyLoading: "Loading proxy settings…",
	proxyLoadFailed: "Failed to load proxy settings: {message}",
	proxySaved: "Saved — new requests use the updated network settings.",
	proxySaveFailed: "Save failed: {message}",
	proxyNote: "On DSH v0.1.3-alpha.1, prefer the host HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY settings and leave this plugin proxy disabled. This optional override is retained for older hosts and subscription-only routing. Disabled or bypassed requests use DSH network settings; they are not necessarily direct. Applies to token exchange, model APIs, usage and tools. Browser OAuth follows the browser/system proxy."
};
/** zh strings, one per {@link en} key. */
const zh = {
	accountsManage: "管理",
	accountsTitle: "管理 {provider}",
	subscriptionDisplayName: "订阅显示名",
	subscriptionDisplayNameHint: "用于底部额度栏与订阅标题，留空使用默认名称。",
	modelDisplayName: "模型显示名",
	modelDisplayNameHint: "留空使用原名，推理档位仍单独显示。",
	displayNameReset: "恢复默认",
	claudePromptCacheTtl: "提示缓存有效期",
	claudePromptCacheTtlHint: "Anthropic 在最后一次使用后保留对话缓存的时长。两种时长的缓存读取价格相同；1 小时的缓存写入按基础输入价的 2 倍计费（5 分钟为 1.25 倍）。保存后从下一轮对话生效。",
	claudePromptCacheTtlDefault: "跟随配置（{ttl}）",
	claudePromptCacheTtl5m: "5 分钟",
	claudePromptCacheTtl1h: "1 小时",
	accountsHint: "选择参与账号池 LLM 请求的账号。退出账号池仅影响 LLM 路由，不影响工具，也不代表整个会话隔离。",
	accountsLoading: "加载账号中…",
	accountsLoadFailed: "账号设置加载失败：{message}",
	accountsSaveFailed: "保存失败：{message}",
	accountsEmpty: "暂无已连接账号，请先在服务商卡片中添加账号。",
	accountsAlias: "别名（可选）",
	accountsPoolEnabled: "参与 LLM 账号池",
	accountsIndependent: "在模型选择器中显示独立入口",
	accountsIndependentHint: "独立 LLM 路由仅使用此账号，失败时不会回退到其他账号。这不代表工具或整个会话的隔离。",
	accountsModels: "账号池模型白名单",
	accountsModelsAll: "全部模型",
	accountsModelsCount: "已选 {count} 个",
	accountsModelsHint: "仅影响账号池 LLM 路由，不限制独立入口。清空选择表示不允许任何模型。关闭参与账号池后仍保留此选择。",
	accountsModelsAutomatic: "允许全部模型（包含以后新增的模型）",
	accountsNoModels: "此账号暂未返回模型。",
	accountsCatalogUnavailable: "暂时无法获取模型目录，已保存的模型选择会被保留。",
	modelsPartialSave: "部分推理档已保存，其余更改仍保留在草稿中，请重试完成保存。",
	modelsEdit: "编辑模型列表",
	modelsHint: "在此配置模型显示、默认推理档、子代理速度、上下文与工具，底部的「保存更改」会连同账号设置一起提交。隐藏模型不影响已有会话；工具开关对新建会话生效。",
	modelsAutomatic: "自动显示全部模型（包含以后新增的模型）",
	modelsSelectAll: "全选",
	modelsSelectNone: "清空选择",
	modelsContext: "上下文（token）",
	modelsContextBounds: "默认 {default} · 最大 {max}",
	modelsContextHint: "留空跟随服务商。配置值按账号返回的最大窗口限制；账号池取各成员的最小窗口。此设置控制本地历史保留和压缩时机，不会扩大 API 本身的容量。",
	modelsContextInvalid: "请为 {model} 输入正整数 token 数。",
	modelsSubagentSpeed: "子代理默认速度",
	modelsSubagentSpeedHint: "对使用此模型的子代理后续请求生效，与父会话模型无关。主会话仍使用自己的速度设置；快速档仅在模型支持时生效。",
	modelsTools: "Provider 工具",
	modelsToolsHint: "仅对保存后新建的会话生效，已有会话保留原工具。任一支持的服务商启用共享工具时，该工具仍会显示。",
	modelsImage: "图片生成",
	modelsVideo: "视频生成",
	modelsSearch: "X 搜索",
	modelsWebSearch: "网页搜索",
	modelsSave: "保存更改",
	modelsUnavailable: "当前不可用",
	nav: "订阅",
	intro: "在此登录或退出订阅服务商。点击登录会在新标签页打开服务商的授权页面；无浏览器环境可改为粘贴回调 URL 或授权码。",
	unavailable: "连接不可用，无法加载订阅状态。",
	checking: "查询中…",
	loginInProgress: "登录中…",
	notLoggedIn: "未登录",
	loggedInCount: "已连接 {count} 个账号",
	clientVersion: "CLI {version} · {source}",
	clientVersionNpm: "npm 最新",
	clientVersionLocal: "本机 CLI",
	clientVersionFallback: "内置版本",
	clientVersionConfig: "手动配置",
	clientVersionHint: "请求以这个 CLI 版本号发出，新模型可能要求较新的版本。默认使用 npm 上的最新版本；npm 无法访问时使用本机 CLI 或内置版本。刷新模型列表会重新检查。",
	accountExpires: "过期时间 {date}",
	defaultBadge: "默认",
	setDefault: "设为默认",
	addAccount: "添加账号",
	addAccountOAuth: "浏览器授权",
	addAccountKeychain: "导入 Claude Code",
	addAccountHint: "浏览器授权以浏览器当前登录的账号为准；要添加不同账号，请先在浏览器里切换账号，或用无痕窗口走下方手动授权码。",
	login: "登录",
	cancel: "取消",
	logout: "退出登录",
	providerDotBusy: "正在处理",
	providerDotLinked: "已登录",
	providerDotUnlinked: "未登录",
	logoutAccountConfirm: "确定退出 {provider} 的账号 {account} 吗？",
	manualSummary: "浏览器流程无法完成？粘贴回调 URL 或授权码",
	manualPlaceholder: "粘贴回调 URL 或授权码",
	submit: "提交",
	loginMissingUrl: "login 响应缺少 authorizeUrl",
	deviceCodePrompt: "在 GitHub 验证页面输入此验证码：",
	deviceCodeCopy: "复制验证码",
	deviceCodeCopied: "已复制",
	deviceCodeOpenPage: "打开 GitHub 验证页面",
	usageTitle: "用量",
	usageRefresh: "刷新",
	usageLoading: "用量加载中…",
	usageEmpty: "服务商未返回任何用量窗口。",
	usageNoVisibleModels: "当前选中的模型没有可显示的用量窗口。",
	usageError: "用量查询失败：{message}",
	usageSession: "5 小时窗口",
	usageWeekly: "每周",
	usageWindow: "窗口",
	usageResets: "{date} 重置",
	usagePlan: "计划：{plan}",
	resetCreditsTitle: "用量限制重置",
	resetCreditsAvailable: "可用 {count} 次",
	resetCreditsError: "用量限制重置查询失败：{message}",
	resetUseButton: "使用…",
	resetUseChecking: "正在检查…",
	resetUseGuard: "每周用量达到 80% 后才可使用此重置。",
	resetUseRestart: "缺少重置详情。请重启 DSH、重新加载页面并刷新用量。",
	resetUseRefresh: "请刷新用量以验证当前限制和重置可用性。",
	resetUseReady: "使用此最早到期的重置额度，操作前需要确认。",
	resetUseConfirmTitle: "确认完整重置",
	resetUseWarning: "将消耗一次额度并重置每周和 5 小时限制，无法撤销。确认将在 60 秒后过期。",
	resetUseAcknowledge: "我理解将消耗一次额度。",
	resetUseConfirm: "消耗一次重置",
	resetUseSuccess: "重置已确认，用量已刷新。",
	resetCreditFull: "完整重置",
	resetCreditExpires: "{date} 到期",
	resetCreditExpiryUnknown: "到期时间不可用",
	modelDefaultsTitle: "默认推理档",
	modelDefaultsHint: "切换到该模型时，模型选择器会预选此档位；没有推理档的模型始终跟随服务商默认。",
	modelDefaultsFollowProvider: "跟随服务商",
	modelDefaultsNoLevels: "{count} 个模型未声明推理档，始终跟随服务商默认。",
	modelDefaultsLoading: "加载模型中…",
	modelDefaultsLoadFailed: "模型加载失败：{message}",
	modelDefaultsRetry: "重试",
	modelDefaultsRefresh: "刷新模型列表（全部订阅）",
	modelDefaultsSaving: "保存中…",
	modelDefaultsSaveFailedNamed: "{model} 保存失败：{message}",
	modelDefaultsSummary: "{total} 个模型 · {configured} 个已覆盖",
	modelDefaultsSummaryNone: "{total} 个模型 · 全部跟随服务商",
	modelDefaultsSummaryEmpty: "没有模型声明推理档",
	modelDefaultsFilterPlaceholder: "筛选模型",
	modelDefaultsFilterEmpty: "没有匹配「{query}」的模型。",
	modelDefaultsNoModels: "这个服务商没有报告任何模型。",
	modelDefaultsNoAccount: "还没有连接账号。请先在卡片上连接一个账号。",
	modelDefaultsDiscoveryFailed: "模型列表发现失败或超时。可以点「刷新」重试。",
	generating: "正在生成图片…",
	image: "图片",
	viewImage: "查看图片",
	viewImageNamed: "查看 {name}",
	imageLoading: "加载中…",
	imageLoadFailed: "重试",
	imagePreview: "图片预览",
	imageClose: "关闭",
	generatingVideo: "正在生成视频…",
	videoLoading: "视频加载中…",
	videoLoadFailed: "视频加载失败：{message}",
	usageBadgeTitle: "订阅用量",
	usageBadgeDisplay: "状态栏额度显示",
	usageBadgeDisplayRecent: "仅显示当前／最近使用的一家",
	usageBadgeDisplayHidden: "不显示",
	usageBadgeDisplayHint: "自动保存到当前浏览器。状态栏最多显示一家；非订阅模型沿用本视图最近选择的订阅，没有记录则隐藏。关闭不影响本页的额度详情。",
	usageBadgeDisplaySaveFailed: "显示设置保存失败，请检查浏览器存储权限。",
	usageBadgeCurrent: "当前",
	usageBadgeModelCount: "{count} 个模型配额",
	usageBadgeModelUnavailable: "当前模型暂无配额数据",
	usageBadgeMoreWindows: "更多配额窗口（{count}）",
	speed: "速度",
	speedStandard: "标准",
	speedStandardDescription: "默认速度",
	speedFast: "快速",
	speedFastDescription: "约 1.5 倍速度，消耗更多用量",
	commandFast: "切换 Codex 速度档（标准/快速）",
	commandFastUnavailable: "当前模型不支持快速档；/fast 仅对目录声明了 fast tier 的 Codex 模型可用",
	proxyTitle: "代理",
	proxyStatusNone: "插件代理未启用 —— 使用 DSH 网络设置。",
	proxyStatusEnabled: "已启用 · {url}",
	proxyStatusError: "配置错误：{message}",
	proxyConfigure: "配置…",
	proxyDialogTitle: "代理设置",
	proxyDialogClose: "关闭",
	proxyEnabled: "让订阅相关请求走代理",
	proxyDisabledHint: "代理未启用：请求直连",
	proxyUrl: "代理地址",
	proxyUrlPlaceholder: "http://localhost:7890",
	proxyUrlHint: "仅支持 HTTP/HTTPS 代理（Clash/mihomo、v2rayN 等）；不支持 socks。",
	proxyUsername: "用户名（可选）",
	proxyUsernamePlaceholder: "代理用户名",
	proxyPassword: "密码",
	proxyPasswordPlaceholder: "留空则保留已保存的密码",
	proxyClearPassword: "清除已保存的密码",
	proxyBypass: "绕过主机",
	proxyBypassPlaceholder: "127.0.0.1, localhost, *.example.com",
	proxyBypassHint: "逗号分隔的主机名，命中则跳过插件代理，使用 DSH 网络设置。",
	proxyTest: "测试",
	proxyTesting: "测试中…",
	proxyTestOk: "成功 · HTTP {status} · {ms} ms",
	proxyTestOkDirect: "成功（DSH 网络设置）· HTTP {status} · {ms} ms",
	proxyTestFail: "失败：{message}",
	proxySave: "保存",
	proxyCancel: "取消",
	proxySaving: "保存中…",
	proxyLoading: "代理设置加载中…",
	proxyLoadFailed: "代理设置加载失败：{message}",
	proxySaved: "已保存 —— 后续请求使用更新后的网络设置。",
	proxySaveFailed: "保存失败：{message}",
	proxyNote: "DSH v0.1.3-alpha.1 建议使用宿主的 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY 设置，并关闭插件代理。此可选覆盖设置为旧版宿主及仅订阅请求使用独立代理的场景保留。关闭或绕过插件代理后使用 DSH 网络设置，不一定直连。作用于 token 交换、模型 API、用量和工具请求；浏览器 OAuth 使用浏览器/系统代理。"
};

//#endregion
//#region src/client/reset-action.ts
/** Explain client-side gating; the server independently revalidates before spending. */
function resetActionBlock(usage, now = Date.now()) {
	const weekly = usage.windows?.find((w) => w.kind === "weekly" && w.scope === void 0);
	if (!weekly || !Number.isFinite(weekly.usedPercent)) return "resetUseRefresh";
	if (weekly.usedPercent < 80) return "resetUseGuard";
	if (weekly.resetsAt === void 0 || weekly.resetsAt <= now || usage.resetCreditsError) return "resetUseRefresh";
	if (!usage.resetCredits?.some((c) => c.id)) return "resetUseRestart";
	if (!usage.resetCredits.some((c) => c.id && (c.expiresAt === void 0 || c.expiresAt > now))) return "resetUseRefresh";
}

//#endregion
//#region src/client/usage-window-filter.ts
/** Presentation only: never trim the raw snapshots used by quota/routing logic. */
function visibleUsageWindows(provider, windows, visibleModels) {
	const all = windows ?? [];
	const selected = new Set(visibleModels);
	return all.filter((window$1) => !window$1.scope || selected.has(window$1.scope));
}

//#endregion
//#region src/client/subscriptions-rpc.ts
/**
* The node half mounts every endpoint as an exact POST route on the shared
* `/api` channel (`/api/subscriptions-auth.<endpoint>`), so the browser
* reaches it through the `/api` channel with a prefixed endpoint name.
* A dedicated channel is no longer used: since dsh 0.1.5 `rpc.handle`
* cannot register one from a plugin (see `src/auth/rpc.ts`).
*/
const SUBSCRIPTIONS_AUTH_CHANNEL = "/api";
const SUBSCRIPTIONS_AUTH_PREFIX = "subscriptions-auth.";
/** Business error returned by a `subscriptions-auth` endpoint (error branch message). */
var SubscriptionsAuthError = class extends Error {};
/**
* Call one `subscriptions-auth` endpoint and unwrap the business result.
* Shared by the settings section, the composer Speed toggle, the usage
* badge, and the image/video toolviews.
* @param rpc - Connection RPC caller.
* @param endpoint - endpoint name (`status`, `usage`, `image`, ...).
* @param payload - endpoint-owned request payload.
* @returns the success value, cast by the caller to the endpoint's shape.
*/
async function callSubscriptionsAuth(rpc, endpoint, payload) {
	let result;
	try {
		result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL, `${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint}`, payload);
	} catch (error) {
		throw new SubscriptionsAuthError(error instanceof Error ? error.message : String(error));
	}
	if (!result.ok) throw new SubscriptionsAuthError(result.error.message);
	return result.value;
}

//#endregion
//#region src/client/account-preferences.ts
/** Missing allowlist follows discovery; explicit [] must remain empty. */
function accountPoolSelection(account, models) {
	return new Set(account.poolModels ?? models.map((model) => model.id));
}
/** Retain unavailable saved IDs so a temporary catalog failure cannot erase them. */
function accountModelRows(account, preferences) {
	const known = new Set(account.models.map((model) => model.id));
	return [...account.models.map((model) => ({
		...model,
		unavailable: false
	})), ...(preferences.poolModels ?? []).filter((id) => !known.has(id)).map((id) => ({
		id,
		name: id,
		unavailable: true
	}))];
}
/** The model editor owns everything except the separately managed accounts. */
function mergeLatestAccounts(draft, latest) {
	const { accounts: _stale,...settings } = draft;
	return {
		...settings,
		...latest.accounts === void 0 ? {} : { accounts: latest.accounts }
	};
}
/** Only touched accounts replace their latest preferences; other settings survive. */
function mergeAccountChanges(latest, changes) {
	return {
		...latest,
		accounts: {
			...latest.accounts,
			...changes
		}
	};
}

//#endregion
//#region src/client/model-filter.ts
/**
* Which empty state the model list is in.
*
* `provider-empty` means the provider shows NO rows at all — the filter box cannot match
* anything in that state, and printing `No model matches “”.` next to it reads like a broken
* control rather than like an explanation (issue #147).
*
* `filter-empty` keeps the existing message for a query that filtered everything out of a
* provider that does have rows.
*/
function modelListState(total, matched) {
	if (total === 0) return "provider-empty";
	return matched === 0 ? "filter-empty" : "rows";
}
/**
* Row ids the editor can still show when discovery returned nothing: saved visibility,
* display names and subagent speeds must count towards the total —
* otherwise a temporary catalog failure would hide the rows that edit them.
*/
function savedModelIds(visibleModels, displayNames, subagentSpeeds = void 0) {
	return [...new Set([
		...visibleModels ?? [],
		...Object.keys(displayNames ?? {}),
		...Object.keys(subagentSpeeds ?? {})
	])];
}
/**
* Why the provider has no models — read from the data the host already sends.
*
* `total === 0` alone cannot tell these apart, and guessing wrong re-creates the very
* defect issue #147 is about: telling a user who IS logged in to go and log in. The
* catalog payload carries one row per connected account with `unavailable: true` when that
* account's discovery failed or timed out (src/index.ts).
*
*  · no account at all                       → `noAccount`;
*  · accounts exist, every discovery failed  → `discoveryFailed` (retry, not log in);
*  · a connected account answered (possibly with an empty catalog) → `noModels`.
*/
function modelEditorNotice(accounts) {
	if (accounts.length === 0) return "noAccount";
	return accounts.every((account) => account.unavailable === true) ? "discoveryFailed" : "noModels";
}
/** Locale keys for the three honest empty states. */
const NOTICE_KEYS = {
	noAccount: "modelDefaultsNoAccount",
	discoveryFailed: "modelDefaultsDiscoveryFailed",
	noModels: "modelDefaultsNoModels"
};
/**
* The editor's whole empty-state decision, in one testable place: how many rows exist
* (discovered + the user's saved ids), whether a query filtered them all out, and which
* notice to show when there are none.
*/
function modelEditorState(input) {
	return {
		listState: modelListState(input.discovered + input.saved, input.matched),
		noticeKey: NOTICE_KEYS[modelEditorNotice(input.accounts)]
	};
}

//#endregion
//#region src/client/ProviderModelEditor.tsx
const border$1 = "0.5px solid var(--dsw-alias-border-l2, #ddd)";
const actions$1 = {
	display: "flex",
	flexWrap: "wrap",
	gap: 8,
	alignItems: "center"
};
/**
* Embedded section of the account manager dialog. It owns the model draft
* (visibility, effort, context, tools) but not its submission: the dialog
* collects the draft through the handle and saves it with the account edits
* in one go, so there is a single Save/Cancel pair.
*/
const ProviderModelEditor = (0, react.forwardRef)(function ProviderModelEditor$1({ provider, rpc, t, disabled = false, onDirtyChange }, ref) {
	const [catalog, setCatalog] = (0, react.useState)();
	const [draft, setDraft] = (0, react.useState)({});
	const [contexts, setContexts] = (0, react.useState)({});
	const [efforts, setEfforts] = (0, react.useState)({});
	const [query, setQuery] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const [dirty, setDirty] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)("");
	const generation = (0, react.useRef)(0);
	(0, react.useEffect)(() => () => {
		generation.current++;
	}, []);
	(0, react.useEffect)(() => {
		onDirtyChange?.(dirty);
	}, [dirty]);
	function reset(data) {
		setCatalog(data);
		setDraft(data.settings);
		setEfforts(Object.fromEntries(data.models.map((model) => [model.id, model.configured ?? ""])));
		setContexts(Object.fromEntries(Object.entries(data.settings.contextWindows ?? {}).map(([id, value]) => [id, String(value)])));
		setDirty(false);
	}
	async function load(force = false) {
		const request = ++generation.current;
		setBusy(true);
		setError("");
		try {
			const data = await callSubscriptionsAuth(rpc, "providerSettings", {
				provider,
				force
			});
			if (generation.current === request) reset(data);
		} catch (error$1) {
			if (generation.current === request) setError(String(error$1 instanceof Error ? error$1.message : error$1));
		} finally {
			if (generation.current === request) setBusy(false);
		}
	}
	function edit(next) {
		setDraft(next);
		setDirty(true);
	}
	(0, react.useEffect)(() => {
		load();
	}, [provider, rpc]);
	(0, react.useImperativeHandle)(ref, () => ({ collect() {
		if (!catalog || !dirty) return { efforts: [] };
		const windows = Object.create(null);
		for (const [model, text] of Object.entries(contexts)) {
			if (!text.trim()) continue;
			const value = Number(text);
			if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || value <= 0) {
				setError(t("modelsContextInvalid", { model }));
				return;
			}
			windows[model] = value;
		}
		setError("");
		const { accounts: _accounts,...settings } = {
			...draft,
			...provider === "codex" ? { contextWindows: windows } : {}
		};
		return {
			settings,
			efforts: catalog.models.flatMap((model) => {
				const effort = efforts[model.id] ?? "";
				return effort === (model.configured ?? "") || !model.efforts?.length ? [] : [{
					model: model.id,
					effort
				}];
			})
		};
	} }), [
		catalog,
		dirty,
		draft,
		contexts,
		efforts,
		provider
	]);
	const allModels = catalog?.models ?? [];
	const known = new Set(allModels.map((model) => model.id));
	const missing = savedModelIds(draft.visibleModels, draft.modelDisplayNames, draft.subagentSpeeds).filter((id) => !known.has(id)).map((id) => ({
		id,
		name: id
	}));
	const customName = (id) => Object.hasOwn(draft.modelDisplayNames ?? {}, id) ? draft.modelDisplayNames[id] : "";
	const editName = (id, value) => {
		const names = Object.assign(Object.create(null), draft.modelDisplayNames);
		if (value.trim()) names[id] = value;
		else delete names[id];
		edit({
			...draft,
			modelDisplayNames: names
		});
	};
	const models = [...allModels, ...missing].filter((model) => `${model.name} ${model.id} ${customName(model.id)}`.toLowerCase().includes(query.trim().toLowerCase()));
	const editorState = modelEditorState({
		discovered: allModels.length,
		saved: missing.length,
		matched: models.length,
		accounts: catalog?.accounts ?? []
	});
	const selected = new Set(draft.visibleModels ?? allModels.map((model) => model.id));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			borderTop: border$1,
			marginTop: 12,
			paddingTop: 12
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
			style: { margin: 0 },
			children: t("modelsEdit")
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "grid",
				gap: 12,
				marginTop: 12
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dsh-subscription-hint",
					children: t("modelsHint")
				}),
				error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					children: error
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: actions$1,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsh-subscription-quiet",
						disabled: busy || disabled || dirty,
						onClick: () => {
							load(true);
						},
						children: t("usageRefresh")
					}), busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						role: "status",
						children: t("modelDefaultsLoading")
					})]
				}),
				catalog && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
					disabled: busy || disabled,
					style: {
						border: 0,
						padding: 0,
						margin: 0,
						minWidth: 0,
						display: "grid",
						gap: 12
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: draft.visibleModels === void 0,
								onChange: (event) => {
									const next = { ...draft };
									if (event.target.checked) delete next.visibleModels;
									else next.visibleModels = allModels.map((model) => model.id);
									edit(next);
								}
							}),
							" ",
							t("modelsAutomatic")
						] }),
						editorState.listState === "provider-empty" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-subscription-hint",
							children: t(editorState.noticeKey)
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: actions$1,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: { flex: "1 1 180px" },
									value: query,
									onChange: (event) => setQuery(event.target.value),
									placeholder: t("modelDefaultsFilterPlaceholder"),
									"aria-label": t("modelDefaultsFilterPlaceholder")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => edit({
										...draft,
										visibleModels: allModels.map((model) => model.id)
									}),
									children: t("modelsSelectAll")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => edit({
										...draft,
										visibleModels: []
									}),
									children: t("modelsSelectNone")
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								maxHeight: 360,
								overflowY: "auto",
								display: "grid",
								gap: 8
							},
							children: [models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									borderBottom: border$1,
									padding: "8px 2px",
									display: "grid",
									gap: 8
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: { overflowWrap: "anywhere" },
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: selected.has(model.id),
												onChange: (event) => {
													const next = new Set(selected);
													if (event.target.checked) next.add(model.id);
													else next.delete(model.id);
													edit({
														...draft,
														visibleModels: [...next]
													});
												}
											}),
											" ",
											model.name,
											!known.has(model.id) && ` (${t("modelsUnavailable")})`
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", {
										style: {
											color: "var(--dsw-alias-label-tertiary)",
											overflowWrap: "anywhere"
										},
										children: ["ID: ", model.id]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: actions$1,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											style: {
												display: "grid",
												gap: 6,
												flex: "1 1 200px",
												minWidth: 0
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: { fontSize: 12 },
												children: t("modelDisplayName")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												maxLength: 80,
												"aria-label": `${model.name} ${t("modelDisplayName")}`,
												placeholder: model.name,
												value: customName(model.id),
												onChange: (event) => editName(model.id, event.target.value)
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: { alignSelf: "end" },
											"aria-label": `${model.name} ${t("displayNameReset")}`,
											disabled: !customName(model.id),
											onClick: () => editName(model.id, ""),
											children: t("displayNameReset")
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
										style: { color: "var(--dsw-alias-label-tertiary)" },
										children: t("modelDisplayNameHint")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: actions$1,
										children: [(model.efforts?.length ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											style: actions$1,
											children: [t("modelDefaultsTitle"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												"aria-label": `${model.name} ${t("modelDefaultsTitle")}`,
												value: efforts[model.id] ?? "",
												onChange: (event) => {
													setEfforts({
														...efforts,
														[model.id]: event.target.value
													});
													setDirty(true);
												},
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "",
														children: t("modelDefaultsFollowProvider")
													}),
													model.configured && !model.efforts?.some((effort) => effort.id === model.configured) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
														value: model.configured,
														disabled: true,
														children: [
															model.configured,
															" (",
															t("modelsUnavailable"),
															")"
														]
													}),
													model.efforts?.map((effort) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: effort.id,
														children: effort.name
													}, effort.id))
												]
											})]
										}), provider === "codex" && model.maxContextWindow !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: actions$1,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												style: actions$1,
												children: [t("modelsContext"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													style: { width: 140 },
													inputMode: "numeric",
													value: contexts[model.id] ?? "",
													"aria-label": `${model.name} ${t("modelsContext")}`,
													placeholder: String(model.defaultContextWindow),
													onChange: (event) => {
														setContexts({
															...contexts,
															[model.id]: event.target.value
														});
														setDirty(true);
													}
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("modelsContextBounds", {
												default: model.defaultContextWindow,
												max: model.maxContextWindow
											}) })]
										})]
									}),
									provider === "codex" && (model.fastTier || Object.hasOwn(draft.subagentSpeeds ?? {}, model.id)) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "grid",
											gap: 6
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											style: actions$1,
											children: [t("modelsSubagentSpeed"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												"aria-label": `${model.name} ${t("modelsSubagentSpeed")}`,
												value: Object.hasOwn(draft.subagentSpeeds ?? {}, model.id) ? draft.subagentSpeeds[model.id] : "standard",
												onChange: (event) => edit({
													...draft,
													subagentSpeeds: {
														...draft.subagentSpeeds,
														[model.id]: event.target.value
													}
												}),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "standard",
													children: t("speedStandard")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
													value: "fast",
													disabled: !model.fastTier,
													children: [t("speedFast"), !model.fastTier && ` (${t("modelsUnavailable")})`]
												})]
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("modelsSubagentSpeedHint") })]
									})
								]
							}, model.id)), models.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelDefaultsFilterEmpty", { query }) })]
						})] }),
						provider === "codex" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("modelsContextHint") }),
						catalog.tools.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "grid",
								gap: 8
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("modelsTools") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("modelsToolsHint") }),
								catalog.tools.map((tool) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: draft.tools?.[tool] !== false,
										onChange: (event) => edit({
											...draft,
											tools: {
												...draft.tools,
												[tool]: event.target.checked
											}
										})
									}),
									" ",
									t(tool === "image_generate" ? "modelsImage" : tool === "video_generate" ? "modelsVideo" : tool === "web_search" ? "modelsWebSearch" : "modelsSearch")
								] }, tool))
							]
						})
					]
				})
			]
		})]
	});
});

//#endregion
//#region src/client/display-name-events.ts
/** Notify mounted views after a successful save, without another quota request. */
const DISPLAY_NAME_CHANGED = "dsh-subscriptions-display-name-changed";
function notifyDisplayNameChange(provider, displayName) {
	window.dispatchEvent(new CustomEvent(DISPLAY_NAME_CHANGED, { detail: {
		provider,
		...displayName?.trim() ? { displayName: displayName.trim() } : {}
	} }));
}

//#endregion
//#region src/client/provider-settings-styles.ts
/**
* The host loads one JS client bundle, so keep this small, scoped stylesheet
* with the dialog instead of relying on a separate CSS asset. Geometry and
* theme tokens follow the host's settings-form and ui-primitives controls.
*/
const formScope = ":is(.dsh-subscription-manager, .dsh-subscriptions-settings)";
const providerSettingsCss = `
.dsh-subscription-manager {
  box-sizing: border-box;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-panel, 16px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-prominent, 0 20px 70px #0004);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color-scheme: light;
}
.dsh-subscriptions-settings {
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color-scheme: light;
}
body[data-ds-dark-theme] ${formScope} {
  color-scheme: dark;
}
.dsh-subscription-manager::backdrop {
  background: var(--dsw-alias-bg-mask-1, #0006);
  backdrop-filter: var(--dsw-mask-blur, none);
}
${formScope} h2 {
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
}
${formScope} h3 {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
}
${formScope} strong,
${formScope} .dsh-subscription-label {
  font-size: 13px;
  line-height: 1.5;
  font-weight: 500;
}
${formScope} legend {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
}
${formScope} small,
${formScope} .dsh-subscription-hint,
${formScope} [role="status"] {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
${formScope} [role="alert"] {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary, #b42318);
}
${formScope} input:not([type="checkbox"]),
${formScope} select {
  box-sizing: border-box;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.5;
}
${formScope} input::placeholder {
  color: var(--dsw-alias-label-tertiary);
  opacity: 1;
}
${formScope} input:not([type="checkbox"]):focus-visible,
${formScope} select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
}
${formScope} input:not([type="checkbox"]):disabled,
${formScope} select:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
${formScope} input[aria-invalid="true"] {
  border-color: var(--dsw-alias-state-error-primary, #b42318);
}
${formScope} option {
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
}
${formScope} label:has(> input[type="checkbox"]) {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 14px;
  line-height: 20px;
  cursor: pointer;
}
${formScope} input[type="checkbox"] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 2px 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: inherit;
}
${formScope} label:has(> input[type="checkbox"]:disabled) {
  cursor: default;
  opacity: 0.5;
}
${formScope} button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  min-height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
${formScope} button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3));
}
${formScope} button:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-3));
}
${formScope} button:disabled {
  opacity: 0.4;
  cursor: default;
}
${formScope} button.dsh-subscription-quiet {
  border-color: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
}
${formScope} :is(footer, .dsh-subscription-dialog-actions) button {
  min-height: 34px;
  padding: 0 14px;
  border-radius: var(--dsw-radius-md, 8px);
  font-size: 13px;
  line-height: 1.5;
}
${formScope} button.dsh-subscription-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1));
  font-weight: 500;
}
${formScope} button.dsh-subscription-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-label-secondary));
}
${formScope} button:focus-visible,
${formScope} input[type="checkbox"]:focus-visible,
${formScope} summary:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
${formScope} summary {
  border-radius: var(--dsw-radius-sm, 6px);
}
${formScope} summary:hover {
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
}
`;
/** Composer controls retain their own geometry, separate from settings forms. */
const subscriptionChromeCss = `
.dsh-subscription-usage-pill { corner-shape: round; }
.dsh-subscription-usage-panel {
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
}
.dsh-subscription-speed button:hover:not(:disabled) {
  --dsh-subscription-speed-hover: var(--dsw-alias-interactive-bg-hover);
}
.dsh-subscription-speed button:active:not(:disabled) {
  --dsh-subscription-speed-hover: var(--dsw-alias-interactive-bg-active);
}
.dsh-subscription-speed button:disabled { opacity: 0.4; cursor: default; }
.dsh-subscription-speed button:focus-visible,
.dsh-subscription-usage-pill:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
`;

//#endregion
//#region src/client/ProviderAccountManager.tsx
const PROMPT_CACHE_TTLS = ["5m", "1h"];
const border = "0.5px solid var(--dsw-alias-border-l2)";
const stack = {
	display: "grid",
	gap: 12,
	minWidth: 0
};
const actions = {
	display: "flex",
	flexWrap: "wrap",
	gap: 8,
	alignItems: "center"
};
/** Native top-layer dialog provides keyboard containment, Escape and focus restoration. */
function ProviderAccountManager({ provider, name, rpc, t, onClose }) {
	const dialog = (0, react.useRef)(null);
	const title = (0, react.useId)();
	const description = (0, react.useId)();
	const cacheTtlId = (0, react.useId)();
	const [catalog, setCatalog] = (0, react.useState)();
	const [changes, setChanges] = (0, react.useState)({});
	const [loading, setLoading] = (0, react.useState)(true);
	const [saving, setSaving] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)("");
	const [saveError, setSaveError] = (0, react.useState)("");
	const [attempt, setAttempt] = (0, react.useState)(0);
	const [modelsDirty, setModelsDirty] = (0, react.useState)(false);
	const [displayName, setDisplayName] = (0, react.useState)("");
	const [nameDirty, setNameDirty] = (0, react.useState)(false);
	/** '' follows the plugin config; otherwise an explicit TTL. */
	const [cacheTtl, setCacheTtl] = (0, react.useState)("");
	const [cacheTtlDirty, setCacheTtlDirty] = (0, react.useState)(false);
	const alive = (0, react.useRef)(true);
	const saveLock = (0, react.useRef)(false);
	const editor = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		alive.current = true;
		const element = dialog.current;
		const previous = document.activeElement;
		element.showModal();
		return () => {
			alive.current = false;
			element.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);
	(0, react.useEffect)(() => {
		let current = true;
		setLoading(true);
		setError("");
		callSubscriptionsAuth(rpc, "providerSettings", { provider }).then((data) => {
			if (current) {
				setCatalog(data);
				setDisplayName(data.settings.displayName ?? "");
				setCacheTtl(data.settings.promptCacheTtl ?? "");
			}
		}).catch((error$1) => {
			if (current) setError(t("accountsLoadFailed", { message: error$1 instanceof Error ? error$1.message : String(error$1) }));
		}).finally(() => {
			if (current) setLoading(false);
		});
		return () => {
			current = false;
		};
	}, [
		provider,
		rpc,
		attempt
	]);
	function edit(key, next) {
		setChanges((current) => ({
			...current,
			[key]: next
		}));
	}
	/**
	* One submit for both drafts: the model editor's (visibility, effort,
	* context, tools) and this dialog's account edits. A failure keeps the
	* dialog open with every edit intact.
	*/
	async function save() {
		if (saveLock.current) return;
		const models = editor.current === null ? { efforts: [] } : editor.current.collect();
		if (models === void 0) return;
		saveLock.current = true;
		setSaving(true);
		setSaveError("");
		let savedEfforts = 0;
		try {
			for (const { model, effort } of models.efforts) {
				await callSubscriptionsAuth(rpc, "setModelDefault", {
					provider,
					model,
					...effort ? { effort } : {}
				});
				savedEfforts++;
				if (!alive.current) return;
			}
			const latest = await callSubscriptionsAuth(rpc, "providerSettings", { provider });
			if (!alive.current) return;
			const { displayName: _staleName, promptCacheTtl: _staleTtl,...rest } = mergeAccountChanges(models.settings === void 0 ? latest.settings : mergeLatestAccounts(models.settings, latest.settings), changes);
			const savedName = nameDirty ? displayName.trim() : latest.settings.displayName;
			const savedTtl = cacheTtlDirty ? cacheTtl : latest.settings.promptCacheTtl;
			const settings = {
				...rest,
				...savedName ? { displayName: savedName } : {},
				...savedTtl ? { promptCacheTtl: savedTtl } : {}
			};
			await callSubscriptionsAuth(rpc, "setProviderSettings", {
				provider,
				settings
			});
			notifyDisplayNameChange(provider, settings.displayName);
			if (alive.current) onClose();
		} catch (error$1) {
			if (alive.current) {
				const message = error$1 instanceof Error ? error$1.message : String(error$1);
				setSaveError((savedEfforts ? t("modelsPartialSave") + " " : "") + t("accountsSaveFailed", { message }));
			}
		} finally {
			saveLock.current = false;
			if (alive.current) setSaving(false);
		}
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dialog", {
		className: "dsh-subscription-manager",
		ref: dialog,
		"aria-labelledby": title,
		"aria-describedby": description,
		onCancel: (event) => {
			if (saveLock.current) event.preventDefault();
		},
		onClose,
		style: {
			width: 620,
			maxWidth: "calc(100vw - 32px)",
			maxHeight: "calc(100dvh - 32px)",
			overflow: "auto"
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: providerSettingsCss }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				...stack,
				padding: 20
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					style: {
						...actions,
						justifyContent: "space-between"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						id: title,
						style: { margin: 0 },
						children: t("accountsTitle", { provider: name })
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						autoFocus: true,
						disabled: saving,
						onClick: onClose,
						children: t("imageClose")
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					id: description,
					className: "dsh-subscription-hint",
					children: t("accountsHint")
				}),
				error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					children: error
				}),
				loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "status",
					className: "dsh-subscription-hint",
					children: t("accountsLoading")
				}),
				!loading && !catalog && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: () => setAttempt((value) => value + 1),
					children: t("modelDefaultsRetry")
				}),
				catalog && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
					disabled: saving || loading,
					style: {
						...stack,
						border: 0,
						margin: 0,
						padding: 0
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							style: {
								...stack,
								gap: 6,
								paddingBottom: 8
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									...stack,
									gap: 6
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("subscriptionDisplayName") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									maxLength: 80,
									value: displayName,
									placeholder: name,
									onChange: (event) => {
										setDisplayName(event.target.value);
										setNameDirty(true);
									}
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									...actions,
									justifyContent: "space-between"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
									className: "dsh-subscription-hint",
									children: t("subscriptionDisplayNameHint")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									disabled: !displayName,
									onClick: () => {
										setDisplayName("");
										setNameDirty(true);
									},
									children: t("displayNameReset")
								})]
							})]
						}),
						provider === "claude" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							style: {
								...stack,
								gap: 6,
								paddingBottom: 8
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									htmlFor: cacheTtlId,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("claudePromptCacheTtl") })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									id: cacheTtlId,
									value: cacheTtl,
									style: { justifySelf: "start" },
									onChange: (event) => {
										setCacheTtl(event.target.value);
										setCacheTtlDirty(true);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: t("claudePromptCacheTtlDefault", { ttl: catalog.promptCacheTtlDefault ?? "5m" })
									}), PROMPT_CACHE_TTLS.map((ttl) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: ttl,
										children: t(`claudePromptCacheTtl${ttl}`)
									}, ttl))]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
									className: "dsh-subscription-hint",
									children: t("claudePromptCacheTtlHint")
								})
							]
						}),
						catalog.accounts.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-subscription-hint",
							children: t("accountsEmpty")
						}),
						catalog.accounts.map((account) => {
							const preferences = changes[account.key] ?? catalog.settings.accounts?.[account.key] ?? {};
							const selected = accountPoolSelection(preferences, account.models);
							const models = accountModelRows(account, preferences);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
								style: {
									...stack,
									border,
									borderRadius: "var(--dsw-radius-lg, 12px)",
									padding: 14,
									margin: 0
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", {
										style: {
											padding: "0 6px",
											overflowWrap: "anywhere",
											maxWidth: "100%"
										},
										children: account.label
									}),
									account.unavailable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-subscription-hint",
										children: t("accountsCatalogUnavailable")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											...stack,
											gap: 6
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-subscription-label",
											children: t("accountsAlias")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											value: preferences.alias ?? "",
											placeholder: account.label,
											onChange: (event) => {
												const next = { ...preferences };
												if (event.target.value.trim()) next.alias = event.target.value;
												else delete next.alias;
												edit(account.key, next);
											}
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: preferences.poolEnabled !== false,
											onChange: (event) => edit(account.key, {
												...preferences,
												poolEnabled: event.target.checked
											})
										}),
										" ",
										t("accountsPoolEnabled")
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: preferences.independentEntry === true,
											onChange: (event) => edit(account.key, {
												...preferences,
												independentEntry: event.target.checked
											})
										}),
										" ",
										t("accountsIndependent")
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-subscription-hint",
										children: t("accountsIndependentHint")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
										style: {
											cursor: "pointer",
											fontSize: 13
										},
										children: [
											t("accountsModels"),
											" · ",
											preferences.poolModels === void 0 ? t("accountsModelsAll") : t("accountsModelsCount", { count: preferences.poolModels.length })
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											...stack,
											marginTop: 12
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "dsh-subscription-hint",
												children: t("accountsModelsHint")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: preferences.poolModels === void 0,
													onChange: (event) => {
														const next = { ...preferences };
														if (event.target.checked) delete next.poolModels;
														else next.poolModels = account.models.map((model) => model.id);
														edit(account.key, next);
													}
												}),
												" ",
												t("accountsModelsAutomatic")
											] }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: actions,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													onClick: () => edit(account.key, {
														...preferences,
														poolModels: models.map((model) => model.id)
													}),
													children: t("modelsSelectAll")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													onClick: () => edit(account.key, {
														...preferences,
														poolModels: []
													}),
													children: t("modelsSelectNone")
												})]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: {
													...stack,
													gap: 8,
													maxHeight: 240,
													overflowY: "auto"
												},
												children: [models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
													style: { overflowWrap: "anywhere" },
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "checkbox",
															checked: selected.has(model.id),
															onChange: (event) => {
																const next = new Set(selected);
																if (event.target.checked) next.add(model.id);
																else next.delete(model.id);
																edit(account.key, {
																	...preferences,
																	poolModels: [...next]
																});
															}
														}),
														" ",
														model.name,
														model.unavailable && ` (${t("modelsUnavailable")})`
													]
												}, model.id)), models.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													className: "dsh-subscription-hint",
													children: t("accountsNoModels")
												})]
											})
										]
									})] })
								]
							}, account.key);
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProviderModelEditor, {
					ref: editor,
					provider,
					rpc,
					t,
					disabled: saving,
					onDirtyChange: setModelsDirty
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
					style: {
						...stack,
						gap: 8,
						borderTop: border,
						padding: "14px 0 8px",
						position: "sticky",
						bottom: 0,
						background: "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))"
					},
					children: [saveError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: saveError
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...actions,
							justifyContent: "flex-end"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							disabled: saving,
							onClick: onClose,
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-subscription-primary",
							disabled: loading || saving || !Object.keys(changes).length && !modelsDirty && !nameDirty && !cacheTtlDirty,
							onClick: () => {
								save();
							},
							children: saving ? t("modelDefaultsSaving") : t("modelsSave")
						})]
					})]
				})
			]
		})]
	});
}

//#endregion
//#region src/client/usage-badge-preferences.ts
const MODE_KEY = "dsh.subscriptions.usageBadgeMode";
const MODE_EVENT = "dsh:subscriptions:usage-badge-mode";
/** Read the browser preference; blocked storage retains the default display. */
function readUsageBadgeMode() {
	if (typeof window === "undefined") return "recent";
	try {
		return window.localStorage.getItem(MODE_KEY) === "hidden" ? "hidden" : "recent";
	} catch (error) {
		if (!(error instanceof DOMException) || error.name !== "SecurityError") throw error;
		return "recent";
	}
}
/** Save first, then notify; the settings control reports a rejected write. */
function setUsageBadgeMode(mode) {
	if (mode !== "recent" && mode !== "hidden") throw new TypeError("Invalid subscription usage display mode");
	window.localStorage.setItem(MODE_KEY, mode);
	window.dispatchEvent(new Event(MODE_EVENT));
}
/** Same-tab writes need a custom event; other tabs use the storage event. */
function subscribeUsageBadgeMode(notify) {
	const onStorage = (event) => {
		if (event.key === MODE_KEY || event.key === null) notify();
	};
	window.addEventListener(MODE_EVENT, notify);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(MODE_EVENT, notify);
		window.removeEventListener("storage", onStorage);
	};
}
/** Shared React snapshot used by the settings control and every mounted badge. */
function useUsageBadgeMode() {
	return (0, react.useSyncExternalStore)(subscribeUsageBadgeMode, readUsageBadgeMode, () => "recent");
}

//#endregion
//#region src/client/UsageBadgeDisplaySetting.tsx
/** Browser-local display preference; never changes provider or account settings. */
function UsageBadgeDisplaySetting({ t }) {
	const mode = useUsageBadgeMode();
	const [failed, setFailed] = (0, react.useState)(false);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: styles$6.card,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				style: styles$6.field,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageBadgeDisplay") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					style: styles$6.select,
					"aria-label": t("usageBadgeDisplay"),
					value: mode,
					onChange: (event) => {
						const value = event.currentTarget.value;
						if (value !== "recent" && value !== "hidden") return;
						try {
							setUsageBadgeMode(value);
							setFailed(false);
						} catch (error) {
							if (!(error instanceof DOMException) || !["SecurityError", "QuotaExceededError"].includes(error.name)) throw error;
							setFailed(true);
						}
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "recent",
						children: t("usageBadgeDisplayRecent")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "hidden",
						children: t("usageBadgeDisplayHidden")
					})]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$6.hint,
				children: t("usageBadgeDisplayHint")
			}),
			failed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				role: "alert",
				style: {
					...styles$6.hint,
					color: "var(--dsw-alias-state-error-primary)"
				},
				children: t("usageBadgeDisplaySaveFailed")
			})
		]
	});
}
const styles$6 = {
	card: {
		border: "0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))",
		borderRadius: "var(--dsw-radius-xl, 20px)",
		background: "var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))",
		padding: "12px 14px",
		display: "flex",
		flexDirection: "column",
		gap: 6
	},
	field: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		fontSize: 13,
		fontWeight: 500,
		lineHeight: "20px"
	},
	select: { width: "100%" },
	hint: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	}
};

//#endregion
//#region src/client/SubscriptionsSection.tsx
/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS$1 = 2e3;
const CLIENT_VERSION_SOURCES = {
	npm: "clientVersionNpm",
	local: "clientVersionLocal",
	fallback: "clientVersionFallback",
	config: "clientVersionConfig"
};
/** Card display metadata, in page order (names are brand names, not translated). */
const PROVIDERS = [
	{
		id: "codex",
		name: "Codex (ChatGPT)"
	},
	{
		id: "claude",
		name: "Claude"
	},
	{
		id: "grok",
		name: "Grok (X Premium)"
	},
	{
		id: "copilot",
		name: "GitHub Copilot"
	}
];
/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Copy a keyed map without the entries whose key is not in `live`. */
function dropStale(map, live) {
	const stale = Object.keys(map).filter((key) => !live.has(key));
	if (stale.length === 0) return map;
	const next = { ...map };
	for (const key of stale) delete next[key];
	return next;
}
/**
* English-dictionary fallback for a missing inject `t` (standalone renders);
* the slot inject always supplies the locale-bound one.
* @param key - dictionary key.
* @param params - `{name}` template params.
* @returns the template with params substituted.
*/
function fallbackTranslate$4(key, params) {
	let text = en[key];
	for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
	return text;
}
const styles$5 = {
	section: {
		display: "flex",
		flexDirection: "column",
		gap: 12,
		maxWidth: 560,
		color: "var(--dsw-alias-label-primary)"
	},
	intro: {
		margin: 0,
		color: "var(--dsw-alias-label-tertiary)",
		fontSize: 14,
		lineHeight: "22px"
	},
	card: {
		border: "0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))",
		borderRadius: "var(--dsw-radius-xl, 20px)",
		background: "var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))",
		padding: "12px 14px",
		display: "flex",
		flexDirection: "column",
		gap: 6
	},
	proxyCard: {
		padding: "12px 14px",
		display: "flex",
		flexDirection: "column",
		gap: 6
	},
	separator: { borderTop: "0.5px solid var(--dsw-alias-border-l2)" },
	cardHeader: {
		display: "flex",
		alignItems: "center",
		gap: 8
	},
	dot: {
		width: 8,
		height: 8,
		borderRadius: "50%",
		flexShrink: 0
	},
	name: {
		fontWeight: 500,
		fontSize: 14,
		lineHeight: "22px",
		color: "var(--dsw-alias-label-primary)"
	},
	statusLine: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	clientVersion: {
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)",
		fontVariantNumeric: "tabular-nums"
	},
	errorLine: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-state-error-primary)"
	},
	actions: {
		display: "flex",
		gap: 8,
		marginTop: 4,
		alignItems: "center",
		flexWrap: "wrap"
	},
	usage: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		marginTop: 4,
		borderTop: "0.5px solid var(--dsw-alias-border-l2)",
		paddingTop: 8
	},
	usageHeader: {
		display: "flex",
		alignItems: "center",
		gap: 8
	},
	usageTitle: {
		fontSize: 12,
		lineHeight: "18px",
		fontWeight: 500,
		color: "var(--dsw-alias-label-secondary)"
	},
	usagePlan: {
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	usageRefresh: {
		minHeight: 22,
		height: 22,
		padding: "0 8px",
		marginLeft: "auto"
	},
	usageRow: {
		display: "flex",
		flexDirection: "column",
		gap: 3
	},
	usageMeta: {
		display: "flex",
		justifyContent: "space-between",
		gap: 8,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	// issue #1288 第 11 条（横向溢出）：这一行在 600dp 竖屏上会把整页撞宽。
	//
	// 真因不是「文字太长」，是 flex 的默认收缩规则：
	//   · .accountHeader 是 display:flex，而 flex 子项的 min-width 默认是 auto ——
	//     子项**不能收缩到小于其内容宽度**，所以长邮箱（wlx…@gmail.com）+ plan +
	//     「过期时间 2026/11/11 21:39:24」三段并列时，整行按内容总宽被撑开；
	//   · 「退出登录」按钮是 marginLeft:auto + flexShrink:0 —— 它自己不收缩，
	//     于是被前面的内容挤出卡片右边界（用户截图里只能看到一半）。
	// 结果：卡片 → 页面容器 → document 一路被推宽，整页可以左右滑。
	//
	// 修法就是补上 flex 收缩链上缺的两处（不是 overflow-x:hidden 遮住）：
	//   · accountHeader 允许收缩（minWidth:0）—— 容器本身也可能被父级撑；
	//   · 三个文本 span 各给 minWidth:0 + 省略号，让「超出」表现为省略而不是外溢；
	//   · 邮箱是最长的那个，允许换行以求完整可读（省略号会藏掉后半截，
	//     而账号名是用户要核对的东西）。
	accountRow: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		// 卡片在 column flex 里也要能收缩，否则内层 min-width:auto 继续向上传染。
		minWidth: 0,
		border: "0.5px solid var(--dsw-alias-border-l2)",
		borderRadius: "var(--dsw-radius-lg, 16px)",
		padding: "8px 10px",
		marginTop: 4
	},
	accountHeader: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		// 关键：允许这一行收缩到容器宽度，而不是按内容宽度铺开。
		minWidth: 0,
		// 窄屏上让长邮箱与过期时间换行，而不是硬挤一行把按钮顶出去。
		flexWrap: "wrap",
		rowGap: 2
	},
	accountName: {
		fontSize: 13,
		lineHeight: "20px",
		color: "var(--dsw-alias-label-primary)",
		userSelect: "all",
		// 可收缩 + 长串断行（邮箱没有空格，需要 anywhere 才会断）。
		minWidth: 0,
		overflowWrap: "anywhere"
	},
	starButton: {
		border: "none",
		padding: 0,
		width: 28,
		font: "inherit",
		fontSize: 14,
		lineHeight: "20px",
		cursor: "pointer",
		color: "var(--dsw-alias-state-warn-label)"
	},
	usageTrack: {
		height: 6,
		borderRadius: 3,
		overflow: "hidden",
		background: "var(--dsw-alias-bg-layer-1)",
		border: "0.5px solid var(--dsw-alias-border-l2)"
	},
	usageFill: {
		height: "100%",
		borderRadius: 3
	},
	deviceCode: {
		marginTop: 4,
		display: "flex",
		flexDirection: "column",
		gap: 6,
		border: "0.5px solid var(--dsw-alias-border-l2)",
		borderRadius: "var(--dsw-radius-lg, 16px)",
		padding: "10px 12px",
		background: "var(--dsw-alias-bg-layer-1)"
	},
	deviceCodeText: {
		fontFamily: "monospace",
		fontSize: 18,
		lineHeight: "24px",
		letterSpacing: 2,
		color: "var(--dsw-alias-label-primary)",
		userSelect: "all"
	},
	proxyField: {
		display: "flex",
		flexDirection: "column",
		gap: 4
	},
	proxyLabel: {
		fontSize: 13,
		fontWeight: 500,
		lineHeight: "20px",
		color: "var(--dsw-alias-label-primary)"
	},
	proxyInput: { width: "100%" },
	manual: {
		fontSize: 13,
		lineHeight: "20px"
	},
	manualRow: {
		display: "flex",
		flexWrap: "wrap",
		gap: 8,
		alignItems: "center",
		marginTop: 8
	},
	manualInput: {
		flex: "1 1 200px",
		minWidth: 0
	},
	proxyHint: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	proxyCheck: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		fontSize: 13,
		lineHeight: "20px",
		color: "var(--dsw-alias-label-primary)",
		cursor: "pointer"
	},
	proxyMessage: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px"
	},
	proxyActions: {
		display: "flex",
		gap: 8,
		alignItems: "center",
		justifyContent: "flex-end",
		marginTop: 2
	},
	modalOverlay: {
		position: "fixed",
		inset: 0,
		zIndex: 1e3,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		padding: 16,
		background: "var(--dsw-alias-bg-mask-1, #0006)",
		backdropFilter: "var(--dsw-mask-blur, none)"
	},
	modal: {
		width: 460,
		maxWidth: "100%",
		maxHeight: "90vh",
		overflowY: "auto",
		boxSizing: "border-box",
		display: "flex",
		flexDirection: "column",
		gap: 12,
		padding: "16px 18px",
		borderRadius: "var(--dsw-radius-panel, 28px)",
		background: "var(--dsw-alias-bg-layer-2)",
		border: 0,
		boxShadow: "var(--dsw-elevation-prominent)"
	},
	modalHeader: {
		display: "flex",
		alignItems: "center",
		gap: 8
	},
	modalTitle: {
		fontWeight: 500,
		fontSize: 16,
		lineHeight: "24px",
		color: "var(--dsw-alias-label-primary)"
	}
};
/** Status dot color for one provider state. */
function dotColor(status) {
	if (status?.busy === true) return "var(--dsw-alias-state-warn-label)";
	if ((status?.accounts.length ?? 0) > 0) return "var(--dsw-alias-state-success-primary)";
	return "var(--dsw-alias-label-dimmed)";
}
/**
 * 供应商卡标题前那个状态点的**语义**（issue #1288 第 10 条）。
 *
 * 用户报「看不懂这个灰点」——查下来颜色逻辑本身是好的（见 dotColor：busy=黄、
 * 已登录=绿、未登录=灰），缺的只是**把它说出来**：那个 span 没有 aria-label，
 * 也不在任何可读文本里，所以三种状态在无障碍树和肉眼上都只能靠颜色猜。
 * 这里补一个纯语义映射（不改颜色、不改尺寸、不加图例——用户明确说设计不动）。
 * @param status - 该 provider 的账户状态快照。
 * @returns 三态键之一：busy / linked / unlinked。
 */
function dotState(status) {
	if (status?.busy === true) return "busy";
	if ((status?.accounts.length ?? 0) > 0) return "linked";
	return "unlinked";
}
/** 把 dotState 的三态键翻成当前语言的 aria-label 文案键。 */
const DOT_STATE_LABEL = {
	busy: "providerDotBusy",
	linked: "providerDotLinked",
	unlinked: "providerDotUnlinked"
};
/** The CLI version a route presents, beside the provider name; nothing for routes without one. */
function ClientVersionTag({ clientVersion, t }) {
	if (clientVersion === void 0) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		style: styles$5.clientVersion,
		title: t("clientVersionHint"),
		children: t("clientVersion", {
			version: clientVersion.version,
			source: t(CLIENT_VERSION_SOURCES[clientVersion.source])
		})
	});
}
/**
* One-line status text for one provider state.
* @param t - section translate.
* @param status - the provider's last reported state.
* @returns the localized status line.
*/
function statusText(t, status) {
	if (status === void 0) return t("checking");
	if (status.busy) return t("loginInProgress");
	if (status.accounts.length > 0) return t("loggedInCount", { count: status.accounts.length });
	return t("notLoggedIn");
}
/**
* Localized label of one usage window (kind, plus the model scope when named).
* @param t - section translate.
* @param window - the reported window.
* @returns e.g. "5-hour window" or "Weekly · Opus".
*/
function usageWindowLabel$1(t, window$1) {
	const base = window$1.kind === "session" ? t("usageSession") : window$1.kind === "weekly" ? t("usageWeekly") : t("usageWindow");
	return window$1.scope !== void 0 && window$1.scope !== "" ? `${base} · ${window$1.scope}` : base;
}
/** Bar fill color: success normally, warn from 80%, error from 95%. Shared with the composer badge. */
function usageBarColor(usedPercent$1) {
	if (usedPercent$1 >= 95) return "var(--dsw-alias-state-error-primary)";
	if (usedPercent$1 >= 80) return "var(--dsw-alias-state-warn-label)";
	return "var(--dsw-alias-state-success-primary)";
}
/** One-line status text of the proxy config card. */
function proxyStatusText(t, proxy, loadError) {
	if (loadError !== void 0) return t("proxyLoadFailed", { message: loadError });
	if (proxy === void 0) return t("proxyLoading");
	if (proxy.error !== void 0) return t("proxyStatusError", { message: proxy.error });
	if (proxy.enabled) return t("proxyStatusEnabled", { url: proxy.url });
	return t("proxyStatusNone");
}
/** Feedback-line color of the proxy dialog. */
function messageColor(tone) {
	return tone === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-state-success-primary)";
}
/**
* The Subscriptions settings page component.
* @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
* @returns the section body, or a notice while the RPC face is absent.
*/
function SubscriptionsSection(props) {
	const { rpc } = props;
	const t = props.t ?? fallbackTranslate$4;
	const [statuses, setStatuses] = (0, react.useState)({});
	const [errors, setErrors] = (0, react.useState)({});
	const [manualDrafts, setManualDrafts] = (0, react.useState)({
		codex: "",
		claude: "",
		grok: "",
		copilot: "",
		});
	/** Pending device-flow codes (copilot), shown while the attempt polls. */
	const [deviceCodes, setDeviceCodes] = (0, react.useState)({});
	const [copiedCode, setCopiedCode] = (0, react.useState)(void 0);
	/** Usage snapshots keyed `${provider}:${accountKey}` — every account tracks its own windows. */
	const [usages, setUsages] = (0, react.useState)({});
	const [usageErrors, setUsageErrors] = (0, react.useState)({});
	const [usageLoading, setUsageLoading] = (0, react.useState)({});
	const [resetConfirmation, setResetConfirmation] = (0, react.useState)();
	const [resetBusy, setResetBusy] = (0, react.useState)(false);
	const [resetAcknowledged, setResetAcknowledged] = (0, react.useState)(false);
	const [resetMessage, setResetMessage] = (0, react.useState)("");
	const [resetAccount, setResetAccount] = (0, react.useState)();
	const resetDialogRef = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		if (resetConfirmation) resetDialogRef.current?.showModal();
		else resetDialogRef.current?.close();
	}, [resetConfirmation]);
	const resetInflight = (0, react.useRef)(false);
	const mountedRef = (0, react.useRef)(true);
	const pollersRef = (0, react.useRef)(/* @__PURE__ */ new Map());
	/** Accounts with a `usage` call in flight; guards the auto-fetch effect against re-entry. */
	const usageInflightRef = (0, react.useRef)(/* @__PURE__ */ new Set());
	/** Proxy config as last answered by `proxyGet`/`proxySet`. */
	const [proxy, setProxy] = (0, react.useState)(void 0);
	const [proxyLoadError, setProxyLoadError] = (0, react.useState)(void 0);
	/** Proxy dialog state (draft fields; the password never pre-fills). */
	const [proxyOpen, setProxyOpen] = (0, react.useState)(false);
	const [managedProvider, setManagedProvider] = (0, react.useState)();
	const [proxyEnabled, setProxyEnabled] = (0, react.useState)(false);
	const [proxyUrl, setProxyUrl] = (0, react.useState)("");
	const [proxyUsername, setProxyUsername] = (0, react.useState)("");
	const [proxyPassword, setProxyPassword] = (0, react.useState)("");
	const [proxyClearPassword, setProxyClearPassword] = (0, react.useState)(false);
	const [proxyBypass, setProxyBypass] = (0, react.useState)("");
	const [proxySaving, setProxySaving] = (0, react.useState)(false);
	const [proxyTesting, setProxyTesting] = (0, react.useState)(false);
	const [proxyMessage, setProxyMessage] = (0, react.useState)(void 0);
	const [proxyTestResult, setProxyTestResult] = (0, react.useState)(void 0);
	const setProviderError = (0, react.useCallback)((provider, message) => {
		if (!mountedRef.current) return;
		setErrors((prev) => {
			const next = { ...prev };
			if (message === void 0) delete next[provider];
			else next[provider] = message;
			return next;
		});
	}, []);
	const stopPolling = (0, react.useCallback)((provider) => {
		const poller = pollersRef.current.get(provider);
		if (poller !== void 0) {
			clearInterval(poller);
			pollersRef.current.delete(provider);
		}
	}, []);
	/** Refetch every provider's status; stop a provider's poller once its attempt settles. */
	const refresh = (0, react.useCallback)(async () => {
		if (rpc === void 0) return;
		let response;
		try {
			response = await callSubscriptionsAuth(rpc, "status", {});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			for (const { id } of PROVIDERS) setProviderError(id, message);
			return;
		}
		if (!mountedRef.current) return;
		setStatuses(response.providers);
		for (const { id } of PROVIDERS) setProviderError(id, void 0);
		for (const { id } of PROVIDERS) {
			const status = response.providers[id];
			if (status.accounts.length > 0 || !status.busy) {
				stopPolling(id);
				setDeviceCodes((prev) => {
					if (prev[id] === void 0) return prev;
					const next = { ...prev };
					delete next[id];
					return next;
				});
			}
		}
	}, [
		rpc,
		stopPolling,
		setProviderError
	]);
	const startPolling = (0, react.useCallback)((provider) => {
		if (pollersRef.current.has(provider)) return;
		pollersRef.current.set(provider, setInterval(() => {
			refresh();
		}, POLL_INTERVAL_MS$1));
	}, [refresh]);
	(0, react.useEffect)(() => {
		mountedRef.current = true;
		refresh().then(() => {
			if (!mountedRef.current) return;
			setStatuses((current) => {
				for (const { id } of PROVIDERS) if (current[id]?.busy === true) startPolling(id);
				return current;
			});
		});
		return () => {
			mountedRef.current = false;
			for (const poller of pollersRef.current.values()) clearInterval(poller);
			pollersRef.current.clear();
		};
	}, [refresh, startPolling]);
	const loadUsage = (0, react.useCallback)(async (provider, account, force = false) => {
		const key = `${provider}:${account}`;
		if (rpc === void 0 || usageInflightRef.current.has(key)) return;
		usageInflightRef.current.add(key);
		setUsageLoading((prev) => ({
			...prev,
			[key]: true
		}));
		try {
			const usage = await callSubscriptionsAuth(rpc, "usage", {
				provider,
				account,
				...force ? { force: true } : {}
			});
			if (!mountedRef.current) return;
			setUsages((prev) => ({
				...prev,
				[key]: usage
			}));
			setUsageErrors((prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
		} catch (error) {
			if (mountedRef.current) setUsageErrors((prev) => ({
				...prev,
				[key]: messageOf(error)
			}));
		} finally {
			usageInflightRef.current.delete(key);
			if (mountedRef.current) setUsageLoading((prev) => ({
				...prev,
				[key]: false
			}));
		}
	}, [rpc]);
	async function prepareReset(account) {
		if (!rpc || resetInflight.current) return;
		resetInflight.current = true;
		setResetBusy(true);
		setResetAccount(account);
		setResetConfirmation(void 0);
		setResetMessage("");
		try {
			const result = await callSubscriptionsAuth(rpc, "prepareReset", { account });
			setResetAcknowledged(false);
			setResetConfirmation({
				...result,
				account
			});
		} catch (error) {
			setResetMessage(messageOf(error));
		} finally {
			resetInflight.current = false;
			setResetBusy(false);
		}
	}
	async function consumeReset() {
		if (!rpc || !resetConfirmation || !resetAcknowledged || resetInflight.current) return;
		const { account, ticket } = resetConfirmation;
		resetInflight.current = true;
		setResetBusy(true);
		setResetConfirmation(void 0);
		try {
			await callSubscriptionsAuth(rpc, "consumeReset", {
				account,
				ticket
			});
			setResetMessage(t("resetUseSuccess"));
		} catch (error) {
			setResetMessage(messageOf(error));
		} finally {
			await loadUsage("codex", account, true);
			resetInflight.current = false;
			setResetBusy(false);
		}
	}
	(0, react.useEffect)(() => {
		const live = /* @__PURE__ */ new Set();
		for (const { id } of PROVIDERS) for (const account of statuses[id]?.accounts ?? []) {
			const key = `${id}:${account.key}`;
			live.add(key);
			if (usages[key] === void 0 && usageErrors[key] === void 0) loadUsage(id, account.key);
		}
		setUsages((prev) => dropStale(prev, live));
		setUsageErrors((prev) => dropStale(prev, live));
	}, [
		statuses,
		usages,
		usageErrors,
		loadUsage
	]);
	const login = (0, react.useCallback)(async (provider, method) => {
		if (rpc === void 0) return;
		setProviderError(provider, void 0);
		try {
			const response = await callSubscriptionsAuth(rpc, "login", {
				provider,
				...method === void 0 ? {} : { method }
			});
			if (typeof response.authorizeUrl === "string" && response.authorizeUrl === "") {
				await refresh();
				return;
			}
			if (typeof response.authorizeUrl !== "string") throw new SubscriptionsAuthError(t("loginMissingUrl"));
			if (!mountedRef.current) return;
			setStatuses((prev) => ({
				...prev,
				[provider]: {
					accounts: prev[provider]?.accounts ?? [],
					...prev[provider],
					busy: true
				}
			}));
			if (typeof response.userCode === "string" && response.userCode.length > 0) setDeviceCodes((prev) => ({
				...prev,
				[provider]: {
					userCode: response.userCode,
					verificationUrl: response.authorizeUrl
				}
			}));
			else window.open(response.authorizeUrl, "_blank", "noopener");
			startPolling(provider);
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
	}, [
		rpc,
		t,
		setProviderError,
		startPolling
	]);
	const cancel = (0, react.useCallback)(async (provider) => {
		if (rpc === void 0) return;
		stopPolling(provider);
		try {
			await callSubscriptionsAuth(rpc, "cancel", { provider });
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
		await refresh();
	}, [
		rpc,
		stopPolling,
		setProviderError,
		refresh
	]);
	const submitManual = (0, react.useCallback)(async (provider) => {
		if (rpc === void 0) return;
		const input = manualDrafts[provider].trim();
		if (input === "") return;
		setProviderError(provider, void 0);
		try {
			await callSubscriptionsAuth(rpc, "manual", {
				provider,
				input
			});
			if (mountedRef.current) setManualDrafts((prev) => ({
				...prev,
				[provider]: ""
			}));
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
		await refresh();
	}, [
		rpc,
		manualDrafts,
		setProviderError,
		refresh
	]);
	const logout = (0, react.useCallback)(async (provider, account, display, name) => {
		if (rpc === void 0) return;
		if (!window.confirm(t("logoutAccountConfirm", {
			provider: name,
			account: display
		}))) return;
		setProviderError(provider, void 0);
		try {
			await callSubscriptionsAuth(rpc, "logout", {
				provider,
				account
			});
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
		await refresh();
	}, [
		rpc,
		t,
		setProviderError,
		refresh
	]);
	const setDefault = (0, react.useCallback)(async (provider, account) => {
		if (rpc === void 0) return;
		setProviderError(provider, void 0);
		try {
			await callSubscriptionsAuth(rpc, "setDefault", {
				provider,
				account
			});
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
		await refresh();
	}, [
		rpc,
		setProviderError,
		refresh
	]);
	const copyDeviceCode = (0, react.useCallback)((provider, userCode) => {
		navigator.clipboard?.writeText(userCode).then(() => {
			if (!mountedRef.current) return;
			setCopiedCode(provider);
			setTimeout(() => {
				if (mountedRef.current) setCopiedCode((current) => current === provider ? void 0 : current);
			}, 1500);
		}).catch(() => void 0);
	}, []);
	(0, react.useEffect)(() => {
		if (rpc === void 0) return;
		let alive = true;
		callSubscriptionsAuth(rpc, "proxyGet", {}).then((view) => {
			if (!alive) return;
			setProxy(view);
			setProxyLoadError(void 0);
		}).catch((error) => {
			if (alive) setProxyLoadError(messageOf(error));
		});
		return () => {
			alive = false;
		};
	}, [rpc]);
	(0, react.useEffect)(() => {
		if (!proxyOpen) return;
		const onKey = (event) => {
			if (event.key === "Escape") setProxyOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [proxyOpen]);
	const openProxyDialog = (0, react.useCallback)(() => {
		if (proxy === void 0) return;
		setProxyEnabled(proxy.enabled);
		setProxyUrl(proxy.url);
		setProxyUsername(proxy.username ?? "");
		setProxyPassword("");
		setProxyClearPassword(false);
		setProxyBypass(proxy.bypass.join(", "));
		setProxyMessage(void 0);
		setProxyTestResult(void 0);
		setProxyOpen(true);
	}, [proxy]);
	const saveProxy = (0, react.useCallback)(async () => {
		if (rpc === void 0) return;
		setProxySaving(true);
		setProxyMessage(void 0);
		try {
			setProxy(await callSubscriptionsAuth(rpc, "proxySet", {
				enabled: proxyEnabled,
				url: proxyUrl.trim(),
				username: proxyUsername,
				...proxyClearPassword ? { password: null } : proxyPassword !== "" ? { password: proxyPassword } : {},
				bypass: proxyBypass.split(/[,\n]/).map((entry) => entry.trim()).filter((entry) => entry !== "")
			}));
			setProxyLoadError(void 0);
			setProxyMessage({
				tone: "success",
				text: t("proxySaved")
			});
			setProxyOpen(false);
		} catch (error) {
			setProxyMessage({
				tone: "error",
				text: t("proxySaveFailed", { message: messageOf(error) })
			});
		} finally {
			setProxySaving(false);
		}
	}, [
		rpc,
		proxyEnabled,
		proxyUrl,
		proxyUsername,
		proxyPassword,
		proxyClearPassword,
		proxyBypass,
		t
	]);
	const testProxy = (0, react.useCallback)(async () => {
		if (rpc === void 0 || proxyTesting) return;
		setProxyTesting(true);
		setProxyTestResult(void 0);
		try {
			setProxyTestResult(await callSubscriptionsAuth(rpc, "proxyTest", { proxy: {
				url: proxyUrl.trim(),
				...proxyUsername.trim() !== "" ? { username: proxyUsername.trim() } : {},
				...proxyPassword !== "" ? { password: proxyPassword } : {}
			} }));
		} catch (error) {
			setProxyTestResult({
				ok: false,
				viaProxy: false,
				error: messageOf(error)
			});
		} finally {
			setProxyTesting(false);
		}
	}, [
		rpc,
		proxyTesting,
		proxyUrl,
		proxyUsername,
		proxyPassword
	]);
	if (rpc === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		style: styles$5.intro,
		children: t("unavailable")
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-subscriptions-settings",
		style: styles$5.section,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: providerSettingsCss }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$5.intro,
				children: t("intro")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageBadgeDisplaySetting, { t }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles$5.proxyCard,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles$5.cardHeader,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								...styles$5.dot,
								background: proxy?.enabled === true ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-dimmed)"
							},
							role: "img",
							"aria-label": proxy?.enabled === true ? t("proxyEnabled") : t("proxyDisabledHint")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles$5.name,
							children: t("proxyTitle")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								marginLeft: "auto",
								flexShrink: 0
							},
							onClick: openProxyDialog,
							children: t("proxyConfigure")
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: styles$5.statusLine,
					children: proxyStatusText(t, proxy, proxyLoadError)
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: styles$5.separator }),
			PROVIDERS.map(({ id, name }) => {
				const status = statuses[id];
				const busy = status?.busy === true;
				const deviceCode = deviceCodes[id];
				const accounts = status?.accounts ?? [];
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles$5.card,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles$5.cardHeader,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										...styles$5.dot,
										background: dotColor(status)
									},
									role: "img",
									"aria-label": t(DOT_STATE_LABEL[dotState(status)])
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.name,
									children: status?.displayName || name
								}),
								status?.displayName && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
									style: styles$5.statusLine,
									children: name
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ClientVersionTag, {
									clientVersion: status?.clientVersion,
									t
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles$5.statusLine,
							children: statusText(t, status)
						}),
						status?.detail !== void 0 && status.detail !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles$5.statusLine,
							children: status.detail
						}),
						errors[id] !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles$5.errorLine,
							children: errors[id]
						}),
						accounts.map((account) => {
							const usageKey = `${id}:${account.key}`;
							const usage = usages[usageKey];
							const shownWindows = visibleUsageWindows(id, usage?.windows, status?.visibleModels);
							const usageError = usageErrors[usageKey];
							const display = account.account ?? account.key;
							const sortedCredits = [...usage?.resetCredits ?? []].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
							const nextReset = sortedCredits.find((c) => c.expiresAt === void 0 || c.expiresAt > Date.now());
							const resetBlock = usage ? resetActionBlock(usage) : "resetUseRefresh";
							const resetDisabled = resetBusy || resetBlock !== void 0;
							const showUsage = usage?.supported !== false && (usage !== void 0 || usageError !== void 0 || usageLoading[usageKey] === true);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles$5.accountRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: styles$5.accountHeader,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: styles$5.starButton,
											title: account.isDefault ? t("defaultBadge") : t("setDefault"),
											onClick: () => {
												if (!account.isDefault) setDefault(id, account.key);
											},
											children: account.isDefault ? "★" : "☆"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: styles$5.accountName,
											children: display
										}),
										account.plan !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: styles$5.usagePlan,
											children: account.plan
										}),
										account.expiresAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: styles$5.statusLine,
											children: t("accountExpires", { date: new Date(account.expiresAt).toLocaleString() })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: {
												marginLeft: "auto",
												flexShrink: 0
											},
											onClick: () => {
												logout(id, account.key, display, name);
											},
											children: t("logout")
										})
									]
								}), showUsage && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: styles$5.usage,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: styles$5.usageHeader,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: styles$5.usageTitle,
													children: t("usageTitle")
												}),
												usage?.plan !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: styles$5.usagePlan,
													children: t("usagePlan", { plan: usage.plan })
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: styles$5.usageRefresh,
													disabled: usageLoading[usageKey] === true,
													onClick: () => {
														loadUsage(id, account.key, true);
													},
													children: t("usageRefresh")
												})
											]
										}),
										usage === void 0 && usageError === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: styles$5.statusLine,
											children: t("usageLoading")
										}),
										usageError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: styles$5.errorLine,
											children: t("usageError", { message: usageError })
										}),
										usage?.windows !== void 0 && usage.windows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: styles$5.statusLine,
											children: t("usageEmpty")
										}),
										usage?.windows !== void 0 && usage.windows.length > 0 && shownWindows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: styles$5.statusLine,
											children: t("usageNoVisibleModels")
										}),
										shownWindows.map((window$1, index) => {
											const percent = Math.min(100, Math.max(0, window$1.usedPercent));
											return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: styles$5.usageRow,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: styles$5.usageMeta,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: usageWindowLabel$1(t, window$1) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [`${String(Math.round(percent))}%`, window$1.resetsAt !== void 0 && ` · ${t("usageResets", { date: new Date(window$1.resetsAt).toLocaleString() })}`] })]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: styles$5.usageTrack,
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
														...styles$5.usageFill,
														width: `${String(percent)}%`,
														background: usageBarColor(percent)
													} })
												})]
											}, index);
										}),
										id === "codex" && usage?.resetCreditsError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: styles$5.errorLine,
											children: t("resetCreditsError", { message: usage.resetCreditsError })
										}),
										id === "codex" && usage?.resetCredits !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
											className: "subscriptions-reset-credits",
											style: styles$5.usageRow,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
													style: {
														...styles$5.usageMeta,
														cursor: "pointer",
														listStyle: "none",
														justifyContent: "flex-start",
														gap: 6
													},
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
															"aria-hidden": "true",
															width: "12",
															height: "12",
															viewBox: "0 0 16 16",
															style: { flexShrink: 0 },
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
																d: "m6 3 5 5-5 5",
																fill: "none",
																stroke: "currentColor",
																strokeWidth: "1.5",
																strokeLinecap: "round",
																strokeLinejoin: "round"
															})
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("resetCreditsTitle") }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: { marginLeft: "auto" },
															children: t("resetCreditsAvailable", { count: usage.resetCredits.length })
														})
													]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: ".subscriptions-reset-credits > summary::-webkit-details-marker { display: none; }.subscriptions-reset-credits[open] > summary > svg { transform: rotate(90deg); }" }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: {
														paddingLeft: 18,
														marginTop: 6
													},
													children: [sortedCredits.map((credit, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														style: {
															...styles$5.usageMeta,
															minHeight: 28,
															gap: 12
														},
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															style: {
																display: "inline-flex",
																alignItems: "center",
																gap: 8,
																flexShrink: 0
															},
															children: [t("resetCreditFull"), credit === nextReset && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																"aria-disabled": resetDisabled,
																title: t(resetBusy ? "resetUseChecking" : resetBlock ?? "resetUseReady"),
																style: {
																	height: 22,
																	minHeight: 22,
																	padding: "0 7px",
																	opacity: resetDisabled ? .35 : 1,
																	cursor: resetDisabled ? "not-allowed" : "pointer"
																},
																onClick: () => {
																	if (!resetDisabled) prepareReset(account.key);
																},
																children: resetBusy && resetAccount === account.key ? t("resetUseChecking") : t("resetUseButton")
															})]
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: { textAlign: "right" },
															children: credit.expiresAt === void 0 ? t("resetCreditExpiryUnknown") : t("resetCreditExpires", { date: new Date(credit.expiresAt).toLocaleString() })
														})]
													}, credit.id ?? index)), resetAccount === account.key && resetMessage && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														role: "status",
														style: styles$5.statusLine,
														children: resetMessage
													})]
												})
											]
										})
									]
								})]
							}, account.key);
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles$5.actions,
							children: [
								!busy && accounts.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => {
										login(id);
									},
									children: t("login")
								}),
								!busy && accounts.length > 0 && id === "claude" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => {
										login(id, "oauth");
									},
									children: t("addAccountOAuth")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => {
										login(id, "keychain");
									},
									children: t("addAccountKeychain")
								})] }),
								!busy && accounts.length > 0 && id !== "claude" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => {
										login(id);
									},
									children: t("addAccount")
								}),
								!busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									"aria-haspopup": "dialog",
									onClick: () => setManagedProvider({
										id,
										name
									}),
									children: t("accountsManage")
								}),
								busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => {
										cancel(id);
									},
									children: t("cancel")
								})
							]
						}),
						!busy && accounts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles$5.statusLine,
							children: t("addAccountHint")
						}),
						busy && deviceCode !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles$5.deviceCode,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.statusLine,
									children: t("deviceCodePrompt")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.deviceCodeText,
									children: deviceCode.userCode
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: styles$5.actions,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => {
											copyDeviceCode(id, deviceCode.userCode);
										},
										children: copiedCode === id ? t("deviceCodeCopied") : t("deviceCodeCopy")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => {
											window.open(deviceCode.verificationUrl, "_blank", "noopener");
										},
										children: t("deviceCodeOpenPage")
									})]
								})
							]
						}),
						busy && deviceCode === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
							style: styles$5.manual,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("manualSummary") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles$5.manualRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: styles$5.manualInput,
									value: manualDrafts[id],
									placeholder: t("manualPlaceholder"),
									onChange: (event) => setManualDrafts((prev) => ({
										...prev,
										[id]: event.target.value
									}))
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => {
										submitManual(id);
									},
									children: t("submit")
								})]
							})]
						})
					]
				}, id);
			}),
			managedProvider && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProviderAccountManager, {
				provider: managedProvider.id,
				name: managedProvider.name,
				rpc,
				t,
				onClose: () => {
					setManagedProvider(void 0);
					refresh();
				}
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: ".subscriptions-reset-dialog::backdrop { background: var(--dsw-alias-bg-mask-1, #0006); backdrop-filter: var(--dsw-mask-blur, none); }" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dialog", {
				ref: resetDialogRef,
				className: "subscriptions-reset-dialog",
				"aria-labelledby": "subscriptions-reset-title",
				onCancel: () => setResetConfirmation(void 0),
				onClose: () => setResetConfirmation(void 0),
				style: {
					...styles$5.modal,
					display: resetConfirmation ? "flex" : "none",
					margin: "auto",
					color: "var(--dsw-alias-label-primary)"
				},
				children: resetConfirmation && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						id: "subscriptions-reset-title",
						style: {
							...styles$5.modalTitle,
							margin: 0
						},
						children: t("resetUseConfirmTitle")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...styles$5.statusLine,
							overflowWrap: "anywhere"
						},
						children: statuses.codex?.accounts.find((a) => a.key === resetConfirmation.account)?.account ?? resetConfirmation.account
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...styles$5.usageMeta,
							gap: 12
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageWeekly") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [Math.round(resetConfirmation.weeklyUsedPercent), "%"] })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles$5.usageMeta,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: resetConfirmation.creditExpiresAt === void 0 ? t("resetCreditExpiryUnknown") : t("resetCreditExpires", { date: new Date(resetConfirmation.creditExpiresAt).toLocaleString() }) })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...styles$5.statusLine,
							margin: "4px 0"
						},
						children: t("resetUseWarning")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "flex",
							gap: 8,
							alignItems: "flex-start",
							fontSize: 12
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: resetAcknowledged,
							onChange: (e) => setResetAcknowledged(e.target.checked)
						}), t("resetUseAcknowledge")]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-subscription-dialog-actions",
						style: {
							...styles$5.actions,
							justifyContent: "flex-end",
							marginTop: 8
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							autoFocus: true,
							onClick: () => setResetConfirmation(void 0),
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-subscription-primary",
							style: {
								opacity: resetAcknowledged ? 1 : .35,
								cursor: resetAcknowledged ? "pointer" : "not-allowed"
							},
							disabled: !resetAcknowledged || resetBusy,
							onClick: () => {
								consumeReset();
							},
							children: t("resetUseConfirm")
						})]
					})
				] })
			}),
			proxyOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: styles$5.modalOverlay,
				onClick: () => setProxyOpen(false),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles$5.modal,
					onClick: (event) => event.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles$5.modalHeader,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles$5.modalTitle,
								children: t("proxyDialogTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: { marginLeft: "auto" },
								onClick: () => setProxyOpen(false),
								children: t("proxyDialogClose")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: styles$5.proxyCheck,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: proxyEnabled,
								onChange: (event) => setProxyEnabled(event.target.checked)
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("proxyEnabled") })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: styles$5.proxyField,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.proxyLabel,
									children: t("proxyUrl")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: styles$5.proxyInput,
									value: proxyUrl,
									placeholder: t("proxyUrlPlaceholder"),
									onChange: (event) => setProxyUrl(event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: styles$5.proxyHint,
									children: t("proxyUrlHint")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: styles$5.proxyField,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles$5.proxyLabel,
								children: t("proxyUsername")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles$5.proxyInput,
								value: proxyUsername,
								placeholder: t("proxyUsernamePlaceholder"),
								onChange: (event) => setProxyUsername(event.target.value)
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles$5.proxyField,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.proxyLabel,
									children: t("proxyPassword")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "password",
									style: styles$5.proxyInput,
									value: proxyPassword,
									placeholder: t("proxyPasswordPlaceholder"),
									onChange: (event) => setProxyPassword(event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: styles$5.proxyCheck,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: proxyClearPassword,
										onChange: (event) => setProxyClearPassword(event.target.checked)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("proxyClearPassword") })]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: styles$5.proxyField,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.proxyLabel,
									children: t("proxyBypass")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: styles$5.proxyInput,
									value: proxyBypass,
									placeholder: t("proxyBypassPlaceholder"),
									onChange: (event) => setProxyBypass(event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: styles$5.proxyHint,
									children: t("proxyBypassHint")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles$5.proxyHint,
							children: t("proxyNote")
						}),
						proxyMessage !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								...styles$5.proxyMessage,
								color: messageColor(proxyMessage.tone)
							},
							children: proxyMessage.text
						}),
						proxyTestResult !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								...styles$5.proxyMessage,
								color: proxyTestResult.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)"
							},
							children: proxyTestResult.ok ? proxyTestResult.viaProxy ? t("proxyTestOk", {
								status: String(proxyTestResult.status),
								ms: String(proxyTestResult.latencyMs)
							}) : t("proxyTestOkDirect", {
								status: String(proxyTestResult.status),
								ms: String(proxyTestResult.latencyMs)
							}) : t("proxyTestFail", { message: proxyTestResult.error ?? "" })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-subscription-dialog-actions",
							style: styles$5.proxyActions,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									disabled: proxyTesting,
									onClick: () => {
										testProxy();
									},
									children: proxyTesting ? t("proxyTesting") : t("proxyTest")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-subscription-primary",
									disabled: proxySaving,
									onClick: () => {
										saveProxy();
									},
									children: proxySaving ? t("proxySaving") : t("proxySave")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => setProxyOpen(false),
									children: t("proxyCancel")
								})
							]
						})
					]
				})
			})
		]
	});
}

//#endregion
//#region src/client/ImageGallery.tsx
/** Display box for a lone image (platform rule): long edge 240px with the
* rendered aspect ratio clamped to [0.25, 4] — the overflow is cropped by
* `object-fit: cover` — and never upscaled past the image's natural size. The
* crop anchor keeps the top of very tall images and the left of very wide
* ones, where the informative content usually starts. */
function singleFit(attachment) {
	const natural = attachment.width / attachment.height;
	const ratio = Math.min(4, Math.max(.25, natural));
	const box = ratio >= 1 ? {
		width: 240,
		height: 240 / ratio
	} : {
		width: 240 * ratio,
		height: 240
	};
	const scale = Math.min(1, attachment.width / box.width, attachment.height / box.height);
	return {
		width: Math.max(1, Math.round(box.width * scale)),
		height: Math.max(1, Math.round(box.height * scale)),
		objectPosition: natural < .25 ? "center top" : natural > 4 ? "left center" : "center"
	};
}
const styles$4 = {
	gallery: {
		display: "flex",
		flexWrap: "wrap",
		gap: 8,
		justifyContent: "flex-start"
	},
	frame: {
		display: "grid",
		placeItems: "center",
		overflow: "hidden",
		padding: 0,
		border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
		borderRadius: 8,
		background: "var(--dsw-alias-interactive-bg-hover-solid)",
		cursor: "zoom-in"
	},
	tile: {
		width: 64,
		height: 64
	},
	img: {
		width: "100%",
		height: "100%",
		objectFit: "cover",
		display: "block"
	},
	loading: {
		fontSize: 12,
		color: "var(--dsw-alias-label-tertiary)",
		padding: "0 8px"
	},
	error: {
		fontSize: 12,
		color: "var(--dsw-alias-state-error-primary)",
		cursor: "pointer",
		border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
		borderRadius: 8,
		background: "transparent",
		padding: "6px 10px"
	},
	overlay: {
		position: "fixed",
		inset: 0,
		zIndex: 1e3,
		display: "grid",
		placeItems: "center",
		background: "rgba(0, 0, 0, 0.72)",
		padding: 24
	},
	overlayImg: {
		maxWidth: "92vw",
		maxHeight: "92vh",
		objectFit: "contain",
		borderRadius: 4
	},
	close: {
		position: "absolute",
		top: 12,
		right: 12,
		width: 32,
		height: 32,
		display: "grid",
		placeItems: "center",
		border: "none",
		borderRadius: "50%",
		cursor: "pointer",
		background: "rgba(255, 255, 255, 0.16)",
		color: "#fff",
		fontSize: 16,
		lineHeight: 1
	}
};
/**
* Full-viewport original-image preview: backdrop or close-control click and
* Escape all dismiss; the image itself is inert so a click on it does not
* fall through to the backdrop dismissal.
*/
function ImageLightbox({ src, alt, labels, onClose }) {
	(0, react.useEffect)(() => {
		const onKey = (event) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
		};
	}, [onClose]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		role: "dialog",
		"aria-label": labels.dialog,
		style: styles$4.overlay,
		onClick: onClose,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
			src,
			alt,
			style: styles$4.overlayImg,
			onClick: (event) => {
				event.stopPropagation();
			}
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			"aria-label": labels.close,
			style: styles$4.close,
			onClick: onClose,
			children: "×"
		})]
	});
}
/**
* Compact history renderer with retryable loading and click-to-open original
* preview. A lone image renders at its `singleFit` size; an image among
* several renders as a fixed 64px square tile.
*/
function MessageImage({ attachment, load, variant, labels }) {
	const [src, setSrc] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(false);
	const [open, setOpen] = (0, react.useState)(false);
	const [attempt, setAttempt] = (0, react.useState)(0);
	const retry = (0, react.useCallback)(() => {
		setAttempt((a) => a + 1);
	}, []);
	const close = (0, react.useCallback)(() => {
		setOpen(false);
	}, []);
	const fit = (0, react.useMemo)(() => variant === "single" ? singleFit(attachment) : void 0, [attachment, variant]);
	(0, react.useEffect)(() => {
		let live = true;
		setError(false);
		setSrc(null);
		load(attachment).then((url) => {
			if (live) setSrc(url);
		}).catch(() => {
			if (live) setError(true);
		});
		return () => {
			live = false;
		};
	}, [
		attachment,
		load,
		attempt
	]);
	const label = attachment.name ?? labels.image;
	if (error) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		style: styles$4.error,
		onClick: retry,
		children: labels.loadFailed
	});
	const box = fit === void 0 ? styles$4.tile : {
		width: fit.width,
		height: fit.height
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		style: {
			...styles$4.frame,
			...box
		},
		title: labels.open,
		"aria-label": labels.openNamed(label),
		onClick: () => {
			if (src !== null) setOpen(true);
		},
		children: src === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: styles$4.loading,
			children: labels.loading
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
			src,
			alt: label,
			style: {
				...styles$4.img,
				objectPosition: fit?.objectPosition
			}
		})
	}), open && src !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImageLightbox, {
		src,
		alt: label,
		labels: labels.lightbox,
		onClose: close
	})] });
}
/** Wrapping image group: a lone image renders large, several render as 64px
* square tiles (same rule as the platform gallery). */
function ImageGallery({ images, load, labels }) {
	if (images.length === 0) return null;
	const variant = images.length === 1 ? "single" : "tile";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: styles$4.gallery,
		children: images.map((image, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MessageImage, {
			attachment: image.attachment,
			load,
			variant,
			labels
		}, `${image.attachment.attachmentId}:${index}`))
	});
}

//#endregion
//#region src/client/host-icons.ts
/** A decorative glyph the host lacks renders nothing rather than crashing. */
const NoIcon = () => null;
/**
* Resolve one 16px glyph under either host naming.
* @param icons - the host primitives module (`import * as`), read by name.
* @param name - the glyph name without prefix or size, e.g. `Sparkle`.
* @returns the host's component, or one rendering nothing.
*/
function hostIcon(icons, name) {
	const exports$1 = icons;
	return exports$1[`Icon${name}Regular`] ?? exports$1[`Icon${name}16`] ?? NoIcon;
}

//#endregion
//#region src/client/ImageGenerateToolview.tsx
/** DSH 0.1.7 renamed IconSparkle16; resolving it by name keeps older hosts working too. */
const SparkleIcon$1 = hostIcon(__deepseek_ai_dsh_client_ui_primitives, "Sparkle");
/** Title prompt truncation budget (characters). */
const PROMPT_MAX_LENGTH$1 = 60;
/**
* Build the ImageGallery loader over the `image` endpoint.
* @param rpc - Connection RPC caller.
* @returns loader resolving an attachment ref to a data URL.
*/
function createImageLoader(rpc) {
	return (attachment) => callSubscriptionsAuth(rpc, "image", { ...attachment }).then((result) => `data:${result.mediaType};base64,${result.dataBase64}`);
}
/**
* English-dictionary fallback for a missing locale seat (standalone renders);
* the framework always supplies the namespace-bound one.
* @param key - dictionary key.
* @param params - `{name}` template params.
* @returns the template with params substituted.
*/
function fallbackTranslate$3(key, params) {
	let text = en[key];
	for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
	return text;
}
/** Extract the prompt from the call's raw args JSON; falls back to the first string value, then the raw line. */
function derivePrompt$1(argsRaw) {
	let parsed;
	try {
		parsed = JSON.parse(argsRaw);
	} catch {
		parsed = void 0;
	}
	let prompt;
	if (typeof parsed === "object" && parsed !== null) {
		const args = parsed;
		if (typeof args.prompt === "string" && args.prompt !== "") prompt = args.prompt;
		else for (const value of Object.values(args)) if (typeof value === "string" && value !== "") {
			prompt = value;
			break;
		}
	}
	const line = (prompt ?? argsRaw).split("\n", 1)[0] ?? "";
	return line.length > PROMPT_MAX_LENGTH$1 ? `${line.slice(0, PROMPT_MAX_LENGTH$1)}…` : line;
}
/** Flatten a settled result's text blocks (the degraded text-only route and the error line). */
function resultText$1(block) {
	if (!("kind" in block)) return "";
	const parts = [];
	for (const part of block.content) if (part.type === "text") parts.push(part.text);
	if (parts.length === 0 && block.error !== void 0) parts.push(`${block.error.name}: ${block.error.code}`);
	return parts.join("\n");
}
/** Image attachments of a settled result; empty while running or on the text-only route. */
function resultImages(block) {
	if (!("kind" in block)) return [];
	const images = [];
	for (const part of block.content) if (part.type === "image") images.push({ attachment: part.attachment });
	return images;
}
const styles$3 = {
	container: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		padding: "4px 0"
	},
	row: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		minWidth: 0
	},
	icon: {
		display: "inline-flex",
		flexShrink: 0,
		color: "var(--dsw-alias-label-tertiary)"
	},
	title: {
		fontSize: 13,
		lineHeight: "20px",
		color: "var(--dsw-alias-label-primary)",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	subtle: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	output: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-secondary)",
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere"
	},
	error: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-state-error-primary)"
	}
};
/**
* The `image_generate` keyed toolview component.
* @param props - owner share, inject face, and locale seat (spread flat).
* @returns the call row plus, once settled, the gallery / text / error body.
*/
function ImageGenerateToolview(props) {
	const { block, load } = props;
	const t = props.t ?? fallbackTranslate$3;
	if (block === void 0) return null;
	const settled = "kind" in block;
	const argsRaw = (settled ? block.call?.argsRaw : "argsRaw" in block ? block.argsRaw : void 0) ?? "";
	let references = 0;
	try {
		const args = JSON.parse(argsRaw);
		if (Array.isArray(args?.referenceImages)) references = args.referenceImages.length;
	} catch {}
	const title = `image_generate${references > 0 ? ` (${references} ref)` : ""}: ${derivePrompt$1(argsRaw)}`;
	const images = resultImages(block);
	const text = settled ? resultText$1(block) : "";
	const labels = {
		image: t("image"),
		open: t("viewImage"),
		openNamed: (name) => t("viewImageNamed", { name }),
		loading: t("imageLoading"),
		loadFailed: t("imageLoadFailed"),
		lightbox: {
			dialog: t("imagePreview"),
			close: t("imageClose")
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: styles$3.container,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles$3.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles$3.icon,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SparkleIcon$1, { size: 14 })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles$3.title,
					children: title
				})]
			}),
			!settled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$3.subtle,
				children: t("generating")
			}),
			settled && block.isError && text !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$3.error,
				children: text.split("\n", 1)[0]
			}),
			settled && !block.isError && images.length > 0 && load !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImageGallery, {
				images,
				load,
				labels
			}),
			settled && !block.isError && images.length === 0 && text !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$3.output,
				children: text
			})
		]
	});
}

//#endregion
//#region src/client/VideoGenerateToolview.tsx
/** DSH 0.1.7 renamed IconSparkle16; resolving it by name keeps older hosts working too. */
const SparkleIcon = hostIcon(__deepseek_ai_dsh_client_ui_primitives, "Sparkle");
/** Title prompt truncation budget (characters). */
const PROMPT_MAX_LENGTH = 60;
/**
* Build the video loader over the `/subscriptions-auth` `video` endpoint.
* @param rpc - Connection RPC caller.
* @returns loader resolving a bare file name to the decoded bytes.
*/
function createVideoLoader(rpc) {
	return (name) => callSubscriptionsAuth(rpc, "video", { name });
}
/**
* English-dictionary fallback for a missing locale seat (standalone renders);
* the framework always supplies the namespace-bound one.
*/
function fallbackTranslate$2(key, params) {
	let text = en[key];
	for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
	return text;
}
/** Extract the prompt from the call's raw args JSON; falls back to the first string value, then the raw line. */
function derivePrompt(argsRaw) {
	let parsed;
	try {
		parsed = JSON.parse(argsRaw);
	} catch {
		parsed = void 0;
	}
	let prompt;
	if (typeof parsed === "object" && parsed !== null) {
		const args = parsed;
		if (typeof args.prompt === "string" && args.prompt !== "") prompt = args.prompt;
		else for (const value of Object.values(args)) if (typeof value === "string" && value !== "") {
			prompt = value;
			break;
		}
	}
	const line = (prompt ?? argsRaw).split("\n", 1)[0] ?? "";
	return line.length > PROMPT_MAX_LENGTH ? `${line.slice(0, PROMPT_MAX_LENGTH)}…` : line;
}
/** Flatten a settled result's text blocks (the fallback body and the error line). */
function resultText(block) {
	if (!("kind" in block)) return "";
	const parts = [];
	for (const part of block.content) if (part.type === "text") parts.push(part.text);
	if (parts.length === 0 && block.error !== void 0) parts.push(`${block.error.name}: ${block.error.code}`);
	return parts.join("\n");
}
/**
* The generated video's bare file name: presentation meta first (top-level
* dispatches), then the render text's "Saved video to …" line (nested
* dispatches compute no meta).
*/
function resolveFileName(block) {
	if (!("kind" in block)) return void 0;
	const meta = block.meta;
	if (typeof meta === "object" && meta !== null) {
		const fileName = meta.fileName;
		if (typeof fileName === "string" && fileName.length > 0) return fileName;
	}
	const match = /^Saved video to (.+\.mp4)/m.exec(resultText(block));
	if (match === null) return void 0;
	const path = match[1];
	return path.slice(path.lastIndexOf("/") + 1);
}
/** Decode a base64 payload into bytes (browser-side; no Buffer). */
function base64Bytes(dataBase64) {
	const binary = atob(dataBase64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}
const styles$2 = {
	container: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		padding: "4px 0"
	},
	row: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		minWidth: 0
	},
	icon: {
		display: "inline-flex",
		flexShrink: 0,
		color: "var(--dsw-alias-label-tertiary)"
	},
	title: {
		fontSize: 13,
		lineHeight: "20px",
		color: "var(--dsw-alias-label-primary)",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	subtle: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	output: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-secondary)",
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere"
	},
	error: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-state-error-primary)"
	},
	video: {
		display: "block",
		maxWidth: 480,
		width: "100%",
		borderRadius: 8,
		backgroundColor: "var(--dsw-alias-fill-tertiary)"
	}
};
/**
* The `video_generate` keyed toolview component.
* @param props - owner share, inject face, and locale seat (spread flat).
* @returns the call row plus, once settled, the player / text / error body.
*/
function VideoGenerateToolview(props) {
	const { block, loadVideo } = props;
	const t = props.t ?? fallbackTranslate$2;
	const settled = block !== void 0 && "kind" in block;
	const isError = settled && block.isError;
	const fileName = block !== void 0 && settled && !isError ? resolveFileName(block) : void 0;
	const [load, setLoad] = (0, react.useState)({ phase: "loading" });
	(0, react.useEffect)(() => {
		if (fileName === void 0 || loadVideo === void 0) return;
		let cancelled = false;
		let objectUrl;
		setLoad({ phase: "loading" });
		loadVideo(fileName).then((video) => {
			if (cancelled) return;
			objectUrl = URL.createObjectURL(new Blob([base64Bytes(video.dataBase64).slice()], { type: video.mediaType }));
			setLoad({
				phase: "ready",
				url: objectUrl
			});
		}, (error) => {
			if (cancelled) return;
			setLoad({
				phase: "failed",
				message: error instanceof Error ? error.message : String(error)
			});
		});
		return () => {
			cancelled = true;
			if (objectUrl !== void 0) URL.revokeObjectURL(objectUrl);
		};
	}, [fileName, loadVideo]);
	if (block === void 0) return null;
	const title = `video_generate: ${derivePrompt((settled ? block.call?.argsRaw : "argsRaw" in block ? block.argsRaw : void 0) ?? "")}`;
	const text = settled ? resultText(block) : "";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: styles$2.container,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles$2.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles$2.icon,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SparkleIcon, { size: 14 })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles$2.title,
					children: title
				})]
			}),
			!settled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$2.subtle,
				children: t("generatingVideo")
			}),
			settled && isError && text !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$2.error,
				children: text.split("\n", 1)[0]
			}),
			settled && !isError && fileName !== void 0 && load.phase === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$2.subtle,
				children: t("videoLoading")
			}),
			settled && !isError && fileName !== void 0 && load.phase === "failed" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$2.error,
				children: t("videoLoadFailed", { message: load.message })
			}),
			settled && !isError && fileName !== void 0 && load.phase === "ready" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("video", {
				style: styles$2.video,
				src: load.url,
				controls: true,
				preload: "metadata"
			}),
			settled && !isError && fileName === void 0 && text !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$2.output,
				children: text
			})
		]
	});
}

//#endregion
//#region src/client/SpeedSelect.tsx
/**
* The `loadSpeed` half of the inject face: the plugin's own speed state plus
* the host's current model selection (the visibility gate). A model-RPC
* failure throws rather than answering "hidden" — the caller keeps its last
* known state, so a transient failure never locks the toggle away.
*
* `sessionId` is a plain string: slot and command contexts brand it through
* different dsh-session copies, and only the service boundary needs one.
*
* `models` resolves lazily per call: the ui-model-selection service may
* register after this plugin applies, and a shell without it (no model seat
* at all) simply keeps the toggle hidden.
*/
function createSpeedLoader(connection, models, sessionId) {
	return async () => {
		const directories = models();
		const current = directories === void 0 ? null : (await directories.directoryFor(sessionId).load()).current;
		const state = await callSubscriptionsAuth(connection.rpc, "speed", {
			sessionId,
			...current?.provider === "codex" ? { model: current.model } : {}
		});
		return {
			visible: current !== null && current.provider === "codex" && state.fastModels.includes(current.model),
			tier: state.tier
		};
	};
}
/** The `setSpeed` half of the inject face: boolean outcome for the component's busy state. */
function createSpeedSetter(connection, sessionId) {
	return (tier) => callSubscriptionsAuth(connection.rpc, "setSpeed", {
		sessionId,
		tier
	}).then(() => true, () => false);
}
/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate$1(key) {
	return en[key];
}
const TIERS = ["standard", "fast"];
/**
* The composer Speed control: a trigger reading `速度 · 快速`/`速度 · 标准`
* that opens a two-row menu (standard/fast with descriptions, check mark on
* the current tier). Mount and every open reload the host state so a model
* switch made since the last open self-corrects.
*/
/** How often the control re-reads the host state (model switches arrive only by asking). */
const POLL_INTERVAL_MS = 3e3;
/**
* The composer Speed control: a trigger reading `速度 · 快速`/`速度 · 标准`
* that opens a two-row menu (standard/fast with descriptions, check mark on
* the current tier). The host pushes nothing on a model switch, so the
* control re-reads on a slow poll with a single-flight guard; a failed read
* keeps the last known state, so a transient RPC failure can never lock the
* toggle away (the earlier mount-only load had no recovery path).
*/
function SpeedSelect({ loadSpeed, setSpeed, t }) {
	const translate = t ?? fallbackTranslate$1;
	const [state, setState] = (0, react.useState)(null);
	const [open, setOpen] = (0, react.useState)(false);
	const [busy, setBusy] = (0, react.useState)(false);
	const rootRef = (0, react.useRef)(null);
	const loadRef = (0, react.useRef)(loadSpeed);
	loadRef.current = loadSpeed;
	(0, react.useEffect)(() => {
		if (loadRef.current === void 0) return;
		let cancelled = false;
		let inflight = false;
		const reload = () => {
			const load = loadRef.current;
			if (load === void 0 || inflight) return;
			inflight = true;
			load().then((loaded) => {
				if (!cancelled) setState(loaded);
			}, () => {}).finally(() => {
				inflight = false;
			});
		};
		reload();
		const timer = setInterval(reload, POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);
	(0, react.useEffect)(() => {
		if (!open) return;
		const closeOutside = (event) => {
			if (!rootRef.current?.contains(event.target)) setOpen(false);
		};
		document.addEventListener("mousedown", closeOutside);
		return () => {
			document.removeEventListener("mousedown", closeOutside);
		};
	}, [open]);
	if (loadSpeed === void 0 || setSpeed === void 0 || state === null || !state.visible) return null;
	const choose = (tier) => {
		if (busy) return;
		if (tier === state.tier) {
			setOpen(false);
			return;
		}
		setBusy(true);
		setSpeed(tier).then((ok) => {
			setBusy(false);
			if (ok) {
				setState({
					visible: true,
					tier
				});
				setOpen(false);
			}
		});
	};
	const show = () => {
		setOpen(true);
		const load = loadRef.current;
		if (load === void 0) return;
		load().then(setState, () => {});
	};
	const tierName = (tier) => translate(tier === "fast" ? "speedFast" : "speedStandard");
	const tierDescription = (tier) => translate(tier === "fast" ? "speedFastDescription" : "speedStandardDescription");
	const triggerLabel = `${translate("speed")} · ${tierName(state.tier)}`;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		ref: rootRef,
		className: "dsh-subscription-speed",
		style: styles$1.root,
		onKeyDown: (event) => {
			if (event.key === "Escape" && open) {
				event.preventDefault();
				setOpen(false);
			}
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: subscriptionChromeCss }),
			open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: styles$1.menu,
				role: "menu",
				"aria-label": translate("speed"),
				children: TIERS.map((tier) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					role: "menuitemradio",
					"aria-checked": tier === state.tier,
					style: styles$1.item,
					disabled: busy,
					onClick: () => {
						choose(tier);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles$1.itemCheck,
						children: tier === state.tier ? "✓" : ""
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: styles$1.itemText,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles$1.itemName,
							children: tierName(tier)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles$1.itemDescription,
							children: tierDescription(tier)
						})]
					})]
				}, tier))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				style: styles$1.trigger,
				"aria-haspopup": "menu",
				"aria-expanded": open,
				title: triggerLabel,
				disabled: busy,
				onClick: () => {
					if (open) setOpen(false);
					else show();
				},
				children: triggerLabel
			})
		]
	});
}
const styles$1 = {
	root: {
		position: "relative",
		display: "inline-flex"
	},
	trigger: {
		border: "0.5px solid var(--dsw-alias-border-l3)",
		borderRadius: "var(--dsw-radius-sm, 8px)",
		background: "var(--dsh-subscription-speed-hover, transparent)",
		color: "var(--dsw-alias-label-secondary)",
		font: "inherit",
		fontSize: 12,
		lineHeight: "18px",
		padding: "2px 8px",
		cursor: "pointer",
		whiteSpace: "nowrap"
	},
	menu: {
		position: "absolute",
		bottom: "100%",
		right: 0,
		marginBottom: 4,
		minWidth: 180,
		padding: 4,
		zIndex: 20,
		background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2))",
		border: 0,
		boxShadow: "var(--dsw-elevation-prominent)",
		borderRadius: "var(--dsw-radius-lg, 16px)",
		display: "flex",
		flexDirection: "column",
		gap: 2
	},
	item: {
		display: "flex",
		alignItems: "flex-start",
		gap: 6,
		width: "100%",
		border: "none",
		borderRadius: "var(--dsw-radius-sm, 8px)",
		background: "var(--dsh-subscription-speed-hover, transparent)",
		padding: "6px 8px",
		cursor: "pointer",
		font: "inherit",
		textAlign: "left"
	},
	itemCheck: {
		width: 14,
		flexShrink: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-primary)"
	},
	itemText: {
		display: "flex",
		flexDirection: "column"
	},
	itemName: {
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-primary)"
	},
	itemDescription: {
		fontSize: 11,
		lineHeight: "16px",
		color: "var(--dsw-alias-label-tertiary)"
	}
};

//#endregion
//#region src/client/SubscriptionUsageBadge.tsx
/** DSH renamed the data icon in 0.1.7; retain older supported hosts too. */
function usageBadgeIcon(icons) {
	return hostIcon(icons, "DataOutline");
}
const UsageBadgeIcon = usageBadgeIcon(__deepseek_ai_dsh_client_ui_primitives);
/** How often the badge re-reads usage; the server also shares its own cache/negative-cache across UI surfaces. */
const USAGE_POLL_INTERVAL_MS = 15 * 6e4;
/** How often the badge re-reads the session's current model (model switches arrive only by asking). */
const MODEL_POLL_INTERVAL_MS = 3e3;
/** Distance between the trigger's top edge and the dialog's bottom (host stat dialogs use the same). */
const PANEL_GAP = 8;
/** Distance kept between the dialog and each viewport edge. */
const PANEL_MARGIN = 12;
/** The account the collapsed pill reads: the default one, else the first listed. */
function pillAccountOf(d) {
	return d.accounts.find((a) => a.isDefault) ?? d.accounts[0];
}
/** Brand display names (short form for the compact badge). */
const PROVIDER_NAMES = {
	codex: "Codex",
	claude: "Claude",
	grok: "Grok",
	copilot: "Copilot",
};
/**
* The `currentModel` half of the inject face: the session's effective
* model selection through ui-model-selection's `modelDirectories` service,
* resolved lazily per call (the service may register after this plugin, and
* a shell without it reports "unknown"; the badge keeps the most recent
* subscription selected in this view, or stays hidden).
*/
function createCurrentModelReader(models, sessionId) {
	return async () => {
		const directories = models();
		if (directories === void 0) return void 0;
		const { current } = await directories.directoryFor(sessionId).load();
		return current ?? void 0;
	};
}
/**
* Compact time-remaining label derived from the window's `resetsAt` timestamp:
* "6d 18h" (days+hours), "1h 58m" (hours+minutes), or "42m" (minutes only).
* Falls back to the scope/kind abbreviation when no reset time is known.
*/
function windowLabel(w) {
	if (w.resetsAt === void 0) {
		if (w.scope !== void 0 && w.scope !== "") return w.scope;
		switch (w.kind) {
			case "session": return "5h";
			case "weekly": return "Wk";
			default: return "W";
		}
	}
	const ms = Math.max(0, w.resetsAt - Date.now());
	const minutes = Math.floor(ms / 6e4);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	return `${Math.max(1, minutes)}m`;
}
/** Clamp and round a window's used share for display. */
function usedPercent(w) {
	return Math.round(Math.min(100, Math.max(0, w.usedPercent)));
}
/** Keep model quotas separate: matching percentages do not imply a shared pool. */
function prioritizeWindows(windows, model) {
	return model === void 0 ? [...windows] : [...windows.filter((w) => w.scope === model), ...windows.filter((w) => w.scope !== model)];
}
/** Small previews keep a live model catalog from taking over the dialog. */
const WINDOW_PREVIEW_LIMIT = 4;
function previewWindows(windows, model, provider) {
	const ordered = prioritizeWindows(windows, model);
	const limit = WINDOW_PREVIEW_LIMIT;
	return {
		shown: ordered.slice(0, limit),
		hidden: ordered.slice(limit)
	};
}
/** Bounded readout. */
function compactSegment(d, model, t = fallbackTranslate) {
	const windows = pillAccountOf(d).windows;
	const parts = windows.slice(0, 2).map((w) => `${windowLabel(w)} ${usedPercent(w)}%`);
	if (windows.length > 2) parts.push(`+${windows.length - 2}`);
	return `${d.name} ${parts.join(" · ")}`;
}
/** Remember only the most recent subscription in this view, including its model scope. */
function retainSubscriptionSelection(previous, current) {
	return current !== void 0 && Object.hasOwn(PROVIDER_NAMES, current.provider) ? current : previous;
}
/** At most one provider; no known selection or no usage means no badge. */
function collapsedDisplays(displays, current) {
	const match = displays.find((d) => d.provider === current);
	return match === void 0 ? [] : [match];
}
/** Order for the expanded dialog: the current provider first, the rest in poll order. */
function expandedDisplays(displays, current) {
	const match = displays.find((d) => d.provider === current);
	return match === void 0 ? displays : [match, ...displays.filter((d) => d !== match)];
}
/**
* A provider's logged-in accounts, the effective default first. When no
* account is flagged default the first listed stands in, matching what
* direct routes fall back to.
*/
function accountsOf(status) {
	if (status === void 0 || status.accounts.length === 0) return [];
	const fallback = status.accounts.find((a) => a.isDefault) ?? status.accounts[0];
	return status.accounts.map((a) => a === fallback ? {
		...a,
		isDefault: true
	} : a).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}
/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key, params) {
	return en[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ""));
}
/** Localized label of one usage window (kind, plus the model scope when named). */
function usageWindowLabel(t, window$1) {
	const base = window$1.kind === "session" ? t("usageSession") : window$1.kind === "weekly" ? t("usageWeekly") : t("usageWindow");
	return window$1.scope !== void 0 && window$1.scope !== "" ? `${base} · ${window$1.scope}` : base;
}
/**
* The composer subscription-usage badge: a pill reading e.g.
* `Codex 6d 1h 25%` for the current model's provider, opening a dialog with
* every provider's accounts and their windows. Returns null when no data is
* available.
*/
function SubscriptionUsageBadge({ rpc, currentModel, t }) {
	const translate = t ?? fallbackTranslate;
	const [displays, setDisplays] = (0, react.useState)([]);
	const [selection, setSelection] = (0, react.useState)(void 0);
	const [lastSubscription, setLastSubscription] = (0, react.useState)(void 0);
	const displayMode = useUsageBadgeMode();
	const current = selection?.provider;
	const badgeSelection = retainSubscriptionSelection(lastSubscription, selection);
	const [open, setOpen] = (0, react.useState)(false);
	const [hover, setHover] = (0, react.useState)(false);
	const inflightRef = (0, react.useRef)(false);
	const mountedRef = (0, react.useRef)(true);
	const rootRef = (0, react.useRef)(null);
	const panelRef = (0, react.useRef)(null);
	const seatRef = (0, react.useRef)(null);
	const currentRef = (0, react.useRef)(currentModel);
	currentRef.current = currentModel;
	const lastKnownRef = (0, react.useRef)(/* @__PURE__ */ new Map());
	const namesRevision = (0, react.useRef)(0);
	const recentNames = (0, react.useRef)(/* @__PURE__ */ new Map());
	const refresh = (0, react.useCallback)(async () => {
		if (rpc === void 0 || inflightRef.current) return;
		inflightRef.current = true;
		const revision = namesRevision.current;
		try {
			const statusResp = await callSubscriptionsAuth(rpc, "status", {});
			if (!mountedRef.current) return;
			const roster = [];
			for (const provider of Object.keys(statusResp.providers)) for (const account of accountsOf(statusResp.providers[provider])) roster.push({
				provider,
				account
			});
			const keyOf = (provider, account) => `${provider}:${account.key}`;
			const lastKnown = lastKnownRef.current;
			const live = new Set(roster.map(({ provider, account }) => keyOf(provider, account)));
			for (const key of lastKnown.keys()) if (!live.has(key)) lastKnown.delete(key);
			if (roster.length === 0) {
				setDisplays([]);
				return;
			}
			const results = await Promise.allSettled(roster.map(async ({ provider, account }) => {
				return {
					provider,
					account,
					usage: await callSubscriptionsAuth(rpc, "usage", {
						provider,
						account: account.key
					})
				};
			}));
			if (!mountedRef.current) return;
			const plans = /* @__PURE__ */ new Map();
			for (const r of results) {
				if (r.status !== "fulfilled") continue;
				const { provider, account, usage } = r.value;
				const key = keyOf(provider, account);
				if (usage.plan !== void 0) plans.set(key, usage.plan);
				if (!usage.supported || !usage.windows || usage.windows.length === 0) {
					lastKnown.delete(key);
					continue;
				}
				lastKnown.set(key, usage.windows);
			}
			const byProvider = /* @__PURE__ */ new Map();
			for (const { provider, account } of roster) {
				const key = keyOf(provider, account);
				const windows = lastKnown.get(key);
				if (windows === void 0) continue;
				const plan = plans.get(key) ?? account.plan;
				const row = {
					key: account.key,
					isDefault: account.isDefault,
					...account.account === void 0 ? {} : { account: account.account },
					...plan === void 0 ? {} : { plan },
					windows
				};
				const display = byProvider.get(provider);
				if (display === void 0) byProvider.set(provider, {
					provider,
					name: statusResp.providers[provider]?.displayName || PROVIDER_NAMES[provider],
					accounts: [row]
				});
				else display.accounts.push(row);
			}
			setDisplays([...byProvider.values()].map((row) => {
				const saved = recentNames.current.get(row.provider);
				return saved && saved.revision > revision ? {
					...row,
					name: saved.name
				} : row;
			}));
		} catch {} finally {
			inflightRef.current = false;
		}
	}, [rpc]);
	(0, react.useEffect)(() => {
		const update = (event) => {
			const { provider, displayName } = event.detail;
			recentNames.current.set(provider, {
				revision: ++namesRevision.current,
				name: displayName || PROVIDER_NAMES[provider]
			});
			setDisplays((current$1) => current$1.map((row) => row.provider === provider ? {
				...row,
				name: displayName || PROVIDER_NAMES[provider]
			} : row));
		};
		window.addEventListener(DISPLAY_NAME_CHANGED, update);
		return () => {
			window.removeEventListener(DISPLAY_NAME_CHANGED, update);
		};
	}, []);
	(0, react.useEffect)(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	(0, react.useEffect)(() => {
		if (displayMode === "hidden") return;
		refresh();
		const timer = setInterval(() => {
			refresh();
		}, USAGE_POLL_INTERVAL_MS);
		return () => {
			clearInterval(timer);
		};
	}, [refresh, displayMode]);
	(0, react.useEffect)(() => {
		if (currentRef.current === void 0) return;
		let cancelled = false;
		let inflight = false;
		const reload = () => {
			const read = currentRef.current;
			if (read === void 0 || inflight) return;
			inflight = true;
			read().then((model) => {
				if (cancelled) return;
				setLastSubscription((previous) => retainSubscriptionSelection(previous, model));
				setSelection(model);
			}, () => {}).finally(() => {
				inflight = false;
			});
		};
		reload();
		const timer = setInterval(reload, MODEL_POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);
	const pos = (0, __deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)({
		open,
		anchorRef: rootRef,
		panelRef,
		side: "top",
		gap: PANEL_GAP,
		margin: PANEL_MARGIN
	});
	(0, __deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen, panelRef);
	(0, react.useEffect)(() => {
		if (!open) return;
		const onKeyDown = (event) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);
	const [statsRow, setStatsRow] = (0, react.useState)(null);
	(0, react.useEffect)(() => {
		const seat$1 = seatRef.current;
		if (seat$1 === null) return;
		const scope = statsScopeOf(seat$1);
		if (scope === null) return;
		const find = () => scope.querySelector("[data-composer-stats]");
		setStatsRow(find());
		const observer = new MutationObserver(() => {
			setStatsRow(find());
		});
		observer.observe(scope, {
			childList: true,
			subtree: true
		});
		return () => {
			observer.disconnect();
		};
	}, []);
	(0, react.useEffect)(() => {
		if (displayMode === "hidden") setOpen(false);
	}, [displayMode]);
	const seat = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		ref: seatRef,
		style: styles.seat,
		"aria-hidden": true
	});
	const collapsed = collapsedDisplays(displays, badgeSelection?.provider);
	if (displayMode === "hidden" || collapsed.length === 0) return seat;
	const label = compactSegment(collapsed[0], badgeSelection?.model, translate);
	const expanded = expandedDisplays(displays, badgeSelection?.provider);
	const title = translate("usageBadgeTitle");
	const toggle = () => {
		const next = !open;
		setOpen(next);
		if (next) refresh();
	};
	const pill = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		ref: rootRef,
		style: styles.anchor,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: subscriptionChromeCss }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "dsh-subscription-usage-pill",
				style: {
					...styles.pill,
					...hover || open ? styles.pillActive : {}
				},
				"aria-haspopup": "dialog",
				"aria-expanded": open,
				"aria-label": `${title} · ${label}`,
				title,
				onMouseEnter: () => {
					setHover(true);
				},
				onMouseLeave: () => {
					setHover(false);
				},
				onClick: toggle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageBadgeIcon, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.label,
					children: label
				})]
			}),
			open && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: panelRef,
				role: "dialog",
				"aria-label": title,
				className: "dsh-subscription-usage-panel",
				style: {
					...styles.panel,
					...pos ?? MEASURE_STYLE
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.title,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: styles.titleLabel,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageBadgeIcon, {}), title]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.titleRule,
						"aria-hidden": true
					}),
					expanded.map((d, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: index === 0 ? void 0 : styles.section,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.providerRow,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: styles.providerName,
								children: [d.name, d.provider === current && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.currentTag,
									children: translate("usageBadgeCurrent")
								})]
							}), d.accounts.length === 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountMeta, {
								account: d.accounts[0],
								translate
							})]
						}), d.accounts.map((account, accountIndex) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: accountIndex === 0 ? void 0 : styles.accountBlock,
							children: [d.accounts.length > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: styles.accountRow,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountMeta, {
									account,
									translate
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountWindows, {
								windows: account.windows,
								model: d.provider === badgeSelection?.provider ? badgeSelection.model : void 0,
								provider: d.provider,
								translate
							}, `${d.provider}:${badgeSelection?.model ?? ""}`)]
						}, account.key))]
					}, d.provider))
				]
			}), document.body)
		]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [seat, statsRow !== null && statsRow.isConnected ? (0, react_dom.createPortal)(pill, statsRow) : pill] });
}
/**
* Nearest ancestor of the dock seat that can contain the host's stats row:
* the composer bar. Bounded so a badge in an unfamiliar layout never adopts
* some other composer's pills.
*/
function statsScopeOf(seat) {
	let node = seat.parentElement;
	for (let depth = 0; node !== null && depth < 4; depth++) {
		if (node.querySelector("[data-composer-stats]") !== null) return node;
		node = node.parentElement;
	}
	return seat.parentElement;
}
/**
* One account's handle and plan: `★ ys@example.com · 计划：pro`. The star
* marks the default account (the one direct routes serve and the collapsed
* pill reads), the same glyph Settings → 订阅 uses.
*/
function AccountMeta({ account, translate }) {
	const parts = [account.account, account.plan === void 0 ? void 0 : translate("usagePlan", { plan: account.plan })].filter((part) => part !== void 0 && part !== "");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		style: styles.providerMeta,
		title: account.account,
		children: [account.isDefault && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: styles.defaultStar,
			"aria-label": "default",
			children: "★ "
		}), parts.join(" · ")]
	});
}
/** Preview each account independently; all remaining quotas stay accessible. */
function AccountWindows({ windows, model, provider, translate }) {
	const { shown, hidden } = previewWindows(windows, model, provider);
	const rows = (items) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dl", {
		style: styles.details,
		children: items.map((w, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WindowRow, {
			label: `${usageWindowLabel(translate, w)}${model !== void 0 && w.scope === model ? ` · ${translate("usageBadgeCurrent")}` : ""}`,
			window: w
		}, i))
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [rows(shown), hidden.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
		style: styles.moreWindows,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
			style: styles.moreSummary,
			children: translate("usageBadgeMoreWindows", { count: hidden.length })
		}), rows(hidden)]
	})] });
}
/** One `dt`/`dd` pair: window name → `25% · 6d 1h`, with the bar underneath. */
function WindowRow({ label, window: w }) {
	const percent = usedPercent(w);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
			style: styles.dt,
			children: label
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", {
			style: styles.dd,
			children: [
				percent,
				"%",
				w.resetsAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					style: styles.reset,
					children: [" · ", windowLabel(w)]
				})
			]
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: styles.bar,
			"aria-hidden": true,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
				...styles.barFill,
				width: `${percent}%`,
				background: usageBarColor(percent)
			} })
		})
	] });
}
/**
* Unplaced portal panel: hidden but laid out so the clamp measures real
* dimensions (the `useAnchoredPosition` measure pass).
*/
const MEASURE_STYLE = {
	visibility: "hidden",
	left: 0,
	top: 0
};
const styles = {
	seat: { display: "none" },
	anchor: {
		minWidth: 0,
		maxWidth: "100%",
		display: "inline-flex"
	},
	pill: {
		boxSizing: "border-box",
		maxWidth: "100%",
		color: "var(--dsw-alias-label-tertiary)",
		font: "inherit",
		fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
		fontVariantNumeric: "tabular-nums",
		lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
		whiteSpace: "nowrap",
		background: "transparent",
		border: "none",
		borderRadius: 999,
		alignItems: "center",
		gap: 6,
		padding: "1px 8px",
		display: "inline-flex",
		cursor: "pointer"
	},
	pillActive: {
		background: "var(--dsw-alias-interactive-bg-hover)",
		color: "var(--dsw-alias-label-secondary)"
	},
	label: {
		textOverflow: "ellipsis",
		minWidth: 0,
		overflow: "hidden"
	},
	panel: {
		position: "fixed",
		zIndex: 1100,
		boxSizing: "border-box",
		background: "var(--dsw-specific-menu)",
		width: "max-content",
		minWidth: "min(300px, 100vw - 24px)",
		maxWidth: "min(440px, 100vw - 24px)",
		maxHeight: "min(560px, 100dvh - 24px)",
		overflowY: "auto",
		overscrollBehavior: "contain",
		boxShadow: "var(--dsw-elevation-prominent)",
		color: "var(--dsw-alias-label-secondary)",
		cursor: "default",
		border: 0,
		borderRadius: "var(--dsw-radius-lg, 16px)",
		padding: 16,
		fontSize: 12,
		lineHeight: "18px"
	},
	title: {
		color: "var(--dsw-alias-label-primary)",
		display: "flex",
		justifyContent: "space-between",
		gap: 16,
		marginBottom: 8,
		fontWeight: 500
	},
	titleLabel: {
		alignItems: "center",
		gap: 6,
		minWidth: 0,
		display: "inline-flex"
	},
	titleRule: {
		borderTop: "0.5px solid var(--dsw-alias-border-l2)",
		marginBottom: 10
	},
	section: {
		marginTop: 12,
		paddingTop: 10,
		borderTop: "0.5px solid var(--dsw-alias-border-l2)"
	},
	providerRow: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "baseline",
		gap: 16,
		marginBottom: 6
	},
	providerName: {
		color: "var(--dsw-alias-label-primary)",
		fontWeight: 500,
		display: "inline-flex",
		alignItems: "center",
		gap: 6
	},
	currentTag: {
		fontSize: 10,
		lineHeight: "14px",
		fontWeight: 400,
		padding: "0 5px",
		borderRadius: 7,
		color: "var(--dsw-alias-label-secondary)",
		background: "var(--dsw-alias-interactive-bg-hover)"
	},
	providerMeta: {
		color: "var(--dsw-alias-label-tertiary)",
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	defaultStar: { color: "var(--dsw-alias-state-warn-label)" },
	accountBlock: { marginTop: 8 },
	accountRow: {
		display: "flex",
		marginBottom: 4
	},
	details: {
		color: "var(--dsw-alias-label-tertiary)",
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) max-content",
		gap: "4px 16px",
		margin: 0
	},
	moreWindows: { marginTop: 8 },
	moreSummary: {
		cursor: "pointer",
		color: "var(--dsw-alias-label-secondary)",
		marginBottom: 8
	},
	dt: {
		minWidth: 0,
		margin: 0,
		overflowWrap: "anywhere"
	},
	dd: {
		minWidth: 0,
		margin: 0,
		color: "var(--dsw-alias-label-secondary)",
		fontVariantNumeric: "tabular-nums",
		textAlign: "right"
	},
	reset: { color: "var(--dsw-alias-label-tertiary)" },
	bar: {
		gridColumn: "1 / -1",
		height: 4,
		borderRadius: 2,
		overflow: "hidden",
		background: "var(--dsw-alias-border-l2)",
		marginBottom: 2
	},
	barFill: {
		height: "100%",
		borderRadius: 2
	}
};

//#endregion
//#region src/client/fast-command.ts
/** Build the locale resolver used by the /fast command contribution. */
function fastCommandDescription(t) {
	return () => t();
}

//#endregion
//#region src/client/index.ts
/** Dictionary namespace owned by this plugin. */
const NS = "settings.subscriptions";
/**
* Required services (cordis fiber inject): `slots` carries the registration
* seat, `connection` the `/subscriptions-auth` RPC caller, and `locale` the copy
* dictionaries.
*/
const inject = [
	"slots",
	"connection",
	"locale"
];
/**
* Register the Subscriptions section once the `settings.section` declaration
* is on the ledger (the shell's apply order relative to this one is NOT
* constrained; registration depends on the slot through `slots.inject()`).
* @param ctx - client root context.
*/
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "dsh-plugin-subscriptions: copy dictionaries");
	ctx.effect(() => {
		const style = document.createElement("style");
		style.setAttribute("data-plugin", "dsh-plugin-subscriptions");
		// issue #1288 第 2/5/8 条：**必须限定在非手机形态**。
		//
		// 原选择器是裸的 div[role=dialog][aria-modal=true]:has(> nav)，特异性 (0,2,2) —— 它会命中
		// **宿主的**设置面板（那是唯一「dialog 且直接子节点是 nav」的面板），并把它的 padding-top
		// 压成 14px。宿主手机形态的顶部 inset 由 dsh-client-ui-responsive 的 mobile-form.css.ts
		// 提供（--dsh-mobile-top-inset，实测 24px），被压成 14px 之后二级页标题栏就顶到状态栏下面
		// （用户实测：一级页正常、二级页标题只剩半截 —— 一级的顶部条是 absolute 不吃面板 padding）。
		// 在手机形态下这块留白本来就由宿主按真实 inset 负责，插件不该再插一手；桌面形态维持原样。
		style.textContent = 'html:not([data-dsh-mobile-form]) div[role="dialog"][aria-modal="true"]:has(> nav) { padding-top: 14px; }';
		document.head.appendChild(style);
		return () => style.remove();
	}, "dsh-plugin-subscriptions: settings panel breathing room (desktop form only)");
	const connection = ctx.get("connection");
	const t = ctx.locale.bind(NS);
	const injected = () => ({
		rpc: connection.rpc,
		t
	});
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "subscriptions",
		order: 90,
		label: () => t("nav"),
		inject: injected
	}, SubscriptionsSection));
	const toolviewInjected = () => ({ load: createImageLoader(connection.rpc) });
	ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
		name: "tool.call.toolview",
		key: "image_generate",
		locale: NS,
		inject: toolviewInjected
	}, ImageGenerateToolview));
	const videoToolviewInjected = () => ({ loadVideo: createVideoLoader(connection.rpc) });
	ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
		name: "tool.call.toolview",
		key: "video_generate",
		locale: NS,
		inject: videoToolviewInjected
	}, VideoGenerateToolview));
	const models = () => ctx.get("modelDirectories");
	ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
		name: "conversation.input.right",
		id: "codex-speed",
		order: 0,
		locale: NS,
		inject: (sessionId) => ({
			loadSpeed: createSpeedLoader(connection, models, sessionId),
			setSpeed: createSpeedSetter(connection, sessionId)
		})
	}, SpeedSelect));
	ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
		name: "conversation.composer.dock",
		id: "subscription-usage",
		order: 10,
		locale: NS,
		inject: (sessionId) => ({
			rpc: connection.rpc,
			currentModel: createCurrentModelReader(models, sessionId)
		})
	}, SubscriptionUsageBadge));
	ctx.inject(["commandUi"], (scope) => {
		const command = scope.get("commandUi");
		scope.effect(() => command.register({
			name: "fast",
			description: fastCommandDescription(() => t("commandFast")),
			available: () => true,
			ui: {
				kind: "popupSelect",
				options: async (session) => {
					const state = await createSpeedLoader(connection, models, session.sessionId)();
					if (!state.visible) throw new Error(t("commandFastUnavailable"));
					return [{
						id: "standard",
						label: t("speedStandard"),
						detail: t("speedStandardDescription")
					}, {
						id: "fast",
						label: t("speedFast"),
						detail: t("speedFastDescription")
					}].map((option) => ({
						...option,
						active: option.id === state.tier
					}));
				},
				onSelect: async (option, session) => {
					await createSpeedSetter(connection, session.sessionId)(option.id);
				}
			}
		}), "dsh-plugin-subscriptions: /fast contribution");
	});
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map