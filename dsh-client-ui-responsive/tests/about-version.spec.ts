// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AboutSection } from '../src/client/mobile/about-section.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined

afterEach(async () => {
  if (root !== undefined) {
    const current = root
    await act(async () => { current.unmount() })
  }
  root = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function renderVersion(): Promise<string | null | undefined> {
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  await act(async () => {
    root = createRoot(mount)
    root.render(createElement(AboutSection, {} as never))
  })
  return mount.querySelector('[data-dsh-about-engine-version]')?.textContent
}

function addLegacyVersionRow(): void {
  const row = document.createElement('div')
  row.setAttribute('data-dsh-about-source', '0.2.1-rc.2')
  row.textContent = 'Current version: 0.2.1-rc.2'
  document.body.appendChild(row)
}

describe('About release identity', () => {
  it('renders the Host release on a direct visit before General settings is mounted', async () => {
    vi.stubGlobal('__DSH_BOOT__', { release: { version: '0.2.2-rc.3' } })
    expect(document.querySelector('[data-dsh-about-source]')).toBeNull()
    expect(await renderVersion()).toContain('0.2.2-rc.3')
  })

  it('uses the same Host release when the General settings row contains an older version', async () => {
    vi.stubGlobal('__DSH_BOOT__', { release: { version: '0.2.2-rc.3' } })
    addLegacyVersionRow()
    const version = await renderVersion()
    expect(version).toContain('0.2.2-rc.3')
    expect(version).not.toContain('0.2.1-rc.2')
  })

  it('leaves the version unavailable when the Host omits its release metadata', async () => {
    vi.stubGlobal('__DSH_BOOT__', {})
    addLegacyVersionRow()
    expect(await renderVersion()).toContain('—')
  })
})
