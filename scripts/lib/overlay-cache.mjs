// overlay-cache.mjs — 引擎 overlay 包缓存的「命中即校验」与原子落盘（issue #1414）。
//
// 为什么单独成模块：这段逻辑原来内联在 build-snapshot-013.mjs 里，只能靠「真的跑一次双 ABI
// 构建」来验（要 WSL，十几分钟），于是它的负控没人跑得动。抽成纯函数后可以用临时目录毫秒级
// 打正例/反例，构建脚本只负责「调一次」。
//
// 修的三件事（同一段缓存逻辑的三个侧面）：
//   ① 命中即信：`if (existsSync(dest)) return dest` 把上次中断留下的残档、换镜像后同名不同字节
//      的包原样解进引擎树，构建日志里没有任何异常 → 现在命中必须过 sidecar 摘要；
//   ② 写入非原子：`writeFileSync(dest, buf)` 中途被杀就留下截断的 tgz，而它下次会被「命中」——
//      现在写临时文件再 rename；
//   ③ 没有摘要就无从校验：落盘时同时写 `<dest>.sha512`（base64，与 npm 的 dist.sha512 同格式）。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 摘要 sidecar 的后缀。与 tgz 同目录同名，便于人工核对与清理。 */
export const SIDECAR_SUFFIX = '.sha512'

const sha512Base64 = (buf) => createHash('sha512').update(buf).digest('base64')

/**
 * 命中判定：只有「文件在 + sidecar 在 + 两者摘要一致」才算命中。
 *
 * 任何一项不成立都**删掉残档**并返回 null（调用方据此重新下载）：
 *   - 没有 sidecar 的旧缓存无法证明完整性——一次性重下的代价，换掉「命中即信」；
 *   - 摘要不一致说明文件被截断/替换过，留着只会让下一次构建继续用坏包。
 *
 * @param {string} dest tgz 的绝对路径
 * @returns {string|null} 命中返回 dest，否则 null
 */
export function overlayCacheHit(dest) {
  if (!existsSync(dest)) return null
  const sidecar = dest + SIDECAR_SUFFIX
  if (!existsSync(sidecar)) {
    rmSync(dest, { force: true })
    return null
  }
  let want = ''
  try {
    want = readFileSync(sidecar, 'utf8').trim()
  } catch {
    want = ''
  }
  const got = sha512Base64(readFileSync(dest))
  if (want === '' || got !== want) {
    rmSync(dest, { force: true })
    rmSync(sidecar, { force: true })
    return null
  }
  return dest
}

/**
 * 原子落盘 + 写 sidecar。
 *
 * 先写 `<dest>.tmp-<pid>` 再 rename：中断时目标文件要么是上一版完整字节、要么不存在，
 * 不会出现「截断的 tgz 被下一次命中当成好包」。sidecar 在 rename 之后写——即使这一步被杀，
 * 下次命中会因缺 sidecar 而重下，方向仍是安全的。
 *
 * @param {string} dest tgz 的绝对路径
 * @param {Buffer} buf  已校验过的 tarball 字节
 * @returns {string} dest
 */
export function overlayCacheStore(dest, buf) {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = dest + '.tmp-' + process.pid
  try {
    writeFileSync(tmp, buf)
    renameSync(tmp, dest)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败不掩盖真错 */ }
    throw e
  }
  writeFileSync(dest + SIDECAR_SUFFIX, sha512Base64(buf))
  return dest
}
