// @vitest-environment jsdom
// issue #1476：Shizuku「通道就绪」必须有**功能证据**，不能只看 binder 代理活着。
//
// 缺陷形态（用户可见）：设置页「手机权限」显示「Shizuku 可用 / 已就绪」，诊断也写
// `Shizuku is ready; next: nothing to do`，而所有依赖 shell 身份的功能一致失败于
// `the Shizuku shell service did not start within 30 s`。
//
// 壳侧已经改成「binder 活 + 已绑定 + 功能探测成功」才算就绪，并把结论落在 readyState 上；
// 但 UI 此前只看 `bound`，于是照旧复述那个错误结论。本文件锁死 UI 侧这条判据。
//
// 判据取向：**行为断言**，不是「接口里有这个字段」。删掉 label/hint 里的 readyState 分支，
// 下面每一条都必须变红。
import { describe, it, expect } from 'vitest'
import {
  parseShizukuReadyState,
  readShizuku,
  shizukuStateLabel,
  shizukuStepHint,
} from '../src/client/dev-section/phone-control.tsx'

/** 一个 binder 已连上的基线状态（bound=true 是最容易骗过旧判据的形态）。 */
const bound = {
  readable: true,
  installed: true,
  running: true,
  granted: true,
  bound: true,
  binding: false,
  guidance: '',
}

describe('issue #1476：就绪必须有功能证据，binder 活不等于可用', () => {
  it('功能探测失败时必须报「用户服务不可用」，不得报「通道就绪」', () => {
    const label = shizukuStateLabel({ ...bound, readyState: 'not-ready', probeError: 'timeout' })
    expect(label).toBe('已授权，用户服务不可用')
    // 反面：这条断言的价值全在「不能等于就绪」——把它单独写出来，改回旧行为时红得更直白。
    expect(label).not.toBe('通道就绪')
  })

  it('探测未完成（unknown）不得判就绪，也不得判失败', () => {
    const label = shizukuStateLabel({ ...bound, readyState: 'unknown' })
    expect(label).toBe('已授权，正在验证通道')
    expect(label).not.toBe('通道就绪')
  })

  it('只有 ready 才允许说「通道就绪」', () => {
    expect(shizukuStateLabel({ ...bound, readyState: 'ready' })).toBe('通道就绪')
  })

  it('旧壳没有 readyState 时必须退回旧的 bound 口径，不得永久卡在探测中', () => {
    // 缺席 ≠ unknown：老壳上根本没有这条判据，UI 把缺席当 unknown 会让升级后的老壳
    // 永久显示「正在验证通道」，那是把一个新缺陷换进来。
    expect(shizukuStateLabel({ ...bound, readyState: undefined })).toBe('通道就绪')
  })

  it('引导文案把探测失败翻成可执行动作，并带上诊断原因', () => {
    const hint = shizukuStepHint({ ...bound, readyState: 'not-ready', probeError: 'IPC died' })
    expect(hint).toContain('不应答')
    expect(hint).toContain('IPC died')
    // 必须给出下一步，而不是只描述故障。
    expect(hint).toContain('重置链接')
  })

  it('探测中的引导文案不得劝阻使用（坑 161：unknown 不是不可用）', () => {
    const hint = shizukuStepHint({ ...bound, readyState: 'unknown' })
    expect(hint).toContain('功能探测')
    expect(hint).toContain('现在就可以')
  })

  it('readyState 解析只认三个字面量，其余一律缺席', () => {
    expect(parseShizukuReadyState('ready')).toBe('ready')
    expect(parseShizukuReadyState('not-ready')).toBe('not-ready')
    expect(parseShizukuReadyState('unknown')).toBe('unknown')
    // 拼错 / 新值 / 非字符串都不得被当成某个态——尤其不得被当成 ready。
    expect(parseShizukuReadyState('READY')).toBeUndefined()
    expect(parseShizukuReadyState('weird-new-state')).toBeUndefined()
    expect(parseShizukuReadyState(undefined)).toBeUndefined()
    expect(parseShizukuReadyState(null)).toBeUndefined()
    expect(parseShizukuReadyState(1)).toBeUndefined()
  })

  it('readShizuku 从桥面把 readyState 与探测原因透出来', () => {
    const original = (window as unknown as { androidBridge?: unknown }).androidBridge
    try {
      ;(window as unknown as { androidBridge?: unknown }).androidBridge = {
        shizukuStatus: () => JSON.stringify({
          ...bound,
          readyState: 'not-ready',
          functionalProbe: { probed: true, ok: false, error: 'protocolVersion threw', atMs: 1, stale: false, fromCache: true },
        }),
      }
      const parsed = readShizuku()
      expect(parsed.readyState).toBe('not-ready')
      expect(parsed.probeError).toBe('protocolVersion threw')
    } finally {
      ;(window as unknown as { androidBridge?: unknown }).androidBridge = original
    }
  })

  it('旧壳桥面（无 readyState 字段）读出来是缺席而不是 unknown', () => {
    const original = (window as unknown as { androidBridge?: unknown }).androidBridge
    try {
      ;(window as unknown as { androidBridge?: unknown }).androidBridge = {
        shizukuStatus: () => JSON.stringify(bound),
      }
      const parsed = readShizuku()
      expect(parsed.readyState).toBeUndefined()
      // 端到端一致：同一条旧壳回复，状态词仍是旧的「通道就绪」。
      expect(shizukuStateLabel(parsed)).toBe('通道就绪')
    } finally {
      ;(window as unknown as { androidBridge?: unknown }).androidBridge = original
    }
  })
})
