// @vitest-environment node
// CSS string sanity checks: mobile-settings.css.ts once shipped an unclosed selector block
// ({7 / }5) injected as <style> — the rule never applied and no build/test step caught it.
// This test asserts brace balance on the template strings of src/**/*.css.ts so the same
// class of mistake cannot slip through again.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Collect every *.css.ts path under src. */
function collectCssTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectCssTs(full))
    else if (entry.name.endsWith('.css.ts')) out.push(full)
  }
  return out
}

describe('CSS 注入字符串健全性', () => {
  const files = collectCssTs(join(root, 'src'))
  it('存在 css.ts 文件（防测试自身静默空跑）', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const rel = relative(root, file)
    it(`${rel} 的花括号平衡`, () => {
      const source = readFileSync(file, 'utf8')
      // Extract the template string bodies: css.ts CSS lives inside backticks; pull all backticked fragments.
      const bodies: string[] = []
      for (const match of source.matchAll(/`([^`]*)`/g)) bodies.push(match[1])
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) {
        const open = (body.match(/\{/g) ?? []).length
        const close = (body.match(/\}/g) ?? []).length
        expect(open, `${rel} CSS 模板花括号不平衡（{ ${open} / } ${close}）`).toBe(close)
      }
    })
  }
})
