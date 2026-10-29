`#878` 与已合入的 `#880` 同改 `mobile-form.css.ts`，产生冲突。按既有做法（不 force-push 作者分支）在当前 main 上重做。

## 冲突解法（内联而非并列拼接）

冲突是两个 CSS 规则块**共用同一个 `{ display: none; }` 体**：

- `#880` 移除左栏「更多」入口：`aria-label='更多'` / `'More'`
- `#878` 移除 guide 页「更多工具」：`aria-label='更多工具'` / `'More tools'`

「保留双方」并列拼会得到「两个选择器组 + 一个体」的畸形结构（实测第一次解完第二条规则丢了 body）。**改成两条各自独立的规则**，各带自己的 `display: none; }`。

## 验证

```
CSS 花括号配平：open=19 close=19 balanced=true
npx tsc -p . --noEmit        -> 0
npx vitest run               -> Test Files 67 passed / Tests 996 passed
```

## 验证档位：spec/静态。**未做设备渲染验证。**

## 未做的原因（环境不具备，非本 PR 问题）

1. debug 包过不了 Hard 清单指纹校验（`EngineManager.kt:1461` → `PluginMounts.ensureHard(ctx, currentFingerprint(ctx))`）；实测三种配对全部报 `stage=hard-bundle-selection-unverified`；
2. 发布链 `build-apk-013.ps1 -Fast` 需协调仓布局（`.deploy-tmp/deepseek-harness/` 上游树 + `dsh/` 只读 checkout），本轮 worktree 不具备，`CONTRACT FAIL (11)` 拒绝打包；
3. 详见 #891 / #908。

## 已验

- `dsh-client-ui-responsive` 全量 vitest **67 个 spec / 996 条用例全过**
- `tsc -p . --noEmit` 通过
- CSS 结构级检查（花括号配平 19/19）
- 静态选择器断言：两条规则的 `aria-label` 中英各一对，互不覆盖

## 未验

设备渲染效果（「更多工具」是否真的不可见 / 虚拟屏双屏图标形状）。**不写成绿。**

## 进发版候选前必须补渲验

本改动进入任何发版候选前**必须补做模拟器三层验收**（代码层 / CDP 层 / ADB 用户层）。未补验不得随版本发布。