# 2026-10-29 构建 canonical 路由与镜像门禁政策修复

## 问题

- 2026-10-28 政策把构建 / 门禁 / 校验脚本的权威源移到 `dsh-mobile-apk`，但 `check-patch-mirror.mjs` 仍逐字节比较 `scripts/**`，主线 13 项脚本差异让 Fast 必红。
- `check-release-gates.mjs` 仍逐字节断言 `build-apk-013.ps1` / `build-release.ps1` 两树同版，同样与政策冲突。
- 协调仓父构建入口仍执行本仓历史副本，会覆盖 APK 较新的 #677 Kotlin 单测前置。

## 改动

- `check-patch-mirror.mjs`：`scripts/**` 脚本条目跳过字节比对并打印 `APK-CANONICAL` 计数（不计 SKIP）；`scripts/patches/**`、Android 插件 / 子仓目录仍逐字节判别。`--self-test` 转接配套测试。
- `check-release-gates.mjs`：删除两树构建脚本逐字节断言，改为「父入口确实委派 + APK canonical 保留 #677 前置且无 `--allow-missing` 回退」；新增 `--self-test` 正控 / 负控。
- `check-snapshot-builder-output.mjs`：删除 `build-apk-013.ps1` / `build-snapshot-013.mjs` 的两树字节断言（Fast 路径上的同类误报）；产出面、配置键闭合与路径同源判据保留。
- `build-apk-013.ps1`（协调仓）：nested APK 在场时委派 `dsh-mobile-apk/scripts/build-apk-013.ps1`，参数与退出码透传；无 nested APK 时走历史实现。
- `build-apk.mjs`（协调仓）：同上，委派到 APK canonical，`--dry-run` 等参数原样透传。

## 证据

- `node scripts/check-patch-mirror.mjs --self-test`：通过（正控：脚本差异 PASS；负控：patch / plugin 漂移 FAIL）。
- `node dsh-mobile-apk/scripts/check-patch-mirror.mjs --self-test`：通过。
- `node scripts/check-release-gates.mjs --self-test`：6 例全过（2 正控 + 4 负控）。
- `node scripts/check-release-gates.mjs`：PASSED（静态接线断言，38 项）。
- `node dsh-mobile-apk/scripts/check-release-gates.mjs`：PASSED。
- `node --test scripts/canonical-route.test.mjs`：4 例全过（PS1 / Node 委派参数与退出码、裸协调仓回退、APK 自包含不自我委派）。
- `node scripts/check-gate-skips.mjs`、`node scripts/check-build-chain-abort.mjs`：PASSED。
- `node scripts/check-snapshot-builder-output.mjs` 与 `--self-test`：PASSED。

## 边界

- 真实 `--peer` 运行仍会因本工作树未镜像的插件 `lib/` 产物报 plugin 清单差异；这是政策保留的真镜像判别，等 robocopy / 构建产物同步后转绿。
- 未运行完整 Fast / Gradle 构建；委派路径由上述 stub 测试验证。最终 Fast 以 APK 仓根资源与插件产物执行。
- 第三方许可相关文件由另一条工作流处理，本次未改。


补充复核：父入口显式把子进程工作目录设为 APK 仓根；参数、退出码与工作目录均由 stub 验证，防止相对资源仍读到父仓历史副本。共享控制协议 JSON 的漂移负控通过，镜像自测共八项。
