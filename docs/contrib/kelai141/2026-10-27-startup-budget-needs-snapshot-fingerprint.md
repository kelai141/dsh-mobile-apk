# 测启动预算之前，先确认包里有 snapshot.sha256

## 坑

本地用 `assembleDebug` 打的包，如果 `app/src/main/assets/` 下只有 `snapshot.tar.xz`
而没有 `snapshot.sha256`，应用会**主动拒绝启动引擎**：

```
dsh-boot-fail stage=snapshot-bundled-sha-missing
  ... fingerprint=snapshot=na,snapshotEmbedded=na,vcode=53,
      transaction=absent,patchRepair=absent,home=present,engineLog=absent
  detail=内嵌运行时缺少 SHA-256 指纹，已停止更新与启动；
         请安装包含完整快照指纹的安装包。现有用户数据未改动。
```

这是**设计如此**（0.14.7 起内嵌资产必须带指纹校验），不是 bug。问题在于它失败得很安静。

## 为什么会害人

此时 `am start -W` 的返回是**假绿**：

```
adb shell am start -W -n com.dsharnessmobile.shell/.MainActivity
Status: ok
LaunchState: COLD
TotalTime: 4553
WaitTime: 4557
Complete
```

`TotalTime: 4553` 看起来「启动 4.5 秒，还行」。但 `am start -W` 量的是 **Activity 起来**，
不是引擎起来。引擎压根没启动，所以这个数字比真实冷启预算**小得多**。

拿这种包去测启动预算，会得出「启动很快、没问题」的反向结论。如果有人拿它去证明
「某个启动缺陷不存在」，那就是用错包得出的假阴性。

## 这个坑就是这么撞上的

排查 #643（instrumentation 后启动超预算）时，我第一次只把 `snapshot.tar.xz` 拷进
`app/src/main/assets/`，忘了 `snapshot.sha256`。装上去跑 `am start -W` 得到 4553ms，
一度以为「启动没问题，问题在别处」。

直到去翻 `boot-fail.log` 才看到 `snapshot-bundled-sha-missing`。补上指纹包之后，
真实行为才暴露出来：引擎**从不拉起**（`boot-start` 计数 0、端口不监听、无 `engine.log`），
这才是 #654 记的那个缺陷。

**同一个包，两种结论，完全相反。** 差别只在有没有那个 64 字节的文件。

## 检查清单（装机/测量之前跑一遍）

1. 文件在不在：
   ```
   Test-Path app/src/main/assets/snapshot.sha256
   ```
2. 哈希对不对（内容必须与 `snapshot.tar.xz` 的 SHA-256 一致）：
   ```
   (Get-Content app/src/main/assets/snapshot.sha256 -Raw).Trim()
   (Get-FileHash app/src/main/assets/snapshot.tar.xz -Algorithm SHA256).Hash.ToLower()
   ```
3. **装完之后**确认引擎真的启动了，别只看 `am start -W`：
   ```
   adb shell run-as com.dsharnessmobile.shell grep -c 'boot-start' files/boot-diag.log
   adb shell run-as com.dsharnessmobile.shell ls files/home/.dsh/engine.log
   adb shell "cat /proc/net/tcp | grep -c ':1F'"
   ```
   `boot-start` 为 0 或 `engine.log` 不存在 → **本次所有启动预算结论作废**，先修包。

## 顺带记两条

- `snapshot.sha256` 与 `snapshot.tar.xz` 都不入库（`.gitignore`），本地构建前要自己放；
  指纹在同批产物目录里（如 `.deploy-tmp/snapshot-013/<abi>/snapshot.sha256`），别手算。
- dev 档打包脚本（`build-apk-dev-fast.mjs`）**不重建、不注入快照**，复用现有
  `app/src/main/assets/snapshot.tar.xz`。所以换快照或换 ABI 时，指纹文件也要一起换，
  否则会拿着旧指纹校验新归档，同样 `snapshot-bundled-sha-missing`。
