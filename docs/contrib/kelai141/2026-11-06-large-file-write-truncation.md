# 操作坑位：大文件分段读 + 拼接写 = 静默截断

- 日期：2026-11-06
- 性质：**操作坑位**（工具使用形态），不是产品缺陷
- 出处：缺陷 2（首启提速）期间误写 `docs/AGENTS/EXECUTION-MAP.md` 的真实事故

---

## 现象

用 `read` 读一个 2766 行的文件（`docs/AGENTS/EXECUTION-MAP.md`，659,062 B），
然后按「读到的内容」`write` 回去。文件从 **2766 行 / 659,062 B** 变成 **233 行 / 50,650 B**。

没有报错，没有警告，`write` 返回成功。**下游表现是 code-map 门禁突然冒出 20+ 条
`bad-anchor-content`**——因为 2500 多行锚点内容全没了。

## 真因

`read` 的 `limit` **默认 2000 行**。对 2766 行的文件，一次 `read` 只返回前 2000 行，
而返回结果里只有 `totalLines: 2766` 这一个字段暗示「还有 766 行没给你」。
把它当全文拼起来再 `write`，后 766 行就**静默消失**。

**这不是疏忽，是工具形态的必然**：只要「读」有默认上限而「写」是全文替换，
任何超过上限的文件都会踩。文件越大越危险——而越大的文件越容易让人想「整读整写」。

## 修法（三条，缺一不可）

1. **`write` 之前断言行数**：`totalLines === 手里内容的行数`。不等就是读漏了，**绝不写**。
2. **受版本控制的大文件只用定向 `edit`**：`old_string` 唯一匹配 → 替换。不要整读整写。
   本仓 `docs/AGENTS/EXECUTION-MAP.md`（2700+ 行）、`docs/AGENTS/changelog-archive.md` 都属于这一类。
3. **改完立刻 `git diff --stat` 自查字节量级**：改 1 行却显示 600 行删除 = 立刻停手还原。

## 复验（本次事故的还原证据）

```powershell
# 从 index 里的 blob 逐字节还原（只读对象库，不碰工作区历史）
$sha = (git ls-files -s docs/AGENTS/EXECUTION-MAP.md).Split(' ')[1]
git cat-file blob $sha > .deploy-tmp/EXECUTION-MAP.HEAD.md
Copy-Item .deploy-tmp/EXECUTION-MAP.HEAD.md docs/AGENTS/EXECUTION-MAP.md -Force

# 复验：行数与字节数都要对上
(Get-Content docs/AGENTS/EXECUTION-MAP.md).Count   # 2766
git diff --stat -- docs/AGENTS/EXECUTION-MAP.md    # 只剩该有的锚点重钉
```

## 为什么值得单独记一条

- 它**不会失败**：`write` 成功、文件合法、Markdown 能渲染，只有靠门禁或 diff 才发现。
- 它的**后果与改动量不成比例**：一次「顺手整理」能删掉 2500 行权威文档。
- 本仓的 `EXECUTION-MAP.md` 是锚点门禁的唯一真源，截断它等于把整套门禁的坐标清零。
- 它**与个人无关**：任何人在任何大文件上都会踩，所以按 AGENTS.md §5.1 应由维护者汇总进
  `docs/AGENTS/gotchas.md`（本文只是贡献者记录，编号与汇总由维护者定）。

---

## 附：同一轮里另外两个「工具形态」教训（都不进 gotchas，只记在这里）

### 附 1：`--only --write` 的 dry-run 与落盘是**两套输出**

`node scripts/check-code-map.mjs --only <path>`（不加 `--write`）只打印「将改写 N 处」，
**不落盘**；加了 `--write` 才写。两者都要看——只看 dry-run 会以为已经改完。
（本仓 `issue #1179` 就是为此把默认行为改成 dry-run 的，说明踩过不止一次。）

### 附 2：多会话并发跑 `:app:testDebugUnitTest` 会互相锁 build 目录

现象：
```
java.io.IOException: Unable to delete directory
  'app\\build\\test-results\\testDebugUnitTest\\binary'
  Failed to delete some children. ... output.bin
```
真因：Gradle 的 **Test Executor** worker 进程（不是 gradle daemon）在父 gradle 退出后可能成为孤儿，
它持有 `output.bin` 句柄 ⇒ 后续任何 `:app:testDebugUnitTest` 都删不掉该目录。
判据：`Get-CimInstance Win32_Process -Filter "Name='java.exe'"` 里找
`CommandLine` 含 `GradleWorkerMain` 且父进程已消失的进程。
处置：kill 孤儿 executor（**不是** daemon），再重跑。
