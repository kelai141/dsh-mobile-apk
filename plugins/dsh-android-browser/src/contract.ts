/**
 * dsh-android-browser 数据契约（唯一契约源）。
 *
 * 本文件是**面板（client 半，待 dev-gesture 释放 ui-responsive 后落地）/ 工具面 / 壳桥 op**
 * 三面共用的命名与载荷契约。任何一面改名前先改这里，避免三处各自漂移。
 *
 * 命名对齐（方案 §5.3）：工具名对齐 Lum1104/dsh-browser 的生态既有语义
 * （browser_open/snapshot/click/type/press/scroll/navigate/*_tab/get_text/wait）；
 * 视口/身份档位对齐 DSH-Chrome-devtools 的 resize/emulate 语义。
 * 归属：入口按用户约束 U-1 落 app 内「文件」面板（与「工作区文件」同级），不另起入口。
 */

/** 引擎侧工具名（模型可见）。本轮只注册 TIER，其余为契约预留。 */
export const BROWSER_TOOLS = {
  tier: 'android_browser_tier',
  open: 'browser_open',
  snapshot: 'browser_snapshot',
  click: 'browser_click',
  type: 'browser_type',
  press: 'browser_press',
  scroll: 'browser_scroll',
  getText: 'browser_get_text',
  wait: 'browser_wait',
  navigate: 'browser_navigate',
  back: 'browser_back',
  forward: 'browser_forward',
  reload: 'browser_reload',
  listTabs: 'browser_list_tabs',
  followTab: 'browser_follow_tab',
  closeTab: 'browser_close_tab',
  setIdentity: 'browser_set_identity',
  setViewport: 'browser_set_viewport',
  screenshot: 'browser_screenshot',
} as const

/**
 * 壳桥 op 名（DeviceControlService.handle 分支 + ControlProtocolV2.SUPPORTED_OPS + 引擎 ControlOp
 * + ROUTE_OPS + manage 工具面 = 六处登记链；**browser\* 不进 A11Y_OPS**，方案 §4.5 明确）。
 * 壳侧执行位已落地（BrowserHost.kt / DeviceControlService 的 browser* 分支，见 #523），op 名与此处一致。
 */
export const BROWSER_OPS = {
  caps: 'browserCaps',
  show: 'browserShow',
  hide: 'browserHide',
  close: 'browserClose',
  open: 'browserOpen',
  js: 'browserJs',
  input: 'browserInput',
  shot: 'browserShot',
  state: 'browserState',
  setUa: 'browserSetUa',
  viewport: 'browserViewport',
  // 0.14.0 多页签（用户语义：AI 用工具直接管多网页，UI 只是给人看的视图）：
  // 此前只注册了 browserOpen，但BrowserHost 是单 WebView —— 工具承诺了做不到的事
  // （用户实测开三个站点只有一个生效）。这三条把「多页」补齐为真。
  tabs: 'browserTabs',
  followTab: 'browserFollowTab',
  closeTab: 'browserCloseTab',
} as const

/** 面板数据面路由（引擎侧 webserver；**本轮不注册**，避免 exact 路由绕过 /api 前缀鉴权的老问题）。 */
export const BROWSER_ROUTES = {
  status: '/api/android/browser/status',
} as const

/** 视口档位（方案 §4.3 全量表 + “跟随系统屏幕”动态档）。 */
export interface ViewportPreset {
  id: string
  width: number
  height: number
  label: string
  mobile: boolean
}

export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: 'device', width: 0, height: 0, label: '跟随工位（默认）', mobile: true },
  { id: 'phone-portrait', width: 390, height: 844, label: '手机竖屏 390×844', mobile: true },
  { id: 'portrait-720', width: 720, height: 1280, label: '手机竖屏 720×1280', mobile: true },
  { id: 'portrait-1080', width: 1080, height: 1920, label: '手机竖屏 1080×1920', mobile: true },
  { id: 'tablet', width: 768, height: 1024, label: '平板 768×1024', mobile: true },
  { id: 'tablet-landscape', width: 1024, height: 768, label: '平板横屏 1024×768', mobile: false },
  { id: 'desktop-720', width: 1280, height: 720, label: '桌面 1280×720', mobile: false },
  { id: 'desktop-1080', width: 1920, height: 1080, label: '桌面 1920×1080', mobile: false },
] as const

/** 身份档位（默认真实手机；伪装档需额外确认与风险文案，方案 §3.5）。 */
export interface IdentityProfile {
  id: string
  label: string
  ua: string
  platform: string
  mobile: boolean
  requiresConfirm: boolean
}

export const IDENTITY_PROFILES: readonly IdentityProfile[] = [
  {
    id: 'android-real',
    label: '真实手机（默认）',
    ua: '',
    platform: '',
    mobile: true,
    requiresConfirm: false,
  },
  {
    id: 'linux-desktop',
    label: 'Linux 桌面 Chrome',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    mobile: false,
    requiresConfirm: true,
  },
  {
    id: 'windows-desktop',
    label: 'Windows 桌面 Chrome',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
    platform: 'Win32',
    mobile: false,
    requiresConfirm: true,
  },
] as const

/**
 * 工具面逐条契约（参数 / 返回值 / 权限档）——面板与实现共用；权限档对齐
 * docs/IMPLEMENTATION-ACCEPTANCE-PLAN-2026-09-12.md §4.5 的审批表：
 *  read = 只读（可按 origin 信任）/ approval = 需批准 / full-access = 完全访问档且默认失败关闭 /
 *  confirm = 需批准 + 额外二次确认（伪装档）。
 */
export interface ToolContract {
  name: string
  params: string
  returns: string
  permission: 'read' | 'approval' | 'full-access' | 'confirm'
}

export const BROWSER_TOOL_CONTRACTS: readonly ToolContract[] = [
  { name: BROWSER_TOOLS.tier, params: '{}', returns: '{ok,tier,viewportRoute,identityRoute,factsSource,uaChAvailable,androidxWebkitAvailable,densityOverrideSupported,browserWebViewAvailable,cdpEnabled,reasons[],degradedNotes[],tools[],ops[],routes[],viewportPresets[],identityProfiles[]}', permission: 'read' },
  { name: BROWSER_TOOLS.open, params: '{url:string, viewport?:string, identity?:string}', returns: '{ok,url,title,loadState}', permission: 'approval' },
  { name: BROWSER_TOOLS.snapshot, params: '{delta?:boolean}', returns: '{ok,sourceUrl,sourceTitle,text,refs:[{ref,bx,role,name}],truncated}', permission: 'read' },
  { name: BROWSER_TOOLS.click, params: '{ref:string}', returns: '{ok,url,changed:boolean}', permission: 'approval' },
  { name: BROWSER_TOOLS.type, params: '{ref:string, text:string, replace?:boolean}', returns: '{ok,url}', permission: 'approval' },
  { name: BROWSER_TOOLS.press, params: '{key:string}', returns: '{ok,url}', permission: 'approval' },
  { name: BROWSER_TOOLS.scroll, params: '{direction:"up"|"down"|"left"|"right", amount?:number}', returns: '{ok,scrollY,atEnd:boolean}', permission: 'read' },
  { name: BROWSER_TOOLS.getText, params: '{region?:{x:number,y:number,w:number,h:number}}', returns: '{ok,sourceUrl,text,truncated}', permission: 'read' },
  { name: BROWSER_TOOLS.wait, params: '{selector?:string, stable?:boolean, timeoutMs?:number}', returns: '{ok,waited:number,reason}', permission: 'read' },
  { name: BROWSER_TOOLS.navigate, params: '{url:string}', returns: '{ok,url,title}', permission: 'approval' },
  { name: BROWSER_TOOLS.back, params: '{}', returns: '{ok,url,canGoBack:boolean}', permission: 'approval' },
  { name: BROWSER_TOOLS.forward, params: '{}', returns: '{ok,url,canGoForward:boolean}', permission: 'approval' },
  { name: BROWSER_TOOLS.reload, params: '{}', returns: '{ok,url}', permission: 'approval' },
  { name: BROWSER_TOOLS.listTabs, params: '{}', returns: '{ok,tabs:[{tabId,url,title,active}],activeTabId}', permission: 'approval' },
  { name: BROWSER_TOOLS.followTab, params: '{tabId:string}', returns: '{ok,activeTabId,url}', permission: 'approval' },
  { name: BROWSER_TOOLS.closeTab, params: '{tabId:string}', returns: '{ok,activeTabId}', permission: 'approval' },
  { name: BROWSER_TOOLS.setIdentity, params: '{profile:string}', returns: '{ok,profile,uaChApplied:boolean,degraded?:string}', permission: 'confirm' },
  { name: BROWSER_TOOLS.setViewport, params: '{preset:string, fit?:"fit"|"one-to-one"}', returns: '{ok,preset,width,height,route}', permission: 'approval' },
  { name: BROWSER_TOOLS.screenshot, params: '{inline?:boolean}', returns: '{ok,path?,bytes,health:"ok"|"suspect",note?}', permission: 'full-access' },
] as const

/** 壳桥 op 逐条契约（参数 / 返回 / 权限档），供六处登记链与面板共用。 */
export const BROWSER_OP_CONTRACTS: readonly ToolContract[] = [
  { name: BROWSER_OPS.caps, params: '{}', returns: '{ok,webviewMajor,uaChAvailable,androidxWebkitCompiled,androidxWebkitAvailable,densityOverrideSupported,screenWidth,screenHeight,densityDpi,rendererProcesses}', permission: 'read' },
  { name: BROWSER_OPS.show, params: '{url?:string}', returns: '{ok,visible,created,url,pageGeneration}', permission: 'read' },
  { name: BROWSER_OPS.hide, params: '{}', returns: '{ok,visible}', permission: 'read' },
  { name: BROWSER_OPS.close, params: '{}', returns: '{ok,created,visible}', permission: 'read' },
  { name: BROWSER_OPS.open, params: '{url:string}', returns: '{ok,url,title,pageGeneration,reason}', permission: 'approval' },
  { name: BROWSER_OPS.js, params: '{expr?:string, snapshot?:boolean}', returns: '{ok,value,pageGeneration,url} | 快照 {ok,tabId,surface,pageGeneration,url,title,viewport,nodes[],truncated}', permission: 'full-access' },
  { name: BROWSER_OPS.input, params: '{kind:"tap"|"key"|"text", ref?, pageGeneration?, x?, y?, text?, key?}', returns: '{ok,url,pageGeneration,changed?,value?}', permission: 'approval' },
  { name: BROWSER_OPS.shot, params: '{inline?:boolean}', returns: '{ok,path,bytes,width,height,health,note?}', permission: 'full-access' },
  { name: BROWSER_OPS.state, params: '{}', returns: '{ok,url,title,pageGeneration,canGoBack,canGoForward,visible,tabId,tabs[]}', permission: 'read' },
  { name: BROWSER_OPS.setUa, params: '{profile:string, ua:string, platform:string, mobile:boolean}', returns: '{ok,profile,applied,uaChApplied:boolean,degraded?,reloaded}', permission: 'confirm' },
  { name: BROWSER_OPS.viewport, params: '{route:"S1"|"S2"|"S2b"|"S3", preset?:string, width:number, height:number, scale?:number}', returns: '{ok,route,width,height}', permission: 'approval' },
  // 0.14.0 多页签：三条 op 与 BROWSER_OPS 同批登记。契约完备性由插件单测守
  // （test/tier.test.mjs 的「契约完备」用例断言 BROWSER_OPS 每个键都有条目——
  //  我加 op 时漏补这里，正是被该用例抓到的）。
  { name: BROWSER_OPS.tabs, params: '{}', returns: '{ok,tabs[],activeTabId,tabCount}', permission: 'read' },
  { name: BROWSER_OPS.followTab, params: '{tabId:string}', returns: '{ok,activeTabId,url,tabs[]}', permission: 'read' },
  { name: BROWSER_OPS.closeTab, params: '{tabId?:string}', returns: '{ok,closedTabId,activeTabId,tabs[]}', permission: 'read' },
] as const

/** 面板状态载荷（面板/设置页读；**只读、无副作用**）。字段全部为必填，避免 undefined 成员。 */
export interface BrowserPanelStatus {
  available: boolean
  tier: string
  viewportRoute: string
  identityRoute: string
  factsSource: string
  reasons: readonly string[]
  degradedNotes: readonly string[]
}
