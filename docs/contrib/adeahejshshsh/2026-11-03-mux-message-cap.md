# 文本帧的跨分片累计上限（2026-11-03，issue #1402）

## 现象

`MAX_FRAME` 只限制单帧大小。一条消息拆成 N 个 `fin=0` 分片时，`textBuf` 会一直增长到
`MAX_FRAME × N`——异常或恶意上游能把壳侧直接撑到 OOM。

## 真因

判据挂在了「帧」这个粒度上，而缓冲是「消息」粒度：`0x1` 分支 `reset` 后写入、`0x0` 分支继续
追加，全程没有任何一处看 `textBuf.size()`。单帧上限对多分片消息不构成约束。

## 修法

- 新增 `MAX_MESSAGE = 8 MiB`（与单帧同量级：正常 `$events` 帧远小于它，超限说明对端不按协议说话）。
- 两个文本分支改走 `appendText(payload)`：写入前判 `textBuf.size() + payload.size > MAX_MESSAGE`，
  超限**先 reset 再抛**——半条消息不会留给下一条消息当开头。
- `appendText` 与 `MAX_MESSAGE` 放开到 `internal`：JVM 单测直接打边界（`MAX_MESSAGE` 可写、
  `MAX_MESSAGE + 1` 抛、抛完缓冲已重置）。

## 复验

`MuxMessageCapTest` 四例：① 上限与单帧同量级；② 刚好到上限可写、多一字节即抛；③ 超限后缓冲
被重置（不会被下一条消息继承）；④ 源码契约——两个文本分支都必须走 `appendText`（裸
`textBuf.write` 会绕过上限）。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本（源码契约部分）：
  改前 2 条全红，改后 2 条全绿；①②③ 是纯 JVM 行为断言，由 CI 跑。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED
  （`MuxClient.kt` 两处锚点按新行号手钉并补 `#expect`）。
- **未做设备验证**：本机无模拟器。可达性依赖上游能否发多分片消息，见 PR 验收卡。
