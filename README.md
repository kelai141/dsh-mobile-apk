# dsh-mobile-apk — 手机上的 AI Agent（DeepSeek Harness 安卓壳）

<!-- 本文件与 README.en.md 逐节对应，改动请在同一 PR 内双语同步。 -->

[English README](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/kelai141/dsh-mobile-apk)](https://github.com/kelai141/dsh-mobile-apk/releases/latest)
![Android](https://img.shields.io/badge/Android-8.0%2B-3DDC84?logo=android&logoColor=white)
[![QQ群](https://img.shields.io/badge/QQ群-dsh--mobile用户群-12B7F5?logo=tencentqq)](https://qun.qq.com/universal-share/share?ac=1&authKey=C2NW5eWXsV%2FYu5DEkV9Ac%2FqYcXhGCY8C3Lga40KNCfE4AOjzlSeAaRGvWZqc3ADV&busi_data=eyJncm91cENvZGUiOiIxMTA5NDkzOTkyIiwidG9rZW4iOiJjTTRDM3pwNjRLTE8rbkZBVjRDbnFVWlBOdU04aGJaS3FaSG1xZWFXbm5ZNXphbEJBOXdGMGw2N0V3YnpabnhaIiwidWluIjoiMzc1NDY4MDE3NSJ9&data=NzUYIVyoUDsINSstug9aQ6Kf4EUx-hhDegPFaPS-1RD-p_4eE02WN773yEIujclrFYtWRDkLyDa-YDtWj2bKjg&svctype=4&tempid=h5_group_info)
[![QQ2群](https://img.shields.io/badge/QQ2群-dsh--mobile用户2群-12B7F5?logo=tencentqq)](qrcode/qqcommunity-2.png)

> **一个 APK 装下完整的 AI agent：AI 能操作浏览器与手机、真实执行 bash——无需 root，无需刷机。**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的安卓壳。应用名 `DeepCode`，包名 `com.dsharnessmobile.shell`。

> 本项目基于 MIT 开源，欢迎二次开发，二次分发，为项目提交建议与反馈。
> AI 生成内容与执行的操作请自行判断；实验性能力会在对应条目如实标注。

## 它能做什么

- **真实执行 bash**：AI 跑的命令在内置 Termux 环境里真实生效，不是模拟输出。
- **后台持续运行与自动恢复**：切走应用、锁屏，任务照跑；引擎异常自动探活恢复，手机重启后自动回到运行状态。后台耗电高于普通应用，建议按应用内引导允许忽略电池优化。
- **AI 独立浏览器**（实验特性）：AI 用一个独立窗口打开和操作网页，cookie 与登录状态和你的日常浏览器完全隔离，不碰你的账号。
- **虚拟屏**（实验特性，需 Shizuku）：AI 在一块独立虚拟屏幕上启动并操作第三方 App，不占你正在用的屏幕，还能在浮窗里围观它操作。
- **AI 操作手机**：开启无障碍授权后，AI 能看到屏幕内容并替你点击、滑动、输入、截屏；默认只允许操作虚拟屏，要动真实屏幕需要你在设置里主动放开。
- **通知栏应答与审批**：AI 的提问、审批直接推到通知栏，直接回复、选选项、批准或拒绝，不用切回应用（Android 13 及以上需在系统设置里允许通知）。
- **桌面悬浮球**：实时显示 AI 进度，展开面板能直接回答 AI 的提问、看任务报告，三击状态行跳回应用；不想被打扰可一键隐藏。
- **稳定与自愈**：页面被装坏的插件搞挂时自动摘除并恢复；环境被改坏可用安全模式启动修复；启动失败有修复助手与脱敏诊断包（仅你主动点击才会发出）。

## 界面速览

| 主界面与对话 | 双工作区分栏与悬浮小窗 |
|---|---|
| ![主界面与对话](docs/images/ui-home.jpg) | ![双工作区分栏与悬浮小窗](docs/images/ui-split.jpg) |
| **通知栏应答** | **侧边栏与会话管理** |
| ![通知栏应答](docs/images/ui-notification.jpg) | ![侧边栏与会话管理](docs/images/ui-drawer.jpg) |

截图来自真实任务运行。

## 快速开始

| 项目 | 要求 |
|---|---|
| 系统版本 | Android 8.0 及以上 |
| 安装包大小 | 约 150-160 MB，建议 Wi-Fi 下载 |
| root | 不需要（可选装 Shizuku 解锁高级设备控制） |

1. 下载与本机匹配的 APK（见下一节）：真机选 arm64，模拟器选 x86_64。
2. 安装并首次启动。首次启动或升级后需要解压/刷新运行环境，可能需要几分钟到十余分钟，期间请勿强杀应用。
3. 按需开权限：无障碍、通知、Shizuku，应用内有引导。
4. 在设置里配置模型 API，跑第一条命令。

进阶安装：`adb install -r -t <apk>`（同签名覆盖安装）。

## 下载与安装

最新版永远在这里：[GitHub Releases（latest）](https://github.com/kelai141/dsh-mobile-apk/releases/latest)。
访问 GitHub 困难时，用[官方下载页](https://kelai141.github.io/dsh-mobile-apk/)（自动路由官方源与镜像加速源）。

| 包 | 适合 |
|---|---|
| arm64 版 APK | 绝大多数真机 |
| x86_64 版 APK | 模拟器 / x86_64 设备 |

**ABI 必须与设备匹配**：装错包引擎启动即崩（处理器架构不符），请按设备类型选包；装错了重装对应包即可。

**请始终从同一渠道获取升级**：应用自带应用内检查更新；跨渠道混装出问题时，先完整卸载重装再反馈。

覆盖升级会保留会话、设置与插件配置；若触发运行环境刷新，可能需要十余分钟，期间请勿强杀应用。

## 权限说明

| 权限 | 用途 |
|---|---|
| 网络连接 | 加载 AI 对话、探测本地引擎、检查更新（仅手动触发） |
| 通知 | 通知栏应答与任务提醒（Android 13 及以上需在系统设置里允许） |
| 前台服务 | 保活运行，让 AI 任务在后台持续跑 |
| 所有文件访问 | 使用外部工作区目录时需要，你在系统页手动授予 |
| 安装未知应用 | 应用内检查更新时唤起系统安装器，须你在系统页显式授权 |

选择目录与图片走系统选择器，无需额外权限。虚拟屏与特权操作需你自行安装、启动并授权 [Shizuku](https://github.com/RikkaApps/Shizuku)。

## 常见问题

**为什么必须给无障碍权限？**
无障碍是 AI 看屏幕内容、替你操作的数据通道；不开启则仅虚拟屏可用。默认只允许 AI 操作虚拟屏，要动真实屏幕需要你在设置里主动放开范围。

**后台被杀怎么办？**
按应用内引导把本应用加入电池优化白名单；个别厂商的激进省电策略可能仍需手动加白。

**应用出问题去哪反馈？**
到 [issues](https://github.com/kelai141/dsh-mobile-apk/issues) 反馈，请附机型、应用版本（关于页可见）与复现步骤；也可以加文末用户群直接说。

**模型 API 从哪来、怎么配？**
在设置页的模型条目里直接选择协议与思考档位，应用不内置任何模型服务。

**armv7l / 老机型什么时候支持？**
暂不支持，欢迎到 issues 提需求。

## 面向开发者

- **自己构建**：构建与快照链在协调仓库 [dsh-mobile](https://github.com/kelai141/dsh-mobile) 完成，本仓库是壳子仓库；环境要求见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与 `docs/AGENTS/build-and-env.md`。
- **桥协议**（`window.androidBridge`）：见 [`docs/AGENTS/BRIDGE-API.md`](docs/AGENTS/BRIDGE-API.md)。
- **模型可见工具面**：见 [`docs/AGENTS/modules.md`](docs/AGENTS/modules.md)（以当前代码为准）。
- **参与贡献**：见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
- **版本历史**：见 [`docs/AGENTS/changelog-archive.md`](docs/AGENTS/changelog-archive.md)（倒序，最新在最上）。

## 致谢

这个项目是靠社区一起做出来的。下面按代码贡献行数排序，致谢贡献最多的八位协作者（维护者本人与 AI 账号不计入；统计排除上游构建产物与 lockfile）：

| # | 协作者 | 主要贡献 |
|---|---|---|
| 1 | [@snoworwind](https://github.com/snoworwind) | 可来源审计的 ARM64 构建链、来源链可复现性修复、快照面板层级与遮罩修复 |
| 2 | [@cmyfqwq](https://github.com/cmyfqwq) | AI root 权限授权开关与应用级 root 授权面、root 租约清算判据改写为真绑定实证、入口拆锁落地 |
| 3 | [@lemonhub-io](https://github.com/lemonhub-io) | 启动页与控制台 UI 重构、原生界面的设计令牌体系、应用命名与图标、版本号收编为单一来源 |
| 4 | [@daum110715](https://github.com/daum110715) | 下载页整体改版为瑞士国际主义排印风格（网格、字阶、等宽数据） |
| 5 | [@SinBC227](https://github.com/SinBC227) | 图片输入与视觉读图（含华为 WebView 兼容）、剪贴板桥、LaTeX 流式渲染、字体大小与沉浸式状态栏 |
| 6 | [@adeahejshshsh](https://github.com/adeahejshshsh) | 通用设置里安卓自建项的行规与控件重做、语言跟随系统改为启动时解析 |
| 7 | [@wen0531](https://github.com/wen0531) | 快照内 git SHELL_PATH 重定位、arm64 资产名口径、文件写入回退、预设播种修复 |
| 8 | [@FuRongJun-1999](https://github.com/FuRongJun-1999) | 灵枢（AEIS）长期记忆框架的快照构建工具与手机端测试指引 |

另外感谢最早一批通过 issue 与 PR 帮我们定位问题的成员：cdwlll、haitunlang、TACONailoong、X-SCI-TECH、Yangerwei、gr12-cmd，以及所有提交反馈与建议的用户。

## 欢迎加入用户群反馈

<img src="qrcode/qqcommunity-1.png" alt="dsh-mobile 用户群二维码（群号 1109493992）" width="320">
<img src="qrcode/qqcommunity-2.png" alt="dsh-mobile 用户2群二维码（群号 1038381236）" width="320">

使用问题、机型兼容、功能建议都可以在群里直接提。一群已满或无法加入时，请扫码加入二群（群号 1038381236）。

## 支持我们

请在个人生活有余力且经济自主的前提下进行适当的自愿赞助。

- 第三方模型 API 中转站（非本开发者所属，仅作推广支持）：<https://d1api.xin/sign-up?aff=mVa0>
- 第三方模型 API 中转站（非本开发者所属，仅作推广支持）：<https://aiapi.keniis.top/sign-up?aff=v5GFqLPO>

微信赞赏与支付宝收款码：

<img src="qrcode/support-wechat.png" alt="微信赞赏码" width="320">
<img src="qrcode/support-alipay.png" alt="支付宝收款码" width="320">

## License

MIT。第三方组件按各自许可，见 [`LICENSES/`](LICENSES) 与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。GPL 合规：copyleft 许可全文三形态在场——快照 `usr/share/LICENSES/`、仓库 `LICENSES/`、APK `assets/licenses/`。
