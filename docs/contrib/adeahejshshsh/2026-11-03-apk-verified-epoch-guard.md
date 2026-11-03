# verifiedArtifact 的写入补换代守卫（2026-11-03，issue #1410）

## 现象

`verifiedArtifact` 是单槽字段。下载线程在**换代之后**仍会把它覆盖成旧产物；随后 `install()`
可能以旧产物为依据拉起安装器——校验结论与实际包不一致。

## 真因

同一个函数里，两处早退都写了 `if (!isCurrentEpoch(e)) return`（下载完成、校验驳回），唯独收尾
那次赋值没有。差别来自写法：前两处是「状态机转移」（必须确认还是当前代），收尾这处被当成
「只是记个字段」——但它是**共享单槽**，换代后写入等于把上一轮的结论盖到新一轮头上。

## 修法

```kotlin
synchronized(publicationLock) {
  if (isCurrentEpoch(e)) verifiedArtifact = VerifiedArtifact(dest, r.sizeBytes, r.sha256)
}
```

锁与守卫都要：锁保证与 `install()` 的读写互斥，守卫保证旧代不写入。与 `install()` 里既有的
`if (isCurrentEpoch(e))` 同一口径。

## 复验

`UpdateArtifactRecheckTest.下载收尾写 verifiedArtifact 必须带换代守卫`：赋值必须落在
`synchronized(publicationLock)` 内且受 `isCurrentEpoch(e)` 守卫，并反证「不得回到裸赋值」。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：改前 2 条红，
  改后 3 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器。换代时序的真机复验见 PR 验收卡。
