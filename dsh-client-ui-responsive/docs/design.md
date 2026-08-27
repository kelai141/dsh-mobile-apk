# dsh Web UI 内嵌适配设计：同构响应式（横屏复用 / 竖屏抽屉化）

> 版本 v1.0 ｜ 2026-08-14 ｜ 依据：ui-layout 源码实读（AppFrame.tsx / columns.ts / stores.ts / AppFrame.module.css）+ web-styling.md + 客户端栈规范

---

## 0. 核心结论

**用户思路成立且可优雅落地**：UI 照搬，竖屏靠"**同构响应式**"——同一套 DOM/组件/动效，容器层按宽度切换三档形态。**上游已有 60% 的响应式基础**（自动折叠侧栏/拖拽/动效 token），缺的是"手机竖屏形态"：抽屉、底部 sheet、安全区。方案 = 新 client 插件包（派生 AppFrame + 移动分支），零改动上游。

---

## 1. 调研结论：现有机制盘点（源码实证）

### 1.1 AppFrame 已是"响应式就绪"的三栏框架

| 机制 | 位置 | 现状 |
|---|---|---|
| 视口追踪 | AppFrame.tsx：ResizeObserver + rAF，追踪 frame 宽度（非 window） | 已有 ✓ |
| 窄屏断点 | `SIDEBAR_AUTO_COLLAPSE = 1024`（columns.ts） | 已有 ✓ |
| 自动折叠 | viewport < 1024 → 侧栏折叠为 **56px rail**（compact rail，不消失） | 已有 ✓ |
| 手动展开 | `narrowExpanded` 覆盖（窄屏 toggle 翻转覆盖而非改写偏好） | 已有 ✓ |
| 列宽求解 | `computeColumns(viewport, sidebar, details)` 纯函数 concession 链（中心 ≥640 → 缩 details → 关 details） | 已有 ✓ |
| 动效 | grid-template-columns transition（`--ds-ease-in-out` + `--ds-transition-duration-slow`，deepsuite sider 曲线）；拖拽时暂停；`prefers-reduced-motion` 降级 | 已有 ✓ |
| 覆盖层 | `shell.overlay` 槽位（z-index 20，绝对定位 inset:0） | 已有 ✓（抽屉/弹层天然宿主） |
| 输入区 | **已在底部**（命令/权限/模型/发送工具栏，与桌面同排） | 已有 ✓（移动习惯友好） |
| 主题 | `--dsw-*` 静态 token + `--dsw-alias-*` 语义别名（ui-theme） | 已有 ✓ |

### 1.2 缺口（手机竖屏 360-430px 场景）

1. **rail 仍占 56px**：折叠后挤压中心列，不是"全宽消息流"；
2. **中心列 640px 下限**：手机宽度不足时 concession 把 details 关闭后中心仍挤；
3. **无抽屉**：侧栏内容（会话列表/工作区/设置）无法全屏覆盖式浏览；
4. **无底部 sheet**：details（工具详情/轨迹）无处安放；
5. **无安全区适配**：底部输入区会被手势导航条遮挡；
6. **无汉堡/返回手势**：移动端导航缺位。

---

## 2. 设计原则

1. **照搬复用**：sidebar/conversation/details/overlay 槽位内容与组件**原样**进入移动形态，只换容器；
2. **同构响应式**：同一 DOM 树，宽度变化（横竖屏旋转）原地切换形态，动效平滑过渡；
3. **三档形态、一个断点增量**：复用 1024 断点（桌面/平板），新增 640 移动断点；
4. **动效全复用**：sider 曲线、transition token、reduced-motion 降级——不发明新动效语言；
5. **零侵入上游**：新 client 插件包 + profile patch 替换 ui-layout 行（安卓 profile 内），上游可继续演进。

---

## 3. 三档断点体系

| 档位 | 宽度 | 形态 | 说明 |
|---|---|---|---|
| **Wide** | ≥1024px | 三栏完整（现状） | 桌面/平板横屏 |
| **Narrow** | 640–1024px | 现有行为：侧栏自动 rail + 手动展开 | 平板竖屏/窗口缩小（上游已有） |
| **Mobile** | <640px | **抽屉化单栏**（新设计） | 手机竖屏（360–430 主流） |

横屏手机（如 800+ 逻辑宽）落在 Narrow/Wide——**横屏直接复用原界面**，符合用户要求。

---

## 4. 移动形态详细设计（<640px）

### 4.1 布局结构（同一 DOM，CSS/容器切换）

```text
┌──────────────────────────────┐
│ 顶栏（新增，仅移动形态）      │
│ [☰] 会话标题 ▾    [⋯]        │  ← safe-area-inset-top
├──────────────────────────────┤
│                              │
│     conversation 全宽         │  ← 原中心列内容原样
│     （消息流/详情视图）        │
│                              │
│  ┌────────────────────────┐  │
│  │ 输入工具栏（原样，已在底部）│ │  ← env(safe-area-inset-bottom)
│  └────────────────────────┘  │
└──────────────────────────────┘
    ╔══════════════════╗        ← 抽屉（覆盖层，z 低于 overlay）
    ║ 侧栏原样内容      ║        ← translateX 动画
    ║ 会话/工作区/设置  ║
    ╚══════════════════╝
        ╔══════════════╗        ← 底部 sheet（details 原样内容）
        ║ 工具详情/轨迹  ║        ← translateY 动画
        ╚══════════════╝
```

### 4.2 三块容器的移动化（照搬内容，换容器）

| 槽位 | Wide/Narrow（原样） | Mobile（新容器） |
|---|---|---|
| `sidebar` | 三栏内 | **左抽屉**：fixed/absolute 280–320px，`translateX(-100%)` 隐藏 → 0 滑入；配套全屏遮罩（点遮罩关闭）；内容 = 原 sidebar 组件（会话列表/工作区/设置）零改动 |
| `conversation` | 中心列 | 全宽（`100%`）；消息流/输入区原样 |
| `details` | 右栏 | **底部 sheet**：max-height 70%，`translateY(100%)` 隐藏 → 0 滑入；拖拽手柄保留（竖向拖动关闭，可选）；内容 = 原 details 组件零改动 |
| `shell.overlay` | 覆盖层 | 原样（z 最高层，弹层/审批不受影响） |

### 4.3 状态与交互（复用现有 store 语义）

- 抽屉开合 = **现有 `narrowExpanded` 语义扩展**：Mobile 下 toggle 翻转抽屉状态（复用 toggleSidebar 动作）；
- details sheet = 现有 `details` 宽度偏好映射：Mobile 下 `details>0` → sheet 打开（复用 openDetails/closeDetails）；
- 顶栏"☰" = 复用现有 sidebar toggle 入口（ui-sidebar 的 toggle 按钮可原位复用或新增顶栏入口）；
- 会话切换 = 抽屉内会话列表（原样）。

### 4.4 动效设计（全复用现有语言）

| 动效 | 实现 | 曲线 |
|---|---|---|
| 抽屉滑入/滑出 | `transform: translateX` + transition | `--ds-ease-in-out` / `--ds-transition-duration-slow`（与 AppFrame 网格动效同款） |
| sheet 上滑/下滑 | `transform: translateY` + transition | 同上 |
| 遮罩淡入 | `opacity` + transition | 同上 |
| 形态切换（旋转） | grid→全宽 由 ResizeObserver 驱动，容器级 transition | 同上 |
| 降级 | `prefers-reduced-motion: reduce` 全部 transition 关闭 | 上游已有模式 |

### 4.5 安全区与触控

- 顶栏/底栏：`env(safe-area-inset-top/bottom)` + `viewport-fit=cover`（index.html 需补，或 tapIndex 注入）；
- 触控目标：抽屉项/汉堡/关闭按钮 ≥44px；拖拽手柄触控区加宽（8px→24px，仅 Mobile）；
- 手势（P1 可选）：右缘左滑关闭抽屉、sheet 下滑关闭（复用现有 DragHandle 的 pointer 捕获模式）。

---

## 5. 实现路径（方案对比）

### 方案 A（推荐）：`dsh-client-ui-responsive` 新插件包（派生 + 移动分支）

- **包结构**（遵守客户端栈 checklist）：
  ```
  packages/client/ui-responsive/
    src/index.ts            # 空 node-half apply
    src/client/
      ResponsiveAppFrame.tsx  # 派生自 AppFrame（复制+移动分支）
      mobile.css / AppFrame.module.css
      columns.ts / stores.ts  # 复制上游（MIT），或上游加 subpath 导出（PR）
      service.ts              # ctx.layout 扩展（移动状态）
    dsh.client manifest + cordis patch 行
  ```
- **挂载**（安卓 profile patch）：
  ```yaml
  - id: ui-layout
    disabled: true            # 仅安卓；桌面不受影响（条件式）
  - insert:
      - id: ui-responsive
        name: '@deepseek-ai/dsh-client-ui-responsive'
  ```
- **优点**：完全掌控移动形态；上游演进不阻塞；可独立测试；之后可反向贡献 PR 回上游；
- **代价**：AppFrame/columns/stores 约 400 行复制（MIT 许可明确允许）；需同步上游改动（dev preview 期频繁）。

### 方案 B（纯 CSS 覆盖，不推荐）

- 用 `!important` 覆盖 inline grid 宽度 + rail 转抽屉——**CSS 无法干净覆盖 inline style**，且行为（窄屏折叠）需要 JS 注入，收益低、债高。

### 方案 C（上游 PR 直接改 ui-layout）

- 长期最优（社区贡献），但 dev preview 期 API 破坏频繁、评审周期长——作为 M2 后的"反哺"计划，不阻塞当前交付。

---

## 6. 复用清单（零重写）

| 复用对象 | 来源 | 移动形态用法 |
|---|---|---|
| 侧栏组件（会话列表/工作区/设置入口） | ui-sidebar 槽位内容 | 抽屉内原样 |
| 消息流/输入区/工具栏 | ui-conversation + 输入触发器 | 全宽原样 |
| 工具详情/轨迹面板 | ui-tool / ui-trajectory details 槽位 | sheet 内原样 |
| 弹层/审批 | shell.overlay | 原样（最顶层） |
| 动效曲线/过渡 token | ui-theme（--ds-*） | 抽屉/sheet/遮罩 |
| 主题/浅深色 | ui-theme | 原样 |
| 断点/折叠/拖拽状态 | ui-layout stores/columns | 扩展而非重写 |
| 会话标题/模型选择/命令 | 现有输入工具栏 | 原样 |

---

## 7. 风险与测试

| 风险 | 缓解 |
|---|---|
| AppFrame 上游频繁变更（dev preview） | 复制版随上游定期同步（脚本化 diff）；长期走方案 C 反哺 |
| 抽屉/遮罩 z 序与 shell.overlay 冲突 | 抽屉 z=10（overlay 是 20），遮罩 z=9；文档化层级 |
| 横竖屏切换闪烁 | ResizeObserver 已 rAF 节流；形态切换仅容器级 transition |
| 老 WebView 兼容（MuMu） | matchMedia/ResizeObserver 为老 API（Chrome 30+/64+）；继续保留 web-compat polyfill 兜底 |
| 触控误触（拖拽 vs 滚动） | 抽屉拖动区独立；列表滚动区不拦截 |
| 测试 | 仓库 GUI 三阶测试：组件级（props 直喂）+ test:gui + 快照；移动形态补视口夹具（jsdom 宽度参数化） |

---

## 8. 里程碑

- **M1**：`dsh-client-ui-responsive` 骨架 + Mobile 形态（抽屉/sheet/安全区/汉堡）→ 竖屏可用；
- **M1.5**：横竖屏切换平滑化 + 手势（P1）+ 真机（MuMu/实体机）触控回归；
- **M2**：反哺 PR 回上游（可选）；平板多窗口适配。

---
