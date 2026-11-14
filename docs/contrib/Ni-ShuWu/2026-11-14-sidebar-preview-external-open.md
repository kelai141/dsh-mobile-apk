# 侧边栏未支持格式的外部打开入口

## 现象与原因

音频等文件在文档预览里显示「该格式文件暂时无法预览」，提示下缺少 Android 外部应用入口。上游已提供 `sidebar.right.tab.document.unpreviewable` 列表插槽；Android 适配层此前未注册原生打开动作。压缩包等文件另有既存 `open-with` 标签，不属于该提示分支。

## 实现

- 在该插槽注册 `PreviewExternalAction`，保留上游图标和提示，在其下显示「在外部应用打开」药丸按钮。
- 路径直接消费预览所有者提供的 `absolutePath`，不拼接当前前台会话的 cwd。按钮动作每次读取已注入的 `androidBridge.openFileExternal`，共享文件卡片的 JSON 回执解析和 MIME 映射；补足常见音频 MIME。
- 既有壳侧 `FileExternalBridge` 继续负责 canonical 允许面、FileProvider、只读授权和 ACTION_VIEW 系统选择器，不新增桥方法或权限。
- 使用主题变量、细描边、999px 圆角和 44px 最小触控高度；无方向或视口宽度开关，横竖屏共用同一内容流。中英字典注册 `androidPreviewExternal`，操作失败在本文件提示原因并允许重试，后续成功清除提示。
- `documentpreview` 依赖固定为已有运行时版本 `0.2.2-rc.1`，仅作为开发期插槽类型来源；无运行时值导入。

## 本轮审阅与范围

源码及新增测试已完成两轮独立静态交叉审核，未发现阻断问题。用户后续要求执行构建、测试、设备验收及覆盖安装最新 APK；全程禁止重置的约束保持有效。

代码层证据位于 `.deploy-tmp/sidebar-external-open/`：`build.log` 构建和 TypeScript 编译通过；`tests-all.log` 既有 95 文件 / 1352 测试通过；`tests-targeted.log` 新入口与既有文件卡片、open-with 共 3 文件 / 72 测试通过；`negative-mime.log` 在 Vite 内存变换中撤去 FLAC MIME 后，真实点击传给桥的 MIME 变为空串，对应用例按预期失败，未改动或重置源码。`kotlin-file-external.log` 的 `FileExternalBridgeTest` 19 项与 `FileIncomingSafetyTest` 15 项通过。桥面对称和状态登记门禁通过。

执行地图校验仍报告基线已有 193 项锚点漂移；使用 `git archive HEAD` 在隔离目录运行相同门禁也为 193 项。本次只补新入口/覆盖账本，并修复因新增 import 移动的那条引用，没有刷新全仓基线或将既有失败标为通过。

设备先前安装 `0.14.11-fix960` 非调试包，无法直接 CDP 或 run-as。先核对同签名，使用相同快照的 debug 壳覆盖安装并热推 JS；竖屏已通过真实 WebView 状态读取、ADB 点击及 Android 系统选择器断言。随后按用户要求，将构建后的插件经仓库 `inject-all.py` 注入同一 arm64 底座的两个 profile，并重算指纹及 Hard 清单、构建 `0.14.11-preview-external` APK。该 APK 已使用 `adb install -r -t` 覆盖安装，未卸载或清数据。

本次开发 APK 不属于发版候选：底座复用设备已安装包的快照，仅注入本次客户端插件；构建期压缩采用 preset 1。壳源码来自基线 `7f1f8eab`，按钮源码为本 PR。APK 内两个 profile 的 `lib/client.js` 均逐字节对应本次构建（SHA-256 `382e7e1c8c3a89536ed3fb1322156913232b559d49f3a5fc57653f5355e0d7d3`）。不得将这份单 ABI 调试 APK 当作双 ABI 发布全链产物。

## 开发 APK 设备结果

- APK：`dsh-mobile-apk-0.14.11-preview-external-arm64-debug.apk`，versionCode `1411114`，217843282 字节，SHA-256 `b68ad5c1c65775e6c46e4ea8d2c1768f94e05534dc242fcaaab4bfacf35daba2`。最新覆盖安装成功，快照指纹翻转为 `e2c3577e8f90a1b4cbd3375dddaaf00e706d5ad8d37567bf87d281e3c4deebfe` 且事务消失后才开始最终验收，未再次热推。
- 实际任务：从保留的会话打开工作区 WAV 样本，点外部打开并选择播放器，返回后旋转横屏再次打开系统候选，检查英文浅色主题，再返回文本预览并恢复原语言/主题/旋转设置。系统音乐应用打开后被其自身更新弹窗拦住；MT 分组另显示「音乐播放器 / MT管理器」。本轮证明的是 Android 选择器及应用拉起，不将第三方应用的播放结果记为通过。
- 竖屏 `430×941 CSS px` 与横屏 `941×430 CSS px`：CDP 确认文案、按钮在提示下、命中测试和视口内布局；ADB 真实点按均拉起 `com.android.intentresolver/.ChooserActivityLauncher`，`PASS`。原始状态分别为 `portrait-apk.json`、`landscape-apk.json`；截图 `ui-portrait-apk.png` / `ui-portrait-apk-chooser.png`、`ui-landscape-apk.png` / `ui-landscape-apk-chooser.png`。
- 英文浅色：实际显示 `Open in external app`，前景 `rgb(15, 17, 21)`、背景 `rgb(255, 255, 255)`、圆角 `999px`，命中测试为真；`cdp-english-light.json` 与 `ui-english-light-landscape.png`。
- 数据与范围：覆盖升级后仍恢复原会话和工作区文件；只写入独立样本目录 `preview-external-20261114`。没有执行卸载、清应用数据、Git reset、ADB 重置或偏好清空。语言/主题恢复原 `zh` / `system`，旋转恢复 `0`。
- 以上为开发 APK 的代码层、CDP 层、ADB 用户层证据；发布前仍需最终双 ABI 来源链及发布候选验收。

## 公开证据

按用户要求，验证摘要与关键截图同 PR 提交。使用受控样本，文字证据按字段白名单导出；省略设备序列号、会话 ID、令牌、本机绝对路径和原始 Activity 日志。截图只包含受控验收会话和样本文件；没有通知浮层。

- [脱敏验证摘要](assets/2026-11-14-preview-external/validation.json)
- [竖屏实际界面](assets/2026-11-14-preview-external/portrait.png)
- [横屏实际界面](assets/2026-11-14-preview-external/landscape.png)
- [英文浅色实际界面](assets/2026-11-14-preview-external/english-light.png)
