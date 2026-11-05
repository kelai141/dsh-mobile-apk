# Mux 客户端补读超时（2026-11-03，issue #1401）

## 现象

Mux 客户端从不设置 `soTimeout`：握手阶段的 `readLine(ins)` 与帧循环的 `ins.read()` 都是无限阻塞。
网关 accept 后不回 upgrade、或引擎被杀而 TCP 未 RST（半开连接）时，读线程永久卡住——
重连循环里的退避与自愈都不进入，审批卡与提问卡静默不弹，直到用户重启应用。

## 真因

`connect(..., 3000)` 的超时只管**建连**，不管建连之后的读。代码里没有任何一处
`socket.soTimeout`，于是「服务端不回包」这种最常见的半开形态没有任何时间界：
`read()` 返回的唯一条件是对方发包、对方 RST、或本端 close。

## 修法

两段各自设超时，超时按**失败**抛出（走 `loop()` 既有的 catch → 失败计数 → 退避）：

- 握手：`s.soTimeout = HANDSHAKE_TIMEOUT_MS`（5 秒）；
- 帧循环：进 `frameLoop` 之前 `s.soTimeout = READ_TIMEOUT_MS`（60 秒 ≈ 网关 30 秒心跳的两拍）；
- `SocketTimeoutException` 翻译成 `IOException("frame read timeout (60000ms)")`，日志里能直接
  看出是「半开」而不是 EOF。

没有新增线程、没有新增重连路径：超时复用「连接被拒」那条自愈链。

## 复验

`MuxReadTimeoutTest` 两条用例：① 两个阶段各自设了超时、超时被翻译成失败、两个数值都是具名常量；
② 握手超时必须先于帧读超时、帧读超时紧接在进 `frameLoop` 之前（顺序错等于某一段仍无界）。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：改前 7 条全红，
  改后 7 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED
  （`MuxClient.kt` 两处锚点按 +14 行手钉并补 `#expect`）。
- **未做设备验证**：本机无模拟器。半开连接的现场复验见 PR 验收卡（`nc -l` 只 accept 不回包）。
