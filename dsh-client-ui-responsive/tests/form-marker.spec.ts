// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUBBLE_CHROME_ATTR,
  DEVICE_FORM_ATTR,
  MobileFormMarker,
  classifyDeviceForm,
  rightbarOverlaysConversation,
  usesBubbleChrome,
} from '../src/client/mobile/form-marker.ts'

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height })
}

describe('classifyDeviceForm: (shortSide, aspectRatio) four-state model', () => {
  it('classifies standard portrait and landscape phones', () => {
    expect(classifyDeviceForm(412, 915)).toBe('phone-portrait')
    expect(classifyDeviceForm(915, 412)).toBe('phone-landscape')
    expect(classifyDeviceForm(360, 800)).toBe('phone-portrait')
    expect(classifyDeviceForm(800, 360)).toBe('phone-landscape')
  })

  it('prevents ultra-high-DPI elongated phones (20:9 / 21:9) from being misclassified as tablets', () => {
    expect(classifyDeviceForm(600, 1260)).toBe('phone-portrait')
    expect(classifyDeviceForm(1260, 600)).toBe('phone-landscape')
    expect(classifyDeviceForm(640, 1280)).toBe('phone-portrait')
    expect(classifyDeviceForm(1280, 640)).toBe('phone-landscape')
  })

  it('gives 16:9 emulators (1600x900 @ DPR 1.5 = 1067x600 / 1067x566 with status bar) and landscape tablets full PC semantics', () => {
    expect(classifyDeviceForm(1067, 600)).toBe('desktop-landscape')
    expect(classifyDeviceForm(1067, 566)).toBe('desktop-landscape')
    expect(classifyDeviceForm(1280, 720)).toBe('desktop-landscape')
    expect(classifyDeviceForm(1024, 768)).toBe('desktop-landscape')
  })

  it('classifies portrait tablets cleanly', () => {
    expect(classifyDeviceForm(768, 1024)).toBe('tablet-portrait')
    expect(classifyDeviceForm(800, 1280)).toBe('tablet-portrait')
  })

  it('computes chrome and rightbar overlay semantics per device form', () => {
    expect(usesBubbleChrome('phone-portrait')).toBe(true)
    expect(usesBubbleChrome('phone-landscape')).toBe(true)
    expect(usesBubbleChrome('tablet-portrait')).toBe(true)
    expect(usesBubbleChrome('desktop-landscape')).toBe(false)

    expect(rightbarOverlaysConversation('phone-portrait', false)).toBe(true)
    expect(rightbarOverlaysConversation('phone-landscape', false)).toBe(false)
    expect(rightbarOverlaysConversation('phone-landscape', true)).toBe(true)
    expect(rightbarOverlaysConversation('tablet-portrait', false)).toBe(false)
    expect(rightbarOverlaysConversation('desktop-landscape', false)).toBe(false)
  })
})

describe('MobileFormMarker live DOM attributes', () => {
  const markers: MobileFormMarker[] = []
  afterEach(() => {
    while (markers.length > 0) markers.pop()!.detach()
  })

  it('publishes data-dsh-device-form and updates on resize across 1600x900 emulator & phone orientations', () => {
    setViewport(412, 915)
    const marker = new MobileFormMarker()
    markers.push(marker)
    marker.attach()

    expect(document.documentElement.getAttribute(DEVICE_FORM_ATTR)).toBe('phone-portrait')
    expect(document.documentElement.hasAttribute(BUBBLE_CHROME_ATTR)).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-form')).toBe(true)

    setViewport(915, 412)
    window.dispatchEvent(new Event('resize'))
    expect(document.documentElement.getAttribute(DEVICE_FORM_ATTR)).toBe('phone-landscape')
    expect(document.documentElement.hasAttribute(BUBBLE_CHROME_ATTR)).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-form')).toBe(false)

    setViewport(1067, 600)
    window.dispatchEvent(new Event('resize'))
    expect(document.documentElement.getAttribute(DEVICE_FORM_ATTR)).toBe('desktop-landscape')
    expect(document.documentElement.hasAttribute(BUBBLE_CHROME_ATTR)).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-mobile-form')).toBe(false)
  })
})
