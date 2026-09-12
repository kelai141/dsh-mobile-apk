// 源码级纪律门禁（ST-09 / ST-27）：组件里禁止裸写一次性桥读。
// 判据（计划 §4.3 ST-09）：grep "useState(() => window.androidBridge" 命中数 = 0。
import { test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

test('ST-09/ST-27：src 内不得存在 useState(() => window.androidBridge 这类裸写一次性桥读', () => {
  const hits: string[] = []
  for (const file of walk(SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // 与计划 §4.3/ST-27 的判据同形：字面子串命中（注释里出现也算，避免门禁被注释糊过去）
      if (line.includes('useState(() => window.androidBridge')) hits.push(file + ':' + (i + 1))
    })
  }
  expect(hits, '裸写一次性桥读必须改用 useShellState').toEqual([])
})

test('ST-09：壳体状态读点都经 useShellState（DevSection 三处 + 设置页一处）', () => {
  const files = walk(SRC)
  // 路径分隔符跨平台（Windows 是 \\）：只按文件名判定
  const dev = files.find((f) => f.endsWith('DevSection.tsx'))
  const general = files.find((f) => f.endsWith('GeneralSettings.tsx'))
  const hook = files.find((f) => f.endsWith('use-shell-state.ts'))
  expect(dev && general && hook, '三个文件必须存在').toBeTruthy()
  const devText = readFileSync(dev as string, 'utf8')
  const genText = readFileSync(general as string, 'utf8')
  expect(devText).toContain("from '../mobile/use-shell-state.ts'")
  expect(genText).toContain("from '../mobile/use-shell-state.ts'")
  expect((devText.match(/useShellState</g) ?? []).length).toBeGreaterThanOrEqual(3)
  expect((genText.match(/useShellState</g) ?? []).length).toBeGreaterThanOrEqual(1)
  // 反向：旧的裸读形态必须彻底消失（否则门禁形同虚设）
  expect(/setAllFiles\(window\.androidBridge/.test(devText), 'DevSection 仍在 effect 里裸读桥').toBe(false)
})
