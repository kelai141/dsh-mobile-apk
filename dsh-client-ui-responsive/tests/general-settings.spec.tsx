// @vitest-environment jsdom
// ST-10 页侧回归（离线）：沉浸式开关的初值必须以壳桥 getImmersiveMode() 为准，
// localStorage 只在桥缺失时兜底（旧实现以 localStorage 为初值 → 与壳侧真值分裂）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GeneralSettings } from '../src/client/general-settings/GeneralSettings.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'dsh.android.immersive'

let root: Root | undefined
let host: HTMLElement | undefined

async function render(bridge?: Record<string, unknown>): Promise<HTMLInputElement> {
  delete window.androidBridge
  if (bridge !== undefined) window.androidBridge = bridge as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<GeneralSettings {...({} as never)} />)
  })
  return host.querySelector('input[type=checkbox]') as HTMLInputElement
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* jsdom storage always present; guard for parity */ }
  delete window.androidBridge
})

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => { root!.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
  delete window.androidBridge
})

describe('GeneralSettings 沉浸式开关（ST-10）', () => {
  it('桥与 localStorage 冲突时以桥为准（桥 true / 存储 "0" → 开）', async () => {
    localStorage.setItem(KEY, '0')
    const input = await render({ getImmersiveMode: () => true })
    expect(input.checked).toBe(true)
  })

  it('桥与 localStorage 冲突时以桥为准（桥 false / 存储 "1" → 关）', async () => {
    localStorage.setItem(KEY, '1')
    const input = await render({ getImmersiveMode: () => false })
    expect(input.checked).toBe(false)
  })

  it('桥缺失时回落 localStorage（"0" → 关）', async () => {
    localStorage.setItem(KEY, '0')
    const input = await render()
    expect(input.checked).toBe(false)
  })

  it('桥缺失且无存储值时用壳侧同款默认（true → 开）', async () => {
    const input = await render()
    expect(input.checked).toBe(true)
  })

  it('桥抛错时也走存储兜底，不把开关打成关闭', async () => {
    localStorage.setItem(KEY, '1')
    const input = await render({ getImmersiveMode: () => { throw new Error('bridge broken') } })
    expect(input.checked).toBe(true)
  })

  it('切换同时写存储镜像并单向推桥，展示值回到壳侧真值', async () => {
    const state = { immersive: true }
    const setImmersiveMode = vi.fn((v: boolean) => { state.immersive = v })
    const input = await render({ getImmersiveMode: () => state.immersive, setImmersiveMode })
    expect(input.checked).toBe(true)
    await act(async () => { input.click() })
    expect(setImmersiveMode).toHaveBeenCalledWith(false)
    expect(localStorage.getItem(KEY)).toBe('0')
    // 写后回读：展示值跟随壳侧真值（stub 已同步翻转）
    expect(input.checked).toBe(false)
  })

  it('ST-09：只动壳侧真源 + 回前台 → 展示跟随（不重挂载、不靠 localStorage）', async () => {
    const state = { immersive: true }
    localStorage.setItem(KEY, '1') // 存储镜像与真源相反：必须听真源
    const input = await render({ getImmersiveMode: () => state.immersive })
    expect(input.checked).toBe(true)
    state.immersive = false // 系统设置里关掉（只动系统侧）
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(input.checked).toBe(false)
  })
})
