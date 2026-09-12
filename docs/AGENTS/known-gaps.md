# known-gaps.md — 待办与已知缺口（非本轮范围，防再探）

## 8. 待办与已知缺口（非本轮范围，记录防止再探）

- F2「T1 授权豁免自动升级」未落地（电池白名单仅引导 Intent；指数退避仅日志不改调度）——涉及系统策略写面，不自动执行。
- F1.10 引擎更新通道未实现；F0.3 引擎事件桥未实现。
- 子代理 PRD 评审完整清单见协调仓库 `docs/review-0.13.0-20260823.md §九` 与 `.deploy-tmp/prd-gap-review.md`（U4/U5、A4/A6/A8、B4/B5/B7、F4、P4 未修项）。
- **~~扫描/图片版 PDF → 页图渲染受限~~（0.13.1 已修，0.13.0 记录作废）**：原记录「`@napi-rs/canvas` 仅 glibc 预编译装不上」系**误判**——npm 有 `@napi-rs/canvas-android-arm64`（N-API/Bionic 预编译，os=android cpu=arm64，真机 createCanvas 实测可用）。0.13.1 起随出厂快照装配（profiles/web package.json 登记 + tarball 解入，仅 arm64；npm 无 android-x86_64 triple，x86_64 模拟器维持守卫降级）。构建脚本 7c2 段。
- **marketplace 惰性加载决策（0.13.0 D4）**：cordis 装配层无惰性概念；拆装配违反 F4「内置市场」。启动速度优化由 D2（快照瘦身）+ D3（NODE_COMPILE_CACHE）承担，marketplace 保持启动装配。
- **provider 命名混淆（0.13.0 C3 实锤）**：默认 pin 曾为 `opencode-go`（OpenCode Zen Go 网关，`opencode.ai/zen/go/v1`，实测 404）——用户误以为配了 OpenRouter。0.13.0 默认 pin 改 `deepseek-official`（壳注 DEEPSEEK_API_KEY），opencode-go/OpenRouter 需在「添加自定义供应商」显式配置；设置页文案与文档需持续提醒区分。

---

## 无障碍通道待办（0.13.5 W4 未完项）

- **无障碍输入法**（API 33+，`FLAG_INPUT_METHOD_EDITOR` + `InputMethod`）：可替代 ADBKeyboard，中文输入不再依赖 IME 切换（当前 `ACTION_SET_TEXT` 已覆盖可编辑节点，非编辑节点仍需 ADBKeyboard）。
- **`getSystemActions()` 驱动全局动作面**：当前只暴露 back/home/recents/notifications，设备实际支持的动作集合未枚举给模型。
- **节点动作面**：长按（`ACTION_LONG_CLICK`）/展开折叠/复制粘贴/翻页/拖拽尚未暴露为工具参数。
- **单窗口截屏**（API 34 `takeScreenshotOfWindow`）与多窗口选择（`getWindows()`）未接。
- **API <30 设备**：无障碍截屏不可用（`takeScreenshot` 需要 API 30），仍需 ADB `screencap`；`GLOBAL_ACTION_TAKE_SCREENSHOT`(28) 只存相册不回传数据。
- **arm64 真机验证**：无障碍通道目前仅在 x86_64 模拟器验证（无 arm64 设备在线）。

## 0.13.8 收尾新增登记（2026-09-12 晚）

- **滚动条未吸附到最右侧（布局边界不匹配）**：用户真机反馈——滚动条与容器右边界之间有缝，
  没有贴在屏/面板最右（与 apk #197 的布局视口/边界同族，但独立现象，本轮未修）。待定位：
  ① WebView 右侧是否残留 padding 或系统手势区（壳侧 `setPadding` 目前只动 bottom）；
  ② 页面侧滚动容器的 `scrollbar-gutter`/`padding-right`/`max-width` 与
  `--dsh-mobile-popup-max-width` 等钳制变量是否把滚动条挤离边界（`composer-menu.css.ts` 的
  viewport 宽度钳制是重点嫌疑）；③ 移动形态下轨道宽度是否被 `ComposerPopupGuard` 按 CSS 宽度
  而非内容盒计算。定位方法：设备上量 `scrollContainer.getBoundingClientRect().right` 与
  `innerWidth`，以及 `getComputedStyle(el).scrollbarGutter / paddingRight`——先取数再改。
- **悬浮球动效手感（M4-M8）**：时长/幅度未经人眼走查（静态截图断言不了），发布前真机确认一次。
- **`KeyboardBoundary` 机制①的最终形态**：壳侧已把 IME inset 施加到 WebView 布局尺寸，
  页面侧的 `visualViewport.offsetTop` 补偿因此**刻意没有实现**（按 #197 建议修法 1，机制①
  从根上消失后该补偿即冗余）。若真机仍见残留平移，再补页面侧补偿——届时它是第二道防线而非主修。

## 0.13.8 批 F 收尾登记（2026-09-12）

- **API 33+「无障碍输入法」（E6d）无法实现**：`javap` 校验 android-36 的 `android.jar`，
  `AccessibilityNodeInfo` 无 `INPUT_METHOD_EDITOR` 相关符号，设计文档设想的路径在当前 SDK
  上不存在。`ACTION_SET_TEXT` 不被接受的场景由 ADB-IME 通道（`AdbKeyboardService`）承担。
- **截图回落 ADB 的触发路径未在设备上跑通**：本机 API 35 无障碍截屏可用，回落分支只能在
  API<30 设备上真实触发（ADB `screencap` 本身已多次实测）。
- **profile patch 合并语义「按 id 只增不删」**（坑 70）：我们注入的 row 一旦写进设备
  `home/.dsh/profiles/web/cordis.patch.yml` 就**删不掉**（改代码 + 重装 + 重解压都不生效）。
  影响：0.13.8 之后若要下线已注入 row，需要在 `SnapshotTransaction.mergePatchYamlById` 上给
  「上游注入行以 staged 为准」留口子（当前无标记区分「我们注入的」与「用户手改的」，
  实现前先设计标记方式，勿草率改成覆盖语义——那会吃掉用户手改）。
- **悬浮球动效 M4–M8 未做**（G3 余项）：待答卡位移渐隐 / 状态行 TextSwitcher / 琥珀呼吸 /
  PENDING 脉冲。M1/M2/M9/M10/M11 与降级门（`DsUi.animationsEnabled`）已在 #191 落地。
