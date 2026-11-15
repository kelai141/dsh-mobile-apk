# 2026-11-15：并行 XZ 的判据读了堆上限，导致 OOM 后整段重解（issue #1714）

## 现象

首次解包（或覆盖安装后换快照）时，并行 XZ 解码跑了一段后抛 `OutOfMemoryError`，
整段回落到单线程，把已经解过的内容**全部重解一遍**。

设备 `emulator-5586`（API 35、x86_64）logcat 原文：

```
W dsh-snap: parallel xz decode failed after 120155ms; falling back to single thread
            (this is not an extraction failure)
W dsh-snap: java.lang.OutOfMemoryError: Failed to allocate a 368 byte allocation with
            296032 free bytes and 289KB until OOM, target footprint 201326592,
            growth limit 201326592; giving up on allocation because <1% of heap free after GC.
```

## 真因：判据读的是堆上限，不是当前余量

`ParallelPlan.threadsFor` 的两个阈值（128 MiB → 2 线程 / 256 MiB → 4 线程）本身是实测出来的，
数没问题。问题在**喂给它的那个数**：

```kotlin
// 修前
fun production(): ParallelPlan {
  val runtime = Runtime.getRuntime()
  return ParallelPlan(threadsFor(runtime.availableProcessors(), runtime.maxMemory()))
  //                                                          ^^^^^^^^^^^^^^^^^^ 堆上限，恒定
}
```

`maxMemory()` 是**堆上限**，从进程启动到退出都不变。而 OOM 那条日志同时写着两件事：

- `growth limit 201326592` —— 上限 192 MiB，与 `maxMemory()` 读到的完全一致；
- `296032 free bytes` —— 实际只剩 289 KB，一次 368 字节的分配都拿不到。

也就是说：**判据读到的数（192 MiB）与真实处境（289 KB）完全脱钩**。解压前刚跑完快照校验、
堆已经涨上去时，判据照样看到「192 MiB 可用」⇒ 放行 2 线程 ⇒ 每个 worker 再要一份 xz 字典 ⇒
立刻 OOM ⇒ 回落单线程重解。

这也解释了为什么「阈值有实测依据」仍然挡不住：那些实测是在**刚启动的进程**上做的
（`-Xmx128m/-Xmx192m/-Xmx256m` 三档），那时「上限 ≈ 余量」，两种读法给出同一个答案。
真实触发场景是「解压前堆已用了一部分」，两种读法分道扬镳。

## 修法

判据来源从「上限」换成「余量」，并再扣一段保底：

```kotlin
// 修后
fun production(): ParallelPlan {
  val runtime = Runtime.getRuntime()
  return ParallelPlan(
    threadsFor(runtime.availableProcessors(), liveFreeHeapBytes(runtime)),
  )
}

fun liveFreeHeapBytes(runtime: Runtime): Long {
  val used = runtime.totalMemory() - runtime.freeMemory()
  return (runtime.maxMemory() - used).coerceAtLeast(0L)
}
```

`threadsFor` 内部再扣 `PARALLEL_HEAP_RESERVE_BYTES`（64 MiB）后才比阈值：

```kotlin
val usable = maxHeapBytes - PARALLEL_HEAP_RESERVE_BYTES
if (usable < MIN_HEAP_FOR_TWO_BYTES) return 1
val heapCap = if (usable >= MIN_HEAP_FOR_FOUR_BYTES) MAX_THREADS else 2
```

三段设计的理由：

1. **余量而非上限** —— 这是 #1714 的核心。上限恒定，余量随已用堆下降，只有后者能反映真实处境。
2. **扣保底余量** —— xz 字典 + tar 缓冲 + 解压期间的临时分配。扣完不够就是不够，
   不让并行把最后一点堆吃干；退化了只是慢，OOM 是装不了应用。
3. **钳到 0 以上** —— 极端 GC 压力下 `used > max` 会出现负余量，负值对调用方没有意义。

形参名沿用 `maxHeapBytes` 只为保持既有命名参数调用兼容，**语义以注释为准**（注释里写明了这一点）。

## 判据

`SnapshotParallelDecodeTest`，17 例：

```
com.dsharnessmobile.shell.SnapshotParallelDecodeTest: tests=17 fail=0
```

新增/改写的四条：

| 用例 | 钉什么 |
|---|---|
| `liveFreeHeapIsCeilingMinusUsed` | 余量必须等于「上限 − 已用」，用同一个 Runtime 的读数交叉验证（不钉常量，堆大小随机器变） |
| `sameCeilingDifferentUsageYieldsDifferentPlans` | **核心判据**：同一 192 MiB 上限下，「刚启动」放行并行、「堆已用满（余量 289 KB）」必须退单线程，且两者结论必须不同 |
| `threadPlanDegradesOnSmallHeaps` | 各档阈值改为按「保底 + 阈值」推导（`reserve + MIN_HEAP_FOR_*"），不再写死 128/256 |
| `threadPlanNeverExceedsFourOrCoresOrBlocks` | 上限 4 / 不超核数 / 不超块数（把「丰厚余量」抽成局部变量，说明入参是余量） |

### 负控

把 `liveFreeHeapBytes` 退回 `return runtime.maxMemory()`（即修前的语义）：

```
tests=17 fail=1
  RED: liveFreeHeapIsCeilingMinusUsed
```

恢复后 17/17 绿（原地 edit + 恢复，未使用 git stash）。

**只有 1 条转红是预期的**：`threadsFor` 是纯函数，它对自己的入参从来没有判错——
错的只是 `production()` 喂给它的那个数。所以「纯函数阈值档位」那几条在负控下仍绿是正确的，
真正该红的只有「余量来源」那一条。

### 一条失败的判据形态（如实记录）

第一版判据写的是「把本进程的堆顶到接近上限，再断言 `production()` 退单线程」。
它在本地 **failed**：`expected:<1> but was:<2>`。

原因是**判据不可靠而非代码错**：Gradle 测试 JVM 的堆上限是宿主机给的（本机 2 GiB 起步），
`LongArray` 顶到 `maxHeap/2` 也压不到 64 MiB 保底以下，于是「已占满」这个前提根本没建立，
断言自然不成立。换成「上限 − 已用」的恒等式判据 + 纯函数双档对照后，判据既确定又有判别力。

**可复用的教训**：涉及「内存压力下行为改变」的判据，不要试图在单测里真的制造内存压力——
测试 JVM 的堆大小不受你控制。把「压力」表达成**入参**，用纯函数断言两种入参给出不同结论。
