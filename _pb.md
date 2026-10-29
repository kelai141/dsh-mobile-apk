修 `#921`：启动失败的真因码不再被 `?:` 兜底值吞掉。

## 缺陷

`EngineManager.kt:393`：

```kotlin
lastRefreshFailureCode = (t as? SnapshotFsException)?.code ?: "snapshot-refresh-failed"
```

`?:` 把两种**完全不同**的情况压成同一个字符串：

| 情况 | 旧行为 |
|---|---|
| 异常携带真因码、只是被包了一层（`IOException(cause = SnapshotFsException(...))`） | **真码被丢掉**，`as?` 拿到 null |
| 异常确实没有码 | 兜底是对的，但结果与上一种**无法区分** |

诊断里因此看不出「这条是兜底值还是真因」。

## 改法

1. **沿 cause 链解包根因**（`findSnapshotFsException`，上限 16 层防环），真因码一律保留；
2. 新增 `lastRefreshFailureUnclassified: Boolean` —— 确实没有码时 `lastRefreshFailureCode` **保持 null**，由标记表达「未归类」；
3. 新增纯函数 `refreshFailureState(t)` 返回 `(真因码, 是否未归类)`，`:393` 改用它；`:924` 同步同口径；
4. 新增纯函数 `refreshFailureLabel(code, unclassified)` 负责**渲染**，`EngineStartFlow.kt:790` 改用它；未归类渲染成新码 `snapshot-refresh-unclassified`，**与 `snapshot-refresh-failed` 刻意分开**。

抽取纯函数的理由：让「无码 ⇒ null 且未归类」与「两者渲染不同」这两条要求能被**纯 JVM 单测真正钉住**，而不是靠读 catch 块自证。

## 三条负控（各自能红，且红在不同用例上）

```
BASELINE            -> GREEN
M1 不解包根因       -> RED  wrappedTrueCauseCodeIsUnwrappedAndKept
M2 旧兜底值语义     -> RED  codeWithNoCodeYieldsNullAndUnclassified
M3 两者渲染相同     -> RED  realCodeAndUnclassifiedRenderDifferently
RESTORED            -> GREEN
```

三条**恰好各自命中一个不同用例**，说明测的不是同一件事。

## 一条必须交代的过程问题

中途我用 `--tests "com.dsharnessmobile.shell.RefreshFailureCodeTest"`（**带引号**）跑，得到 `BUILD SUCCESSFUL` 就以为绿了 —— 实际上 **0 个测试被执行**，是假绿。换成不带引号（`cmd /c gradlew.bat ... --tests com.dsharnessmobile.shell.RefreshFailureCodeTest`）后立刻暴露出基线其实是红的。

另有一次负控脚本被 120s 死线中断，**把变异态留在文件里**，后续把变异态当成 `orig` → 基线永远红。这也印证了 gotchas 规则 4：「写→用→删」必须同一次成功执行内闭合。

## 验证

```
:app:compileDebugKotlin                        -> BUILD SUCCESSFUL
:app:testDebugUnitTest --tests RefreshFailureCodeTest -> GREEN（3 用例）
```

## 档位

L3 壳侧行为（启动失败诊断）：**已做纯 JVM 单测 + 三条受控负控；未做设备验证**（需构造「被包装的真因」失败态，当前无发布链包）。进发版候选前必须补渲验。