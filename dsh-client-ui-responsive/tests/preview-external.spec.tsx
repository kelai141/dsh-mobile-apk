// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { PreviewExternalAction } from '../src/client/mobile/PreviewExternalAction.tsx'
import { openExternalFile, type FileCardBridge } from '../src/client/mobile/file-card-actions.ts'
import { en, zh } from '../src/client/mobile/preview-external.locales.ts'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let bridge: FileCardBridge = {}
let path = '/workspace/其他会话/audio track.FLAC'
let copy = zh

async function render() {
  if (root === undefined) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  const props = { absolutePath: path, openExternal: (target: string) => openExternalFile(bridge, target),
    t: (key: keyof typeof zh) => copy[key] } as ComponentProps<typeof PreviewExternalAction>
  await act(async () => { root!.render(<PreviewExternalAction {...props} />) })
}

async function click() {
  await act(async () => { document.querySelector('button')!.click() })
}

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  document.body.innerHTML = ''
  bridge = {}
  path = '/workspace/其他会话/audio track.FLAC'
  copy = zh
})

describe('unsupported preview external action', () => {
  it('opens the owner path unchanged with an audio MIME and the bridge receiver', async () => {
    const calls: Array<[string, string]> = []
    bridge = { openFileExternal(target, mime) {
      expect(this).toBe(bridge)
      calls.push([target, mime])
      return '{"ok":true}'
    } }
    await render()
    expect(document.querySelector('button')!.textContent).toBe(zh.open)
    await click()
    expect(calls).toEqual([[path, 'audio/flac']])
    expect(document.querySelector('[role="status"]')!.textContent).toBe('')
  })

  it('allows late bridge injection and clears an earlier failure after successful retry', async () => {
    await render()
    await click()
    expect(document.querySelector('[role="status"]')!.textContent).toBe(zh.unavailable)
    copy = en
    await render()
    expect(document.querySelector('button')!.textContent).toBe(en.open)
    expect(document.querySelector('[role="status"]')!.textContent).toBe(en.unavailable)
    bridge = { openFileExternal: () => '{"ok":true}' }
    await click()
    expect(document.querySelector('[role="status"]')!.textContent).toBe('')
  })

  it.each([
    ['{"ok":false,"error":"no-receiver"}', 'noReceiver'],
    ['{"ok":false,"reason":"no-handler"}', 'noReceiver'],
    ['{"ok":false,"error":"io"}', 'notReadable'],
    ['{"ok":false,"error":"uri-denied"}', 'notAllowed'],
    ['not-json', 'failed'],
    ['null', 'failed'],
  ] as const)('shows a localized, retryable result for %s', async (answer, key) => {
    bridge = { openFileExternal: () => answer }
    await render()
    await click()
    expect(document.querySelector('[role="status"]')!.textContent).toBe(zh[key])
    expect(document.querySelector('button')!.disabled).toBe(false)
  })

  it('contains bridge exceptions and does not show a previous file error on navigation', async () => {
    bridge = { openFileExternal: () => { throw new Error('native failure') } }
    await render()
    await click()
    expect(document.querySelector('[role="status"]')!.textContent).toBe(zh.failed)
    path = '/workspace/next.mp3'
    await render()
    expect(document.querySelector('[role="status"]')!.textContent).toBe('')
    let received: string | undefined
    bridge = { openFileExternal: target => { received = target; return '{"ok":true}' } }
    await click()
    expect(received).toBe(path)
  })
})
