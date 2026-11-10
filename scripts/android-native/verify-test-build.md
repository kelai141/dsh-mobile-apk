# verify-test-build.mjs

测之前先证明「被测二进制确实包含你以为的那些改动」。

## 为什么有它

本项目已经犯过两次同类错误：

1. 在慢设备上测构建期脚本清单，装的是**不含清单代码的旧 APK**，量到 527 秒，
   被读成「清单失效」。
2. 在**缺 #1715 限流修复**的分支上测解包，测到 OOM 崩溃，被读成「限流没解决问题」。

两次都是「没测到」被当成「修复无效」，代价是整整一轮的错误结论。

## 用法

```sh
node scripts/android-native/verify-test-build.mjs \
  --require 9de07ad9,a718d812 \
  --device emulator-5574 \
  --pkg com.dsharnessmobile.shell \
  --apk app/build/outputs/apk/debug/app-debug.apk
```

## 检查三项

1. 每个 `--require` 提交必须是当前 HEAD 的祖先——这是那两次错误的直接形态。
2. APK 必须比工作树里所有已改动文件都新，否则装上去测的是旧代码。
3. 给了 `--device` 与 `--pkg` 时，打印设备上该包的 `lastUpdateTime` 与本地 APK 字节数，
   供人工核对是同一份产物。

退出码 0 = 全部满足；1 = 有不满足项并逐条列出。

## 负控

`--require` 一个不是 HEAD 祖先的提交，必须打印 `FAIL HEAD 不包含 <sha>` 并以 1 退出。
实测：`--require 89219fed`（另一分支的提交）在 `perf/extract-batch-permissions` 上判红。