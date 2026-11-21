// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ComposerImeMotion } from '../src/client/composer-ime-motion.ts'

const TARGET = '--dsh-android-page-ime-target'
const DURATION = '--dsh-android-page-ime-duration'
const LAYOUT = '--dsh-page-ime-layout'
let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.documentElement.removeAttribute('style')
  document.body.replaceChildren()
})

function changeTarget(target: number): void {
  document.documentElement.style.setProperty(TARGET, `${target}px`)
  window.dispatchEvent(new Event('dsh-page-ime-change'))
}

function mount() {
  document.body.innerHTML = `
    <div data-conversation-content data-content-phase="active">
      <div data-conversation-scroll><div data-composer-seat></div></div>
    </div>`
  const scroll = document.querySelector<HTMLElement>('[data-conversation-scroll]')!
  const seat = scroll.querySelector<HTMLElement>('[data-composer-seat]')!
  const style = document.documentElement.style
  const layout = () => Number.parseFloat(style.getPropertyValue(LAYOUT))
  let offset = 0
  vi.spyOn(seat, 'getClientRects').mockReturnValue([{ width: 300 }] as unknown as DOMRectList)
  vi.spyOn(seat, 'getBoundingClientRect').mockImplementation(() => ({ top: 600 - layout() + offset }) as DOMRect)
  const animate = vi.fn(() => Object.assign(new EventTarget(), {
    cancel() { offset = 0 },
  }) as unknown as Animation)
  Object.assign(scroll, { animate })
  Object.assign(seat, { animate })
  style.setProperty(DURATION, '180ms')
  changeTarget(0)
  dispose = new ComposerImeMotion().attach()
  return { animate, layout, setOffset: (value: number) => { offset = value } }
}

it('moves the layer on open before committing layout, and expands once on close', () => {
  const { animate, layout } = mount()
  changeTarget(250)
  expect(layout()).toBe(0)
  expect(animate).toHaveBeenLastCalledWith([
    { transform: 'translate3d(0, 0px, 0)' }, { transform: 'translate3d(0, -250px, 0)' },
  ], expect.objectContaining({ duration: 180 }))
  // Intermediate Android samples use the same event, without a new target.
  window.dispatchEvent(new Event('dsh-page-ime-change'))
  expect(animate).toHaveBeenCalledTimes(1)
  animate.mock.results[0].value.dispatchEvent(new Event('finish'))
  expect(layout()).toBe(250)
  changeTarget(0)
  expect(layout()).toBe(0)
  expect(animate).toHaveBeenLastCalledWith([
    { transform: 'translate3d(0, -250px, 0)' }, { transform: 'translate3d(0, 0px, 0)' },
  ], expect.objectContaining({ duration: 108 }))
})

it('reverses from the painted position and ignores a canceled animation completion', () => {
  const { animate, layout, setOffset } = mount()
  changeTarget(250)
  setOffset(-90)
  changeTarget(0)
  expect(animate).toHaveBeenLastCalledWith([
    { transform: 'translate3d(0, -90px, 0)' }, { transform: 'translate3d(0, 0px, 0)' },
  ], expect.objectContaining({ duration: 108 }))
  animate.mock.results[0].value.dispatchEvent(new Event('finish'))
  expect(layout()).toBe(0)
})
