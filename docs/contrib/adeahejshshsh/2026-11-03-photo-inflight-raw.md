# 连拍不再删掉仍在压缩的原图（2026-11-03，issue #1387）

## 现象

连续拍照两次（间隔小于一次压缩耗时）时，第一张的回执可能写着「原图已保留」，而 detail 指向的
路径已经不存在；或者成品直接缺失。

## 真因

`pending` 在相机返回那一刻就置空（用户马上能拍第二张），而后台压缩线程还在读第一张的
`raw-*.jpg`；第二张的 `capture()` 一进来先跑 `sweepOld(photoDir, rawDir)`，其中原图那一路是
`keep = 0`——**一个不留**。于是第一张正在被读的文件被当垃圾删掉，`compress()` 读到缺失文件返回
null，走「保留原图」分支时原图已经没了，回执却照旧承诺「已保留」。

「原图可删」这条产品口径本身没错（压缩成功后确实该删），错的是清理侧不知道**哪些原图还在用**。

## 修法

`PhotoCapture.sweepOld()` 增加 `exclude: Set<String> = emptySet()`：原图那一路多一条
`it.name !in exclude`。控制器持有一个同步集合 `inFlightRawNames`：

- `finish()` 在**起压缩线程之前**登记原图名（起线程后再登记有窗口期让并发的清理抢在前面）；
- 线程 `finally` 注销（留在集合里会让同名原图永远清不掉）；
- `capture()` 把 `inFlightRawNames.toSet()` 交给 `sweepOld`。

没有把压缩串行化：第二张照样能立刻拍，只是清理不再碰在途文件。

## 复验

- `PhotoCaptureTest.连拍时仍在压缩的原图不被清理删掉`：在途原图活下来、不在途的照旧清掉、
  返回值只计被删的那张（纯 File 操作，JVM 可直接跑）。
- `PhotoCaptureTest.控制器把在途原图交给清理侧排除`：排除集真的传下去、用的是同步集合、
  登记先于起线程、线程结束会注销。
- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本（源码契约部分）：
  改前 4 条全红，改后 4 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器、装不了包。连拍的真机复验见 PR 验收卡。
