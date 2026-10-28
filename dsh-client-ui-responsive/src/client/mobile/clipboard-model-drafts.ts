import { tr } from '../i18n.ts'
import type { AndroidShellBridge } from '../android-bridge.ts'
import { parseClipboardModelConfig, type ClipboardModelConfig } from './clipboard-model-config.ts'

interface DraftTarget { input: HTMLInputElement; value: string; before: string }
const KEY = 'input[aria-label="API key"],input[aria-label="API 密钥"]'
const BASE = 'input[aria-label="Base URL"],input[aria-label="API 地址"]'
const MODEL = 'input[aria-label^="Model ID "],input[aria-label^="模型 ID "]'
const EDITOR_SCOPE = '[data-dsh-settings-dialog],[role="dialog"][aria-modal="true"]'
const SAVE_LABEL = /^(Apply|保存|Save and continue|保存并继续)$/

/** A mounted editor can still be hidden by the mobile settings layer. */
function visible(owner: HTMLElement): boolean {
  if (!owner.isConnected || owner.closest('[hidden],[aria-hidden="true"],[inert]')) return false
  const rect = owner.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && getComputedStyle(owner).visibility !== 'hidden'
}

/** Change the React-owned input through its native setter and normal input event. */
export function fillModelDraft(targets: readonly DraftTarget[], owner: HTMLElement): boolean {
  if (!visible(owner) || targets.some(t => !owner.contains(t.input) || !t.input.isConnected
    || t.input.disabled || t.input.readOnly || t.input.value !== t.before)) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) return false
  for (const target of targets) {
    target.input.closest('details')?.setAttribute('open', '')
    setter.call(target.input, target.value)
    target.input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return true
}

/** Attach a clipboard preview to one provider editor; never invoke its save action. */
function attachEditor(owner: HTMLElement, key: HTMLInputElement): () => void {
  const panel = document.createElement('div')
  panel.dataset.dshClipboardDraft = ''
  panel.style.cssText = 'display:grid;gap:12px;margin:12px 0;max-width:100%;overflow-wrap:anywhere'
  const read = document.createElement('button')
  read.type = 'button'
  read.textContent = tr('从剪贴板填充', 'Fill from clipboard')
  read.style.cssText = 'min-height:44px;padding:8px 12px;border:1px solid currentColor;border-radius:8px;text-align:start;font:inherit;background:transparent;color:inherit'
  const notice = document.createElement('p')
  notice.setAttribute('role', 'status')
  notice.style.cssText = 'margin:0;font-size:0.9em'
  const preview = document.createElement('div')
  panel.append(read, notice, preview)
  const save = [...owner.querySelectorAll('button')].find(b => SAVE_LABEL.test((b.textContent || '').trim()))!
  let actions: HTMLElement = save
  while (actions.parentElement !== owner) actions = actions.parentElement!
  owner.insertBefore(panel, actions)
  let release: (() => void) | undefined
  let clearPreview: (() => void) | undefined

  const show = (config: ClipboardModelConfig) => {
    clearPreview?.()
    preview.replaceChildren()
    const heading = document.createElement('p')
    heading.textContent = tr('确认填入此提供商的草稿；完成后请自行保存。', 'Review this provider draft, then save it yourself when ready.')
    const summary = document.createElement('p')
    summary.textContent = [config.apiKey === undefined ? '' : tr('API 密钥：已隐藏', 'API key: hidden'),
      config.baseURL === undefined ? '' : tr('地址：', 'Base URL: ') + config.baseURL,
      config.model === undefined ? '' : tr('模型：', 'Model: ') + config.model].filter(Boolean).join('\n')
    summary.style.whiteSpace = 'pre-wrap'
    const targets: DraftTarget[] = []
    const add = (selector: string, value: string | undefined) => {
      if (value === undefined) return true
      const matches = owner.querySelectorAll<HTMLInputElement>(selector)
      if (matches.length !== 1) return false
      targets.push({ input: matches[0], before: matches[0].value, value })
      return true
    }
    const available = add(KEY, config.apiKey) && add(BASE, config.baseURL)
    const choose = document.createElement('select')
    choose.setAttribute('aria-label', tr('要填充的模型字段', 'Model field to fill'))
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = tr('选择要填充的模型字段', 'Choose the model field to fill')
    choose.append(empty)
    const models = [...owner.querySelectorAll<HTMLInputElement>(MODEL)]
    if (config.model !== undefined) {
      // Reveal the actual fields before asking the user to choose a model row.
      models.forEach(input => input.closest('details')?.setAttribute('open', ''))
    }
    models.forEach((input, index) => {
      const option = document.createElement('option')
      option.value = String(index)
      option.textContent = (input.getAttribute('aria-label') || '') + (input.value ? ': ' + input.value : tr('（空）', ' (empty)'))
      choose.append(option)
    })
    const modelBefore = models.map(input => input.value)
    const fill = document.createElement('button')
    fill.type = 'button'
    fill.textContent = tr('填入草稿', 'Fill draft')
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = tr('取消', 'Cancel')
    for (const button of [fill, cancel]) button.style.cssText = read.style.cssText
    choose.style.cssText = 'min-height:44px;max-width:100%;font:inherit;color:inherit;background:transparent'
    const update = () => { fill.disabled = !available || (config.model !== undefined && choose.value === '') }
    choose.onchange = () => {
      update()
      models[Number(choose.value)]?.scrollIntoView?.({ block: 'nearest' })
    }
    if (models.length === 1) choose.value = '0'
    update()
    if (!available || (config.model !== undefined && models.length === 0)) {
      notice.textContent = tr('当前编辑器没有对应字段，请先打开所需的配置项。', 'This editor has no matching field. Open the required configuration fields first.')
    }
    let draft: ClipboardModelConfig | undefined = config
    clearPreview = () => { draft = undefined; preview.replaceChildren(); clearPreview = undefined }
    cancel.onclick = () => { clearPreview?.(); notice.textContent = '' }
    fill.onclick = () => {
      if (!draft || fill.disabled) return
      const writes = [...targets]
      if (draft.model !== undefined) {
        const index = Number(choose.value)
        const input = models[index]
        if (!input) return
        writes.push({ input, before: modelBefore[index], value: draft.model })
      }
      const ok = fillModelDraft(writes, owner)
      clearPreview?.()
      notice.textContent = ok ? tr('已填入草稿，尚未保存。请检查后点击原有保存按钮。', 'Draft filled, not saved. Review it and use the existing Apply button.')
        : tr('编辑器已变化，未填入。请重新读取并预览。', 'The editor changed; nothing was filled. Read and preview again.')
    }
    preview.append(heading, summary)
    if (config.model !== undefined) preview.append(choose)
    preview.append(fill, cancel)
  }

  read.onclick = () => {
    if (key.disabled || key.readOnly || !visible(owner) || release) return
    clearPreview?.()
    const bridge = (window as unknown as { androidBridge?: AndroidShellBridge }).androidBridge
    if (typeof bridge?.requestClipboardText !== 'function') {
      notice.textContent = tr('当前壳版本不支持读取剪贴板。', 'This shell version cannot read the clipboard.')
      return
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const requestId = 'clip_' + [...bytes].map(v => v.toString(16).padStart(2, '0')).join('')
    read.disabled = true
    notice.textContent = tr('请在系统确认框中允许读取。', 'Confirm the clipboard read in the native prompt.')
    const receive = (event: Event) => {
      const value = (event as CustomEvent).detail
      if (value?.requestId !== requestId) return
      release?.()
      if (!visible(owner)) return
      if (value.ok !== true || typeof value.text !== 'string') {
        notice.textContent = tr('未读取配置。可再次点击重试。', 'No configuration was read. Tap again to retry.')
        return
      }
      try { show(parseClipboardModelConfig(value.text)); notice.textContent = '' } catch {
        notice.textContent = tr('无法识别配置。请复制 API 密钥、JSON 或 key=value 配置后重试。', 'Unrecognized configuration. Copy an API key, JSON or key=value configuration and retry.')
      }
    }
    const timeout = window.setTimeout(() => {
      release?.()
      notice.textContent = tr('读取已超时，请重试。', 'The read expired. Try again.')
    }, 35_000)
    release = () => {
      window.removeEventListener('dsh:clipboard-text', receive)
      window.clearTimeout(timeout)
      read.disabled = false
      release = undefined
      try { bridge.cancelClipboardText?.(requestId) } catch { /* A disposed native reader holds no page draft. */ }
    }
    window.addEventListener('dsh:clipboard-text', receive)
    try { bridge.requestClipboardText(requestId) } catch { release(); notice.textContent = tr('读取未能启动，请重试。', 'Could not start the read. Try again.') }
  }
  return () => { release?.(); clearPreview?.(); panel.remove() }
}

/** Observe provider editors in Settings or onboarding; native confirmation still gates reads. */
export function installClipboardModelDrafts(): () => void {
  const editors = new Map<HTMLElement, () => void>()
  const scan = () => {
    for (const [owner, dispose] of editors) if (!visible(owner)) { dispose(); editors.delete(owner) }
    for (const key of document.querySelectorAll<HTMLInputElement>(KEY)) {
      if (!key.closest(EDITOR_SCOPE)) continue
      let owner = key.parentElement
      while (owner) {
        if ([...owner.querySelectorAll('button')].some(b => SAVE_LABEL.test((b.textContent || '').trim()))) break
        owner = owner.parentElement
      }
      if (!owner || !visible(owner) || !owner.closest(EDITOR_SCOPE) || owner.querySelectorAll(KEY).length !== 1 || editors.has(owner)) continue
      editors.set(owner, attachEditor(owner, key))
    }
  }
  const observer = new MutationObserver((records) => {
    // Only dialog-scoped churn can add, mutate or remove a provider editor. This effect runs
    // for the whole app lifetime and the chat stream mutates the DOM every frame — rescan the
    // whole document for each of those frames and the streaming UI pays for it (2026-10-28
    // scan M3; same shape as the about-entry observer's dialog filter).
    const scopes = [...document.querySelectorAll(EDITOR_SCOPE)]
    const removedTrackedEditor = records.some(record =>
      [...record.removedNodes].some(node => node instanceof Element
        && [...editors.keys()].some(owner => node === owner || node.contains(owner))))
    if (removedTrackedEditor) {
      scan()
      return
    }
    if (scopes.length === 0) return
    const withinScope = (node: Node): boolean =>
      node instanceof Element && scopes.some(scope => scope.contains(node))
    const touched = records.some(record => withinScope(record.target)
      || [...record.addedNodes].some(withinScope))
    if (touched) scan()
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'inert', 'data-dsh-settings-level'] })
  scan()
  return () => { observer.disconnect(); editors.forEach(dispose => dispose()); editors.clear() }
}
