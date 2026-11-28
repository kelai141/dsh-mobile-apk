// @vitest-environment jsdom
import { expect, it } from 'vitest'

import { COMPOSER_MENU_CSS } from '../src/client/composer-menu.css.ts'

it('lets the suggestion viewport shrink without collapsing its section and source headings', () => {
  const style = document.createElement('style')
  style.textContent = `
    .section-title { flex: none; min-height: 23px; }
    .source-title { flex: 0 1 auto; min-height: auto; }
    ${COMPOSER_MENU_CSS}
  `
  const composer = document.createElement('div')
  composer.setAttribute('data-composer-card', '')
  composer.innerHTML = `
    <div data-menu-material="translucent">
      <div aria-hidden="true"></div>
      <div role="listbox">
        <div role="presentation" class="section-title">Add</div>
        <button role="option">File</button>
        <div role="presentation" class="source-title" data-source="skills">Skills</div>
        <button role="option">Example</button>
      </div>
    </div>
  `
  document.head.append(style)
  document.body.append(composer)
  try {
    const menu = composer.querySelector('[role="listbox"]')!
    const sectionTitle = getComputedStyle(menu.children[0])
    const sourceTitle = getComputedStyle(menu.children[2])
    expect([sectionTitle.flexShrink, sectionTitle.minHeight]).toEqual(['0', '23px'])
    expect([sourceTitle.flexGrow, sourceTitle.minHeight]).toEqual(['0', 'auto'])

    const viewport = getComputedStyle(menu)
    expect([viewport.flexGrow, viewport.flexShrink, viewport.minHeight]).toEqual(['1', '1', '0'])
  } finally {
    composer.remove()
    style.remove()
  }
})
