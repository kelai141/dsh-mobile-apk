/**
 * 「关于」设置分区（0.15.0 用户定例，第三版：品牌页形态）。
 *
 * 入口在「设置 → 通用」最下方那一行（上游的「当前版本」被替换成「关于」），
 * 点进去是本页——与其它分区同构：列表 → 二级页，返回键自动可用。
 *
 * 页面自上而下：应用图标 → 名称 → 版本 → 仓库与社群两个可点击链接。
 *
 * 版本来源：
 *  - 壳（DeepCode）：壳桥 `androidBridge.version()`（BuildConfig.VERSION_NAME）；
 *  - 引擎（DeepSeek​Harness）：由 about-entry 在被替换的那行原文里抓到，经 getEngineVersion() 取。
 */
import { useEffect, useRef } from 'react'
import { tr } from '../i18n.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ABOUT_LOGO_DATA_URL } from './about-logo.ts'
import { getEngineVersion, getShellVersion } from './about-entry.ts'

/** 仓库地址。 */
const REPO_URL = 'https://github.com/kelai141/dsh-mobile-apk'

/** QQ 交流群（群号 1109493992）；与 README 徽章同一个分享链接。 */
const QQ_GROUP_URL =
  'https://qun.qq.com/universal-share/share?ac=1&authKey=C2NW5eWXsV%2FYu5DEkV9Ac%2FqYcXhGCY8C3Lga40KNCfE4AOjzlSeAaRGvWZqc3ADV'
  + '&busi_data=eyJncm91cENvZGUiOiIxMTA5NDkzOTkyIiwidG9rZW4iOiJjTTRDM3pwNjRLTE8rbkZBVjRDbnFVWlBOdU04aGJaS3FaSG1xZWFXbm5ZNXphbEJBOXdGMGw2N0V3YnpabnhaIiwidWluIjoiMzc1NDY4MDE3NSJ9'
  + '&data=NzUYIVyoUDsINSstug9aQ6Kf4EUx-hhDegPFaPS-1RD-p_4eE02WN773yEIujclrFYtWRDkLyDa-YDtWj2bKjg&svctype=4&tempid=h5_group_info'

/** 外链一律走系统浏览器（与市场反馈、外部链接预览同一路径）。 */
function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * 一行可点击链接，沿用上游通用设置的行骨架：
 * 左文字列（标题 + 灰色说明）+ 右控件列（外链箭头），16px 行内距、0.5px 分隔线。
 */
function LinkRow(props: { label: string; detail: string; url: string }) {
  return (
    <button
      type="button"
      className="dsh-gs-row dsh-about-link"
      data-dsh-about-link={props.url}
      onClick={() => openExternal(props.url)}
    >
      <span className="dsh-gs-text">
        <span className="dsh-gs-title">{props.label}</span>
        <span className="dsh-gs-desc">{props.detail}</span>
      </span>
      <span className="dsh-gs-control">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none"
          stroke="currentColor" strokeWidth="1.3">
          <path d="M6 3h7v7M13 3 5.5 10.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M11 12.5H3.5V5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  )
}

/** 上游内容列表头行的标记：它是「关于」字样的第二个来源。 */
const HEADER_ATTR = 'data-dsh-about-header'

/**
 * 认出「上游内容列的表头行」并打上标记，返回被打标记的节点（收回时逐个撤销）。
 *
 * 为什么不在样式表里写结构选择器：`> div:last-child > div:first-child` 假设内容列的第一个
 * 子节点就是表头行。上游一旦把分区根节点直接放进内容列，那条规则命中的就是**整页**——
 * 关于页整个 display:none，界面上只剩一条返回条，而且没有任何测试能发现（jsdom 不算布局）。
 *
 * 判据改成「从本页根节点往上找第一个可收的表头」：
 *  - 逐级看祖先的第一个元素子节点；它必须是个 div、且**不含本页根节点**（含就说明那是
 *    包装层而不是表头，继续往上）；
 *  - 走到设置面板就停：面板的第一个孩子是我方标题条（含返回键），绝不能标记；
 *  - 认不出来时什么都不标——宁可留下一个重复的「关于」，也不能把页面藏掉。
 *
 * 只认 div：与原先那条 `> div:first-child` 的目标一致，不扩大打击面（把工具条之类一并收掉）。
 *
 * @param root - 关于页根节点。
 * @returns 被打上 [HEADER_ATTR] 的节点；没有可收的表头时为空数组。
 */
function markUpstreamHeader(root: HTMLElement): HTMLElement[] {
  const panel = root.closest('[data-dsh-settings-dialog]')
  let node: HTMLElement | null = root.parentElement
  for (let depth = 0; node !== null && depth < 8; depth++) {
    // 面板本身不进候选：它的第一个孩子是我方标题条（含返回键）。
    if (node === panel || node === document.body) break
    const first = node.firstElementChild
    if (first instanceof HTMLElement && first.tagName === 'DIV'
      && first !== root && !first.contains(root)
      && !first.matches('[data-dsh-settings-bar], nav')) {
      first.setAttribute(HEADER_ATTR, '')
      return [first]
    }
    node = node.parentElement
  }
  return []
}

export function AboutSection(_props: PropsRuntime<'settings.section'>) {
  // 标题条已经由图标 + 名称承担，再挂一个「关于」是重复的（用户定例）。
  // 标记打在**设置容器**上而不是标题元素上：移动层每次同步会重建/改写标题条，
  // 打在标题上的标记会随之丢失（上一版就是这么又冒出来的）。
  const pageRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // 给**所有**带这个标记的容器都打上：不同构建里可能嵌套多层，只标最外层会漏掉标题条所在的那层。
    const targets = [...document.querySelectorAll('[data-dsh-settings-dialog]')]
    if (targets.length === 0) targets.push(document.documentElement)
    for (const el of targets) el.setAttribute('data-dsh-about-active', '')
    const header = pageRef.current === null ? [] : markUpstreamHeader(pageRef.current)
    return () => {
      for (const el of targets) el.removeAttribute('data-dsh-about-active')
      for (const el of header) el.removeAttribute(HEADER_ATTR)
    }
  }, [])
  const shell = getShellVersion()
  const engine = getEngineVersion()
  return (
    <div className="dsh-about-page" data-plugin="android-about" ref={pageRef}>
      <div className="dsh-about-brand">
        <img className="dsh-about-logo" src={ABOUT_LOGO_DATA_URL} alt="" width={148} height={148} />
        <div className="dsh-about-name">DeepCode</div>
        <div className="dsh-about-version" data-dsh-about-shell-version="">
          {tr('DeepCode 版本：', 'DeepCode version: ')}
          {shell === '' ? '—' : shell}
        </div>
        <div className="dsh-about-engine" data-dsh-about-engine-version="">
          {tr('DeepSeek​Harness 版本：', 'DeepSeek​Harness version: ')}
          {engine === '' ? '—' : engine}
        </div>
      </div>

      <div className="dsh-about-links" data-dsh-about-list="">
        <LinkRow
          label={tr('GitHub 仓库', 'GitHub repository')}
          detail="kelai141/dsh-mobile-apk"
          url={REPO_URL}
        />
        <LinkRow
          label={tr('QQ 交流群', 'QQ group')}
          detail={tr('群号 1109493992', 'Group 1109493992')}
          url={QQ_GROUP_URL}
        />
      </div>
    </div>
  )
}
