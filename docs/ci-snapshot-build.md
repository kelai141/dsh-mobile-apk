# 快照构建 CI/CD 方案（草案 v0.1）

> 状态：待确认。目标：把双 ABI APK 构建搬到 GitHub Actions，产物存 workflow artifact，测试闭环后手动发 release。

## 一、总体流程

```
┌─ 设备侧（不可自动化）────────────────────────────┐
│ 1. Termux/MuMu 制作双快照（make-snapshot.sh /   │
│    assemble-arm64.py）→ snapshot-{arm64,x86_64}  │
│ 2. 本地脚本上传到专用 tag 的 release 资产        │
└──────────────────────────────────────────────────┘
        ↓ CI（可自动化）
┌─ GitHub Actions（dsh-mobile-apk 仓库）───────────┐
│ 3. 下载双快照 + checkout 3 插件仓 + root 脚本    │
│ 4. 插件 npm build + pack                         │
│ 5. inject-snapshot.py 注入插件到快照             │
│ 6. 门禁：ELF 架构 / 插件一致性 / secrets 扫描    │
│ 7. 双 ABI gradle 构建 + MANIFEST.txt             │
│ 8. upload-artifact（apk×2 + 快照×2 + tgz×3 +    │
│    MANIFEST + notes 模板）——【不自动发 release】 │
└──────────────────────────────────────────────────┘
        ↓ 本地
┌─ 测试闭环 ───────────────────────────────────────┐
│ 9. gh run download 下载 artifact                 │
│ 10. 解压成 release/v*/ 结构 → 真机/MuMu 测试     │
│ 11. 有 bug → 改代码 → PR → merge → 重新触发构建  │
│ 12. 全通过 → 手动 upload-release.mjs 发 release  │
└──────────────────────────────────────────────────┘
```

## 二、核心约束与设计决策

### 0. 版本号规则（已确认 2026-08-20）
- 正式版：`0.12.4`（不带后缀；versionName 基础值来自 build.gradle.kts）
- 快照版（Demo/测试 APK）：基础版本 + `-SN-<序号>` + 可选注释后缀，如 `0.12.3-FX-1-SN-1`、`0.12.4-SN-1-RC8`
- 实现：`-PversionNameSuffix=-SN-1-RC8`（build.gradle.kts 已支持；versionCode 不变）
- 正式发版 APK 不带 SN 标签；快照版只在 workflow artifact 中，不创建 release

### 1. 快照是输入资产，不是 CI 产物
快照是设备侧产物（含 termux 环境 + 引擎 + 补丁），CI 无法从零生成。
→ 双快照上传到 **draft release** tag `snapshot-input` 的资产（draft 不显示在 release 界面），
  CI 用 `gh api`（GITHUB_TOKEN）经 releases 列表遍历下载（draft 不走 tags 端点）。
→ 上传脚本：`scripts/upload-snapshot-input.mjs`（复用 upload-release.mjs 的鉴权/上传逻辑，幂等）。
→ 更新快照（如 rc8→rc9）：本地重做快照后重跑上传脚本，同 tag 覆盖。

### 2. Workflow 放 dsh-mobile-apk 仓库
gradle wrapper / build.gradle.kts / pr-gate 都在该仓库；CI 步骤：
`actions/checkout` 多个仓库（apk 自身 + root 脚本 + 3 插件），插件按指定 ref。
注意：`dsh-mobile`（root）是私有仓库，checkout 需 `secrets.GH_PAT`（已在 apk 仓库配置）。

### 3. 触发方式
- 主入口：`workflow_dispatch`（手动），输入：快照后缀（默认空=正式版）、快照 tag（默认 `snapshot-input`）、插件 ref（默认 main）。
- 自动：push 到 `release/*` 分支即构建正式版（合并 PR 后直接出包，减少手动操作）；产物只存 artifact。
- PR 本身不触发全量构建（省额度；代码门禁已有 pr-gate 编译检查）。

### 4. 门禁链（CI 脚本 scripts/ci-verify-snapshot.py）
- ELF 架构断言（usr/bin/node machine 匹配 aarch64/x86_64）
- 敏感内容扫描（.credentials / sessions/ / storages/ / anon-id / settings.yaml / .npmrc / 私有 sourcemap）
- 插件一致性（快照内 @dsh-android/*/lib 与插件仓库 lib 哈希一致）
- MANIFEST.txt 生成（sha256 + 相对路径 + 大小，与本地格式一致）

### 5. 产物与本地结构对齐
artifact 内目录结构 = `release/v*/` 的结构（apk/ snapshot/ plugins/ MANIFEST.txt notes.md），
下载后直接放进本地 release 目录 → 测试 → 发布流程不变（upload-release.mjs 仍是唯一发布入口）。

### 6. 与 0.12.4 一起上
CI 文件（workflow + 上传脚本 + 门禁脚本 + 文档）已随 0.12.4 的 PR 合并（root #25 / apk #50 / 插件 #14 #9 #4）。

## 三、Workflow 骨架（已实现 .github/workflows/build-snapshot.yml）

```yaml
name: Snapshot Build
on:
  workflow_dispatch:
    inputs:
      version_suffix:  # 如 -SN-1-RC8；空 = 正式版
      snapshot_tag:    # 默认 snapshot-input
      plugins_ref:     # 默认 main
  push:
    branches: [release/*]   # 自动构建正式版（只存 artifact）

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - checkout dsh-mobile-apk (self)
      - checkout kelai141/dsh-mobile → dsh-mobile (token: secrets.GH_PAT)
      - checkout 3 插件仓 → dsh-shell-termux 等 (ref=plugins_ref)
      - setup-java 17 + gradle 缓存 + sdkmanager android-36
      - setup-node 22 + npm ci/build/pack（3 插件，web-compat 只 pack；Node 22 供 tsdown native TS loader）
      - 下载快照：gh api releases 列表遍历（draft 资产，GITHUB_TOKEN）
      - 门禁：dsh-mobile/scripts/ci-verify-snapshot.py（双 ABI）
      - python dsh-mobile/scripts/inject-snapshot.py（双快照）
      - 双 ABI：cp 快照→assets + 写 snapshot.sha256 + gradlew assembleDebug -PversionNameSuffix（×2）
      - 生成 MANIFEST.txt + notes 模板
      - actions/upload-artifact（保留 90 天，不创建 release）
```

## 四、日常操作速查

- **更新快照输入**（设备侧重做快照后）：`$env:GH_TOKEN=<pat> node scripts/upload-snapshot-input.mjs`（覆盖 draft tag `snapshot-input`）
- **手动构建快照版**：GitHub → dsh-mobile-apk → Actions → Snapshot Build → Run workflow → 填 `version_suffix=-SN-1-RC8`
- **下载产物**：`gh run download <run-id> -R kelai141/dsh-mobile-apk -n dsh-mobile-apk-<version>` → 解压即 release/v*/ 结构
- **自动构建**：push `release/*` 分支自动出正式版 artifact（如 PR 合并后）
- **发布**：测试通过 → 本地 `node scripts/upload-release.mjs <version>`（唯一发布入口）
- **网络不稳时推送**：`./scripts/push-retry.ps1 -All`（自动探测 WinINET 系统代理 + 指数退避重试；
  本机浏览器能开 GitHub 但 git 直连被重置时，正是缺代理所致——脚本自动走系统代理）
