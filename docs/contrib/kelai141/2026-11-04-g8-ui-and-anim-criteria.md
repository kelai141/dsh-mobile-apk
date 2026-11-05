# #1525 + #1527 + #1524 + #1526 四条判据/口径缺陷：把「源码文本断言」换成行为断言，把「字符串取值」换成数值取值

四条 issue 都是同一类病：**判据或取值与实现结构同构，与用户可见行为脱钩**。
两条是「回归用例读源码文本」（#1525 / #1527 的回归判据），两条是「把字符串当取值」
（#1524 的族名比较、#1526 的动画倍速回读）。前两条的交付物是**行为用例**，
后两条要先改实现再让用例真的能红。

## #1525：touchcancel 的回归判据读源码切片

- **缺陷形态**：`composer-sheet-touchcancel.spec.ts` 读 `src/client/mobile/composer-sheet.ts`
  的文本，断言 `touchcancel` 绑在 `onSheetTouchCancel`、且从该函数起 800 字符窗口里
  没有 `this.close()`。把 `close()` 从取消处理器挪进它调用的 `settleTo()`（issue 给的复现路径），
  窗口里确实不再出现那句话，用例照旧绿，而用户仍然会在来电/通知下拉之后丢掉面板。
- **修法**：改成派发合成触摸序列的 jsdom 行为用例（3 条）：
  下拉越过关闭阈值后 `touchcancel` ⇒ 遮罩仍是**同一块节点**、phase 回到 peek、高度回到 peek、
  translateY 归零、拖拽标记摘掉；同一手势序列把收尾换成 `touchend` ⇒ 必须关
  （证明上一条不是「怎么都不关」）；expanded 态下取消 ⇒ 吸附回 expanded（落点按取消前形态算）。
- **负控**：① 把 `this.close()` 挪进 `settleTo()` ⇒ 用例 1 红；② 把 `touchcancel` 重新绑到
  `onSheetTouchEnd`（#1378 原缺陷）⇒ 用例 1 红；③ 取消时恒吸附 peek ⇒ 用例 3 红。

## #1527：`busy` 在 detach 时不复位，重挂后「添加 N 项」永久失效

- **真因**：`busy` 只在 `addSelected` 的 finally 里复位，`detach()` 走 `clearState()` 不碰它。
  在途时关面板（每项最长 1500+600ms）再 re-attach，`onMenuClick` 的 `if (this.busy) return`
  挡掉每一次点击；而底部条是 clearState 撤掉、re-attach 后**新建**的按钮 ——
  新按钮 enabled、无 aria-busy，「按钮看着能用、点下去什么都不发生」。
- **修法**：`detach()` 里复位 `busy` 并 `syncBusy()`；同时加**代次守卫**
  （`generation`，detach 时 +1）：旧插入链的 finally 只收自己那条链的尾，
  否则旧链收尾会把新链的在途标志抹掉，双击又能起第三条链 —— #1404 的重复插入原样复发。
- **用例**（`reference-menu-detach-busy.spec.ts`）：造出在途窗口（按钮 disabled + aria-busy）→
  detach → attach → 新按钮 enabled 无 aria-busy → 点下去上游 settle-pick **真的被再次驱动**
  → 旧链收尾后新链仍在途。
- **负控**：① 去掉 detach 里的复位 ⇒ 「重挂后点击必须驱动上游」红；② 去掉代次守卫
  （finally 无条件复位）⇒ 「旧链收尾不得复位新链」红。

## #1524：预发布族名按字典序比较

- **缺陷形态**：`comparePrerelease` 里 `if (a.first != b.first) return a.first > b.first` ——
  先后由字母位置**偶然**决定（sn > rc > preview）。当前发布线碰巧对得上，
  但新增后缀（beta / alpha / dev）会按字母位置插进任意位置。
- **修法**：显式族序表 `PRERELEASE_FAMILY_RANK = {preview: 0, rc: 1, sn: 2}`，
  抽出 `internal fun prereleaseFamilyIsNewer(a, b)`。未登记族退回字典序：
  该分支今天不可达（`prereleaseOf` 只认白名单），它的作用是把「白名单加了新族名、
  族序表忘了加」那天的行为钉成**旧口径**——静默改变现网比较结果比维持历史行为更危险。
- **用例**：跨族三组（preview/rc、rc/sn、preview/sn）双向 + 大小写不敏感；
  直接单测 `prereleaseFamilyIsNewer`（经 `isNewer` 走不到兜底分支）。
- **负控**：把表里 preview 与 rc 对调 ⇒ 3 条跨族用例红。

## #1526：env_prepare 的动画回读用字符串等值

- **缺陷形态**（两条）：① 回读 `now[k] === '1'` / `=== '0'`：ROM 回 `1.0` 或读通道缺席时
  真成功也进 `notDone`，`env_prepare` 整条返回 ok=false（假失败），且「读不到」与
  「没写进去」压成同一句；② 恢复写常量 1：`restoreAnimScales({})` ⇒ 一律写 '1'，
  用户自设的 0.5 / 10 被静默抹成默认值。
- **修法**：抽出 `src/anim-scales.ts`（`parseAnimScales` / `animScaleMatches` /
  `checkAnimScales` / `animRestoreValues` / `checkAnimRestore` / `animDisableVerdict` /
  `animRestoreVerdict` / `serializeAnimState` / `parseAnimState`）：
  取值按**数值**等值；读不到与不等于**分开报**；恢复写回**准备前读到的原值**，
  原值未知才退 1 并在回执里点名。原值落盘到 `DSH_FILES_DIR/anim-scales.json`
  （关与恢复是两次独立调用，内存里的原值活不过引擎重启/会话切换）。
- **用例**（重写 `test/env-prepare-anim-restore.test.mjs`）：驱动 `apply()` 注册的真工具，
  用假 priv 面喂回读形态，只断言回执与真正写给设备的键值表。夹具**复现 ROM 的浮点回显**
  （写 0 → 读回 0.0）——这正是原用例绿着的真因：不复制这个形态，字符串等值缺陷在夹具里不显形。
- **负控**：① `animScaleMatches` 改回字符串等值 ⇒ 4 条红；② 恢复写回常量 '1' ⇒ 原值用例红；
  ③ 把「读不到」并进「未生效」⇒ 文案区分用例红。

## 门禁

- `testDebugUnitTest` 全量通过（Kotlin 12 例在本类，含新增 3 例）；
  `check-kotlin-test-count` PASSED。
- `dsh-client-ui-responsive` vitest 76 文件 / 1146 例全通过。
- `plugins/dsh-android-manage` `npm test` 197 例全通过。
- `check-code-map` PASSED（新增 `anim-scales.ts` 进覆盖账本 + P02 行；
  `index.ts` 的 42 条 `#expect` 锚点按内容重铺）。
- `check-kotlin-comments` PASSED。

## 未做设备验证

四条都是代码级判据/口径修正，交互路径（手势取消、菜单重挂、动画倍速）的真机形态
**未做设备验证**——本机 `adb devices` 为空。进入发版候选前须补 §2.1 三层验收。
