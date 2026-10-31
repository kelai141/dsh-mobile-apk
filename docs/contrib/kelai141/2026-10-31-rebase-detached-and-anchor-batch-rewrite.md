# rebase 停在 checkout origin/main，与锚点基线批量重铺的两个坑（2026-10-31）

两个都在 rebase `fix/browser-output-injection-1200`（issue #1200）到 `a4f0b568` 时踩到。
第一条差点让我以为提交丢了，第二条让 `check-code-map` 在一个我没碰过的文件上判红。
两条都不是「操作失误」，是**工具在当前状态下给出的信号本身有误导性**——所以值得记。

---

## 坑一：`git rebase` 在 checkout `origin/main` 阶段中断，`git log` 看着像提交丢了

### 现象

`git rebase origin/main` 在 `scripts/check-code-map-anchor-baseline.json` 上报冲突后中断。
但中断的**位置**不是「正在应用我的提交」，而是更早一步——reflog 说明了这一点：

```
$ git reflog -4
a4f0b568 HEAD@{0}: rebase (start): checkout origin/main      <- 卡在这一步
8ca20f5b HEAD@{1}: commit: fix(browser): 页面可控的 role/title/url …（#1200）
203d36b0 HEAD@{2}: reset: moving to HEAD
```

此时：

```
$ git log --oneline -1
a4f0b568 fix(session-delete): 先移目录后卸载…（#1203） (#1223)   <- 是 main，不是我的提交

$ git status --short
M  docs/AGENTS/EXECUTION-MAP.md
M  plugins/dsh-android-browser/src/tools.ts
A  plugins/dsh-android-browser/test/output-injection.test.mjs
MM scripts/check-code-map-anchor-baseline.json
```

**我的提交 `8ca20f5b` 看起来凭空消失了**：`git log` 里没有它，`HEAD` 指向 main。
但它其实完好——全部改动都还在**暂存区**（`M `/`A ` 是已暂存，`MM` 是暂存后又改过）。

### 为什么

`git rebase` 的流程是「先 checkout 到 upstream，再逐个 cherry-pick 你的提交」。
第一步 checkout 就会把工作区/暂存区改成 upstream 的内容，**你的提交此时还没开始重放**。
如果在 checkout 阶段就停下（冲突、被中断、磁盘/权限问题），仓库就停在一个
「HEAD = upstream，我的改动躺在暂存区」的中间态。

这个状态在 `git log` 看来和「提交丢了」一模一样，而在 `git status` 看来又像
「一堆莫名其妙的未提交改动」。两个视角都不对，真相在 `git diff --cached`。

顺带一个放大误导的细节：我在中断后先跑了 `git diff origin/main --name-only`，
结果列出一堆**我没碰过**的文件（`scripts/check-boot-budget.mjs`、
`scripts/check-mcp-client-deps.mjs`、`docs/AGENTS/gotchas.md`…），看上去像
「我的分支把别人 142 行代码删了」。

真因不是「ref 过期」，恰恰相反——**`origin/main` 比我 rebase 的基准新**：

```
a4f0b568   <- 我 rebase 到的基准
d405e1c9   <- 当时 origin/main 指向这里（a4f0b568 的后代，更新）
```

`git diff origin/main` 拿「基准较旧的我的树」去比「更新的远端」，差异里当然
全是**别人在这段区间新加的提交**，看起来就像我删了它们。换成
`git diff a4f0b568 --name-only`（与我 rebase 基准同一个 commit）立刻只剩
我预期的 4 个文件。

**教训是「比对基准必须和你实际基于的 commit 一致」**，而不是笼统的「ref 过期」——
ref 偏新和偏旧都会给出误导性的 diff，方向相反而已。

### 以后怎么做

**先判状态，再决定恢复路径**——三条命令足够定性：

```bash
git status            # 看有没有 rebase 中间态标记
git reflog -4         # 看 HEAD 是怎么走到当前位置的（rebase (start) 是关键特征）
git diff --cached --stat   # 我的改动还在不在暂存区
```

**情形 A：改动都在暂存区**（最常见）。不要 `git rebase --abort` 重来，直接收口：

```bash
# 1. 把暂存区内容提交到当前 HEAD（= upstream）之上
git commit -F <message-file>
```

这就是我这次的恢复路径，一次成功，得到 `f0290f5d`（4 files changed）。
之后照常 `git push --force-with-lease`。

**情形 B：暂存区是空的 / 不完整**。用 reflog 找回原提交再重做：

```bash
git reflog | grep 'commit:'        # 找到你自己的提交 hash
git show <hash> --stat             # 确认内容完整
git cherry-pick <hash>             # 或 git reset --hard <hash> 后重新 rebase
```

**情形 C：确实想从头再来**：`git rebase --abort`（回到 rebase 前状态），
但先确认 `git stash list` / `git diff --cached` 里没有你要保留的东西。

**永远不要做的事**：看到「提交没了」就 `git reset --hard`。这一步会真的把
暂存区里那份唯一的副本删掉。本次如果这么做了，188 行改动就真丢了。

**另一个必须养成的习惯**：比对差异时**用具体 commit hash，不要用 `origin/main`**。
本地跟踪 ref 和「你实际 rebase 到的基准」经常不是同一个 commit（偏新或偏旧都可能），
拿它当基准会凭空多出一堆「别人删了代码」或「我少了代码」的假差异：

```bash
git diff origin/main --name-only      # 危险：ref 与你基于的 commit 未必一致
git diff <你 rebase 到的那个 hash> --name-only   # 安全：基准明确
```

（`git fetch` 只能让 ref 追上远端，**不能**保证它等于你 rebase 的基准——
如果你 rebase 到的是稍早的 commit，fetch 后 ref 反而更「新」。）

---

## 坑二：批量重铺锚点基线时，「裸文件名」键会跨文件撞车

### 现象

`scripts/check-code-map-anchor-baseline.json` 的 `sourceLines` 里，同一个文件可能
**同时存在两种键形**：完整路径与裸文件名。实测（`a4f0b568`）：

```
total keys = 971 | bare-name keys = 486 | path keys = 485

共存基名数 = 70      <- 70 个文件名同时以两种键形存在
  AndroidBridge.kt:319 -> AndroidBridge.kt:319 | app/src/main/java/com/dsharnessmobile/shell/AndroidBridge.kt:319
  ARCHITECTURE.md:15   -> ARCHITECTURE.md:15   | docs/AGENTS/ARCHITECTURE.md:15
```

所以「按行号重铺」这个动作必须回答一个问题：**我拿到的是哪个文件的行号？**
如果你的匹配条件写成 `key.startsWith('tools.ts:')`，你就是在假设
「所有以 `tools.ts:` 开头的键都属于 `plugins/dsh-android-browser/src/tools.ts`」——
而基线里 `tools.ts` 这个裸名只对应那一个文件，看似安全；但同一个脚本如果
**先算出 `ln` 再无条件用目标文件的内容覆盖**，任何键形匹配写松一点都会跨文件误改。

### 为什么

基线是**混合键形**的历史产物：早期锚点写裸名，后来规范成完整路径，迁移时两种都留着
（`migrate-anchors.mjs` 的 `onlyMatches` 注释里也记着同一件事——文档里同一个文件
常出现裸名 / 相对路径 / 全路径三种写法）。键形不唯一 ⇒ 任何「按前缀/后缀匹配」的
批量改写都天然有跨文件歧义。

### 真实后果（这条必须写清，因为它是我自己造的）

我在 rebase 后写了个脚本重铺 `tools.ts` 的锚点。它跑完 `check-code-map` 报 3 项
`anchor-content-drift`，全部指向 **`scripts/check-boot-budget.mjs`** ——
一个我**根本没碰过**的文件：

```
- [anchor-content-drift] scripts/check-boot-budget.mjs:671;
    expected ["check('④b-⑥ 行数不一致的判红理由点名截断/漏读',"], actual: "{"
- [anchor-content-drift] scripts/check-boot-budget.mjs:609;
    expected ["const run = (segText, probeOut) => runChecks({"], actual: "okOf(r, 'C1') === false, ..."
- [anchor-content-drift] scripts/check-boot-budget.mjs:681;
    expected ["{"], actual: "const c5skip = absent.results.find((x) => x.id === 'C5')"
```

排查结论（分两步，第一步的直觉是错的，值得记）：

**第一步我怀疑「`startsWith` 太松」——错。** 实测三个键形在
`key.startsWith('tools.ts:')` 下只有 `tools.ts:254` 命中，boot-budget 的键不命中。
所以匹配条件本身没问题。

**真因是跨 commit 混合了两个来源的字节。** 用同一套校验跑三个 commit 才看清：

```
d405e1c9   check-boot-budget.mjs 989 行   baseline 与自身源码 drift=0
a4f0b568   check-boot-budget.mjs 969 行   baseline 与自身源码 drift=0
f53f4be5   check-boot-budget.mjs 989 行   baseline 与自身源码 drift=0
```

**三个 commit 各自都是自洽的**（drift=0）。但 `d405e1c9` 与 `f53f4be5` 的
boot-budget 锚点值相同（989 行版本），而 `a4f0b568` 不同（969 行版本）。

拓扑是关键（`git log --graph` 实测）：

```
f53f4be5  ← 当前 main
  ↑
d9f84119
d405e1c9  ← #1219「修两条拿自报当判据」，把 boot-budget 改回 989 行
a4f0b568  ← 我当时 rebase 的基准，处在 #1219 **之前**，969 行
f68752e5
```

即 **`d405e1c9` 是 `a4f0b568` 的后代，不是祖先**。我一开始写错过这一条
（记成「d405 同时是两者的祖先」），是用 `git merge-base --is-ancestor` 核对后改的。

于是真实因果是：

1. 我在 `a4f0b568` 上 rebase（该 commit 的 boot-budget 是 969 行版本）；
2. 却用 `git checkout origin/main -- <baseline>` 取基线，而本地 `origin/main`
   跟踪 ref 指向**更新的** `d405e1c9`（boot-budget 989 行版本）；
3. 两份字节来自不同 commit ⇒ 基线里 boot-budget 的 3 个键是 989 行版本的值，
   而工作区源码是 969 行版本 ⇒ 必然 drift。

**根因一句话**：我 rebase 到 `a4f0b568`，却从 `origin/main`（指向更晚的 `d405e1c9`）
取基线字节，于是把**另一个 commit 的锚点值**写进了当前 commit 的基线。
和坑一同源：**本地跟踪 ref ≠ 你实际基于的 commit**。

修法（可复用）：只重铺目标文件的键，其余一律回填 main 版本：

```js
// 只动目标文件；其它键逐个还原成基准 commit 的值（并删掉多出来的键）
for (const key of Object.keys(base.sourceLines)) {
  const isMine = key.startsWith(TARGET + ':') || /^tools\.ts:\d+$/.test(key);
  if (isMine) continue;
  if (JSON.stringify(mine.sourceLines[key]) !== JSON.stringify(base.sourceLines[key])) {
    mine.sourceLines[key] = base.sourceLines[key];
  }
}
for (const key of Object.keys(mine.sourceLines)) {
  const isMine = key.startsWith(TARGET + ':') || /^tools\.ts:\d+$/.test(key);
  if (!isMine && base.sourceLines[key] === undefined) delete mine.sourceLines[key];
}
```

改完核对 `git diff <基准hash> --numstat`，确认只有目标文件那几行变化。
本次最终是 `20 增 / 22 删`，全部落在浏览器锚点，`CHECK-CODE-MAP PASSED`。

### 以后怎么做

1. **键形必须整键匹配，不能前缀/后缀**：

   ```js
   // 坏：任何以 tools.ts: 开头的键都算（跨文件歧义）
   key.startsWith('tools.ts:')

   // 好：整键就是 bare + ':' + 纯数字
   /^tools\.ts:\d+$/.test(key)
   ```

2. **只重铺目标文件的键，其余回填基准值**（上面那段代码）。
   这比「小心一点」可靠——它把「不该动的键」变成结构上不可能被动。

3. **基准用具体 commit hash，不用 `origin/main`**（同坑一）。

4. **改完必看 numstat**：

   ```bash
   git diff <base> --numstat
   ```

   如果出现任何你没预期的文件，**先停**，不要 push。本次就是靠这一步发现
   `check-boot-budget.mjs` 的 3 个键被写坏的。

5. **能用工具就别手写脚本**。仓库自带
   `node scripts/check-code-map.mjs --refresh-anchor-baseline --force-drift`，
   它按真实源码重算、并带 `sourceLines` 守卫（会拒绝让键数掉太多）。
   我这次手写重铺是因为该命令在有陈旧符号锚点时拒绝执行，正确做法是
   **先按它给的提示删掉那几个确认过期的符号键，再用工具跑**，而不是绕过它。

---

## 两条的共同点

**都在「我以为我在操作 A，实际数据来自 B」时发生。**

- 坑一：我以为 HEAD 是我的提交，实际是 main；我以为 `origin/main` 是当前 main，实际是旧的。
- 坑二：我以为我在重铺 `tools.ts`，实际把另一份 commit 的 boot-budget 锚点值也写了进去。

共同的对策只有一条：**动手前把基准钉死成具体 hash，动完用 `--numstat` 复核实际改了什么**。
`git log` / `git status` / `origin/main` 都是**可能过期的二手信号**，
`git diff <hash>` 和 `git diff --cached` 才是当下事实。

## 相关

- `docs/AGENTS/gotchas.md`：这两条**尚未**登记为坑位（2026-10-31 查过，
  `rebase|reflog|detached|批量重铺|anchor-baseline` 均无对应条目）。
  按 §5.1 流程，确认稳定且与个人无关后可由维护者汇总进 `gotchas.md` 文末。
- `scripts/check-code-map.mjs --refresh-anchor-baseline`：锚点基线的唯一权威刷新入口。
- `docs/AGENTS/gotchas.md`：锚点基线在纯行号位移时属构建产物，不是判据本身——
  这条口径散见于 `check-code-map.mjs` 的 `--refresh-anchor-baseline` 帮助与历次
  锚点债 PR 描述里，`gotchas.md` 中**没有**对应编号条目（本次查过），故此处不复述编号。
