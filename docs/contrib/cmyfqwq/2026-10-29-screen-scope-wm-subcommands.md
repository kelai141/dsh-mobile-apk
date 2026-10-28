# `wm` 的子命令白名单漏拦读/写真实屏（`dump-visible-window-views` / `dismiss-keyguard` / `reset`）

## 现象

`SCREEN_COMMAND_FAMILIES` 里 `wm` 那条是**子命令白名单**：

```
pattern: /\bwm[ \t]+(?:size|density|overscan|user-rotation|fixed-to-user-rotation)\b/i
```

而 `wm` 在 SDK 37 上实际有 20+ 子命令（`wm` 裸跑打印的清单）。白名单之外的一律匹配不上家族
⇒ `families.length === 0` ⇒ 无 `-d` 凭据 ⇒ **放行**。

## 真机实测（2026-10-29，小米 14 Pro / 23116PN5BC / SDK 37 / mksh）

| 命令 | RC | 实际效果 | 修前判定 |
|---|---|---|---|
| `wm dump-visible-window-views` | 0 | 65704 B 的 ZIP（`PK\x03\x04` 头），含 `com.miui.home/com.miui.home.launcher.Launcher`、`LauncherOverlayWindow:com.miui.personalassistant` 等每个窗口的 **View 层级** | `allow` |
| `wm dismiss-keyguard` | 0 | 直接 dismiss 真实屏的 keyguard | `allow` |
| `wm reset` | 0 | 无 `-d` 时重置 display 0 的 size/density/rotation 覆盖 | `allow` |
| `wm disable-blur true` | 0（uid 2000 下随后被 SecurityException 拦） | 改 `Settings.Global` 的 blur 开关 | `allow` |
| `wm scaling auto` | - | 改真实屏缩放 | `allow` |
| `wm set-letterbox-style` | - | 改真实屏 letterbox 覆盖 | `allow` |
| `wm size 900x1600` | 0 | 改真实屏分辨率 | `deny-uncertified-target`（白名单内） |

`dump-visible-window-views` 的性质与 `uiautomator dump` / `dumpsys activity top` 相同：
它把**真实屏**每个窗口的 View 树交出来，属于「读真实屏 UI」，不是「无关子命令」。

## 根因：白名单式判据会随 ROM 升版本静默失效

白名单列举的是「我知道会改屏的子命令」。这条判据的失效方向是**放行**：ROM 新增任何子命令
（本机的 `set-letterbox-style`、`set-display-windowing-mode`、`set-sandbox-display-apis`
都是近几版才有的），白名单不跟着长 ⇒ 新子命令直接落在家族之外。这与 `screencap` 加新参数、
`input` 加新命令属于同一类结构问题（见 `docs/contrib/cmyfqwq/2026-10-28-screen-scope-input-device-commands.md`）。

## 叠加上 `-d` 的绕过（这是 `wm-no-target` 存在的理由）

三个子命令**不解析 `-d`**，但门禁按 `ALL_DISPLAY_FLAGS` 认凭据 ⇒ 带一个已注册虚拟屏 token
就能把「读真实屏」洗成「已认证」：

```
wm dump-visible-window-views -d 47   -> 仍 dump 出 65702 B 真实屏窗口树（同一批窗口名）
wm dismiss-keyguard -d 47            -> RC=0，照常解锁
wm disable-blur true -d 47           -> 把 -d 47 当 blur 参数（随后 SecurityException）
```

对照：`wm size -d 47` 与 `wm reset -d 47` **确实解析** `-d`（后者真机输出
`Reset all settings for displayId=47`）⇒ 它们带已注册虚拟屏 token 属范围内操作，必须继续放行。

另：`wm -d 47 <cmd>`（前导选项）真机报 `Unknown command: -d` ⇒ `-d` 只跟在子命令之后，
判据不需要穿透前导选项。

## 修法

1. `wm` 家族改成**反向表**：除 `help` 与 `get-*`（纯查询）之外的每个子命令都进家族。
   新增子命令默认拒（fail-closed），失效方向从「放行」翻成「拒绝」。
2. 新增 `wm-no-target` 家族，把不解析 `-d` 的三个子命令按 `dumpsys` 同档恒拒
   （`targetFlags: []`）。`screenCommandVerdict` 对命中家族的每一族都要求自证，
   所以「`wm` 认可 + `wm-no-target` 恒拒」的组合结果是拒。

两层实现（`plugins/dsh-android-bridge/src/screen-scope.ts` 与 `ShellOps.kt`）逐条同源改，
跨语言 fixture 锁死。

## 反证：不误伤（同一批 fixture 里成对存在）

| 命令 | 期望 | 理由 |
|---|---|---|
| `wm get-ignore-orientation-request` | `allow` | `get-*` 只读，不改显示、不读屏内容 |
| `wm help` | `allow` | 纯帮助文本 |
| `wm`（裸） | `allow` | 无子命令时打印帮助 |
| `wm size 900x1600 -d 7` | `allow` | 已注册虚拟屏，范围内 |
| `wm reset -d 7` | `allow` | `reset` 解析 `-d` |
| `echo "wm dump-visible-window-views"` | `allow` | 引号内不执行，`stripQuotedText` 后无命令词面 |

## 判据级变异（两个判据互不干扰）

| 变异 | 红掉的用例 |
|---|---|
| 把 `wm` 反向表换回白名单 | 仅 `S-20c`（`wm reset`）、`S-20i`（`wm reset -d 7` 退化成 `deny-orphan-target-token`）、`S-20k`（`wm scaling`）、`S-20l`（`wm set-letterbox-style`） |
| 把 `wm-no-target` 的 `targetFlags` 换成 `ALL_DISPLAY_FLAGS`（等价撤掉恒拒） | 仅 `S-20e`（`wm dump-visible-window-views -d 7` 变 `allow`） |

`S-20a/b/c/d` 由 `wm-no-target` 拦，`S-20k/l` 由反向表拦 —— 两组用例各自锁一个判据，
所以换掉任一判据都只红它自己那一组。

## 判干净/不再赘述的面

- `wm shell <cmd>`：真机报 `Invalid wm shell command: screencap, -p, …`，不转发任意命令 ⇒ 不是万能入口。
- `settings put system user_rotation 1`：本机 MIUI 上不生效（`mRotation` 仍 `ROTATION_0`），
  与 `wm user-rotation` 同档「这台没生效但别的 ROM 会生效」。`settings` 面目前不在任何家族里，
  属已知未覆盖面（需要先摸清哪些 `settings` 键会改真实屏，别整类拦）。
- `/dev/graphics/fb0`：本机 `/dev/graphics/` 目录不存在，无帧缓冲可读。
