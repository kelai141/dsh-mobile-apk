# dsh-client-ui-responsive

[English README](README.md)

> **dsh-mobile 生态** · [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（壳 APK）· [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）· [dsh-mobile](https://github.com/kelai141/dsh-mobile)（协调仓库，private）

DeepSeek Harness Web UI 的 **Android 移动适配层**。

**0.2.0 起「去 fork」**：0.1.14 之前本插件用自研的移动版 AppFrame 替换上游
`ui-layout`；上游 0.1.5 把 `ui-layout` 变成了布局服务中枢（`ctx.layout`、键控
`main` 面板槽、右栏 track/fullscreen 汇报），ui-conversation / ui-sidebar /
ui-sidebar-right 都挂在它上面——继续 fork 就得每个版本复刻一遍 API 面。现在改为
保留上游框架，只补手机需要的那一层。

## 做什么

| 面 | 内容 |
|---|---|
| 手机形态（<768px） | 纯 CSS 覆盖上游框架：左栏变离屏抽屉、中栏占满框架、右栏沿用上游自带的全屏滑入（同一 768px 阈值）、拖拽手柄让位 |
| 抽屉入口 | `shell.overlay` 顶栏一个开关（手机上 rail 已离屏；不往 composer 行加控件） |
| 原生「打开方式」 | 会话头部入口（打开工作区目录）+ `extension` 带的标签类型（压缩包/二进制）——都唤起壳侧选择器（MT 管理器 / 系统文件管理） |
| 输入区 | 系统栏/输入法 inset、窄屏控件行宽度上限、弹出面板宽高与水平钳制、手机 Enter 守卫，以及回形针上拉来源菜单。菜单只复用上游已有的隐藏多选 file input：“上传附件”临时设为 `*/*`，“上传图片”临时设为 `image/*`；同步 input focus 不会抢先还原 filter，SAF 结算后才还原，仍走上游 draft/upload 链路。 |
| 浏览器与范围 | 「文件」右栏把原生 BrowserHost 工作台注册为与工作区文件同级的入口；开发者选项卡片「屏幕与 Shizuku 控制」拥有 `virtual-only` / `real-only` / `all` 的开放屏幕范围选择器，模型没有写入面。 |
| 外部打开/分享 | 消费端创建空白临时会话，仅在 Session scope 已在场后 claim opaque 来件元数据，并通过上游 composer/upload 链路加入一个未发送的通用 file attachment。绝不生成 `@路径` 消息，进程重启后不恢复草稿。 |
| 壳侧界面 | 开发者选项页、Android 显示设置行、导出结果弹窗、主题桥、键盘边界 |
| 0.1.5 一并退役 | 框架 fork、重复的 ThemePresenter、注入的「上传图片」「导出调试日志」菜单项、图片选择桥、以及遮蔽上游附件按钮的 CSS |

## 安装与挂载

**1. 打包**进 web profile 的 `node_modules`（模式见 dsh-shell-termux）。

**2. 在 profile 的 `cordis.patch.yml` 里 insert**——`ui-layout` 保持启用：

```yaml
- insert:
    - id: ui-responsive
      name: '@dsh-android/dsh-client-ui-responsive'
- id: open-in-app
  disabled: true
- id: ui-open-in-app
  disabled: true
```

**3. 重启**并核对名册（`window.__DSH_BOOT__` 同时含 `ui-layout` 与本插件）。

## 契约锚点

手机形态只锚定 DOM 事实，不锚 CSS Module 哈希类名；事实由本插件自己发布：

| 事实 | 写入方 | 消费方 |
|---|---|---|
| `html[data-dsh-mobile-form]` | `mobile/form-marker.ts`（镜像 `(max-width: 767px)`） | 所有注入样式表 |
| `[data-dsh-frame]` | 同上（由上游 `[data-rightbar-col]` 反查） | `mobile-form.css.ts`、键盘边界 |
| `html[data-dsh-modal-open]`、`[data-dsh-settings-dialog]` | 同上 | 设置页重排 |
| `[data-dsh-mobile-topbar]` | `mobile/MobileChrome.tsx` | 弹出面板几何守卫 |

样式依赖的上游属性：`data-sidebar-collapsed`、`data-rightbar-col`、
`data-rightbar-panel="fullscreen"`、`data-sidebar-right-toggle`、
`data-conversation-header-corner`。

## 构建

```sh
npm install          # @deepseek-ai/* 固定版本以 package.json 为准
npm run typecheck
npm run build        # tsc（lib/types）+ tsdown（lib/client.js 浏览器包）
npx vitest run
```

浏览器包走 `__ModuleLoader__.load` 契约；对活服务器做探活前必须重新构建
（注册表提供的是 `lib/client.js`，不是源码）。

## 许可

MIT。派生自 `@deepseek-ai/dsh-client-ui-layout`（MIT，© 2026 DeepSeek）——见 NOTICE。
设计说明：`docs/design.md`。
