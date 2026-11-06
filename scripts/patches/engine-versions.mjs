// engine-versions.mjs —— 补丁断言用的版本真源（单一真源，禁止在补丁里硬编码版本号）。
//
// 为什么存在：0.2.2-rc.1 追版时 image-* / mimo / ptc-android 一共 10 处把 '0.2.1-rc.3' 写死在
// 断言里，抬 baseline 后这些补丁不是「失配报错」而是「抛错中断整个探针」，于是命中矩阵跑不完,
// 失配条数也拿不到。写死版本的断言等于把「跟着合同走」变成「跟着上一代走」。
//
// 口径：
//   ENGINE_BASELINE  = scripts/contract.json 的 baseline（引擎第一方包版本）
//   PINNED_PI_AI     = scripts/snapshot-config/engine-overlay.json 的 pins['@earendil-works/pi-ai']
// 补丁只断言「被测包版本 == 合同声明的版本」，不假设具体数字。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

const contract = JSON.parse(readFileSync(join(ROOT, 'scripts', 'contract.json'), 'utf8'))
const overlay = JSON.parse(readFileSync(join(ROOT, 'scripts', 'snapshot-config', 'engine-overlay.json'), 'utf8'))

/** 引擎第一方包版本（contract.baseline）。 */
export const ENGINE_BASELINE = contract.baseline

/** pi-ai 的钉死版本（overlay.pins）；缺登记时明确失败，不猜。 */
export const PINNED_PI_AI = (() => {
  const v = overlay.pins && overlay.pins['@earendil-works/pi-ai']
  if (typeof v !== 'string' || v === '') {
    throw new Error('engine-overlay.json 缺 pins["@earendil-works/pi-ai"]：补丁断言没有可用的 pi-ai 版本真源')
  }
  return v
})()

/** 断言被测包版本 == 合同基线；detail 用于报错时说明是哪个包。 */
export function assertEngineBaseline(manifest, detail) {
  if (manifest.version !== ENGINE_BASELINE) {
    throw new Error(`${detail} requires ${ENGINE_BASELINE}（contract.baseline），实际 ${manifest.version}`)
  }
}
