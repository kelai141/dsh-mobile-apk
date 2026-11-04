# env_prepare 的「恢复动画」分支补回读（2026-11-04，issue #1372）

## 现象

`android_env_prepare` 的「恢复动画」分支没有回读：直接 push「已恢复默认（1）」，而写失败被
`restoreAnimScales` 内部 catch 吞掉。关闭分支有 `readAnimScales()` 回读与 `notDone`，恢复分支没有
——形成假成功。

## 真因

两个分支的口径不一致：关闭分支按「读回才算数」，恢复分支按「调用没抛就算成功」。而
`restoreAnimScales` 自己会吞异常，于是「调用没抛」根本不能证明写进去了。

## 修法

恢复分支补上与关闭分支同形的回读：

```ts
await restoreAnimScales({})
const now = await readAnimScales()
if (ANIM_KEYS.every((k) => now[k] === '1')) {
  lines.push('动画：已恢复默认（1）')
} else {
  notDone.push('动画未恢复默认（读回 ' + ... + '）')
}
```

## 复验

`plugins/dsh-android-manage/test/env-prepare-anim-restore.test.mjs` 两条：恢复分支必须回读且判据是
「三项都等于 1」、读回不符必须进 `notDone`；并反证「不得再有恢复后无条件宣告成功」的写法。

- 本机直接跑：2/2 通过。
- 本机同判据脚本：改前 2 条红，改后 4 条全绿。
- `node scripts/check-code-map.mjs` → PASSED（插件锚点按内容重钉）。
- **未做设备验证**：本机无模拟器。真机复验见 PR 验收卡。
