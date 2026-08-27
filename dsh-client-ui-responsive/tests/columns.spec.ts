// @vitest-environment node
// Concession-chain solver unit tests: columns.ts is the purest logic in the package
// (input = viewport + preferences, output = three-column widths).
import { describe, it, expect } from 'vitest'
import {
  clampWidth, computeColumns,
  CENTER_MIN, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT, SIDEBAR_COLLAPSED,
  DETAILS_MIN, DETAILS_MAX, DETAILS_DEFAULT,
} from '../src/client/columns.ts'

describe('clampWidth', () => {
  it('低于下界钳到下界', () => {
    expect(clampWidth(100, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(SIDEBAR_MIN)
  })
  it('高于上界钳到上界', () => {
    expect(clampWidth(500, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(SIDEBAR_MAX)
  })
  it('区间内原样返回（取整）', () => {
    expect(clampWidth(300.6, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(301)
  })
})

describe('computeColumns 让步链', () => {
  it('Step 1：宽视口全部按偏好宽度', () => {
    const cols = computeColumns(1400, SIDEBAR_DEFAULT, DETAILS_DEFAULT)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.details).toBe(DETAILS_DEFAULT)
    expect(cols.center).toBe(1400 - SIDEBAR_DEFAULT - DETAILS_DEFAULT)
  })

  it('Step 1 边界：恰好等于偏好和 + CENTER_MIN', () => {
    const v = SIDEBAR_DEFAULT + DETAILS_DEFAULT + CENTER_MIN
    const cols = computeColumns(v, SIDEBAR_DEFAULT, DETAILS_DEFAULT)
    expect(cols.center).toBe(CENTER_MIN)
    expect(cols.details).toBe(DETAILS_DEFAULT)
  })

  it('Step 2：details 让步到最小值，center 保住 CENTER_MIN', () => {
    // Step 2 pass boundary: s + DETAILS_MIN + CENTER_MIN <= viewport < s + d0 + CENTER_MIN
    const v = SIDEBAR_DEFAULT + DETAILS_MIN + CENTER_MIN // = 1220 (exactly passing)
    const cols = computeColumns(v, SIDEBAR_DEFAULT, DETAILS_DEFAULT)
    expect(cols.details).toBe(DETAILS_MIN)
    expect(cols.center).toBe(CENTER_MIN)
  })

  it('Step 2 边界 -1：差 1px 即走 Step 3 自动关闭', () => {
    const v = SIDEBAR_DEFAULT + DETAILS_MIN + CENTER_MIN - 1
    const cols = computeColumns(v, SIDEBAR_DEFAULT, DETAILS_DEFAULT)
    expect(cols.details).toBe(0)
    expect(cols.center).toBe(v - SIDEBAR_DEFAULT)
  })

  it('Step 3：details 让步到最小仍放不下 → 自动关闭（偏好不被重写）', () => {
    const v = SIDEBAR_DEFAULT + DETAILS_MIN + CENTER_MIN - 1
    const cols = computeColumns(v, SIDEBAR_DEFAULT, DETAILS_DEFAULT)
    expect(cols.details).toBe(0)
    expect(cols.center).toBe(v - SIDEBAR_DEFAULT)
  })

  it('兜底：极窄视口 center 可低于 CENTER_MIN（最终回退），不为负', () => {
    const cols = computeColumns(200, SIDEBAR_DEFAULT, DETAILS_DEFAULT)
    expect(cols.details).toBe(0)
    expect(cols.center).toBe(Math.max(0, 200 - SIDEBAR_DEFAULT))
    expect(cols.center).toBeGreaterThanOrEqual(0)
  })

  it('sidebar 从不让步：宽度偏好原样进入求解', () => {
    const v = 800
    const cols = computeColumns(v, 420, 520)
    expect(cols.sidebar).toBe(420)
    expect(cols.details).toBe(0)
    expect(cols.center).toBe(v - 420)
  })

  it('sidebar=0 解析为固定轨道宽度（rail），不是 0', () => {
    const cols = computeColumns(1000, 0, 0)
    expect(cols.sidebar).toBe(SIDEBAR_COLLAPSED)
    expect(cols.details).toBe(0)
    expect(cols.center).toBe(1000 - SIDEBAR_COLLAPSED)
  })

  it('details=0（已关闭）不因让步而打开', () => {
    const cols = computeColumns(700, SIDEBAR_DEFAULT, 0)
    expect(cols.details).toBe(0)
    expect(cols.center).toBe(700 - SIDEBAR_DEFAULT)
  })

  it('偏好越界时重钳（跨 store 边界防御）', () => {
    const cols = computeColumns(1400, 9999, -5)
    expect(cols.sidebar).toBe(SIDEBAR_MAX)
    expect(cols.details).toBe(DETAILS_MIN) // -5 → clamped to min (not 0; callers pass 0 to actually close)
  })

  it('无滞回：相同输入输出相同（恢复性）', () => {
    const a = computeColumns(1100, SIDEBAR_DEFAULT, DETAILS_DEFAULT)
    const b = computeColumns(1100, SIDEBAR_DEFAULT, DETAILS_DEFAULT)
    expect(a).toEqual(b)
  })
})
