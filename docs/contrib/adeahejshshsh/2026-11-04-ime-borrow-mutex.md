# ADBKeyboard 借道 IME 加整段互斥（2026-11-04，issue #1373）

## 现象

两次并发的 `android_ui_input` 会各自读 prev、各自 `ime set`；先结束者在 `finally` 里把输入法还原，
另一路的广播就落到错误 IME 上（`result=2/5`，220ms 重试仍失败），文本丢失，模型看到的是工具失败。

## 真因

「读 prev → `ime set` 本通道 → 广播 → 还原」这一整段没有互斥。每一步都是异步 await，两路调用
天然会在 await 边界穿插；而 `prev` 是**进程级共享状态**（当前默认输入法），被两路各读一次。

## 修法

- 新增 `acquireImeBorrow()`：一条 promise 链（Node 单线程，链即可作互斥），返回放行函数；
- 借道段开始前 `await acquireImeBorrow()`；
- 现有 `finally` 里先还原输入法、再放行（放行放在 `finally` 的内层 `try/finally`，保证异常路径也放行）。

## 复验

`plugins/dsh-android-manage/test/ime-borrow-mutex.test.mjs` 两条：源码里借道段必须取锁且放行落在
`finally` 内；并用与实现同构的最小互斥做行为断言（串行、失败那一路也让出）。

- 本机直接跑：2/2 通过。
- 本机同判据脚本：改前 3 条红，改后 3 条全绿。
- `node scripts/check-code-map.mjs` → PASSED（插件锚点按三段偏移重钉）。
- **未做设备验证**：本机无模拟器。并发输入的真机复验见 PR 验收卡。
