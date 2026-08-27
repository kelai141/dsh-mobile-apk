# Release 发布流程（源码仓库 ↔ 构建产物分离，v0.10.2 起）

> 2026-08-14 v2 ｜ 原则：**源码仓库只维护源码**；产物统一进主仓库 release/ 目录（分门别类 + 版本管理），经 GitHub Releases 发布（单一入口）。

---

## 1. 仓库职责划分

| 仓库 | 维护内容 | 产物 |
|---|---|---|
| dsh-shell-termux/ | 源码 + package.json + 基线 | lib/（tsc 输出）、*.tgz |
| dsh-client-ui-responsive/ | 源码 + 构建配置 | lib/、*.tgz |
| dsh-host-web-compat/ | 源码（lib/index.js 即源码） | lib/、*.tgz |
| dsh-mobile-apk/ | Gradle/Kotlin 源码 + 资源 | build/、snapshot/（快照输入，按 ABI 命名） |
| 主仓库（总控） | docs/ + scripts/ + release/（发布产物唯一出口） | release/v<版本>/... |

## 2. 版本号管理（单一事实源）

| 项 | 规则 |
|---|---|
| 主版本 | APK versionName（build.gradle.kts），v0.10.x；versionCode 随版本递增 |
| release tag | 与主版本同号（v0.10.2），仅 dsh-mobile-apk 仓库 |
| 插件版本 | package.json 各自 0.1.x 独立演进（tgz 文件名带插件版本） |
| 归档 | 已发布版本移入 release/archive/ |

## 3. release/ 目录规范

    release/
    ├── v<版本>/apk/dsh-mobile-apk-v<版本>-<abi>.apk   # abi = arm64-v8a | x86_64（双 ABI 必须同时产出）
    ├── v<版本>/snapshot/snapshot-<abi>.tar.xz         # 双快照（在线更新/重打包用）
    ├── v<版本>/plugins/*.tgz                          # 3 插件
    ├── v<版本>/MANIFEST.txt                           # sha256 清单
    ├── v<版本>/notes.md                               # 发布说明 + 各 ABI 验证记录
    └── archive/                                       # 历史版本

## 4. 一键构建（门禁自动执行）

    powershell -File scripts/build-release.ps1 -Version 0.10.2

门禁：双快照 ELF 架构断言 + npm 层断言 + 快照内插件 hash 与发布 tgz 一致性 + check-snapshot-secrets（凭据/会话/sourcemap）+ MANIFEST 生成。

快照输入：dsh-mobile-apk/snapshot/snapshot-<abi>.tar.xz（设备侧 make-snapshot.sh 产出后按 ABI 命名放入；打快照前必须先部署最新插件，否则一致性门禁中止）。

## 5. 发布（单一入口）

    git -C dsh-mobile-apk tag v0.10.2 && git -C dsh-mobile-apk push origin v0.10.2
    $env:GH_TOKEN=<pat> node scripts/upload-release.mjs 0.10.2

- 插件仓库不再打 release（避免 tag 与包版本错位混乱）；需单独分发时用 plugins/ tgz；
- 发布后闭环：下载新资产 → sha256 对照 MANIFEST → 对应平台安装冒烟（x86_64 → MuMu；arm64 → 真机）→ 记录进 notes.md；
- 错误 release 处置：gh release delete <tag> -R kelai141/dsh-mobile-apk --yes → 修正后重发。

## 6. 资产命名约定

- APK：dsh-mobile-apk-v<主版本>-<abi>.apk（abi = arm64-v8a / x86_64）
- 快照：snapshot-<abi>.tar.xz
- 插件：dsh-android-<pkg>-<插件版本>.tgz（npm pack 原名）
- MANIFEST.txt：sha256 + 相对路径 + 字节数（排序稳定，跨平台可校验）

## 7. 第三方许可合规声明（2026-08-23 起，GPL 义务）

快照运行时预装 Termux 软件包（dpkg 清单见快照 `usr/var/lib/dpkg/status`，标准文本副本与清单见仓库根 `LICENSES/` 与 `THIRD_PARTY_NOTICES.md`，并随 APK 打包在 `assets/licenses/`）。

- **许可证全文随包分发**：每个包 `usr/share/doc/<pkg>/copyright`（或 COPYING*），标准文本统一位于 `usr/share/LICENSES/*.txt`（Termux `licenses` 包，构建链已显式锁定——实测 x86_64 缺省闭包曾漏带，`build-snapshot-013.mjs` TARGETS 已固化 `licenses`）；
- **源码要约（GPL §3）**：各 copyleft 组件对应源码与构建脚本见 [termux/termux-packages](https://github.com/termux/termux-packages)（版本标签对应，详见 THIRD_PARTY_NOTICES.md 的组件/版本/许可表）；要约自本发行发布起三年内有效；
- **对二进制的再加工**（A4，全部随本仓库开源）：前缀/编译期路径重写 `scripts/fix-shebang.py`、`scripts/inject-snapshot.py`、`termux-elf-cleaner` 调用与 `scripts/build-snapshot-013.mjs`（shebang/RUNPATH/elf 处理）、快照注入与打包 `scripts/build-apk-013.ps1`、`scripts/patch-marketplace.mjs`、`scripts/patch-undo-mobile.mjs`；
- **门禁**：`scripts/check-third-party.mjs`（矩阵覆盖 + copyleft 全文在场）已在 `build-apk-013.ps1` 接入，缺失即拒绝打包；
- **无额外限制**：上述二进制保持其上游许可，未施加任何附加条款；本工程 dsh 引擎/壳/插件（MIT 系）与 GPL 二进制为进程级聚合，非链接派生，不受传染（详 THIRD_PARTY_NOTICES.md 说明）。
