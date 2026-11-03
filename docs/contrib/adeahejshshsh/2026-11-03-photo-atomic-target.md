# 压缩失败不再残留半截成品（2026-11-03，issue #1388）

## 现象

拍照压缩失败时，`attachments/` 里会留下 0 字节或半截的 `photo-*.jpg`：它计入
`KEEP_PHOTOS = 10` 的配额、把好图挤掉，而且该目录落在 FileProvider 映射面内，可能被当成
成品分享出去。

## 真因

`compress()` 直接 `FileOutputStream(dst)` 写最终路径。失败分支只有调用方的
`keepRaw(job.raw)`（保住原图），**从不删 `job.target`**——于是「写到一半的成品」既没被当成失败
清掉，也没被当成成功接管，成了一个谁都不负责的文件。

## 修法

- 先写同目录临时文件 `dst.name + ".tmp"`，成功后 `publishCompressed(tmp, dst)` 转正；
- `publishCompressed` 在 rename 失败时**两边都删**（宁可这次压缩失败——调用方会保留原图并如实
  报错——也不留半截成品）；
- `compress` 的失败分支显式删临时文件；写盘抛异常时先删临时文件再抛出。

## 复验

- `PhotoCaptureTest.成品转正失败时临时文件与目标都不留`：目标位置被空目录占住 ⇒ rename 失败 ⇒
  临时文件与空壳都不留（纯 File 操作，JVM 可直接跑）。
- `PhotoCaptureTest.成品转正成功时落到最终路径`：正常路径仍然落盘、临时文件消失。
- `PhotoCaptureTest.压缩先写临时文件再转正_不得直写成品`：源码契约（含「不得再出现
  `FileOutputStream(dst)`」）。
- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本（契约部分）：
  改前 4 条全红，改后 4 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器。磁盘写满 / OOM 的真机复验见 PR 验收卡。
