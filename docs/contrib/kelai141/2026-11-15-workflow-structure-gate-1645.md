# 2026-11-15：workflow 结构判据缺口——重复键让整份文件解析失败（issue #1645）

## 缺陷形态

`.github/workflows/release.yml` 里「建 draft Release 并上传已验证资产」这一步曾出现**同层级两个 `env:`**：

```yaml
- name: 建 draft Release 并上传已验证资产
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  shell: bash
  env:                    # <- 重复键
    INPUT_VERSION: ${{ inputs.version }}
```

后果不是「后一个覆盖前一个」，而是**整份 workflow 解析失败**。GitHub 侧只回
`This run likely failed because of a workflow file issue`，看起来完全像测试失败——
分支上连续 4 次 release run 全红，实际是文件根本起不来。

## 判据的盲区

`scripts/check-workflow-input-injection.mjs` 只检查 `run:` 块里有没有内插 `${{ inputs.* }}`，
**不看 YAML 结构**。于是「改安全了但改坏了文件」的改动能一路绿灯过门禁——这正是 #1614 那轮的实际经过。

## 修法

在同一个门禁里补结构判据（`findDuplicateMappingKeys`），三条设计约束：

### 1. 零依赖

仓里没有 `yaml` / `js-yaml`（实测 `require` 两者都失败），而门禁要在只装了 node 的环境跑。
所以手写一个只认结构的小分析器，不引依赖。

### 2. 不误报 heredoc（这条最重要）

`run: |` 里嵌的 JS/Python 对象（例如 `{ reason: '...', reason: '...' }`）**不是 YAML 键**。
实测直接按缩进扫会在 `build-apk-source.yml` 上误报 1 处（第 421 行那个 `reason:` 在 heredoc 里）。

实现：记录 block scalar（`key: |` / `key: >-` 等）的起始缩进，其后**缩进更深的行整段跳过**，直到缩进回退。

**为什么这条重要**：误报会让门禁失去可信度，比漏报更糟——维护者会学会忽略它，然后真的缺陷也一起被忽略。

### 3. 精确到行号

报 `release.yml:390 重复键 'env'（上一次在第 387 行）`，不是笼统的「解析失败」。#1645 明确要求这一条。

作用域模型用一个显式栈：缩进回退则弹栈，缩进前进则压栈，同缩进且不是序列项则仍在当前 mapping；
`- key:` 开启一个**新的** mapping（同一层里可以有很多个 `- env:`，各属不同 step，不算重复）。

## 判据

自检从 6 条扩到 11 条，新增 5 条结构用例：

```
PASS  负控④：同一 step 两个同层 env:（issue #1645 原样复现）→ 必须命中第 7 行
PASS  负控⑤：同层重复 runs-on → 必须命中第 4 行
PASS  正控④：两个 step 各有一个 env:（不同 mapping）→ 不得命中
PASS  正控⑤：run: | 的 heredoc 里同层重复的 JS 键 → 不得命中
PASS  正控⑥：顶层 env: 与 step 的 env: 不同层 → 不得命中
WORKFLOW-INPUT-INJECTION SELF-TEST PASSED（11 项）
```

负控④⑤各自断言**行号**，不只看命中数——这是 #1645 要的「精确报出 release.yml:行号」。

## 真实负控（在 release.yml 上）

把 issue 描述的那段重复 `env:` 塞回实际文件：

```
FAIL  workflow 同层重复键（2 处）
  - release.yml:390 重复键 'env'（上一次在第 387 行）
  - release.yml:392 重复键 'shell'（上一次在第 389 行）
  YAML 里同层同名键不是「后者覆盖前者」——整份 workflow 解析失败，
  GitHub 侧只显示 "workflow file issue"，看起来像测试失败。
CHECK-WORKFLOW-INPUT-INJECTION FAILED
exit 1
```

两处都报对了（拆成两个 `env:` 也把 `shell:` 撞了两次）。恢复后 `git diff` 为空、门禁绿。

## 现状核对

用新判据扫当前 13 份 workflow：

```
PASS  13 份 workflow：run 块无用户输入内插，且无同层重复键
```

也就是说 #1645 报告的那处重复键**已经被修掉了**（release.yml:384-386 现在有一段注释专门记这件事：
「两个 env 必须合并在**同一个** `env:` 下」）。本 PR 补的是**让它不能再犯**的那条判据。
