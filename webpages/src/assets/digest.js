/**
 * 下载页的摘要可信度判据（issue #1394）。
 *
 * 缺陷形态：离线 seed 构建的 `sha256` 从不与 MANIFEST 交叉校验，却以「校验值」身份渲染。
 * 默认构建（不带 --refresh，正是线上 Pages 的路径）直接采信 `data/releases.json` 里的摘要；
 * seed 手改或过期时，页面把错误摘要当权威值展示，还提示用户「可核对 SHA-256」——校验值形同装饰。
 *
 * 现在给 seed 增 `manifestSha256`（它摘要所依据的那份 MANIFEST.txt 的 sha256），页面端**重新拉一次
 * MANIFEST** 并比对这个字段，得到三态：
 *
 * - `verified`   —— manifest 摘要与 seed 登记一致，且 seed 的 apt 摘要与 manifest 条目一致；
 * - `unverified` —— 无法证明（旧 seed 没有 manifestSha256、拉不到 MANIFEST、或 seed 自洽检查不过）；
 *   **页面可以继续列，但不得以「已校验」身份渲染** —— 这正是本 issue 的核心指控；
 * - `mismatch`   —— 能证明不一致（manifest 摘要对不上，或某条 APK 摘要与 manifest 条目不同）：
 *   该条不得展示为已校验。
 *
 * 三种状态都不是「猜」：要么有正证据，要么明说没有。
 */

/** 三态常量（避免各处写裸字符串漂移）。 */
export const DIGEST_VERIFIED = 'verified'
export const DIGEST_UNVERIFIED = 'unverified'
export const DIGEST_MISMATCH = 'mismatch'

const HEX64 = /^[0-9a-f]{64}$/i

/**
 * 从 MANIFEST.txt 里取某个 APK 的 sha256。
 *
 * 行格式（release.yml 生成）：`<64 位十六进制 sha256>  <相对路径>  <字节数>`，分隔是两个空格。
 *
 * @param {unknown} text MANIFEST 正文。
 * @param {string} apkName APK 文件名（不带 `apk/` 前缀也可）。
 * @returns {string|null} 小写 sha256；找不到或不唯一返回 null。
 */
export function apkDigestFromManifest(text, apkName) {
  if (typeof text !== 'string' || typeof apkName !== 'string' || apkName === '') return null
  const wanted = apkName.startsWith('apk/') ? apkName : 'apk/' + apkName
  const hits = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === wanted)
  if (hits.length !== 1) return null
  const digest = hits[0][0]
  return HEX64.test(digest) ? digest.toLowerCase() : null
}

/**
 * seed 的**廉价**自洽检查（不引入新字段、不改变旧数据可用性）。
 *
 * 只查两件不需要网络的明显矛盾：
 * 1. 摘要键对应的 ABI 必须真的在 `assets` 里有对应 APK —— 摘要指向一个不存在的资产，
 *    它本来就没有任何可核对的落点；
 * 2. `publishedAt` 不得晚于 `generatedAt` —— 反过来说明这份 seed 的时间线是被手改过的
 *    （生成时间早于发布时间的记录不可能由生成链产出）。
 *
 * 返回**问题列表**（空数组 = 通过）。它只用来把状态压到 `unverified`，绝不据此丢弃数据：
 * 旧 seed 缺字段是正常形态，不该因为「我们后来加了检查」就整页不可用。
 *
 * @param {Record<string, unknown>} data 页面数据（含 tag / assets / sha256 / publishedAt / generatedAt）。
 * @param {(tag: string, abi: string, assets: unknown[]) => string|null} pickApk ABI -> APK 文件名。
 * @returns {string[]} 问题描述。
 */
export function seedConsistency(data, pickApk) {
  const problems = []
  const assets = Array.isArray(data?.assets) ? data.assets : []
  const sha = data && typeof data.sha256 === 'object' && data.sha256 !== null ? data.sha256 : {}
  for (const abi of Object.keys(sha)) {
    const name = typeof pickApk === 'function' ? pickApk(String(data?.tag ?? ''), abi, assets) : null
    if (!name) problems.push('digest-without-asset:' + abi)
  }
  const published = Date.parse(String(data?.publishedAt ?? ''))
  const generated = Date.parse(String(data?.generatedAt ?? ''))
  if (Number.isFinite(published) && Number.isFinite(generated) && published > generated) {
    problems.push('published-after-generated')
  }
  return problems
}

/**
 * 摘要三态判定。
 *
 * @param {{
 *   manifestSha256?: unknown,
 *   computedManifestSha256?: unknown,
 *   seedDigest?: unknown,
 *   manifestDigest?: unknown,
 *   consistency?: string[],
 * }} input
 * @returns {'verified'|'unverified'|'mismatch'}
 */
export function classifySeedDigest(input) {
  const {
    manifestSha256, computedManifestSha256, seedDigest, manifestDigest, consistency,
  } = input ?? {}
  // seed 自身有明显矛盾：这张数据本身不可信，最多只能算「未验证」。
  if (Array.isArray(consistency) && consistency.length > 0) return DIGEST_UNVERIFIED
  const registered = typeof manifestSha256 === 'string' ? manifestSha256.trim() : ''
  // 旧 seed 没有这个字段：**不得直接判失败**，落到「未验证」。
  if (!HEX64.test(registered)) return DIGEST_UNVERIFIED
  const computed = typeof computedManifestSha256 === 'string' ? computedManifestSha256.trim() : ''
  // 拉不到 MANIFEST（离线/镜像全挂）：同样只是「未验证」。
  if (!HEX64.test(computed)) return DIGEST_UNVERIFIED
  if (registered.toLowerCase() !== computed.toLowerCase()) return DIGEST_MISMATCH
  // manifest 摘要对上了，再逐条核对：seed 里那条摘要必须与 manifest 条目一致。
  // 这一步才是「手改一条摘要」的直接判据（manifest 本身没变，但 seed 的 sha256 被改过）。
  const seed = typeof seedDigest === 'string' && HEX64.test(seedDigest) ? seedDigest.toLowerCase() : ''
  const truth = typeof manifestDigest === 'string' && HEX64.test(manifestDigest) ? manifestDigest.toLowerCase() : ''
  if (!truth) return DIGEST_UNVERIFIED
  if (seed !== '' && seed !== truth) return DIGEST_MISMATCH
  return DIGEST_VERIFIED
}

/**
 * 把三态翻成用户可见的一句话（中英由调用方的 t() 提供）。
 *
 * @param {string} state 三态之一。
 * @returns {string} 用于 t() 的键。
 */
export function digestStateKey(state) {
  if (state === DIGEST_VERIFIED) return 'digestVerified'
  if (state === DIGEST_MISMATCH) return 'digestMismatch'
  return 'digestUnverified'
}
