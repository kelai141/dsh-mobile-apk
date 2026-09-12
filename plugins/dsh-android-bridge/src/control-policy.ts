/**
 * 设备控制通道策略（0.13.5 W4，PRD-0.13.2 §3.3 B2/B3 + HANDOVER-0.13.3 §196）。
 *
 * 两个后端：
 *   - `a11y` 无障碍通道（壳侧 AccessibilityService）：语义树 + performAction，
 *     需要用户显式开启无障碍服务；**这是「一次系统开关」就能用的轻量通道**；
 *   - `adb` 设备级通道（既有通道）：uiautomator dump + input，需要 ADB 三道人门，
 *     保留给 shell 执行、原图截图、系统面（pm/dumpsys）等高级场景。
 *
 * 不变量（fail-closed）：
 *   - 会话档位不是 danger-full-access → 两个后端都拒绝（隐私敏感面不因通道简化而放宽）；
 *   - a11y 未开启且 ADB 门未齐 → 拒绝并给出可执行的引导；
 *   - 策略是纯函数，便于单测；调用方（工具层）必须使用它的结论，不得自行旁路。
 */

// 0.13.8 收口 longClick：壳侧 handle 的 `longClick` 分支此前未进本类型联合与 A11Y_OPS，
// 于是 a11y 在线时落 `A11Y_OPS.includes` 判假 → 「暂不支持」deny（坑 52 的存量 leak）。
//
// 0.14.0-preview 六面登记：op 名先冻结在两份插件契约里——侧栏 AI 浏览器宿主
// （plugins/dsh-android-browser/src/contract.ts 的 BROWSER_OPS，10 条）与虚拟屏
// （plugins/dsh-android-vdisplay/src/status.ts 的 VD_OPS，5 条）。本联合按契约逐字登记。
// **这 15 条一条都不进 A11Y_OPS**：契约标注 neverA11y（browser*/vd* 是壳桥 op，不经无障碍通道，
// 方案 §4.5），永久豁免登记在 scripts/control-ops-known-gaps.json（faces: A11Y_OPS）。
// 六面登记链由 scripts/check-control-ops.mjs 守：壳侧 handle 分支 + SUPPORTED_OPS（dev-shell2
// 同批）、本联合、ROUTE_OPS（诊断面子集）、manage 工具面。**只落引擎侧不落壳侧必红**
// （ControlOp == SUPPORTED_OPS 差集非空），这是 REV-E 的实测结论，不是误报。
//
// **ROUTE_OPS 刻意不补这 15 条（裁决留档，勿在下一轮「顺手补齐」）**：ROUTE_OPS 不是路由清单，
// 而是 android_privilege_status 里的**后端诊断**面——它逐 op 调 decideControl 打印
// backend / reason / alternative。browser* 与 vd* 是 neverA11y，可它们实际由**同一个 a11y 服务的
// handle 分支**承载；一旦列进 ROUTE_OPS，a11y 在线时诊断面就会输出「无障碍通道暂不支持操作 X」
// 与「该操作请用 ADB 通道」这类**错误指引**（而它们既不进 A11Y_OPS 也不走 ADB）。
// 若将来要让它们出现在诊断面，先解开这个语义矛盾（要么承认它们是 a11y 承载、要么给出独立后端），
// 再同批改 ROUTE_OPS；ROUTE_OPS ⊂ ControlOp 的约束在两种做法下都成立，门禁不会替你做这个判断。
export type ControlOp = 'snapshot' | 'click' | 'longClick' | 'setText' | 'scroll' | 'global' | 'screenshot' | 'state'
  | 'nodeText' | 'webSnapshot' | 'webAction'
  | 'browserCaps' | 'browserShow' | 'browserHide' | 'browserOpen' | 'browserJs'
  | 'browserInput' | 'browserShot' | 'browserState' | 'browserSetUa' | 'browserViewport'
  | 'vdCreate' | 'vdDestroy' | 'vdLaunch' | 'vdMoveTask' | 'vdInfo'

export interface ControlPolicyInput {
  op: ControlOp
  /** 壳侧无障碍服务已连接（live prefs 的 a11yEnabled）。 */
  a11yEnabled: boolean
  /** 既有 ADB 三道人门是否齐备（fullAccess && allowSwitch && paired && wirelessDebug）。 */
  adbReady: boolean
  /** 会话档位（sandboxPolicy.resolve({session}).mode）。 */
  sessionMode?: string
  /** 强制后端（调试/回退用）；缺省按可用性自动选择。 */
  forceBackend?: 'a11y' | 'adb'
}

export interface ControlDecision {
  backend: 'a11y' | 'adb' | 'deny'
  reason: string
  /** 拒绝时给用户/模型的下一步引导。 */
  guidance?: string
}

export const REQUIRED_SESSION_MODE = 'danger-full-access'

/** a11y 通道能覆盖的操作：五个语义操作 + 截屏（API 30+，见 A11Y-CONTROL-DESIGN.md §2.2）
 *  + `state`（便宜的状态读数：快照代次/失效标记，供点击生效校验，issue #129）
 *  + `webSnapshot`/`webAction`（issue #128 L1：自有 WebView 的 DOM 语义快照与动作——
 *  与 a11y 共用同一队列/心跳，壳侧在页面不在场时明确报错）
 *  + `longClick`（0.13.8 收口：壳侧 handle 的 `longClick` 分支就是
 *  `AccessibilityService` 的 ACTION_LONG_CLICK 优先 + 手势按住兜底，本属 a11y 可承载操作；
 *  漏登记 = a11y 在线时长按被 deny。六处登记链由 scripts/check-control-ops.mjs 守）。
 *  **browser\* / vd\*（15 条）刻意不在此列**：契约 neverA11y，见上方 ControlOp 注释与
 *  scripts/control-ops-known-gaps.json 的永久豁免。 */
export const A11Y_OPS: readonly ControlOp[] = [
  'snapshot', 'click', 'longClick', 'setText', 'scroll', 'global', 'screenshot', 'state', 'nodeText', 'webSnapshot', 'webAction',
]

export function decideControl(input: ControlPolicyInput): ControlDecision {
  if (input.sessionMode !== REQUIRED_SESSION_MODE) {
    return {
      backend: 'deny',
      reason: `会话档位为 ${input.sessionMode ?? '未知'}，设备控制面要求 ${REQUIRED_SESSION_MODE}`,
      guidance: '在会话底部的权限芯片里切到「完全权限」后重试（设置 → 通用设置 → 新会话默认权限模式 也可改默认；'
        + '无障碍通道同样受此门约束）。这是用户侧的一次点击，工具无法自行提权。',
    }
  }

  if (input.forceBackend === 'adb') {
    return input.adbReady
      ? { backend: 'adb', reason: '已显式指定 ADB 通道' }
      : {
        backend: 'deny',
        reason: '显式指定 ADB 通道，但 ADB 三道人门未齐',
        guidance: '打开「手机管理」授权页，依次完成完全访问 / 授权开关 / 无线调试配对。',
      }
  }

  if (input.a11yEnabled) {
    if (A11Y_OPS.includes(input.op)) return { backend: 'a11y', reason: '无障碍服务已开启，优先走无障碍通道' }
    return {
      backend: 'deny',
      reason: `无障碍通道暂不支持操作 ${input.op}`,
      guidance: '该操作请用 ADB 通道（android_adb_shell_exec / 截图等）。',
    }
  }

  if (input.forceBackend === 'a11y') {
    return {
      backend: 'deny',
      reason: '显式指定无障碍通道，但无障碍服务未开启',
      guidance: '到系统设置 → 无障碍 → 已下载的服务里开启「DSH 设备控制」。',
    }
  }

  if (input.adbReady) return { backend: 'adb', reason: '无障碍服务未开启，回退到 ADB 通道' }

  return {
    backend: 'deny',
    reason: '无障碍服务未开启，且 ADB 三道人门未齐——设备控制不可用',
    guidance: '任选其一：① 系统设置 → 无障碍 → 开启「DSH 设备控制」（推荐，一次开关）；'
      + '② 打开「手机管理」授权页完成 ADB 三道人门（完全访问 + 授权开关 + 无线调试配对）。',
  }
}
