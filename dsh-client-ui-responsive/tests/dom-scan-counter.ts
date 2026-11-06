/**
 * DOM 查询计数器（测试用）。
 *
 * 为什么需要它：本包的注入层里有十几个 MutationObserver，回调里用 `document.querySelector(...)`
 * 做**整文档**扫描。流式输出时每个 React 提交都会送来一批变更，于是「每次提交扫几遍整棵树」
 * 直接决定主线程每帧的代价 —— 会话越长，扫描越贵。这类缺陷不能用「源码里有这个字符串」判红
 * （换个写法就假绿），必须**数真实调用**。
 *
 * 两类调用分开记，因为它们代价不同：
 *  - `documentCalls`：`document.querySelector(All)`，每次都是整棵树的遍历，代价 ∝ 文档大小；
 *  - `elementCalls`：`someElement.querySelector(All)`，只遍历子树，代价 ∝ 子树大小。
 * 判据只看 `documentCalls`：子树查询的代价本来就跟调用点所在的子树相关，用文档大小当量纲会失真。
 */

/** 一次统计窗口内的读数。 */
export interface DomScanStats {
  /** `document.querySelector(All)` 的调用次数（整文档遍历）。 */
  documentCalls: number
  /** 元素上的 `querySelector(All)` 调用次数（子树遍历）。 */
  elementCalls: number
  /** 每次整文档调用时的文档元素总数之和（代价上界）。 */
  scanned: number
}

/** 计数器句柄：读 `stats`，用完必须 `restore()`（否则污染同文件后续用例）。 */
export interface DomScanCounter {
  readonly stats: DomScanStats
  restore(): void
}

/**
 * 开始计数。
 * @returns 计数器句柄；`restore()` 幂等。
 */
export function countDomScans(): DomScanCounter {
  const stats: DomScanStats = { documentCalls: 0, elementCalls: 0, scanned: 0 }
  const size = (): number => document.getElementsByTagName('*').length
  const undo: Array<() => void> = []
  const documentProto = Object.getPrototypeOf(document) as Record<string, unknown>
  const elementProto = window.Element.prototype as unknown as Record<string, unknown>
  for (const [proto, bucket] of [[documentProto, 'document'], [elementProto, 'element']] as const) {
    for (const name of ['querySelector', 'querySelectorAll'] as const) {
      const original = proto[name] as ((...args: unknown[]) => unknown) | undefined
      if (typeof original !== 'function') continue
      proto[name] = function (this: unknown, ...args: unknown[]): unknown {
        if (bucket === 'document') {
          stats.documentCalls += 1
          stats.scanned += size()
        } else {
          stats.elementCalls += 1
        }
        return original.apply(this, args)
      }
      undo.push(() => { proto[name] = original })
    }
  }
  let restored = false
  return {
    stats,
    restore: (): void => {
      if (restored) return
      restored = true
      for (const revert of undo) revert()
    },
  }
}

/**
 * 等观察者的合帧窗口都跑完。
 *
 * 本包的合帧窗口不止一种：rAF（top-bar-fold、composer-popup-guard）、setTimeout(0)
 * （back-stack）、microtask（file-card-actions）。只等宏任务会让 rAF 那一类**跨批漂移**
 * ——实测两档读数差 0.4 次/批，就是 rAF 节拍（约 16ms）没被两个 setTimeout(0) 赶上的结果。
 * 所以这里先等一帧 rAF，再等两轮宏任务：三个窗口都必然结算过一次。
 * @returns 合帧结算后的 promise。
 */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => { setTimeout(() => { setTimeout(() => { resolve() }, 0) }, 0) })
  })
}
