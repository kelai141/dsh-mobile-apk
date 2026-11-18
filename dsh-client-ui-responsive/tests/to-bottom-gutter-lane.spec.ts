// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { TO_BOTTOM_GUTTER_CSS } from '../src/client/to-bottom-gutter.css.ts'

it('keeps the message column the same width with and without the return action', () => {
  document.head.innerHTML = '<style>' + TO_BOTTOM_GUTTER_CSS + '</style>'
  document.body.innerHTML = '<main data-conversation-scroll><div data-chat-flow>Message</div></main>'
  const flow = document.querySelector('[data-chat-flow]')!
  const before = getComputedStyle(flow).paddingRight
  flow.after(Object.assign(document.createElement('div'), { className: 'hash_toBottomSlot' }))
  expect(getComputedStyle(flow).paddingRight).toBe(before)
})

it('anchors only the return action and supplies bilingual copy', () => {
  expect(TO_BOTTOM_GUTTER_CSS.match(/bottom: var\(--dsh-chat-back-bottom\)/g)).toHaveLength(1)
  expect(TO_BOTTOM_GUTTER_CSS).toContain("content: 'Back'")
  expect(TO_BOTTOM_GUTTER_CSS).toContain("content: '返回'")
  expect(TO_BOTTOM_GUTTER_CSS).toContain('min-width: 44px')
  expect(TO_BOTTOM_GUTTER_CSS).toContain('var(--dsh-composer-ime-shift, 0px)')
})

it('leaves the running text in the transcript without an overlay background', () => {
  document.head.innerHTML = '<style>' + TO_BOTTOM_GUTTER_CSS + '</style>'
  document.body.innerHTML = '<main data-conversation-scroll><div data-chat-running style="position: relative">Running</div>' +
    '<div class="hash_toBottomSlot"><button>⌄</button></div></main>'
  const running = document.querySelector('[data-chat-running]')!
  const style = getComputedStyle(running)
  expect(style.position).toBe('relative')
  expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(TO_BOTTOM_GUTTER_CSS).not.toContain('[data-chat-running]')
})
