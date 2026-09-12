# dsh-android-browser（侧边栏 AI 专用浏览器 · host 半骨架）

状态：0.14.0-preview 切片 1 骨架。依据 docs/SIDEBAR-BROWSER-PLAN-2026-09-12.md、
docs/IMPLEMENTATION-ACCEPTANCE-PLAN-2026-09-12.md 与用户约束 docs/0.14.0-preview-USER-CONSTRAINTS.md U-1
（**入口必须落 app 内「文件」面板，与「工作区文件」同级，不得另起入口**）。

## 本轮交付
- 档位判定工具 android_browser_tier（P0 探针的可执行化，含实测基线）。
- 三面命名与载荷契约（src/contract.ts）：工具名 / 壳桥 op 名 / 面板路由 + 视口档 / 身份档。
- 离线回归 test/tier.test.mjs（9 条：判定规则、fail-safe、来源标注、lossless JSON、契约冻结）。

## 本轮不做（均已在 P0 文档登记阻塞）
- 面板入口与 chrome：等 dev-gesture 释放 dsh-client-ui-responsive（Lead 通知后按 U-1 落点实现）。
- 壳桥 browser* op：壳侧写域（DeviceControlService / ControlProtocolV2）+ 六处 op 登记链；browser* **不进 A11Y_OPS**。
- webserver 状态路由：与鉴权同批（exact 路由绕过 /api 前缀鉴权的既有坑，见 dsh-android-file-open 的 FX-205 批）。
- 插件挂载五处（profile patch / make-snapshot / contract.json / apk 自包含副本 / 镜像门禁）：scripts/** 属 dev-gates 写域。

## 面板数据契约（src/contract.ts 为唯一源）
| 面 | 名字 | 说明 |
|---|---|---|
| 工具 | android_browser_tier | 档位报告（本轮已注册） |
| 工具 | browser_open / snapshot / click / type / press / scroll / get_text / wait / navigate / back / forward / reload | 命名对齐 Lum1104/dsh-browser |
| 工具 | browser_list_tabs / follow_tab / close_tab / set_identity / set_viewport / screenshot | 标签面 + 档位面 |
| 壳桥 op | browserCaps / browserShow / browserHide / browserOpen / browserJs / browserInput / browserShot / browserState / browserSetUa / browserViewport | 六处登记链；browser* 不入 A11Y_OPS |
| 面板路由 | /api/android/browser/status | 只读状态，与鉴权同批落地 |

视口档：phone-portrait 390x844（默认）/ tablet 768x1024 / desktop-720 1280x720 / desktop-1080 1920x1080。
身份档：android-real（默认，无需确认）/ linux-desktop（需二次确认 + 风险文案）/ windows-desktop（同）。

逐条参数 / 返回值 / 权限档见 src/contract.ts 的 BROWSER_TOOL_CONTRACTS 与 BROWSER_OP_CONTRACTS
（测试断言两者与工具名/op 名集合逐条对齐，且完全访问档只含 browserJs/browserShot/browser_screenshot、伪装档必须二次确认）。

## 档位判定规则（src/tier.ts）
| 输出 | 规则 |
|---|---|
| tier | 工位 WebView 不在场 → L1-text；在场 → L2-native；在场且调试档开启 → L3-cdp-debug |
| viewportRoute | density 覆写可用 → S2b；否则工位在场 → S2；否则 S1（调试档另登记 S3） |
| identityRoute | uaChAvailable 且 androidx.webkit 能力门通过 → ua-ch；否则 ua-string-only |
| fail-safe | **未知一律按不支持处理**，且每条降级都进 degradedNotes |

## 设备实测基线（详见 .deploy-tmp/iter-0140/browser-p0.md）
- MuMu x86_64（900x1600 @ density 320 = dpr 2），系统 WebView **110.0.5481.154.1** → **无 UA-CH**（navigator.userAgentData === undefined）。
- 应用 TOTAL PSS 127,160 KB；renderer 仅 1 个（com.android.webview:sandboxed_process0）。
- CDP 1280x720 + dsf=1 + mobile=false 实测：innerWidth 1280 / dpr 1 / matchDesktop true（S3 等价物可行，S2b 的目标态即 dpr=1）。
- androidx.webkit:webkit:1.17.0 可拉取（minCompileSdk 33 / minAGP 7.2.0）；能力门常量名是 WebViewFeature.USER_AGENT_METADATA（方案文档原写的 SET_USER_AGENT_METADATA 会编译不过）；setRendererPriorityPolicy 不在该依赖里（平台 API）。

## 本机限制（必须如实告知模型与用户）
- UA-CH 缺席 → 身份伪装只能做到 UA 串 + JS 指纹，可被检出；不得声称"已伪装为桌面"。
- 触摸能力（maxTouchPoints/ontouchstart）关不掉（CDP 实测），属天然差异。
- Target.setAutoAttach 在本机内核被拒 → 跨域 iframe 帧级控制不可用（与方案 K1 结论一致）。
