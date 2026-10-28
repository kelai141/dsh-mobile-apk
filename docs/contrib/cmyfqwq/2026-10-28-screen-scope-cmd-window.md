# `cmd window` 是 `wm` 的等价拼写：改真实屏分辨率却放行

## 现象

屏幕范围门禁的家族表只认 `wm size|density|overscan`，不认它的等价拼写：

```
screenCommandVerdict("cmd window size 1080x2400")   -> allow
screenCommandVerdict("cmd window user-rotation lock 1") -> allow
screenCommandVerdict("cmd display set-brightness 100")  -> allow
screenCommandVerdict("wm user-rotation lock 1")     -> allow
```

## 真机实测（小米 14 Pro / SDK 37，2026-10-28）

```
cmd window size 900x1600            -> 真实屏变成 Override size: 900x1600（wm size reset 才恢复）
cmd window size 900x1600 -d 7       -> 被接受（返回 Physical size: 0x0，7 号屏不存在）
wm user-rotation lock 1             -> RC=0，但 mRotation 恒定 ROTATION_0（MIUI 忽略）
cmd display set-brightness 100      -> 能改真实屏亮度（目标屏参数是 --id，不是 -d）
cmd uinput                          -> cmd: Can't find service: uinput（这条路不存在，排除）
```

`cmd window size` 那一行是**真的改动了真实屏**（`Physical size: 1440x3200` → `Override size: 900x1600`），
实验后用 `wm size reset` 恢复。

## 与既有缺陷同一型

`am start` 与 `cmd activity start` 是等价拼写，此前只认 `am` ⇒ 整类放行（那次的注释原文：「只认 `am`
会把这条等价拼写整类放行（2026-10-28 自查）」）。`wm` 与 `cmd window` 是同一个关系的另一对。

## 修法（两侧同批）

| 家族 | pattern | targetFlags | 理由 |
|---|---|---|---|
| `cmd-window` | `\bcmd[ \t]+window\b` | `ALL_DISPLAY_FLAGS` | 它的目标屏参数是**子命令内**的 `[-d DISPLAY_ID]`（实测 `cmd window size 900x1600 -d 7` 被接受）；门禁按全文扫 options，所以带已注册虚拟屏 id 时仍能自证 ⇒ 放行 |
| `cmd-display` | `\bcmd[ \t]+display\b` | `[]` | 它用 `--id DISPLAY_ID`，不在 `ALL_DISPLAY_FLAGS` 里、也不是 `ScreenTarget` 的两种 id 空间之一 ⇒ 无法自证，与 `dumpsys` 同档恒拒 |
| `wm`（扩） | `\bwm[ \t]+(?:size|density|overscan|user-rotation|fixed-to-user-rotation)\b` | `ALL_DISPLAY_FLAGS` | `user-rotation` 在本机 MIUI 未生效，但判据看的是**命令能否操作真实屏**，不是这一台有没有生效（别的 ROM 会真转屏） |

壳侧同批补面向用户的家族清单文案（`ShellOps.kt` 的 `__error`）。

## fixture 82 → 87

| 用例 | 命令 | 期望 |
|---|---|---|
| S-16a | `cmd window size 900x1600` | `deny-uncertified-target` |
| S-16b | `cmd window size 900x1600 -d 7` | `allow`（`-d` 在子命令内，仍能自证） |
| S-16c | `cmd display set-brightness 100` | `deny-uncertified-target` |
| S-16d | `wm user-rotation lock 1` | `deny-uncertified-target` |
| 对照 | `wm size 900x1600 -d 7` | `allow` |

最后一条对照是故意的：扩大 `wm` 的子命令表时**不能顺手把虚拟屏路径也拦掉** —— `wm size … -d 7` 原本
就靠 `-d` 自证，行为必须保持不变。

## 复验证据

- 引擎侧：`node --test plugins/dsh-android-bridge/test/screen-scope.test.mjs` → **47 pass / 0 fail**
- 壳侧：`:app:testDebugUnitTest --tests '*ShellOpsScreenCommandFixtureTest*' --rerun-tasks`
  → XML 报告 **tests 10 / failures 0**（87 条 fixture 逐条比对）
- **变异反证（引擎）**：删 `cmd-window` 家族 ⇒ **46 pass / 1 fail**；回滚 47/0
- **变异反证（壳侧）**：删 `cmd-display` 家族 ⇒ `everyFixtureCaseMatchesTheKotlinVerdict` **FAILED**，
  报错原文 `命令：cmd display set-brightness 100 expected:<deny-uncertified-target> but was:<allow>`
- 门禁：`gen-screen-scope-fixture` 一致、`check-kotlin-comments` / `check-code-map` PASSED

本轮把「跑 Kotlin 单测」的姿势也钉死了：必须用**真实类名**过滤 + `--rerun-tasks`，并**读 XML 报告的
tests 数**才算绿（`--tests '*ScreenScope*'` 匹配不到任何类，会 0 测试却 BUILD SUCCESSFUL）。

## 已知边界

1. **没逐子命令核验 `cmd window`**：家族按整词纳入，`size/density/scaling/user-rotation/dismiss-keyguard`
   都在射程内。`cmd window dump-visible-window-views` 这类只读子命令也一并恒拒 —— 与 `dumpsys window`
   同口径（读窗口内容同样属于「读真实屏」），但确实比「只拦改屏子命令」更宽。
2. `cmd display` 用 `--id` 的形态没有做成可自证的口子：要支持 `cmd display … --id 7` 需要把 `--id`
   纳入目标屏凭据，但 `--id` 太泛（很多命令都叫 `--id`），本轮不做。
3. `settings put system user_rotation` 实测在 MIUI 上不生效（与 `wm user-rotation` 同），本轮未纳入；
   若要纳入应连带确认别的 ROM 行为。
4. `cmd SurfaceFlinger capture` / `service call SurfaceFlinger …` 仍 `allow`，但同机实测
   `service call SurfaceFlinger 1008` 返回 `Operation not permitted` ⇒ 走不通，未立项。
