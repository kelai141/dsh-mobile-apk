# 脚本清单路径的设备验证（2026-11-11）

## 做了什么

构建期（`scripts/fix-shebang.py`）本来就要逐个打开 `usr/bin`、`usr/libexec`、`usr/lib` 下的文件
读 64 字节头判断 shebang。现在顺手把「确实是文本脚本」的相对路径写成清单，
壳侧首启重写（`SnapshotPrefixRewrite`）有清单就只按清单校验，不再遍历整棵树。

清单只是加速，**不是正确性前提**：读不到、为空、路径可疑（绝对路径或含 `..`）时一律回落全树遍历。

## 两台设备的结果（同一棵树：bin 609 / libexec 302 / lib 41 710 条目，594 个文本脚本）

| 设备 | 无清单（全树遍历） | 有清单 |
| --- | ---: | ---: |
| `emulator-5574`（API 29） | **527 882 ms** | **21 277 ms** |
| `emulator-5586`（API 35） | 56 ms | 176 ms |

**结论：清单在慢设备上把这一步从 8.8 分钟降到 21 秒（-96%）；在快设备上反而略慢**
（多读一份 594 行的文件，而全树遍历本来就只要几十毫秒）。

两台设备同一棵树差 9 400 倍，差别不在代码，在模拟器的文件系统实现。

## 仍未消除的 21 秒

清单路径下仍要逐条 `File` 构造 + 读文件 + 正则。594 个文件在慢设备上均摊 36 ms，
仍是同一个病根：这台设备每次系统调用几毫秒。要再降只能减少读文件次数，
例如构建期把「已改写」的结果直接烧进快照，运行时只做一次指纹校验。

## 处置

- 构建期产出清单：保留，不增加构建成本（那趟读文件本来就在做）。
- 壳侧按清单校验：保留。单测保证两条路径结果一致（`manifestPathMatchesFullWalkExactly`），
  且清单缺席时必须回落（`absentManifestFallsBackToFullWalk`）。

## 复测方法

在慢设备上先用设备自带 Node 生成清单（shell 循环在该机不可行，`find`+`head` 会跑十分钟以上）：

```sh
adb shell "run-as <pkg> sh -c 'cd /data/user/0/<pkg>; LD_LIBRARY_PATH=$PWD/files/usr/lib files/usr/bin/node files/mkmanifest.mjs'"
```

然后删 `files/.prefix-rewrite-<version>` 重启，读 `boot-diag.log` 的 `perf-prelude`。

注意：装了不带清单读取代码的旧 APK 时，这一步仍会走全树遍历——本轮第一次测出的 527 秒就是
这个原因，不是清单失效。