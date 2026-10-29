把今天踩到的 PowerShell 坑写进 gotchas：**工具输出的通道与类型也会骗人**。

## 实锤

`node ... 2>&1 | Select-Object -Last 8 | ForEach-Object { $_.Substring(0,150) }` 满屏报 `does not contain a method named 'Substring'` —— stderr 合流后是 `ErrorRecord` **对象**，不是字符串；`Select-Object -Last` 也只对行有效，对对象流无效。

**最坑的是**：过滤后一条目标行都没打出来，看起来像「守卫没触发」，实际是读取方式把输出吞了。为此多花两轮。

## 写进去的三条判据

1. 外部程序输出**先 `Out-String`** 再切分；不要直接对管道结果调字符串方法。
2. `2>&1` 之后拿到的是 `ErrorRecord` 还是 `string`，取决于有没有 `Out-String` —— 别假设。
3. **「一条都没匹配到」永远先怀疑读取方式**，再怀疑程序没输出。

这与「失败文案被兜底值吞掉」（#890）同族：真因被工具层的表示形式掩盖。

L0 文档改动，CI 绿即可。