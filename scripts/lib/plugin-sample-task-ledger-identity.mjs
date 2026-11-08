// plugin-sample-task-ledger-identity.mjs — 第一个第三方插件真实功能用例的判定逻辑。
//
// 被测对象：dsh-task-ledger 0.1.8 的只读端点 GET /api/task-ledger/identity。
// 该端点由插件宿主半边提供（dist/host/routes.js:149 registerRead("/identity")），
// 返回 { uuid, name, initCommand }：未初始化身份时 uuid 与 name 都是 null。
//
// 为什么选它当第一个用例：
//   - 只读，不改台账、不写文件，不需要 Git 远端，不依赖网络与 API Key；
//   - 不依赖模型编排：端点自身可被直接请求，结果可逐字段断言；
//   - 覆盖「插件装上了但宿主半边没跑起来」这一类真实故障：装上了却没有该路由时是 404。
//
// 本文件只有纯函数，故意不碰 adb、不碰设备。设备层在 verify-plugin-sample-device.mjs。

/** 端点路径（与插件 dist/host/routes.js 的 API_PREFIX 一致）。 */
export const IDENTITY_ROUTE = '/api/task-ledger/identity'

/** 用例判据的文字口径，随证据一起落盘，避免事后各说各话。 */
export const CASE_EXPECT = 'GET ' + IDENTITY_ROUTE + ' 返回 200 且 JSON 同时含 uuid 与 name 两个键（值可为 null）'

/**
 * 判定一次观测。
 *
 * 只认「明确观察到的事实」：没观察到（null/undefined）一律 INCONCLUSIVE，
 * 不能因为没报错就当通过。
 * @param {{status?: number|null, body?: string|null, error?: string|null}} observation 页面侧请求结果。
 * @returns {{verdict: 'PASS'|'FAIL'|'INCONCLUSIVE', detail: string, reason?: string}}
 */
export function judgeIdentity(observation) {
  if (observation === null || typeof observation !== 'object') {
    return { verdict: 'INCONCLUSIVE', detail: '没有观测结果', reason: 'missing-observation' }
  }
  const { status, body, error } = observation
  if (typeof error === 'string' && error !== '' && (status === null || status === undefined)) {
    return { verdict: 'INCONCLUSIVE', detail: '请求未完成：' + error, reason: 'transport-error' }
  }
  if (!Number.isInteger(status)) {
    return { verdict: 'INCONCLUSIVE', detail: '没有状态码', reason: 'missing-status' }
  }
  if (status === 404) {
    return { verdict: 'FAIL', detail: '路由不存在（404）：插件宿主半边没有注册 ' + IDENTITY_ROUTE, reason: 'route-missing' }
  }
  if (status === 401 || status === 403) {
    return { verdict: 'INCONCLUSIVE', detail: '鉴权被拒（' + status + '）：本次观测不能说明插件是否工作', reason: 'auth' }
  }
  if (status !== 200) {
    let code
    try { code = JSON.parse(body)?.code } catch { /* Non-JSON error response. */ }
    const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null
    return {
      verdict: 'FAIL',
      detail: '状态码 ' + status + '（期望 200）' + (safeCode ? '；错误码 ' + safeCode : ''),
      reason: 'status-' + status + (safeCode ? '-' + safeCode.toLowerCase().replaceAll('_', '-') : ''),
    }
  }
  const text = typeof body === 'string' ? body : ''
  if (text.trim() === '') {
    return { verdict: 'FAIL', detail: '200 但响应体为空', reason: 'empty-body' }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { verdict: 'FAIL', detail: '200 但响应体不是 JSON：' + text.slice(0, 120), reason: 'not-json' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { verdict: 'FAIL', detail: '响应体不是对象', reason: 'not-object' }
  }
  if (!('uuid' in parsed) || !('name' in parsed)) {
    return { verdict: 'FAIL', detail: '缺少 uuid 或 name 键，实际键：' + Object.keys(parsed).join(','), reason: 'missing-fields' }
  }
  const uuidOk = parsed.uuid === null || (typeof parsed.uuid === 'string' && parsed.uuid.trim() !== '')
  const nameOk = parsed.name === null || (typeof parsed.name === 'string' && parsed.name.trim() !== '')
  if (!uuidOk || !nameOk) {
    return { verdict: 'FAIL', detail: 'uuid 或 name 类型不对：' + JSON.stringify({ uuid: parsed.uuid, name: parsed.name }), reason: 'field-type' }
  }
  if ((parsed.uuid === null) !== (parsed.name === null)) {
    return { verdict: 'FAIL', detail: 'uuid 与 name 一个为空一个非空，身份状态自相矛盾', reason: 'identity-mismatch' }
  }
  const who = parsed.uuid === null ? '未初始化身份' : '身份 ' + parsed.name
  return { verdict: 'PASS', detail: '端点可用，' + who, reason: 'ok' }
}

/**
 * 从组件清单里判断任务看板插件的装配状态。
 *
 * 用 pluginManager/listPlugins 的行：moduleName 是包名，entryId 是补丁行 id，
 * 两者不同名，所以只按 moduleName 匹配。
 * @param {unknown} rows listPlugins 的返回数组。
 * @returns {{found: boolean, enabled: boolean|null, phase: string|null, entryId: string|null}}
 */
export function pickInstalledRow(rows, moduleName) {
  const list = Array.isArray(rows) ? rows : []
  const row = list.find((r) => r !== null && typeof r === 'object' && r.moduleName === moduleName)
  if (row === undefined) return { found: false, enabled: null, phase: null, entryId: null }
  return {
    found: true,
    enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
    phase: typeof row.fiberPhase === 'string' ? row.fiberPhase : null,
    entryId: typeof row.entryId === 'string' ? row.entryId : null,
  }
}

/**
 * 把一条用例结论折进兼容证据格式。
 *
 * 只有 PASS/FAIL 带证据；没有观测的一律 unmeasured，绝不默认写成 pass。
 * @param {{verdict: string, detail: string, reason?: string}} judgement 判定。
 * @param {string[]} evidence 证据文件相对路径。
 * @returns {object} 可直接放进证据 samples[].cases[] 的条目。
 */
export function toEvidenceCase(judgement, evidence) {
  // 用例 id 必须是样本清单里已声明的那个，否则两侧用例集不同、比较器会判不可比。
  // 身份接口与看板渲染分别记证，接口通过不能把页面判绿。
  const base = { id: 'identity-api', kind: 'functional' }
  if (judgement.verdict === 'PASS') {
    return { ...base, status: 'pass', detail: judgement.detail, evidence: evidence.length > 0 ? evidence : [] }
  }
  if (judgement.verdict === 'FAIL') {
    return {
      ...base,
      status: 'fail',
      detail: judgement.detail,
      failureKey: judgement.reason ?? 'fail',
      evidence: evidence.length > 0 ? evidence : [],
    }
  }
  return { ...base, status: 'unmeasured', detail: judgement.detail, evidence: [] }
}
