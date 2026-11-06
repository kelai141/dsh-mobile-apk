// verify-frame-timing.test.mjs — verify-frame-timing.mjs 的纯函数自检（node --test）。
//
// 自检只覆盖「读数怎么算」这一层：分位数、帧汇总与判定口径、静止窗口汇总、启动分段。
// 采集器本身（CDP 连接、页内探针）需要设备，不在自检范围；但**判定口径**必须能红——
// 下面每个 describe 都带一条「同一函数在相反输入上给出相反结论」的反向用例。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { percentile, summarizeFrames, summarizeIdle, summarizeStartup } from './verify-frame-timing.mjs'

describe('percentile', () => {
  it('空样本返回 NaN，单样本返回自身', () => {
    assert.ok(Number.isNaN(percentile([], 0.5)))
    assert.equal(percentile([7], 0.95), 7)
  })

  it('线性插值：10 个样本的 p50 落在第 5、6 个之间', () => {
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5.5)
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0), 1)
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1), 10)
  })
})

describe('summarizeFrames', () => {
  it('主线程形状：帧间隔大且 longtask 有阻塞 → main-thread', () => {
    const gaps = Array.from({ length: 60 }, () => 70)
    const reading = summarizeFrames(gaps, [80, 120])
    assert.equal(reading.verdict, 'main-thread')
    assert.equal(reading.over50, 60)
    assert.equal(reading.longTasks, 2)
    assert.equal(reading.blockedMs, 200)
  })

  it('渲染层形状：帧间隔大但一条 longtask 都没有 → renderer', () => {
    const gaps = Array.from({ length: 60 }, () => 70)
    assert.equal(summarizeFrames(gaps, []).verdict, 'renderer')
  })

  it('反向对照：同一函数在顺滑输入上给 smooth（判定不是恒真）', () => {
    const gaps = Array.from({ length: 60 }, (_, index) => 16 + (index % 2))
    const reading = summarizeFrames(gaps, [])
    assert.equal(reading.verdict, 'smooth')
    assert.equal(reading.over50, 0)
  })

  it('短 longtask 不足以判主线程（阈值 50ms 阻塞）', () => {
    const gaps = Array.from({ length: 60 }, () => 20)
    assert.equal(summarizeFrames(gaps, [10, 10]).verdict, 'smooth')
  })
})

describe('summarizeIdle', () => {
  it('计数、频率、阻塞占比与最坏单次', () => {
    const reading = summarizeIdle([
      { action: 'tabs', ms: 2 },
      { action: 'tabs', ms: 6 },
      { action: 'select', ms: 1 },
    ], 5_000)
    assert.equal(reading.calls, 3)
    assert.equal(reading.perSecond, 0.6)
    assert.equal(reading.blockedMs, 9)
    assert.equal(reading.worstMs, 6)
    assert.deepEqual(reading.actions, ['tabs', 'select'])
  })

  it('反向对照：零调用时频率与阻塞都是 0（不是 NaN）', () => {
    const reading = summarizeIdle([], 5_000)
    assert.equal(reading.calls, 0)
    assert.equal(reading.perSecond, 0)
    assert.equal(reading.blockedShare, 0)
    assert.equal(reading.worstMs, 0)
  })
})

describe('summarizeStartup', () => {
  it('分段差值按「标记 − 首绘」与「load − 标记」算', () => {
    const reading = summarizeStartup({ domContentLoaded: 800, load: 1_500, firstPaint: 400, markerAt: 1_000 })
    assert.equal(reading.markerAfterFirstPaintMs, 600)
    assert.equal(reading.loadAfterMarkerMs, 500)
  })

  it('缺项为 null，不伪造成 0（未知与零必须分开）', () => {
    const reading = summarizeStartup({ domContentLoaded: 800 })
    assert.equal(reading.firstPaintMs, null)
    assert.equal(reading.markerAfterFirstPaintMs, null)
    assert.equal(reading.loadAfterMarkerMs, null)
  })
})
