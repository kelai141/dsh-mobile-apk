// @vitest-environment jsdom
// 注入层扫描的**规模不变性**判据（缺陷 3「整体卡顿」）。
//
// 为什么不设绝对阈值：绝对阈值（「每批 ≤ N 次」）在观察者增删时会变成噪声源——加一个观察者就红，
// 与卡顿无关。这里只断言**规模不变性**：同一批提交在 n=400 与 n=1,600 两档会话上，整文档查询
// 次数必须相同。它守的是一条结构性质：注入层的每批代价是常数，不随会话长度增长。
//
// 常数本身太大这件事，由两条针对性预算守：
//   - tests/back-stack-scan-budget.spec.ts（每批 ≤ 2 次，修复前 10.00）
//   - tests/scroll-frame-budget.spec.ts（每帧 = 0，修复前 4.00）
//
// 反向对照：本文件自带一条计数器的判别力用例，证明它真的能数出调用（否则两档都读 0 也假绿）。
import { beforeAll, describe, expect, it } from 'vitest'
import { countDomScans, settle } from './dom-scan-counter.ts'
import { attachBootObservers, buildConversation, installResizeObserverStub } from './dom-scan-fixtures.ts'

beforeAll(() => { installResizeObserverStub() })

/**
 * 跑一批流式提交并读整文档查询次数。
 * @param paragraphs - 会话长度。
 * @param batches - 提交批数。
 * @returns 每批整文档查询次数。
 */
async function measure(paragraphs: number, batches: number): Promise<number> {
  const conversation = buildConversation(paragraphs)
  const dispose = await attachBootObservers()
  await settle()
  await settle()
  const counter = countDomScans()
  try {
    for (let batch = 0; batch < batches; batch++) {
      const wrapper = document.createElement('div')
      for (let token = 0; token < 3; token++) {
        const span = document.createElement('span')
        span.textContent = 'token'
        wrapper.appendChild(span)
      }
      conversation.appendChild(wrapper)
      await settle()
    }
    return counter.stats.documentCalls / batches
  } finally {
    counter.restore()
    dispose()
  }
}

const BATCHES = 20

describe('注入层扫描的规模不变性', () => {
  it('① 每批整文档查询次数与文档规模无关（n=400 与 n=1600 同值）', async () => {
    const small = await measure(400, BATCHES)
    const large = await measure(1_600, BATCHES)
    console.log('① small=' + small.toFixed(2) + ' large=' + large.toFixed(2))
    expect(small, '小文档每批整文档查询次数').toBe(large)
  }, 120_000)

  it('② 反向对照：计数器能数出真实调用（两档夹具都读到 5 次）', async () => {
    const readings: number[] = []
    for (const paragraphs of [400, 1_600]) {
      const conversation = buildConversation(paragraphs)
      const counter = countDomScans()
      try {
        for (let batch = 0; batch < 5; batch++) {
          conversation.appendChild(document.createElement('span'))
          document.querySelectorAll('[role="dialog"]')
          await settle()
        }
        readings.push(counter.stats.documentCalls)
      } finally {
        counter.restore()
      }
    }
    console.log('② fixture_readings=' + JSON.stringify(readings))
    expect(readings, '夹具每批 1 次整文档查询 × 5 批').toEqual([5, 5])
  }, 60_000)
})
