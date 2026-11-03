// overlay-integrity.mjs — 引擎 overlay 包的完整性判据（issue #1415）。
//
// 为什么单独成模块：这条判据原本内联在 build-snapshot-013.mjs 的 overlayTgz 里，只能靠
// 「真的跑一次双 ABI 构建」来验（要 WSL + 全链，十几分钟），于是它的负控没人跑得动。
// 抽成纯函数后可以直接用 node 打正例/反例，门禁成本降到毫秒级。
//
// 判据（issue #1415 的真因就是这里写成了 `if (dist.sha512 && …)`）：
//   ① `dist.sha512` 在场 → 用它比对（npm registry 的常规写法，base64）；
//   ② 只有 `dist.integrity`（`sha512-<base64>`，Subresource Integrity 形态）→ 用它比对；
//   ③ 两者都没有 → **拒绝**。旧实现在这一支静默放行远端字节并解压进引擎树，等于零校验。
//
// 为什么不是「缺摘要就跳过、只告警」：overlay 包直接进引擎树（220 个包），一个被投毒的
// tarball 就是一次出厂级的后门；缺摘要只说明镜像不规矩，不说明内容可信。
import { createHash } from 'node:crypto'

/** 从 dist 元数据里取期望的 sha512（base64）。取不到返回 null —— 调用方必须据此拒绝。 */
export function expectedSha512(dist) {
  const direct = typeof dist?.sha512 === 'string' ? dist.sha512.trim() : ''
  if (direct !== '') return direct
  const integrity = typeof dist?.integrity === 'string' ? dist.integrity : ''
  for (const entry of integrity.split(/\s+/)) {
    if (entry.startsWith('sha512-')) return entry.slice('sha512-'.length)
  }
  return null
}

/**
 * 校验 overlay 包字节；不通过即抛出（构建链靠异常拒打包）。
 *
 * @param {object|undefined} dist  registry 元数据里的 dist 段
 * @param {Buffer} buf            下载到的 tarball 字节
 * @param {string} label          诊断用标识（`<name>@<version>`）
 */
export function assertOverlayDigest(dist, buf, label) {
  const want = expectedSha512(dist)
  if (want === null) {
    throw new Error(`overlay 缺少完整性摘要（sha512/integrity）: ${label}——拒绝接受未校验的远端字节`)
  }
  const got = createHash('sha512').update(buf).digest('base64')
  if (got !== want) throw new Error(`overlay sha512 不匹配: ${label}`)
  return true
}
