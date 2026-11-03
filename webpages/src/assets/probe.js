/**
 * 镜像判活的**纯判据**（issue #1393）。
 *
 * 背景：旧实现把镜像的 MANIFEST.txt 当脚本加载（`<script src=…>`）来判活。任一镜像返回
 * 可执行 JS（被投毒 / 反代把错误页换成 JS / 302 到第三方）就会在**本页 origin 内执行**——
 * 而本页是 APK 分发口：执行后可改写所有下载链接指向任意 APK。
 *
 * 换成 fetch 之后没有执行面，但 fetch 的证据强度分两级，判据必须如实反映：
 *   ① `mode:'cors'` 能读出正文，且正文**确实是 MANIFEST** → 才算「确认可达」（可参与排序）；
 *   ② 只拿到 opaque（连得上但读不到正文）、或 4xx/5xx、或超时 → 「无法判定」，
 *      不参与「谁最快」的排序 —— 否则死线的 403 回得最快，会被选成最优线路；
 *   ③ 网络层失败（DNS/拒连）→ 「不可达」，这是事实而不是猜测。
 */

/** MANIFEST.txt 的单行形态：`<64 位十六进制 sha256>  <相对路径>  <字节数>`（见 release.yml）。 */
const MANIFEST_LINE = /^[0-9a-f]{64} {2}.+ {2}\d+$/

/**
 * 这段正文是否**确实是** MANIFEST.txt。
 *
 * 为什么要求整份都合规而不只是「非空」：被投毒的镜像完全可以返回一段合法 JS 或 HTML 错误页，
 * 那正是本条要挡的东西。要求每行都是 `<sha256>  <path>  <size>` 之后，JS/HTML/错误页一律不匹配。
 *
 * @param {unknown} text 响应正文
 * @returns {boolean}
 */
export function looksLikeManifest(text) {
  if (typeof text !== 'string') return false
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '')
  if (lines.length === 0) return false
  return lines.every((l) => MANIFEST_LINE.test(l))
}

/**
 * 把一次探测归成三态。抽成纯函数，便于离线打正例/反例（真跑浏览器成本太高）。
 *
 * @param {{ ok?: boolean, status?: number, text?: string|null, error?: string|null, aborted?: boolean }} input
 *   - `ok`/`status`：拿到的 HTTP 响应（opaque 响应没有 status，传 `status: 0`）
 *   - `text`：能读出正文时传入；opaque 时为 null
 *   - `error`：fetch 抛错时的 message
 *   - `aborted`：是否因超时被 abort
 * @returns {'ok'|'unknown'|'unreachable'}
 */
export function classifyProbe(input) {
  const { ok, status, text, error, aborted } = input ?? {}
  // 超时：既不能证明可达，也不能证明不可达。
  if (aborted === true) return 'unknown'
  if (typeof error === 'string' && error !== '') return 'unreachable'
  // 拿到 HTTP 响应但没有可读正文（opaque）：连得上，但证不了它给的是那个文件。
  if (status === 0) return 'unknown'
  if (ok !== true) return 'unknown'
  return looksLikeManifest(text) ? 'ok' : 'unknown'
}
