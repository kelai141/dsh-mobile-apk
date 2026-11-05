# 正则锚点也必须「恰好一处」（2026-11-04，issue #1531）

## 现象

`#1384` 给补丁锚点加了「出现次数必须恰好 1」的判据（`replaceOnce` / `replaceAtMostOnce`），
但只覆盖了**字符串字面量**锚点。`apply-patches.mjs` 里另有 8 处锚点走正则 `replace`，
它们仍是「只换第一处、不校验次数」——半补丁静默通过。

实锤（`arkweb-resource-protocol-H1`，把上游夹具里该锚点复制成两份后跑真 runner）：

```
apply exit status: 0
[ok]   arkweb-resource-protocol-H1 applied（…/dsh-client-resources/lib/client.js）
applied 1/1
apply-patches: ALL OK（1/1，mode=apply，changed=1）
```

而文件里仍剩 **1 份**未修补的原始分支。marker 已插入 → `check()` 恒真 → 之后每轮 `[skip] 已应用`。

## 真因

判据不能直接复用。`replaceOnce` 数出现次数用的是 `source.split(before).length - 1`，
把正则传进去是把 `re.source` **当字面量**数。而这 8 处锚点恰恰全是「靠元字符才匹配得上」的：

| 锚点 | 靠什么元字符 |
|---|---|
| `MINIMAL_RE` | `[\s\S]*?` 跨行 |
| `(    profileName,\r?\n)` | `\r?` 兼容 CRLF |
| `(\r?\n)([ \t]*)`（H1） | 捕获组 + 字符类 |

实测：这 8 处锚点的 `source` 串在被测文件里出现次数**全部为 0**。所以「把正则直接交给
`replaceOnce`」这种最省事的修法会让每一处都抛 `found 0`——从「静默半补丁」变成「全线假红」。

出现次数只能问模式本身：`String.match` 的全局匹配。

## 修法

- `scripts/patches/lib/replace-once.mjs` 新增 `replaceOnceRe(source, pattern, after, label?)`
  与 `replaceAtMostOnceRe(...)`：用全局 `exec` 数命中数（零宽匹配手动推进 `lastIndex`，
  否则死循环），判据与字面量版一致——**恰好 1** / **最多 1（只有 0 被容忍）**。
- 计数与替换各用一份独立的正则对象：计数必须带 `g`，替换要去掉 `g`（不误替换第二处），
  且不污染调用方正则的 `lastIndex`。
- `apply-patches.mjs` 的 8 处正则锚点全部迁移：
  `mapRe`（market-D）、`MINIMAL_RE`（undo-safe-align-S1）→ `replaceOnceRe`；
  `buildConfig` / `profileName` / `safeModeDefaultWebStore` / 两条 `node:path` import
  （undo-safe-transaction-S2 的升级路径）→ `replaceAtMostOnceRe`（新形态文件里这些锚点本来就不存在，
  0 次是合法状态）；
  H1 的 `ORIGINAL`（捕获组 + 回调替换）→ `replaceOnceRe`，回调形态照旧。
- 位移为零（12 增 12 删，行数不变）：`check-code-map.mjs` 的锚点按行号+内容钉在
  `apply-patches.mjs:2916` 等处，多删一行就会把锚点错位。

## 复验

`scripts/patches/tests/replace-once-1531.test.mjs`（13 例）：

- 纯函数：0/1/2 次；非 RegExp 抛；缺省标签印模式原文；带 `g` 的锚点且 `lastIndex` 不被改动；
  零宽模式计数确定（`(?=)` 在长度 3 的串里是 4 处）不死循环。
- 元字符语义：`\r?\n` 在 CRLF 文本里数 2（而 source 串字面量数 0——旧判据看不到锚点）；
  转义点号不匹配下划线/任意字符；惰性量词两段都计入；`^[ \t]*` 未加 `m` 只锚串首。
- 端到端（真跑 runner，版本化夹具）：H1 锚点**恰一处** → 施加成功、原始分支被替换（正控）；
  H1 锚点**两处** → 退出码 1、stderr 含 `found 2` 且点名锚点、文件逐字节未变（不得半补丁）。

负控（真打红，两条都验证过再改回）：

| 把实现改坏成 | 结果 |
|---|---|
| `replaceOnceRe` 退回裸 `source.replace(pattern, after)`（#1531 本体） | 8 例 FAILED，含端到端 H1 两处 |
| 计数改回 `source.split(pattern.source).length - 1`（错误修法） | 6 例 FAILED，含 H1 正控（假红） |

其他：

- `node scripts/check-patch-test-manifest.mjs` → PASSED（46 个文件，TAP pass=157 / fail=2，
  两条均为既有 Windows symlink EPERM 豁免项）。
- `node scripts/patches/apply-patches.mjs vendor --check` → `22/22 ALL OK`（真补丁链未受影响）。
- `node scripts/check-patch-mirror.mjs` → PASSED（SKIP=1：对端树不在场）。
- `node scripts/check-code-map.mjs` → PASSED。
- `node scripts/check-release-gates.mjs` → PASSED（静态档，SKIP=1）。
- **未做设备验证**：纯构建链脚本（L1），不触及壳侧与设备面。

## 已知边界

- 本次只收口**锚点型**正则替换。文件里剩下的 `.replace(/re/, …)` 是**变换**而不是锚点
  （`replace(/\n$/, '')` 去尾换行、`replace(/^['"]|['"]$/g, '')` 剥引号、`replace(/\r$/, '')`），
  它们没有「出现次数」语义，不该套同一判据。
- `scripts/patches/**` 是双仓逐字节镜像面：本 PR 是本仓镜像 PR，协调仓权威源由维护者按铁律 6 跟进。
