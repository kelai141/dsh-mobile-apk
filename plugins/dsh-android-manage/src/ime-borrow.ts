/**
 * ADBKeyboard 借道 IME 的整段互斥（issue #1373）。
 *
 * 「读 prev → `ime set` 本通道 → 广播 → 还原」这一整段不能被两路并发穿插：两路各自读 prev、各自切换，
 * 先结束者在 finally 里把输入法还原，另一路的广播就落到错误 IME 上（result=2/5，220ms 重试仍失败）。
 *
 * issue #1516：互斥本身也有代价——排队那一路此前在 `await previous` 上**无超时、无回执**地静默等待，
 * 前一路若卡在设备回填（单条 execShell 最长 20s），后面的注入全部无声卡死，最长实测到 9 秒级。
 * 现在 `acquire` 带排队预算：到点抛 [ImeBorrowTimeout] 并**把自己从队头让位**（否则一条永不 resolve
 * 的队头会把后面每一路都锁死）；回执侧（`android_ui_input`）据 `release.waitedMs` / 错误体如实说明
 * 等了多久、为什么没轮上，而不是静默排队。
 *
 * 为什么单独成模块：判据必须验**真实现**。原先的写法把一条等价的 promise 链**手抄**进测试，
 * 测的是抄件——真实现改成不互斥，测试照样绿。
 */
export interface ImeBorrowAcquireOptions {
  /** 排队预算（毫秒）；缺省或非正数表示不设上限（仅保留给不需要回执的调用点）。 */
  timeoutMs?: number
}

export interface ImeBorrowLock {
  /**
   * 取得借道锁；返回值**必须**在 finally 里调用一次以放行下一路（重复调用安全）。
   * 排队超过 [ImeBorrowAcquireOptions.timeoutMs] 时以 [ImeBorrowTimeout] 拒绝——**没有**取得锁，
   * 调用方不得执行临界区。
   */
  acquire(options?: ImeBorrowAcquireOptions): Promise<ImeBorrowRelease>
}

/** 释放句柄；附带本路的排队量，供工具回执如实说明（issue #1516 的「回执」）。 */
export interface ImeBorrowRelease {
  (): void
  /** 从调用 acquire 到真正拿到锁的毫秒数；队列空时为 0。 */
  waitedMs: number
  /** 本路排在第几路之后（0 = 前面没人）。 */
  queued: number
}

/** 排队超时：等待量在 `waitedMs` 里，回执直接引用它。 */
export class ImeBorrowTimeout extends Error {
  readonly waitedMs: number
  /** 本次排队用的预算（与 waitedMs 一起进回执：用户要看出「等了多久、允许多久」）。 */
  readonly budgetMs: number

  constructor(waitedMs: number, budgetMs: number) {
    super(`IME 借道排队 ${waitedMs}ms 超时（预算 ${budgetMs}ms；前一路的切换/还原未结束）`)
    this.name = 'ImeBorrowTimeout'
    this.waitedMs = waitedMs
    this.budgetMs = budgetMs
  }
}

/**
 * 用一条 promise 链做互斥（Node 单线程，链即可作锁）。
 *
 * 语义：`acquire()` 返回时，前面所有持有者**都已 release**；释放是幂等的，
 * 重复调用不会破坏队列。
 *
 * issue #1516：等待**必须有边界**，且超时的那一路必须让位——它已经把自己挂成了队尾，
 * 若不让位，后面每一路都排在一条永不完成的 promise 上（真实形态：第一路的 `finally`
 * 迟迟不执行，此后所有文本注入静默卡死）。
 */
export function createImeBorrowLock(): ImeBorrowLock {
  let tail: Promise<void> = Promise.resolve()
  /** 队伍里的路径数（含正在持锁的那一路）；只用于回执与 `queued` 计数。 */
  let inLine = 0
  return {
    async acquire(options: ImeBorrowAcquireOptions = {}) {
      const startedAt = Date.now()
      const queued = inLine
      inLine += 1
      const previous = tail
      let handOff!: () => void
      let handedOff = false
      tail = new Promise<void>((resolve) => { handOff = resolve })
      // 放行下一路；幂等——正常释放与超时让位都走这里，顺带把自己从队伍里划掉。
      const handOffOnce = (): void => {
        if (handedOff) return
        handedOff = true
        inLine -= 1
        handOff()
      }
      const budget = options.timeoutMs
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (typeof budget === 'number' && budget > 0 && Number.isFinite(budget)) {
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ImeBorrowTimeout(Date.now() - startedAt, budget)), budget)
          })
          await Promise.race([previous, deadline])
        } else {
          await previous
        }
      } catch (error) {
        // 超时让位：本路的队头 promise 若永不 resolve，后面每一路都卡死在同一处。
        handOffOnce()
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      const waitedMs = Date.now() - startedAt
      const release = ((): void => { handOffOnce() }) as ImeBorrowRelease
      release.waitedMs = waitedMs
      release.queued = queued
      return release
    },
  }
}

/** 进程级单例：所有借道入口共用同一条链。 */
export const imeBorrowLock: ImeBorrowLock = createImeBorrowLock()
