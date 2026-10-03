# dsh-client-ui-responsive 设计说明（0.2.0）

## 定位

DeepSeek Harness Web UI 的 Android 适配层。上游 0.1.5 的 Web 端本身已是移动可用的
桌面布局：左栏 264–420px（<1024px 自动收成 56px rail）、中栏保 400px、右栏
track/fullscreen 两态（<768px 自动全屏）。本插件不重写这套布局，只做三件事：

1. **把竖屏收成手机形态**（<768px，与上游右栏全屏阈值同一个界）；
2. **补 Android 独有的通道**（系统选择器、inset、主题 uiMode 兜底、外部文件直达）；
3. **退役被上游覆盖的自研件**（框架 fork、上传入口、调试日志导出）。

## 为什么去 fork

0.1.2 时代上游 `ui-layout` 只有三段式槽位（sidebar/conversation/details）与
`toggleSidebar/openDetails/closeDetails`，fork 一份 AppFrame 成本可控。0.1.5 起它成了
布局服务中枢：

- `ctx.layout`：`selectPanel / beginNavigation / toggleSidebar / openRightbar(track,fullscreen) / closeRightbar`；
- 键控 `main` 槽：会话与全局面板（`entryKey: panelId ?? 'conversation'`）；
- `provideRoot({ hooks: { panelInfo } })`：`usePanelInfo` 标准钩子；
- 布局 store：`layoutInfo` 八字段（sidebar / viewportWidth / narrowExpanded / rightbar×4）。

ui-conversation 注册 `main@conversation`、ui-sidebar-right 注入 `rightbar`、
ui-sidebar 的 SidebarRoot 读 `usePanelInfo`——禁用 `ui-layout` 会让三者同时失效
（会话与左栏一起消失）。继续 fork 等于每个上游版本复刻一遍这套 API，因此改为
「保留上游 + 补丁层」。

## 手机形态怎么实现

只有一个断点：**768**（上游 `autoFullscreen = viewportWidth < 768`）。

- **左栏**：`[data-dsh-frame] > [class*='sidebarCol']` 改 `position: fixed` 离屏，
  展开态（frame 上没有 `data-sidebar-collapsed`）滑入；grid 轨道被 `!important`
  压成 `0 / 1fr / 0` 并显式指定 `grid-column`（侧栏脱离文档流后，自动排布会把
  中栏塞进第一个 0 宽轨道）；rail 随侧栏一起离屏，入口由顶栏开关承担。
- **右栏**：不动。上游在该阈值下已经是 `position: fixed; inset: 0` 的全屏滑入
  （`data-sidebar-right-panel="fullscreen"`），我们只补安全区 padding。
- **横屏**：完全不干预，与桌面端一致。
- **设置弹窗**：上游 SettingsRoot 的 overlay 渲染在侧栏子树里，祖先被
  `transform` 后会把它一起拖走——标记层在检测到「不在 shell.overlay 里的
  modal」时给 `<html>` 打 `data-dsh-modal-open`，手机形态据此把抽屉钉回屏幕。

## 原生「打开方式」

- 文件（`mode=view`）：FileProvider `content://` + `ACTION_VIEW`（按真实 MIME）→ 系统选择器；
- 目录（`mode=folder`）：主候选 `ACTION_OPEN_DOCUMENT_TREE`（系统文件浏览），
  MT 管理器等按包名逐个尝试并作为「初始意图」进选择器——装了才出现；
- 白名单与 `FileIncoming` 同一份 canonical 校验（file_paths.xml 映射面一致）；
- 返回 JSON `{ok, reason?}`，页面据 reason 分流文案（no-handler 会弹提示，不静默）。

页面侧两个入口：会话头部按钮（工作区目录）与 `open-with` 标签类型
（`priority: 'extension'`，但 `canOpen` 在「有 builtin/extension 类型认领同一地址」时
主动让位，上游将来加渲染器不会被我们挡住）。聊天里的路径点击（mention / 工具行）
也走同一个 `window.__dshOpenPath`。

## 契约与测试

- `mobile/address.ts`：`dsh-resource://file/…` 地址解析（上游
  `@deepseek-ai/dsh-util-workspace-path` 的语法；它不是共享模块表座位，故本地复述 + 单测钉住）；
- `mobile/external-open-paths.ts`：纯决策（后缀表、chip 命名、canOpen 让位规则）；
- `mobile/open-path.ts`：桥调用与结果解码；
- `mobile/form-marker.ts`：手机形态的 DOM 事实（媒体查询 + 框架标记 + modal/settings 标记）；
- 样式一律 `:root` / `html[...]` 作用域 + 属性选择器，避开 `:has()` / `dvh` / `color-mix`
  （MIUI12 / Chromium 83 老内核会整条丢弃）。

## 已知边界

快照管理由 vendored 插件挂在会话标题栏的 actions 插槽。`SnapshotPanelsObserver`
按 renderer 的真实 `display:contents` 包装节点认领面板，在打开时临时抬升 header，
并解除承载面板的 titleRow 的布局包含约束，使 fixed 遮罩覆盖完整视口。关闭后两组
class 租约释放，上游标题行的 query container 恢复。正文容器与 React 节点位置保持
原样。测试必须使用 `conversation.header` / `conversation.session.header` /
`conversation.session.header.actions` 完整插槽链；直接把 header 插入根节点会漏掉
真实 DOM 与布局树的区别。背景、diff 和控件中心的真实命中还需浏览器或设备验证，
jsdom 类名断言不能替代绘制及正常坐标输入。

- 上游若改动 `data-*` 属性名或 768px 阈值，手机形态与全屏假设会失配——真机验收清单
  第一条就是竖屏右栏是否覆盖式滑入；
- 目录打开在部分文件管理器上不接受 FileProvider 目录 URI，故目录主候选固定为
  系统 `ACTION_OPEN_DOCUMENT_TREE`（MT 的目录意图为尽力而为，见 `PathOpen.kt` 注释）；
- 设置弹窗「钉回屏幕」依赖 modal 检测启发式（`role=dialog[aria-modal=true]` 且不在
  shell.overlay 内）；上游若改成 portal 到 body，这条自然失效但无害。
