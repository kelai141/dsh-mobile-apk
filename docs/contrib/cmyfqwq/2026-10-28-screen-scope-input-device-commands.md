# 直接读写 input 设备的命令（`sendevent` / `getevent`）绕过真实屏门禁

## 现象

屏幕范围门禁（virtual-only）的命令词家族表里没有 `sendevent` / `getevent`：

```
screenCommandVerdict("sendevent /dev/input/event1 3 57 1")            -> allow
screenCommandVerdict("su -c 'sendevent /dev/input/event1 0 0 0'")    -> allow
screenCommandVerdict("getevent -lt /dev/input/event1")               -> allow
```

`su -c` 的载荷本来就会被门禁展开重扫（`su` 在解释器包装名单里），扫到 `sendevent` —— 但它不在任何
家族里，于是整条放行。

## 真机实测（小米 14 Pro / SDK 37，2026-10-28）

```
shell 直写 /dev/input/event2                    -> sendevent: Permission denied（RC=1）
printf '' >> /dev/input/event2                  -> can't create ... Permission denied（RC=1）
su -c 'sendevent /dev/input/event1 0 0 0'       -> ROOT_RC=0        ← 设备已 root 时真能写
getevent -p                                     -> 能列出全部输入设备并读事件
service call SurfaceFlinger 1008                -> Operation not permitted（这条路不通）
```

也就是说：**普通 shell 写不进去，root 通道能写**。而 `sendevent` 的唯一用途就是向 input 设备注入事件
（含 `ABS_MT_POSITION_X/Y` 触摸坐标 + `SYN_REPORT`）⇒ 在已 root 的设备上，模型可以绕过
`input tap` 的目标屏判据，直接对**真实屏**注入触摸。

`getevent` 反向：能读回用户正在触摸/按键的设备事件（不含屏幕像素，但属「读真实屏交互」）。

## 修法

两侧同批新增两个 `targetFlags: []` 家族 —— 与 `uiautomator`、`dumpsys window|display|input` 同档：

- `{ name: 'sendevent', pattern: /\bsendevent\b/i, targetFlags: [] }`
- `{ name: 'getevent', pattern: /\bgetevent\b/i, targetFlags: [] }`

理由不是「这两个命令危险」，而是**它们没有目标屏参数** ⇒ 永远自证不了「作用于已注册虚拟屏」；
门禁的放行条件是「命令里显式指定的目标屏能对上注册表」，无参数即无凭据 ⇒ 恒拒。

壳侧同批把那句面向用户的拒绝文案里的家族清单补上这两个名字（`ShellOps.kt` 的 `__error`），否则提示
里列的家族与实际判据不一致 —— 用户照着提示排查会漏掉一条路。

## fixture

82 → **86** 条：

| 用例 | 命令 | 期望 |
|---|---|---|
| S-15a | `sendevent /dev/input/event1 3 57 1` | `deny-uncertified-target` |
| S-15b | `su -c 'sendevent /dev/input/event1 0 0 0'` | `deny-uncertified-target` |
| S-15c | `getevent -lt /dev/input/event1` | `deny-uncertified-target` |
| 对照 | `ls -l /dev/input` | `allow` |

最后一条对照是有意的：判据是**命令词**，不是「路径里有没有 `/dev/input`」—— 列目录既不注入也不读
事件，必须放行，否则就是一个新的误拦面。

## 复验证据

- 引擎侧：`node --test plugins/dsh-android-bridge/test/screen-scope.test.mjs` → **47 pass / 0 fail**
- 壳侧：`:app:testDebugUnitTest --tests '*ShellOpsScreenCommandFixtureTest*'` → **10 tests / 0 failures**
  （该测试逐条比对 86 条 fixture 的 verdict，两侧任一漂移立刻红）
- **变异反证 1**（引擎）：删掉 `sendevent` 家族 ⇒ **46 pass / 1 fail**
- **变异反证 2**（壳侧）：删掉 `getevent` 家族 ⇒
  `everyFixtureCaseMatchesTheKotlinVerdict` **FAILED**，报错原文
  `命令：getevent -lt /dev/input/event1 expected:<deny-uncertified-target> but was:<allow>`
  ⇒ 两侧都真的被 fixture 钉住了（不是只测了引擎那半边）
- 门禁：`gen-screen-scope-fixture` 一致、`check-kotlin-comments` / `check-code-map` PASSED

## 已知边界

1. **没做完整的 MT 协议点击注入**。已证的是「root 下能向 `/dev/input/eventN` 写入（`sendevent … 0 0 0`
   返回 0）」，而 `sendevent` 的语义就是注入 input 事件；真按 `ABS_MT_*` 序列点一下屏幕会实际改变
   设备 UI，本轮没有做（也不必要：门禁要挡的是「无目标屏凭据」，与能否一次点准无关）。
2. `sendevent`/`getevent` 在**非 root** 下不可用（实测 Permission denied），所以这条绕过以「设备已
   root 且 su 已授权」为前提。`su` 本身早就在解释器包装名单里（`su -c` 载荷会展开），所以前提成立
   时这条链是通的。
3. `getevent` 读到的是**输入事件**而不是屏幕像素。它被纳入的理由是「无目标屏参数 ⇒ 无法自证」，与
   `dumpsys window|display|input` 同一口径（那条也只读元数据）。
4. 反方向的误拦代价：任何命令里出现 `sendevent`/`getevent` **整词**都会被拒（例如
   `logcat -d | grep sendevent`）。这与既有家族一致（`echo screencap` 同样会被拒），不是新引入的
   行为模式。

## 未做设备验证

本 PR 的判据改动两侧都有 fixture 逐条钉住（引擎 47 pass、壳侧 10 tests / 0 failures），且**上面的真机
实测是修复前的探针证据**；修后没有重新跑设备侧截图（判据是纯文本层面，不产生新的设备行为）。
按 AGENTS.md §4.2 用「两侧单测 + 双向变异反证 + 真机探针」作为该档证据。本机（10GB 飞牛）不具备
模拟器条件（起 AVD 会 OOM）。
