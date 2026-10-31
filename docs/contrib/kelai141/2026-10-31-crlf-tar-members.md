# 同一判据在两个平台给出不同结论：tar 成员名带 CRLF（2026-10-31）

主题：`check-combo-cache` 修 #1195（单文件缓存漏检）时发现的跨平台假绿。
共同根因：**判据本身正确，但输入在 Windows 上多了一个 `\r`**——
同一份 tar、同一个脚本，Linux 判红、Windows 判绿。

## 现象

为验证「单文件缓存 `.../.combo-cache`（无尾斜杠）也能被扫到」，
我构造了一份只含该成员的 tar，在 Windows 工作树上跑门禁：

```
PASS  产物面无 combo 死缓存条目（6 个成员已扫）
CHECK-COMBO-CACHE PASSED      exit 0        # 期望 exit 1
```

成员数是对的（6 个），路径看起来也对，但就是判绿。

## 真因

`tar -tf` 在 Windows 上输出 **CRLF**，成员名带尾随 `\r`：

```js
["home/\r", "home/.dsh/\r", "...", "home/.dsh/profiles/web/.combo-cache\r"]
//                                                              ^^^ 这里
```

判定用的是路径**分段**比较：

```js
String(name).split('/').includes('.combo-cache')
// 实际得到 '.combo-cache\r' ≠ '.combo-cache'  → false
```

于是判据静默失效。同一份 tar 在 Linux（LF 输出）上会正常判红。

## 修法

读成员时立即归一化，而不是在每条判据里各自处理：

```js
members = listing.split('\n').map((l) => l.replace(/\r/g, '').trim()).filter((l) => l.length > 0)
```

判定函数本身也加一层归一化（`isDeadCacheEntry`），因为它可能被别处以别的形态调用。

## 为什么容易漏

1. **不报错、不 SKIP、不崩**——只是判绿，计数和输出全都「看起来正常」；
2. 开发机是 Windows、CI 是 Linux，**本地绿而 CI 红**会被误读成「CI 环境问题」；
3. 反向也一样：本地红而 CI 绿会被误读成「本地脏了」。

## 识别形态

凡是**解析外部命令文本输出**再按路径/字段比较的门禁，都该问一句：
「这个输出的行尾在我这个平台上是什么？」
`tar -tf`、`git status --porcelain`、`adb shell ls` 这类都可能带 `\r`。

判据：把成员/字段名 `JSON.stringify` 打出来看有没有 `\r`——比读代码快。

## 复验证据

```
归一化前：单文件 .combo-cache 的 tar -> PASSED  exit 0   （假绿）
归一化后：同一份 tar                    -> FAILED  exit 1   （两处判据都命中）
```