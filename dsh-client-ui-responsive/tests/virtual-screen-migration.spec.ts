// @vitest-environment jsdom
// 虚拟屏 UI 迁移契约（旧 dsh-android-vdisplay 的共享 UI → dsh-client-ui-responsive）。
//
// 迁移的边界必须由测试钉住，否则下次有人「顺手」把旧执行面接回来也编译得过：
//   1. 会话里已开页签的 tab id/kind 不变；
//   2. 状态只有原生 androidBridge.vdisplayStatus 一个来源，HTTP 端点与 controlExec/vdInfo
//      队列投递不得回到共享 UI；
//   3. 原生回执畸形/未知时 fail-closed（blocked），不得乐观置位；
//   4. 九键条仍是九键（含四向键与 Ctrl 闩锁），且 self-heal 只绑实例自己的终端根。
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { KEYBAR_KEYS } from '../src/client/virtual-screen/keybar/keymap.ts'
import { KEYBAR_ATTR, TERMINAL_ROOT_SELECTOR } from '../src/client/virtual-screen/keybar/layout.ts'
import { mountKeybar, watchTerminalKeybars } from '../src/client/virtual-screen/keybar/mount.ts'
import { mapStatusPayload, VD_STATUS_UNAVAILABLE } from '../src/client/virtual-screen/status.ts'
import { readNativePanelState, VD_TAB_ID, VD_TAB_KIND } from '../src/client/virtual-screen/index.ts'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const PANEL_SOURCE = source('../src/client/virtual-screen/index.ts')
const STATUS_SOURCE = source('../src/client/virtual-screen/status.ts')
const MOUNT_SOURCE = source('../src/client/virtual-screen/keybar/mount.ts')
const CLIENT_SOURCE = source('../src/client/index.ts')

/** 去掉注释与字符串字面量之外无关内容太重，这里只做「可执行代码里不得出现」的判断。 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('tab 兼容标识', () => {
  it('保留旧插件的 tab id 与 kind，已开页签仍然认得', () => {
    expect(VD_TAB_ID).toBe('@dsh-android/dsh-android-vdisplay')
    expect(VD_TAB_KIND).toBe('android-vdisplay')
  })
})

describe('共享 UI 只走原生桥', () => {
  it('不再引用旧 HTTP 状态端点或读取器', () => {
    for (const body of [code(PANEL_SOURCE), code(STATUS_SOURCE)]) {
      expect(body).not.toContain('/api/android/vdisplay/status')
      expect(body).not.toContain('readPanelState')
      expect(body).not.toContain('FetchLike')
      expect(body).not.toContain('browserFetch')
    }
  })

  it('不再声明或调用 controlExec / ControlQueue / vdInfo 投递', () => {
    for (const body of [code(PANEL_SOURCE), code(STATUS_SOURCE), code(MOUNT_SOURCE)]) {
      expect(body).not.toContain('controlExec')
      expect(body).not.toContain('ControlQueue')
      expect(body).not.toContain("controlExec('vdInfo'")
    }
  })

  it('状态读取只经 androidBridge.vdisplayStatus', () => {
    expect(code(PANEL_SOURCE)).toContain('vdisplayStatus')
    expect(code(PANEL_SOURCE)).not.toContain('fetch(')
  })

  it('虚拟屏 UI 已接进响应式客户端，九键条不依赖 tab 是否打开', () => {
    expect(code(CLIENT_SOURCE)).toMatch(/import \{ apply as applyVirtualScreen \} from '\.\/virtual-screen\/index\.ts'/)
    expect(code(CLIENT_SOURCE)).toContain('applyVirtualScreen(scope)')
  })
+  it('虚拟屏销毁桥与壳侧同形：无参调用，不把别名当参数静默丢弃', () => {
    const destroyCalls: unknown[][] = []
    const destroySource = code(PANEL_SOURCE)
    expect(destroySource).not.toContain('vdisplayDestroy?.(screen.alias)')
    expect(destroySource).not.toContain('vdisplayDestroy?: (target')
    // 桥面声明必须无参（与 AndroidBridge.vdisplayDestroy() 一致）。
    expect(destroySource).toMatch(/vdisplayDestroy\?: \(\) => string/)
    void destroyCalls
  })
})

describe('原生状态 fail-closed', () => {
  it('没有桥时是 blocked，并给出稳定错误码', () => {
    const state = readNativePanelState(undefined)
    expect(state.state).toBe('blocked')
    expect(state.code).toBe(VD_STATUS_UNAVAILABLE)
  })

  it('桥存在但方法缺席时不假装可用', () => {
    expect(readNativePanelState({}).state).toBe('blocked')
  })

  it('桥抛错或返回非法 JSON 时是 blocked', () => {
    expect(readNativePanelState({ vdisplayStatus: () => { throw new Error('bridge gone') } }).state).toBe('blocked')
    expect(readNativePanelState({ vdisplayStatus: () => 'not json' }).state).toBe('blocked')
    expect(readNativePanelState({ vdisplayStatus: () => 42 as unknown as string }).state).toBe('blocked')
  })

  it('正常回执按原生字段映射，active 带 displayId', () => {
    const payload = JSON.stringify({
      ok: true, enabled: true, state: 'active', displayId: 25, selected: 'virtual-1',
      screens: [{ alias: 'virtual-1', displayId: 25, kind: 'virtual', label: 'Virtual 1', state: 'on',
        width: 1080, height: 2400, densityDpi: 440, selectable: true, reason: '' }],
    })
    const state = readNativePanelState({ vdisplayStatus: () => payload })
    expect(state.state).toBe('active')
    expect(state.displayId).toBe(25)
    expect(state.screens.map((s) => s.alias)).toEqual(['virtual-1'])
    expect(state.selected).toBe('virtual-1')
  })

  it('壳侧调用必须保留接收者（Java 桥不能抽出方法裸调）', () => {
    const bridge = {
      tag: 'bridge',
      vdisplayStatus(this: { tag: string }): string {
        if (this === undefined || this.tag !== 'bridge') throw new Error('non-injected object')
        return JSON.stringify({ enabled: true, state: 'ready' })
      },
    }
    expect(readNativePanelState(bridge).state).toBe('ready')
  })

  it('未知 state / 非对象回执一律 blocked，enabled=false 是 disabled', () => {
    expect(mapStatusPayload({ enabled: true, state: 'purple' }).state).toBe('blocked')
    expect(mapStatusPayload({ enabled: true }).state).toBe('blocked')
    expect(mapStatusPayload('nope').state).toBe('blocked')
    expect(mapStatusPayload({ enabled: false, state: 'ready' }).state).toBe('disabled')
  })

  it('坏屏幕条目被丢弃，不会让整块状态失败', () => {
    const state = mapStatusPayload({
      enabled: true, state: 'ready',
      screens: [{ alias: 'virtual-1', displayId: 25 }, { alias: 3, displayId: 'x' }, null],
    })
    expect(state.screens).toHaveLength(1)
    expect(state.screens[0].kind).toBe('unknown')
  })
})

describe('九键条', () => {
  const disposables: { dispose(): void }[] = []
  afterEach(() => {
    for (const item of disposables.splice(0)) item.dispose()
    document.body.innerHTML = ''
  })

  function terminal(): HTMLElement {
    const root = document.createElement('section')
    root.setAttribute('data-sidebar-terminal', '')
    root.innerHTML = '<div class="screen"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div>'
    document.body.append(root)
    return root
  }

  it('仍是九键，四向键都在', () => {
    expect([...KEYBAR_KEYS]).toEqual(['keyboard', 'tab', 'ctrl', 'esc', 'left', 'right', 'up', 'down', 'enter'])
    const root = terminal()
    const handle = mountKeybar({ root, write: () => true, applicationCursorKeys: () => undefined, now: () => 1_000 })
    disposables.push(handle)
    const keys = [...root.querySelectorAll('[' + KEYBAR_ATTR + '] button')].map((b) => (b as HTMLElement).dataset.key)
    expect(keys).toEqual(['keyboard', 'tab', 'ctrl', 'esc', 'left', 'right', 'up', 'down', 'enter'])
  })

  it('Ctrl 仍有闩锁：按下置位，再按一次解除', () => {
    const root = terminal()
    const handle = mountKeybar({ root, write: () => true, applicationCursorKeys: () => undefined, now: () => 1_000 })
    disposables.push(handle)
    const ctrl = root.querySelector('[' + KEYBAR_ATTR + '] button[data-key="ctrl"]') as HTMLButtonElement
    expect(ctrl.dataset.latched).toBe('false')
    ctrl.click()
    expect(ctrl.dataset.latched).toBe('true')
    expect(handle.latch().latched).toBe(true)
    ctrl.click()
    expect(ctrl.dataset.latched).toBe('false')
  })

  it('self-heal 只绑实例自己的终端根：分栏时两条键条各归各根', async () => {
    const first = terminal()
    const second = terminal()
    const watch = watchTerminalKeybars({ doc: document })
    disposables.push(watch)
    expect(watch.count()).toBe(2)
    expect(first.querySelectorAll('[' + KEYBAR_ATTR + ']')).toHaveLength(1)
    expect(second.querySelectorAll('[' + KEYBAR_ATTR + ']')).toHaveLength(1)
    // 每根自己的键条必须是该根的直接子项，且只有一个根里有它。
    expect(first.querySelector('[' + KEYBAR_ATTR + ']')?.parentElement).toBe(first)
    expect(second.querySelector('[' + KEYBAR_ATTR + ']')?.parentElement).toBe(second)
    first.remove()
    // 观察者回调在微任务里跑；等一拍再判定收摊。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(first.querySelectorAll('[' + KEYBAR_ATTR + ']')).toHaveLength(0)
    expect(second.querySelectorAll('[' + KEYBAR_ATTR + ']')).toHaveLength(1)
    expect(watch.count()).toBe(1)
  })

  it('watch 只按终端根选择器枚举，不取全页最后一个根', () => {
    expect(MOUNT_SOURCE).toContain('TERMINAL_ROOT_SELECTOR')
    expect(MOUNT_SOURCE).not.toContain('roots[roots.length - 1]')
    expect(TERMINAL_ROOT_SELECTOR).toBe('[data-sidebar-terminal]')
  })
})
