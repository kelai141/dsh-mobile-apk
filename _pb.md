## 同一个错犯了三次，升级为硬规则

### 实锤

| 次 | 场景 | 后果 |
|---|---|---|
| 1 | `NotifyStructureBatch8Test.kt` 冲突按行拼接 | KDoc 与函数体拼断，`SyntaxError` |
| 2 | `EngineManager.kt` 的 `if (hard == null) {` 块 splice 计数错**多留一行** | 花括号不平衡 → 报错出现在 `UpdateManager.kt` / `WatchdogV2.kt`（`Unresolved reference 'onlineUpdateActive'`），极易误判成 main 坏了 |
| 3 | `console.html` 的 `__dshConsoleSetLang` 块实际 **5 行**只 splice 了 **3 行** | 留重复 `applyLang(); };` → 第二个 script 块 `SyntaxError: Unexpected token ';'` |

### 三条硬规则

1. **禁止裸 `splice` 改代码** —— 首选锚定**字符串**替换（`old` 含足够前后文保证唯一）；必须按行时，splice 前后**断言首尾行原文**，`n` 从实际读出结果来，不能凭印象。
2. **splice 后必跑语法检查再谈功能验证** —— `node --check` / `tsc --noEmit` / `:app:compileDebugKotlin` / `JSON.parse`。顺序不能反：语法都不通过，功能验证的结论没有意义。
3. **报错出现在「别的文件」时先怀疑自己刚改的那块** —— 块界错位的典型形态就是「真正出问题的文件一条错都不报，错误全落在下游受害者上」。排查顺序：`git diff` 看自己改的文件 → 数括号配平 → 最后才看别的文件。

L0 文档改动，CI 绿即可。