/**
 * ADBKeyboard 借道 IME 的整段互斥（issue #1373）。
 *
 * 「读 prev → `ime set` 本通道 → 广播 → 还原」这一整段不能被两路并发穿插：两路各自读 prev、各自切换，
 * 先结束者在 finally 里把输入法还原，另一路的广播就落到错误 IME 上（result=2/5，220ms 重试仍失败）。
 *
 * 为什么单独成模块：判据必须验**真实现**。原先的写法把一条等价的 promise 链**手抄**进测试，
 * 测的是抄件——真实现改成不互斥，测试照样绿。
 */
export interface ImeBorrowLock {
  /** 取得借道锁；返回值**必须**在 finally 里调用一次以放行下一路（重复调用安全）。 */
  acquire(): Promise<() => void>
}

/**
 * 用一条 promise 链做互斥（Node 单线程，链即可作锁）。
 *
 * 语义：`acquire()` 返回时，前面所有持有者**都已 release**；释放是幂等的，
 * 重复调用不会破坏队列。
 */
export function createImeBorrowLock(): ImeBorrowLock {
  let tail: Promise<void> = Promise.resolve()
  return {
    async acquire() {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>((resolve) => { release = resolve })
      await previous
      let released = false
      return () => {
        if (released) return
        released = true
        release()
      }
    },
  }
}

/** 进程级单例：所有借道入口共用同一条链。 */
export const imeBorrowLock: ImeBorrowLock = createImeBorrowLock()
