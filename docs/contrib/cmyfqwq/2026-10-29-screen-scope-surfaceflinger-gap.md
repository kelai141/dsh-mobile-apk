# `dumpsys SurfaceFlinger` 会泄漏真实屏的窗口/图层结构，但这条**不能一刀切拦**

## 现象（小米 14 Pro / SDK 37 实测，2026-10-29）

| 命令 | 输出规模 | 门禁判定 |
|---|---|---|
| `dumpsys window` | UI 结构 | `deny-uncertified-target` |
| `dumpsys activity top` | 完整 View Hierarchy | `deny-uncertified-target` |
| **`dumpsys SurfaceFlinger`** | **1476 行**，其中 190 行含 layer/window/bounds/surface | **`allow`** |
| **`dumpsys SurfaceFlinger --list`** | `RequestedLayerState{Surface(name=Task=1#35)/@0xc25ae87_transition-leash#129 z=3}` 等图层树 | **`allow`** |

裸命令里能直接读到 `Window Infos:` 段与 `Display 4630946416293825923 (HWC display 0)`，
`--list` 更是把每个窗口/任务的图层名逐条列出（`Task=1#35`、`screenFade-container#107`、
`OneHanded:0:23#4`…）。从「真实屏结构」的口径看，这与 `dumpsys window` 同级。

## 为什么不能直接把它加进 `dumpsys` 家族

`screen-scope-cases.json` 里已经有一条**刻意 allow** 的用例：

```json
{
  "name": "对照 SF 反查命令自身必须放行",
  "command": "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'",
  "expect": "allow",
  "why": "这是范围判定用来核对 SF token 的命令（含引号内的 |）。若它被自己的门拦死，
          token 集合恒空 ⇒ 已注册虚拟屏也被拒（比不修更糟）…"
}
```

这条命令正是 `plugins/dsh-android-manage/src/vd-shot.ts` 的 `parseVirtualDisplayTokens` 所依赖的
输入源（`resolveVirtualDisplayToken` 拿不到 token 就必须 fail-closed，虚拟屏截图整条路径不可用）。
把 `surfaceflinger` 加进 `dumpsys` 家族的 pattern ⇒ 这条自证命令当场被自己的门拦死。

## 为什么「只放行带 grep 的形态」也做不到

看似可以写成「`dumpsys SurfaceFlinger` 后面没跟 `| grep` 就拒」，但**架构上做不到**：
`screenCommandVerdict` 判定的是 `splitCommandSegments` 切段后的**单段**（`bare`），
`dumpsys SurfaceFlinger | grep …` 切完是两段 —— 第一段里根本看不到后面有 `| grep`。
要让段级判据知道管道另一端是什么，就得把切段信息传进门禁，那是判据面的结构改动，
不是加一条正则。

## 现在的状态与建议

- **保持现状**（`allow`），把这条记为**已知缺口**而不是当场修；
- 真正要收口的话，方向是「让门禁看见管道」——把切段结果（段数、各段文本）一并传进
  `screenCommandVerdict`，这样「仅当后续段是精确的 SF token 反查 grep 时放行」才可判；
- 在那之前，`dumpsys SurfaceFlinger --list` / `--proto` 这类**明确列图层**的形态仍是敞口；
  它们不与自证命令冲突，可以单独拦，但单独拦 flag 形态属于「枚举式白名单」，按本项目已
  反复验证的经验，枚举必漏（`--latency`、未来的新 flag），收益不抵风险。

## 复现

```bash
adb -s <serial> shell "dumpsys SurfaceFlinger 2>&1 | wc -l"            # 1476
adb -s <serial> shell "dumpsys SurfaceFlinger 2>&1 | grep -icE 'layer|window|bounds|surface'"  # 190
adb -s <serial> shell "dumpsys SurfaceFlinger --list 2>&1 | head -5"
node -e "import('./plugins/dsh-android-bridge/lib/screen-scope.js').then(m=>console.log(m.screenCommandVerdict('dumpsys SurfaceFlinger --list', ()=>false)))"  # allow
```

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

