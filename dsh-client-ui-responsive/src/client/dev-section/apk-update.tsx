/**
 * 设置页「应用更新」分区（0.14.6 起为一行，0.15.0 提级为一级分区）。
 *
 * ## 为什么入口在设置页、又必须是一级分区
 *
 * 壳侧下载+校验+安装的**能力一直都在**（UpdateChecker.download 带镜像链与进度回调、
 * updatesDir 零新映射、verifySha256、invokeInstaller、canInstall/requestInstallPermission），
 * 但状态机与入口一度长在引导页渲染器里：触发入口只有 buildGuideView 造出的那个按钮，
 * 而健康态走 showWeb() 把引导页藏起来 => 健康状态下**没有任何更新入口**（能力在、入口无）。
 *
 * 0.14.6 把状态机提为单一真源（ApkUpdateState + ApkUpdateController），入口先挂在「开发者选项」里；
 * 但真实用户不走开发者选项，等于对普通用户不可达。用户拍板「更新块继续放设置页、从开发者选项提出来」，
 * 故本组件升级为设置页一级分区（`android-apk-update`），开发者选项里只留一句指路。
 *
 * ## 为什么是两个按钮（一次误诊换来的）
 *
 * 旧实现只有一枚按钮，按下时按 `state === 'available' || canStart` **推断**该发 check 还是 install。
 * 推断一旦与壳侧受理判据不同源，就会造出「按钮让你下载、壳侧回 busy」的死路：0.14.6 实测的形态是
 * `state:"failed"` 与 `canStart:true` 并存，用户点「重试」永远得到「上一次更新动作仍在进行中」。
 * 现在两枚按钮各自**硬绑定**一个动作（检查 = check，下载 = install），页面不再替壳侧猜意图；
 * 能不能点由状态表决定，写死在同一处（见 renderRow 的 switch），与 CONTRACT C 节的壳侧状态表同口径。
 *
 * ## 通道与收敛方式
 *
 * 走桥（window.androidBridge.apkUpdate），不走 /api 路由 —— 真源在 Android 侧（Activity 作用域），
 * 引擎侧插件读不到；与 notify-settings.tsx 的定例同构，故 scripts/api-route-auth-policy.json 无需登记。
 *
 * **同步桥不能回 Promise**（@JavascriptInterface 限制），所以用「发起 + 轮询读 status」两段式：
 *   - 发 check / install 只表达**受理**（ok=true 不等于更新成功）；
 *   - 真实进展一律以 `status` 的读回为准。
 * **不使用 page 回调**（onApkUpdateResult / onApkUpdateProgress）：window.__dshBridge 有
 * `if(window.__dshBridge){return}` 的幂等守卫且是**整体赋值**，挂回调存在「被整体跳过」或
 * 「整体覆盖掉 onDirectoryPicked / onPermissionRequired」的风险。轮询读 status 完全不依赖它。
 *
 * ## 纪律
 *  - 只在「进行中」态轮询（checking / downloading），终态立即停止 —— 不做常驻定时器；
 *  - 失败原因**原样展示**壳侧 reason（它已是成句中文且按 8 类归因），不翻译、不截断、不覆盖；
 *  - 桥缺席（桌面宿主）**不得冒充 idle** —— 显示「读不到」，避免把「不可用」渲染成合法空态；
 *  - 发现新版时检查按钮**禁用**：壳侧 `beginCheck()` 会清掉已发现的新版载荷（currentResult），
 *    此刻允许再点检查等于把「可以下载的那个包」抹掉；
 *  - 全程无自动请求：只有用户显式点击才发 check / install。
 */
import { useCallback, useEffect, useState } from 'react'
import { useShellState } from '../mobile/use-shell-state.ts'
import { noticeDataAttrs, type Notice } from '../user-copy.ts'
import { tr } from '../i18n.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '../android-bridge.ts'

/** 壳侧 apkUpdate 返回的状态快照。字段名与 ApkUpdateState.snapshotJson 逐字对应。 */
interface ApkUpdateStatus {
  /** 这次调用是否被**受理**（不表示更新成功）。 */
  ok?: boolean
  /** idle / checking / up-to-date / available / downloading / installing / need-permission / failed */
  state?: string
  /** up-to-date 时的当前版本（"v0.14.6"）。 */
  version?: string
  /** available/installing 时的新版 tag。 */
  tag?: string
  /** 新版资产名（本机 ABI 的那个包）——「将装哪个包」的如实信息。 */
  name?: string
  /** 当前版本（裸版本号）。 */
  current?: string
  /** 新版体积（字节）。 */
  sizeBytes?: number
  /** downloading 时的百分比 0..100。 */
  percent?: number
  /** installing 时：是否**复用**了上次已下好的包（没重复拉 169MB）。 */
  reused?: boolean
  /** 失败原因：壳侧给的**用户可读中文**，原样展示。 */
  reason?: string
  /** 失败归类（壳侧闭集：8 类检查失败 + DOWNLOAD_FAILED / ARTIFACT_REJECTED / INSTALLER_UNAVAILABLE）。 */
  kind?: string
  /**
   * 发布方在 MANIFEST / releases.json 里**声明**的 sha256 摘要（小写）。
   *
   * 语义是「发布方声明的校验值」，**不是**「本机已经校验通过」：壳侧先比对体积与摘要才拉起安装器，
   * 那一步的结论体现在 state 上（安装器已拉起 = 校验已过），而本字段只是它拿来比对的那个值。
   * 本次发布没提供摘要时整字段缺席（null/undefined），界面必须如实说明「本次发布未提供摘要」，
   * 不得渲染成「已校验」或留空冒充通过。
   */
  sha256?: string
  /**
   * 壳侧是否还留着一个「已下载并校验通过、只等安装」的包（`readyToInstall` 的**只读面**）。
   *
   * 失败态的重试安装只有在它为 true 时才会真的受理：那时手上有一个验证过的包，install 直接续继；
   * 否则重试的正确路径是 check（重新取元数据），再发一次 install 只会被壳侧回 not-available。
   * 页面读不到壳侧私有字段，`kind` / 状态名这类旁证推不出它（那是假判据），故判据只能来自快照。
   * 壳侧每个相位的回执都发这个字段且恒为布尔（status / check / install 的成功与拒绝都一样）。
   * 本组件仍按 `=== true` 判：字段缺席只可能发生在更旧的壳侧，那时按「没有」处理——
   * 宁可少一枚按钮，也不摆一枚点了不受理的。旧壳侧里靠旁证猜才是真缺陷的形态。
   */
  hasReadyArtifact?: boolean
  /** 是否处于「可 start」态（已发现新版）。 */
  canStart?: boolean
  /** 受理结果码（accepted / busy / no-pending / not-available）。 */
  code?: string
}

/** 进行中态：需要轮询。其余（含终态）一律停止轮询。 */
const BUSY_STATES = new Set(['checking', 'downloading'])

/** 字节格式化（与设置页其它面同款口径，见 runtime-cache.tsx）。 */
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

/**
 * 读壳侧状态（真源）。
 * @returns 解析后的快照；**桥缺席或返回不可解析时为 null**（调用方据此显示「读不到」，不得冒充 idle）。
 */
function readStatus(): ApkUpdateStatus | null {
  try {
    const raw = window.androidBridge?.apkUpdate?.('status')
    if (typeof raw !== 'string' || raw === '') return null
    const parsed = JSON.parse(raw) as ApkUpdateStatus
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/**
 * 发起一次动作（check / install）。同步桥只回「受理与否」，故返回解析后的快照用于即时反馈。
 * @param action - 壳侧闭集动作名。
 * @returns 解析后的快照；桥缺席或异常时为 null。
 */
function invoke(action: 'check' | 'install'): ApkUpdateStatus | null {
  try {
    const raw = window.androidBridge?.apkUpdate?.(action)
    if (typeof raw !== 'string' || raw === '') return null
    const parsed = JSON.parse(raw) as ApkUpdateStatus
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/** 行内渲染所需的三件事：状态/版本文本 + 两个按钮各自的文案与可点性。 */
interface RowView {
  /** 状态或版本文本（失败时就是壳侧 reason 原文）。 */
  text: string
  /** 检查按钮文案（进行中态如实显示「检查中…」）。 */
  checkLabel: string
  /** 下载按钮文案；null = 本态没有下载这条路（按钮不渲染）。 */
  installLabel: string | null
  /** 检查按钮是否可点。 */
  checkEnabled: boolean
  /** 下载按钮是否可点。 */
  installEnabled: boolean
  /** 补充事实（独占一行）；null = 本态没有要补的。 */
  detail: string | null
}

/**
 * 按壳侧状态给出这一行的渲染事实。
 *
 * 八态与 CONTRACT C 节的**壳侧原生状态表同口径**：客户端与原生读同一份状态，若两边对「能不能点」
 * 给出不同答案，用户看到的按钮就与壳侧会不会受理脱节——同一相位在设置页与引导页表现不一致。
 *
 * @param state - 壳侧状态名；空串或未知值按「读不到」之外的空态处理（见调用方对 null 的分支）。
 * @param status - 壳侧快照（含版本、体积、进度、失败原因）。
 * @returns 文本与两枚按钮的文案/可点性。
 */
function viewOf(state: string, status: ApkUpdateStatus): RowView {
  const checkOnly = (text: string, checkEnabled: boolean, checkLabel = tr('检查更新', 'Check for updates')): RowView =>
    ({ text, checkLabel, installLabel: null, checkEnabled, installEnabled: false, detail: null })
  switch (state) {
    case 'checking':
      return checkOnly(tr('正在查询最新版本…', 'Looking up the latest version…'), false, tr('检查中…', 'Checking…'))
    case 'up-to-date':
      return checkOnly(tr('APK 已是最新 ', 'APK is up to date ') + (status.version ?? ''), true, tr('重新检查', 'Check again'))
    case 'available':
      return {
        text: tr('发现新版 ', 'New version ') + (status.tag ?? '') +
          (status.current === undefined
            ? ''
            : tr('（当前 v', ' (current v') + status.current + tr('，', ', ') + fmtBytes(status.sizeBytes ?? 0) + tr('）', ')')) +
          tr('——资产 ', ' — asset ') + (status.name ?? ''),
        // 检查按钮禁用：beginCheck() 会清掉已发现的新版载荷，此刻再检查等于丢掉可下载的包。
        checkLabel: tr('检查更新', 'Check for updates'),
        checkEnabled: false,
        installLabel: tr('下载并安装 ', 'Download and install ') + (status.tag ?? ''),
        installEnabled: true,
        // 摘要口径：这是**发布方声明的值**（壳侧下载后拿它比对），不是「本机已校验通过」。
        // 本次发布没给摘要就如实说没给——留空会让用户以为校验过了。
        detail: status.sha256 === undefined
          ? tr('本次发布未提供 sha256 摘要：安装包仍会按体积核对，但没有摘要可比对', 'This release provides no sha256 digest, so the package is only size-checked.')
          : tr('发布方声明的 sha256（下载后按它比对）：', 'sha256 declared by the release (checked after download): ') + status.sha256.slice(0, 12) + '…',
      }
    case 'downloading':
      return {
        text: tr('正在从镜像链下载 ', 'Downloading ') + (status.name ?? '') +
          (status.sizeBytes === undefined ? '' : tr('（', ' (') + fmtBytes(status.sizeBytes) + tr('）', ')')) +
          tr('——请保持应用在前台', ' — keep the app in the foreground'),
        checkLabel: tr('检查更新', 'Check for updates'),
        checkEnabled: false,
        installLabel: tr('下载中 ', 'Downloading ') + String(status.percent ?? 0) + '%',
        installEnabled: false,
        detail: null,
      }
    case 'installing':
      return checkOnly(
        tr('已拉起系统安装器——安装完成后重新打开应用即生效', 'The system installer is open; reopen the app after installing') +
          (status.reused === true
            ? tr('（本次复用了上次已下载并校验通过的安装包，未重复下载）', ' (the previously downloaded and verified package was reused)')
            : ''),
        true,
        tr('重新检查', 'Check again'),
      )
    case 'need-permission':
      return {
        text: tr('需要「安装未知应用」权限（壳侧已打开授权页）——开启后返回应用即可续继安装', 'Install-unknown-apps permission is required; the settings page is open. Return after granting to continue.'),
        checkLabel: tr('检查更新', 'Check for updates'),
        checkEnabled: false,
        installLabel: tr('授权后继续安装', 'Continue after granting'),
        installEnabled: true,
        detail: null,
      }
    case 'failed': {
      // 失败态有两条重试路径，取决于壳侧手上还有没有那个已校验的包（快照的 hasReadyArtifact）：
      // 有 → install 直接续继安装，不重拉 169MB；没有 → 只有 check（重新取元数据）说得通，
      // 此时再发 install 只会被壳侧回 not-available。摆一枚点了不受理的按钮比不摆更糟。
      const ready = status.hasReadyArtifact === true
      return {
        // 失败原因原样展示：壳侧 reason 已是成句中文且按类归因，翻译会丢掉它想传达的那一档。
        text: status.reason ?? tr('更新未完成（壳侧未给出原因，可复制日志反馈）', 'The update did not finish; copy the log and report it.'),
        checkLabel: tr('重试', 'Retry'),
        checkEnabled: true,
        installLabel: ready ? tr('重试安装', 'Retry install') : null,
        installEnabled: ready,
        detail: null,
      }
    }
    default:
      return checkOnly(tr('运行时与安装包状态未检查', 'Runtime and APK status not checked'), true)
  }
}

/**
 * 「应用更新」分区内容块：状态/版本文本 + 检查、下载两枚硬绑定动作的按钮。
 * @returns 该设置分区内的一个功能块。
 */
export function ApkUpdateRow() {
  const [raw, refresh] = useShellState<ApkUpdateStatus | null>(readStatus)
  const [message, setMessage] = useState<Notice | null>(null)

  const status = raw ?? null
  const state = typeof status?.state === 'string' ? status.state : ''

  /** 进行中：轮询读回真源。终态不挂定时器（要求：不做常驻轮询）。 */
  const polling = BUSY_STATES.has(state)
  useEffect(() => {
    if (!polling) return
    const timer = window.setInterval(() => { refresh() }, 2000)
    return () => { window.clearInterval(timer) }
  }, [polling, refresh])

  /**
   * 发一次动作并如实回执。
   * @param action - 由**按钮自己**决定（检查按钮只发 check，下载按钮只发 install）；不在这里按状态推断。
   */
  const send = useCallback((action: 'check' | 'install'): void => {
    setMessage(null)
    const accepted = invoke(action)
    if (accepted === null) {
      setMessage({ text: tr('更新通道不可用（仅安卓应用内有此能力）——请确认在本机应用内操作', 'Updates are only available inside the Android app.') })
      return
    }
    // ok 只表达受理；真正的进展由轮询读回。busy 时壳侧会回 ok:false + code:busy，如实说。
    if (accepted.ok !== true) {
      setMessage({
        text: accepted.code === 'busy'
          ? tr('上一次更新动作仍在进行中，请稍候（进度见上方）', 'The previous update is still running; the progress is shown above.')
          : tr('这次请求未被受理：', 'The request was not accepted: ') + (accepted.reason ?? tr('可稍后重试', 'try again later')),
        ...(accepted.code === undefined ? {} : { code: accepted.code }),
      })
    }
    refresh()
  }, [refresh])

  const onCheck = useCallback(() => { send('check') }, [send])
  const onInstall = useCallback(() => { send('install') }, [send])

  const row = status === null
    // 桥缺席/不可解析：措辞纪律不得在同一行里同时出现「读不到」与「已是最新」（那会让判读自相矛盾），
    // 也不得渲染成 idle。这里只说清「无法判断」，不引任何终态词。
    ? {
        text: tr('更新状态：读不到——无法判断是否有新版本（应用内的更新通道不可用或返回异常）', 'Update status could not be read, so a new version cannot be ruled in or out.'),
        checkLabel: tr('检查更新', 'Check for updates'),
        checkEnabled: true,
        installLabel: null,
        installEnabled: false,
        detail: null,
      }
    : viewOf(state, status)

  return (
    <div className="dsh-dev-cache" data-plugin="dev-apk-update">
      <div className="dsh-dev-row" data-apk-state={status === null ? 'unavailable' : state}>
        <span>{row.text}</span>
        <button
          type="button"
          className="dsh-dev-btn"
          data-apk-action="check"
          disabled={!row.checkEnabled}
          onClick={onCheck}
        >{row.checkLabel}</button>
        {/* 下载按钮只在有这条路时才渲染（其余态壳侧没有可受理的 install，摆一枚点了没反应的按钮
            比不摆更糟）。失败态的重试路径是 check，故这里不复活它。 */}
        {row.installLabel !== null && (
          <button
            type="button"
            className="dsh-dev-btn"
            data-apk-action="install"
            disabled={!row.installEnabled}
            onClick={onInstall}
          >{row.installLabel}</button>
        )}
      </div>

      {/* 补充事实（目前是「发布方声明的摘要」）：与状态主文本分行，避免把它读成「已校验通过」。 */}
      {row.detail !== null && <p className="dsh-dev-hint" data-apk-detail>{row.detail}</p>}

      {message !== null && (
        <p className="dsh-dev-hint" {...noticeDataAttrs(message)}>{message.text}</p>
      )}

      {/* 保留「更新的是什么、怎么校验、何时发起」「权限缺失怎么办」这些用户真要拿来做决定的信息；
          去掉与按钮状态逐字重复的流程复述。 */}
      <p className="dsh-dev-hint">
        {tr('更新应用安装包（APK）：按本机 ABI 从 GitHub 发布页取包，校验体积与 sha256 后交给系统安装器。只在你点击时下载；缺「安装未知应用」权限会先打开授权页。', 'Updates the app APK: the matching ABI comes from the GitHub release, and its size and sha256 are verified before the system installer opens. Downloads start only when you tap; a missing install permission opens the grant page first.')}
      </p>
    </div>
  )
}

/**
 * 「应用更新」设置分区（用户拍板：更新块继续放设置页，但从开发者选项**提级**为一级分区）。
 *
 * 真因与此前「通知」提级同形：唯一入口曾埋在开发者选项里，而「应用怎么更新」是每个用户都要用到的
 * 能力，埋在开发者选项等于对普通用户不可达（审查档 §3.3 第 14 行）。
 * 现在的层级：设置页一级分区「应用更新」（`android-apk-update`），开发者选项里只留一行指路文案，
 * 不重复渲染同一组控件（同功能双实现是审查档 §5 的结构性根因）。
 *
 * @returns 该设置分区的内容列。
 */
export function ApkUpdateSection(_props: PropsRuntime<'settings.section'>) {
  return (
    <section className="dsh-screen-control-card" aria-labelledby="dsh-apk-update-title">
      <header className="dsh-screen-control-header">
        <span>
          <strong id="dsh-apk-update-title">{tr('应用更新', 'App updates')}</strong>
          <small>{tr('检查是否有新版安装包，并在此下载安装；只在你点击时才发起。', 'Check for a newer APK and install it here; nothing starts until you tap.')}</small>
        </span>
      </header>
      <ApkUpdateRow />
    </section>
  )
}
