# 原生管理中心开发记录

## 当前交付

本地分支 `codex/android-management-ui`，基于远端 main `e6a0b76b`。启动页精简、全屏管理中心、真实插件列表和存储入口已落地。控制台已按用户后续要求统一黑白灰风格，并精简状态层级。用户已完成开发包测试并授权创建 PR；不发布版本。

齿轮使用六齿图标与 0°/240° 固定终点，可中途反向。返回由 AndroidX 回调修改同一导航状态。2026-10-16 用户反馈的矩形波纹和位置跳动已修：圆形遮罩、只旋转图标、两页共用稳定高度内容容器。

## 业务与数据

插件使用现有鉴权 RPC。Hard 清单按配置 ID 与 moduleName 匹配，兼容库存的 `include:` 根路径，变更入口独立复核。设备库存曾观测 197 条，其中 192 条命中本机 Hard 清单。启停复用 pluginManager 持久化，失败重新读状态；停用造成其他活动插件失活时尝试补偿并报告。上游没有静态依赖图接口。

配置使用 settings/describe 的 Schema、脱敏值与 revision；保存通过 settings/mutate 逐字段提交，保留未编辑的敏感值。包含敏感字段的数组禁止整体替换，可逐项修改并保持原长度。已有用户文件格式不变，新增待重启状态 SharedPreferences `plugin_management_pending`。

## 已执行验证

- 最新 main 集成后的完整 Kotlin 单测：1344 项，0 失败，2 项跳过（Windows 符号链接相关测试）；记录 `.deploy-tmp/management-ui/gradle-main.log` 和 `unit-main-summary.json`。
- 齿轮修复及配置安全修正后的相关单测：33 项，0 失败、0 跳过；壳 APK 构建成功。记录 `gradle-gear-fix.log`。
- code-map 与 Kotlin 注释静态门禁通过；记录 `code-map-main.log` / `comments-main.log`。
- 开发包复用 emulator-5556 已安装 0.14.5 APK 的快照，未重建快照。快照 SHA256 `f54ce9bbde0155a77f1155edcfa9e86f84f3690620b6ceb2fb0312e38e063f9e` 与设备已提交指纹相同。安装采用 `adb install -r -t`，不清数据。
- 已观察原生启动页、管理中心、存储页；运行时 CDP 只读探测 pluginManager/listPlugins、pluginInventory/list、settings/describe 均 HTTP 200。

## 验证边界

这是只编译壳、复用旧快照的开发验证包，不是发版候选。尚未完成最终横屏、大字体、预测返回取消、真机、插件启停/配置写入全链与覆盖升级矩阵，不声称完整验收通过。用户继续测试界面后决定 PR。证据与 APK 身份在 `.deploy-tmp/management-ui/`，APK 在 `app/build/outputs/apk/debug/app-debug.apk`。

## 后续修正：控制台与离线插件入口

控制台保留原有 bash 会话、桥接口、命令历史、快捷命令和键盘 Insets，只调整中性色日夜主题、布局及系统栏颜色。插件页先读取真实引擎状态；未启动时展示正常引导，不调用库存 RPC、不显示 0 插件或错误横幅。用户可显式选择启动，复用启动页原有主操作；启动期间保留三级页面，自动读取真实列表，离页取消轮询。启动失败给出恢复指引；真正的服务读取失败仍会明确报告。

相关单测（ConsoleThemeSourceTest、GuideAndConsoleBatch6Test、PluginEngineAvailabilityTest、PluginManagementRepositoryTest）：41 项，0 失败、0 跳过；壳构建成功。命令与日志见 `.deploy-tmp/management-ui/gradle-console-offline-verified.log`。 模拟器中实测离线引导、显式启动后插件列表载入、返回管理中心、控制台命令执行；控制台实际输出 `ui-console-ok`。CDP 确认控制台主题颜色与核心控件，ADB 截图见 `.deploy-tmp/management-ui/plugins-engine-offline.png`、`plugins-start-result.png`、`console-monochrome.png`、`console-command-result.png`。测试 APK SHA-256：`8223fa168bed51d831a39ad49b4a1ad0f562891d2dd2be3e5a461f98ad81da65`。
