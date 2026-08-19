# dsh-mobile-apk — DeepSeek Harness 安卓壳 APK

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-blue?style=flat&logo=DeepSeek&logoSize=auto&color=%232D5F9E)
![Android](https://img.shields.io/badge/Android-blue?style=flat&logo=Android&logoSize=auto&color=%2397CA00)


> **dsh-mobile 生态** · [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）· [dsh-mobile](https://github.com/kelai141/dsh-mobile)（协调仓库，private）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的安卓壳：WebView UI 覆盖
**内嵌 Termux 运行时快照**（解压即跑，无需 Termux app）、SAF 目录桥、保活前台服务、引擎看门狗、
运行时在线更新。一个 APK 装完即用：完整的 dsh web agent，且能真实执行 bash。

## 功能

- **内嵌运行时**：随包 ~70MB xz 快照（node + bash + coreutils + dsh + 插件）；首启约 10 秒解压、
  从应用自身目录启动引擎；完全离线；
- **移动 UI**：系统 WebView 加载 `http://127.0.0.1:3080`，配响应式插件（手机端抽屉/sheet）；
- **保活**：前台服务（"dsh 引擎运行中"）+ 5 秒看门狗（引擎崩溃自动重启）；
- **在线更新**：manifest 驱动的快照热替换（下载 → sha256 → 原子切换 → 自动重启），
  运行时可自更新而无需更新 APK；
- **SAF 桥**：`pickDirectory` 把所选目录映射为真实路径（`/storage/emulated/0/…`）。

## 构建

要求：JDK 17+、Android SDK（compileSdk 36）；Gradle 8.11.1 由 wrapper 提供。

```sh
# 1. 准备运行时快照（必须，约 70MB，作为 Release 资产分发）
#    方式 A：从 GitHub Releases 下载 snapshot-x86_64.tar.xz
#    方式 B：在 Termux 设备上自打（scripts/make-snapshot.sh）后拉取
mkdir -p app/src/main/assets
cp snapshot/snapshot.tar.xz app/src/main/assets/snapshot.tar.xz

# 2. 构建（缺快照会构建失败并提示）
./gradlew assembleDebug
# 产物: app/build/outputs/apk/debug/app-debug.apk
```

## 桥协议 v1（`window.androidBridge`）

| 方法 | 签名 | 说明 |
|---|---|---|
| `version` | getter → string | 桥协议版本（`"1.0"`），页面 feature-detect 用 |
| `checkEngine` | () → string | 探测 127.0.0.1:3080；JSON `{running, latencyMs}` |
| `keepScreenOn` | (enable: boolean) | 屏幕常亮 |
| `showNotification` | (title, text) | 通知测试通道（POST_NOTIFICATIONS） |
| `pickDirectory` | (callbackId: string) | SAF 目录选择；结果经 `window.__dshBridge.onDirectoryPicked(callbackId, path)` 异步回传 |

桥协议让 APK 与 dsh 版本解耦：页面按 `androidBridge.version` 做特性检测。

## 在线更新协议

1. App 拉取 `manifest.json`：`{url, sha256, size}`（默认 `http://10.0.2.2:8899/manifest.json`
   供模拟器测试；生产指向发布服务器）；
2. 下载快照 → 校验 SHA-256 → 解压到 staging（不碰线上目录）→ 原子切换 `usr` → 杀掉旧引擎 →
   看门狗用新运行时重启。

测试触发：`adb shell am start -n com.dsharnessmobile.shell/.MainActivity -a com.dsharnessmobile.shell.action.UPDATE`；
状态写入 `files/update-status.txt`。测试服务器：`node scripts/snapshot-server.mjs`。

## 权限

`INTERNET`（WebView + 引擎探测）、`POST_NOTIFICATIONS`（通知通道）、
`FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC`（保活）。SAF 选择无需权限。

## ABI 与页大小

x86_64 快照已端到端验证；arm64 快照由官方 Termux aarch64 仓库组装（见 docs/design.md §ABI）；
16KB 页构建需在 16KB 设备上产出。APK 按 ABI 分发（内含快照与架构绑定）。

## License

MIT。第三方组件按各自许可（见依赖声明）。设计文档：`docs/design.md`。
