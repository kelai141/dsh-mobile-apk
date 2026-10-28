// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fillModelDraft, installClipboardModelDrafts } from '../src/client/mobile/clipboard-model-drafts.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let dispose: (() => void) | undefined
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: 120, height: 44, top: 0, left: 0, right: 120, bottom: 44, toJSON: () => ({}),
  })
})
afterEach(async () => {
  dispose?.(); dispose = undefined
  if (root) await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  delete (window as unknown as { androidBridge?: unknown }).androidBridge
  vi.restoreAllMocks()
})

async function setup(locale = 'en', onboarding = false) {
  document.documentElement.lang = locale
  const zh = locale === 'zh'
  const host = document.createElement('div')
  document.body.append(host)
  const saves = vi.fn()
  function Editor() {
    const [key, setKey] = useState('')
    const [url, setUrl] = useState('')
    const [models, setModels] = useState(['existing-one', 'existing-two'])
    return <section data-dsh-settings-dialog={onboarding ? undefined : ''}
      role={onboarding ? 'dialog' : undefined} aria-modal={onboarding ? true : undefined}><div>
      <input aria-label={zh ? 'API 密钥' : 'API key'} type="password" value={key} onChange={e => setKey(e.target.value)} />
      <details><input aria-label={zh ? 'API 地址' : 'Base URL'} value={url} onChange={e => setUrl(e.target.value)} />
        {models.map((model, i) => <input key={i} aria-label={(zh ? '模型 ID ' : 'Model ID ') + (i + 1)} value={model}
          onChange={e => setModels(rows => rows.map((v, n) => n === i ? e.target.value : v))} />)}
      </details>
      <button onClick={saves}>{onboarding ? (zh ? '保存并继续' : 'Save and continue') : (zh ? '保存' : 'Apply')}</button>
      <output>{JSON.stringify({ key, url, models })}</output>
    </div></section>
  }
  root = createRoot(host)
  await act(async () => root!.render(<Editor />))
  const request = vi.fn()
  const cancel = vi.fn()
  ;(window as unknown as { androidBridge: unknown }).androidBridge = {
    requestClipboardText: request,
    cancelClipboardText: cancel,
  }
  dispose = installClipboardModelDrafts()
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === label)
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  const deliver = async (text?: string, requestId = request.mock.calls.at(-1)?.[0]) => {
    await act(async () => window.dispatchEvent(new CustomEvent('dsh:clipboard-text', {
      detail: { requestId, ok: text !== undefined, text },
    })))
  }
  return { host, saves, request, cancel, click, deliver, state: () => JSON.parse(host.querySelector('output')!.textContent!) }
}

describe('clipboard configuration into React drafts', () => {
  it.each(['en', 'zh'])('supports %s onboarding outside Settings without submitting credentials', async locale => {
    const ui = await setup(locale, true)
    expect(ui.host.querySelector('[data-dsh-settings-dialog]')).toBeNull()
    await ui.click(locale === 'zh' ? '从剪贴板填充' : 'Fill from clipboard')
    await ui.deliver('fixture-secret')
    expect(ui.host.querySelector('[data-dsh-clipboard-draft]')!.textContent).not.toContain('fixture-secret')
    await ui.click(locale === 'zh' ? '填入草稿' : 'Fill draft')
    expect(ui.state().key).toBe('fixture-secret')
    expect(ui.saves).not.toHaveBeenCalled()
  })
  it('reveals folded model fields during preview and puts filling before saving', async () => {
    const ui = await setup('zh')
    const details = ui.host.querySelector('details')!
    expect(details.open).toBe(false)
    const panel = ui.host.querySelector('[data-dsh-clipboard-draft]')!
    const save = [...ui.host.querySelectorAll('button')].find(b => b.textContent === '保存')!
    expect(panel.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await ui.click('从剪贴板填充')
    await ui.deliver('{"baseURL":"https://example.test/v1","model":"preview-model"}')
    expect(details.open).toBe(true)
    expect(panel.textContent).toContain('地址：https://example.test/v1')
    expect(panel.textContent).not.toContain('Base URL:')
    expect(ui.state().models).toEqual(['existing-one', 'existing-two'])
    expect(ui.saves).not.toHaveBeenCalled()
  })
  it('does not attach to unrelated nonmodal content with an API key input', async () => {
    const ui = await setup('en', true)
    dispose?.(); dispose = undefined
    ui.host.querySelector('section')!.removeAttribute('aria-modal')
    dispose = installClipboardModelDrafts()
    expect(ui.host.querySelector('[data-dsh-clipboard-draft]')).toBeNull()
  })
  it('does not read during mount, previews a masked key, then fills only the chosen model without saving', async () => {
    const ui = await setup()
    expect(ui.request).not.toHaveBeenCalled()
    await ui.click('Fill from clipboard')
    expect(ui.request).toHaveBeenCalledOnce()
    await ui.deliver('{"apiKey":"fixture-secret","baseURL":"https://example.test/v1","model":"new-model"}')
    expect(ui.host.querySelector('[data-dsh-clipboard-draft]')!.textContent).not.toContain('fixture-secret')
    expect(ui.state().key).toBe('')
    const select = ui.host.querySelector('select')!
    const fill = [...ui.host.querySelectorAll('button')].find(b => b.textContent === 'Fill draft')!
    expect(fill.disabled).toBe(true)
    select.value = '1'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await ui.click('Fill draft')
    expect(ui.state()).toEqual({ key: 'fixture-secret', url: 'https://example.test/v1', models: ['existing-one', 'new-model'] })
    expect(ui.saves).not.toHaveBeenCalled()
  })
  it('rejects another request result and allows cancellation without changing the draft', async () => {
    const ui = await setup()
    await ui.click('Fill from clipboard')
    await ui.deliver('wrong-key', 'unrelated-request')
    expect(ui.host.textContent).not.toContain('Fill draft')
    await ui.deliver('fixture-secret')
    await ui.click('Cancel')
    expect(ui.state().key).toBe('')
    expect(ui.host.textContent).not.toContain('fixture-secret')
    expect(ui.saves).not.toHaveBeenCalled()
  })
  it('supports the Chinese editor labels and keeps its existing save action untouched', async () => {
    const ui = await setup('zh')
    await ui.click('从剪贴板填充')
    await ui.deliver('API_KEY=fixture-secret\nBASE_URL=https://example.test/v1')
    await ui.click('填入草稿')
    expect(ui.state().key).toBe('fixture-secret')
    expect(ui.state().url).toBe('https://example.test/v1')
    expect(ui.saves).not.toHaveBeenCalled()
  })
  it('keeps malformed clipboard contents out of errors and leaves the editor untouched', async () => {
    const ui = await setup()
    await ui.click('Fill from clipboard')
    await ui.deliver('unknown=fixture-secret')
    expect(ui.host.textContent).not.toContain('fixture-secret')
    expect(ui.host.textContent).toContain('Unrecognized configuration')
    expect(ui.state().key).toBe('')
  })
  it('rejects a disabled, edited or detached target before any draft changes', () => {
    const owner = document.createElement('div')
    const input = document.createElement('input')
    owner.append(input); document.body.append(owner)
    input.disabled = true
    expect(fillModelDraft([{ input, before: '', value: 'new' }], owner)).toBe(false)
    input.disabled = false; input.value = 'edited'
    expect(fillModelDraft([{ input, before: '', value: 'new' }], owner)).toBe(false)
    owner.hidden = true
    expect(fillModelDraft([{ input, before: 'edited', value: 'new' }], owner)).toBe(false)
    owner.remove()
    expect(fillModelDraft([{ input, before: 'edited', value: 'new' }], owner)).toBe(false)
    expect(input.value).toBe('edited')
  })
  it('removes the read listener when disposed before the native reply', async () => {
    const ui = await setup()
    await ui.click('Fill from clipboard')
    dispose?.(); dispose = undefined
    await ui.deliver('fixture-secret')
    expect(ui.host.textContent).not.toContain('Fill draft')
    expect(ui.state().key).toBe('')
  })

  // ── observer 只吃 dialog scope 内的变更（2026-10-28 扫描 M3）────────────────────────

  const flushObservers = () => new Promise(resolve => setTimeout(resolve, 0))

  /** scope 内的变更必须照常触发重扫：编辑器不可见时其预览面板被回收。 */
  it('still rescans when a dialog-scoped editor changes', async () => {
    const ui = await setup()
    await ui.click('Fill from clipboard')
    await ui.deliver('API_KEY=fixture-secret')
    const panel = document.querySelector('[data-dsh-clipboard-draft]')
    expect(panel).not.toBeNull()
    const owner = panel!.parentElement!
    await act(async () => { owner.hidden = true })
    await flushObservers()
    expect(document.querySelector('[data-dsh-clipboard-draft]')).toBeNull()
  })

  /** scope 外的变更不得再触发全文档重扫：聊天流每帧都在变，不能为它付 querySelectorAll 的钱。 */
  it('ignores churn outside dialog scopes entirely', async () => {
    const ui = await setup()
    await ui.click('Fill from clipboard')
    await ui.deliver('API_KEY=fixture-secret')
    expect(document.querySelector('[data-dsh-clipboard-draft]')).not.toBeNull()

    // scope 外摆一个结构完整的编辑器（key + save 按钮）+ 一次独立 DOM 变更，两者都不该被看见。
    const outside = document.createElement('div')
    outside.innerHTML = '<input aria-label="API key"><button>Apply</button>'
    document.body.append(outside)
    const bystander = document.createElement('p')
    document.body.append(bystander)
    await flushObservers()

    expect(outside.querySelector('[data-dsh-clipboard-draft]')).toBeNull()
    const panel = document.querySelector('[data-dsh-clipboard-draft]')
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('API key: hidden')
  })

  /** Removing the last dialog must dispose its editor and cancel any in-flight native read. */
  it('disposes tracked editors when the last dialog is removed', async () => {
    const ui = await setup()
    await ui.click('Fill from clipboard')
    expect(ui.request).toHaveBeenCalledOnce()
    const requestId = ui.request.mock.calls[0][0]

    await act(async () => { root!.unmount(); root = undefined })
    await flushObservers()

    expect(ui.cancel).toHaveBeenCalledOnce()
    expect(ui.cancel).toHaveBeenCalledWith(requestId)
    await ui.deliver('late-secret', requestId)
    expect(ui.host.textContent).not.toContain('late-secret')
    expect(ui.host.querySelector('[data-dsh-clipboard-draft]')).toBeNull()
  })
})
