/**
 * issue #472：experimental-inspector 的 Worker 丢掉 `--expose-internals`。
 *
 * 现场（0.14.8 / versionCode 52，android-arm64 真机）：
 *
 *   experimental-inspector (@deepseek-ai/dsh-experimental-inspector):
 *   Error: Cannot find module 'internal/modules/esm/loader'
 *   Require stack: node-addon-require-builtin/lib/index.js
 *                  dsh-app-boot/lib/worker/profile-resolution-bootstrap.js
 *
 * 壳侧启动命令确实带了 `--expose-internals`（设备 `ps` 实测），但 inspector 的 `spawnWorker()`
 * 用 `execArgv: []` 显式清空了 Worker 的继承参数。`node-addon-require-builtin` 没有 android-arm64
 * 预编译件，`requireBuiltin('internal/modules/esm/loader')` 只能走需要该 flag 的 require 回退，
 * 于是 Worker 内必然 MODULE_NOT_FOUND；桌面端因为有 binding 永远看不到。
 *
 * 修法（与 #117 同源：让 flag 到达执行位置）：只把 `execArgv` 换成 `["--expose-internals"]`。
 * **不能**改成继承 `process.execArgv` —— 那会把 `--inspect` 等调试参数带进 Worker。
 * 长期解是补 android-arm64 预编译件（上游/依赖侧），在那之前这条回退路径必须可用。
 *
 * 锚点只在 `spawnWorker()` 的 options 字面量上；同文件其它 `execArgv`（无）不参与。
 */

export const INSPECTOR_WORKER_MARKER = 'dsh-mobile inspector worker expose-internals (472)'

const OPTIONS_ANCHOR = '\tconst options = {\n'
  + '\t\tworkerData: boot,\n'
  + '\t\ttransferList: [boot.hostSourcePort],\n'
  + '\t\texecArgv: []\n'
  + '\t};'

const OPTIONS_REPLACEMENT = '\t/* ' + INSPECTOR_WORKER_MARKER + ' */\n'
  + '\tconst options = {\n'
  + '\t\tworkerData: boot,\n'
  + '\t\ttransferList: [boot.hostSourcePort],\n'
  + '\t\texecArgv: ["--expose-internals"]\n'
  + '\t};'

/** 是否已施加。 */
export function hasInspectorWorkerExposeInternals(source) {
  return source.includes(INSPECTOR_WORKER_MARKER) && source.includes(OPTIONS_REPLACEMENT)
}

/**
 * 施加补丁（幂等）。
 *
 * 锚点必须**恰好命中一次**：`spawnWorker` 的 options 在发布产物里只有一处；出现两处说明上游
 * 新增了第二个 worker 启动点，必须人工重新判断（直接给两处都塞 flag 可能改变非 inspector 行为）。
 */
export function patchInspectorWorkerExposeInternals(source) {
  if (hasInspectorWorkerExposeInternals(source)) return source
  if (source.includes(INSPECTOR_WORKER_MARKER)) {
    throw new Error('472: 检测到 marker 但锚点不完整，拒绝在可疑产物上继续')
  }
  const count = source.split(OPTIONS_ANCHOR).length - 1
  if (count !== 1) throw new Error('472 spawnWorker options: 期望恰好命中 1 处，实际 ' + count)
  return source.replace(OPTIONS_ANCHOR, OPTIONS_REPLACEMENT)
}
