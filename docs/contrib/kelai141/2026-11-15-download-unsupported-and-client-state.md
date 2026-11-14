# 下载页不支持态与两条前端状态缺陷（#1606 / #1585 / #1570）

三条都在**状态判据**上，不在文案上。共同形态：判据算的是「看起来像」而不是「真的是」，
于是缺陷在界面完全正常的情况下发生（AGENTS.md §2.1 第 2 条第 2、4 类）。

## #1606 下载页：明确不支持的设备仍给「更换架构」按钮，一点就进下载分支

**现象**：32 位 x86 / mips 设备访问下载页，页面正确显示「当前设备暂不支持」，但下方**还有**
「更换架构」按钮；点下去页面变成下载按钮，用户下到 160 MB 装不上的包，
安装时 `INSTALL_FAILED_NO_MATCHING_ABIS`。

**真因**：`render()` 末尾那条追加语句在 if/else 链**之外**：

```js
if (!asset) body.innerHTML += routeMarkup() + '<div class="architecture"><button id="switch-abi">…'
```

不支持态与「已支持但该版本没这个资产」态都满足 `!asset`，两个分支被同一条件合并。
而 `switch-abi` 的处理器在 `!c.abi` 时把架构**硬写**成 `arm64/likely`，于是从不支持态
被拉回下载分支 —— 判据（`!asset`）与状态（`confidence`）不是同一件事。

**修法**：追加条件加 `c.confidence !== 'unsupported'`；不支持态改为给「全部版本」出口；
`switch-abi` 处理器再加一道「不支持态直接 return」的兜底（防止别处把按钮重新送进 DOM）。

**判据**：`webpages/tests/unsupported-device.test.mjs` 用一个最小 DOM 真实 import 页面模块，
断言不支持态**没有** `switch-abi`、**没有**任何 `releases/download/` 直链、**有一点得下去**的出口；
另配两条反证（arm64 手机 / 桌面未知）确保修复没把功能一起删掉。修前实测：
`switch-abi` 存在（断言红），修后三条全绿。

## #1585 分屏键条：先挂的先卸，后挂的那条失去全部 CSS

**现象**：分屏两个终端，每条各有一条九键条。关掉左边那栏后，右边那条**仍在**但样式全丢
（布局崩、底部留白失效，看到一排裸按钮）。

**真因**：`ensureStyle()` 只看「`<style>` 在不在」：

```ts
if (existing !== null) return () => {}   // 后来者拿到空 disposer
return () => { style.remove() }          // 创建者的 disposer 无条件删
```

后来者拿到空 disposer，创建者的 disposer 却无条件 `remove()`。**创建者身份**与**是否还有
使用者**在这里被混为一谈 —— A 先死就把 B 还需要的样式带走了。

**修法**：按 document 维度做引用计数（`WeakMap<Document, { style, holders }>`），归零才 remove。
没有采用「dispose 时数还剩几个 `[data-terminal-keybar]`」：键条 DOM 与句柄生命周期不是一回事
—— 根节点被 React 摘掉时 `reconcile` 会先 `bar.remove()` 再自愈挂回，那一瞬 DOM 计数为 0 却
不该清样式。

**判据**：`test/keybar-mount.test.mjs` 新增「先挂先卸、后挂仍活」，另配两条反证
（反过来那一侧、最后一个持有者卸载后必须清掉，防泄漏）。原有用例只覆盖「先挂后卸」那一侧，
永远走不到出问题的一侧。修前实测该用例红，修后 39/39 绿。

## #1570 来件草稿：冷启动 20s 就把条目判死

**现象**：冷启动（引擎刚起来、会话作用域还没绑上）时从别的应用分享文件进来，
第 20 秒之后文件彻底消失，也没有任何提示。

**真因**：`hydrate()` **最开头**无条件 `exhaustedFor(item)` +1，而 hydrate 有三条**非失败**出口：

- `session-refresh-deferred`（刷新失败但可重试）
- `scope-deferred`（`sessionScope` 还没就绪）
- `createSession` 暂时拿不到工作区/创建失败

冷启动时 `sessionScope` 前几拍常是 undefined，5 拍 × 4000 ms = 20 s 就耗尽
`MAX_HYDRATE_ATTEMPTS`，第 6 拍起直接 return 永不再试。**「还没轮到」被当成了「失败了」。**

连带面（同一逻辑改动，不可拆）：判死处的提示只在 `scope !== undefined` 时发会话级 notify，
而没有 scope 恰是判死的常见前提 ⇒ 提示也发不出去，用户侧完全静默。

**修法**：

1. 失败预算只在**真实动作失败**时消耗：`createBlankSessionFor` 返回 undefined、claim 为空、
   content/attach 抛错。`scope-deferred` 走**独立的** `MAX_SCOPE_DEFERRALS`（30 拍 ≈ 2 分钟）。
2. 判死收敛到 `giveUp()`：有会话走会话级 notify，没有会话走 `reportUserFacingResult`
   （与导出结果同一条全局可见通道），不再静默。
3. 已判死的条目每拍只回报 `exhausted` 标记，不再发起真实动作。

**判据**（`tests/incoming-draft.spec.ts`）：

- 正控：`sessionScope` 连续 8 拍 undefined 不得判死，第 9 拍绑上后条目必须仍能投递。
- 负控：真正 claim 且持续失败时**仍必须**在 5 次内封顶并收敛（不得因为改了计次就变成无限重试）。
- 无 scope 时「已停止重试」必须可见。

修前实测：前两条红（`第 6 拍不得判死: expected 'exhausted' not to be 'exhausted'`），修后 34/34 绿。

## 判据纪律

三条都遵守「修前必红、修后必绿」：把实现用 `git checkout -- <file>` 退回缺陷形态，
用**最终版测试**再跑一遍确认变红，然后恢复（`Copy-Item` 备份还原），`git diff --stat` 复核改动仍在。
本仓 `git stash` 是全仓共享的，负控**不得**用它。

## 未做设备验证

三条都属 UI/UX 层，按 AGENTS.md §4.2 需即时模拟器三层。本轮无人值守，**只做了代码层**：

- 代码层：上述三套用例 + 全量套件（webpages 62/62、vdisplay 156/156、client-ui 1358 passed）。
- CDP 层 / ADB 用户层：**未做**。补验点见 PR 描述。
