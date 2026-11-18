# 追版 Harness 0.2.2-rc.3

## 做了什么

构建目标从 `@deepseek-ai/dsh` **0.2.2-rc.1** 抬到 **0.2.2-rc.3**（上游 tag `dsh-v0.2.2-rc.3`，
commit `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`），并把随之失效的面逐条适配。

## 上游变化与安卓落点

以下每一条都在 rc.3 真实发布产物上核对过，不是照抄发布说明。

| 上游变化 | 安卓处置 |
|---|---|
| **客户端 bundle 改发布为紧凑单行**（0.2.2-rc.2 起）：`lib/client.js` 的换行与缩进被整段抹掉，标识符一个都没改名（sidebar-right 从 225,719 B / 5,784 行变成 138,641 B / 3 行） | 7 条面向 client bundle 的引擎补丁按紧凑形态重锚。判据一条没放松：仍是「锚点恰好命中 1 处」，0 处与多处都判红不写回。B1 保留三份形态（紧凑 / 格式化 / Android 源码构建移动形态）互斥求和。 |
| **根包入口拆成两层**：`lib/bin.js` 只剩 shebang + 两条内置 import，真 CLI 在 `./bin-CwxESKe-.js` 里按需动态 import | N2（编译缓存主动落盘）重锚到最后一条顶层 import。注入点仍早于任何命令逻辑：实测 blockAt=651 < firstRegion=1014。 |
| **`office-to-pdf` 包与行被删，改挂 `office-kit`** | profile 里针对 `office-to-pdf` 的禁用行删除。新 `office-kit` 对 `libreoffice-kit` **只有 `import type` 与延迟 `import.meta.resolve`**（产物 `lib/index.js` 的 10 条 import 里没有它），boot 阶段不再解析该依赖 —— 禁行失去理由。如实说明：Android 上仍然没有 LibreOffice 引擎，Office 转换会得到 unavailable；差别是以前启动崩，现在功能不可用但引擎正常起来。 |
| **`experimental-terminal-bundle` 拆掉双入口**：该组只剩 registry / panel / tool-terminal，bash 后端改由 web-app preset minimal 的 `persistent-shell` 组挂（id `terminal-bash` / `terminal-pwsh`） | profile 里针对 `optional-terminal-pwsh` 的禁用行删除（该 id 在上游行面已不存在，保留只是空指向）。撞名风险的现时判据由 `scripts/check-terminal-entries.test.mjs` 的合成判定守着（含负控）。 |
| **PTC 把持久进程拆到 `persistent-process.js`**，且 embedded 形态补了 `--experimental-vm-modules`（走 env 而非 argv） | `ptc-argv-L1` 三处锚重排；packaged 分支**原样保留**上游那个取值，A1 的 nested 正则改成接受两种取值并原样带回，不重写、不吞上游 flag。 |
| 事件客户端 7 个新槽位、行面净增 5 条（202 → 202 重捕，office-to-pdf / optional-terminal-bash / optional-terminal-pwsh 消失，office-kit 等新增） | 逐条判定：本仓客户端面与服务面 grep 均 0 命中 ⇒ 全部「明确不挂」。 |

## 门禁结果

```
check-patch-fixtures        PASSED（夹具代 0.2.2-rc.3，31 个新夹具，rc.1 代 121 个转 superseded）
check-vendor-provenance     PASSED（70 文件 / 1,417,757 B）
check-patch-mirror          PASSED（SKIP=0）
check-maintenance-docs      PASSED
check-contract              §0/§1/§2/§4/§4b/§4c/§5/§6/§8 全绿；§3/§7/§9 具名 SKIP（见下）
check-code-map              失败项与 origin/main 基线**逐条相同**（16 = 16，mine-only = 0）
probe-engine-anchors        applied 36/36
```

`check-contract` 的三处 SKIP 都是环境缺席，不是判据放宽：
- §3 继承符号：本地无 `dsh-shell-termux/node_modules`（未 `npm install`）；
- §7 运行期兼容：本地拿不到 semver；
- §9 人读契约文档：`docs/UPSTREAM-CONTRACT.md` 是协调仓独有文档。
另有 9 条「未构建（lib/ 缺失）」——`lib/` 在本仓是 `.gitignore` 的产物面（`plugins/*/lib/`），
由构建链产出，不随源码提交；`check-contract` 本身也不在 apk 的 PR Gate 里跑。

## 未做（如实标注）

- **未做设备验证**：本轮未打包、未装机、未跑 CDP 层与 ADB 用户层。
- **未跑全量测试**：按指令不跑 Kotlin 单测与设备套件。
- **未构建快照**：`snapshot.tar.xz` 未重建，所以 `check-engine-overlay` / `check-runtime-assets` /
  `check-snapshot-secrets` 这类需要快照产物的门禁**没有跑**，不能当通过。
  这些必须在进入发版候选前补跑 —— 尤其 `check-engine-overlay` 是 overlay 登记表唯一的行为判据。

## 风险与已知缺口

1. **overlay 只核对了「登记面」，没有核对「快照内实际落位」**。`engine-overlay.json` 的
   `packages` 面由生成器重生成（374 个上游包 → 380 条登记），人工段（vendorTop / nested / pins /
   extraPresent / requiredUpstreamPatches / assemblyInventory）已按 rc.3 闭包逐段核对，
   但**没有一个门禁证明快照里真的有这些字节** —— 那要等 `build-snapshot-013.mjs` 重建后跑
   `check-engine-overlay` 才算数。
2. **紧凑 bundle 的补丁只做了锚点级验证**。`node --check` 能证明注入后语法合法、注入位置在类体层，
   但证明不了运行期行为（例如 B1 的 reorderIn 在真 DOM 上的排序结果）。这三层要等设备验收补。
3. `pi-ai` 官方补丁文件 `scripts/patches/upstream/pi-ai-1.3.0.patch` 与 rc.3 上游
   `patches/@earendil-works__pi-ai@1.3.0.patch` **LF 归一后逐字节相同**（sha256 `4e1c90fd…`）；
   本地文件是 CRLF 检出，所以本地哈希是 `d2ee86c4…`，两者不是同一层身份，登记表按本地字节记录。
