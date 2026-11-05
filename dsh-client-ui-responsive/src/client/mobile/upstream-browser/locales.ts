/** Locale-owned Browser tab copy. */
export const zh = {
  'native.desktop': 'PC',
  'native.mobile': '手机',
  'native.viewport': '浏览器视口分辨率',
  'native.viewport.apply': '应用分辨率',
  'native.viewport.invalid': '请输入 240–4096 范围的宽 × 高。',
  'native.unavailable': 'Android 浏览器不可用：{reason}',
  'native.isolation.unavailable': '浏览器可用；身份隔离不可用（已降级为单一身份档）',
  'native.close': '关闭原生浏览器标签页',
  'native.retry': '重新读取浏览器状态',
  'native.operation.failed': '浏览器操作未完成：{reason}',
  'type.label': '浏览器',
  'guide.title': '浏览器',
  'guide.description': '浏览网页',
  'shortcut.noSession': '请先打开一个会话',
  'address.placeholder': '输入 HTTP(S) 地址',
  'address.changed': 'URL 已变化',
  back: '后退',
  forward: '前进',
  reload: '刷新',
  go: '前往',
  external: '在系统浏览器中打开',
  'sandbox.disable': '关闭沙箱限制',
  'sandbox.enable': '恢复沙箱限制',
  'sandbox.warning': '沙箱限制已关闭；页面可以导航顶层应用，并使用下载、模态对话框与输入锁定。',
  start: '输入 HTTP(S) 地址开始浏览',
  loading: '正在打开…',
  'restore.previous': '上次打开',
  'restore.action': '恢复页面',
  'error.empty': '请输入地址。',
  'error.invalid': '这个地址无效或过长。',
  'error.protocol': '只支持 HTTP 和 HTTPS 地址；本地文件请使用文档预览。',
  'error.credentials': '地址不能包含用户名或密码。',
  'error.application-origin': '不能在嵌入浏览器中打开 DSH 应用自身。',
  'load.failed': '页面加载失败；请刷新重试或在系统浏览器中打开。',
  'load.failed.detail': '页面加载失败 ({code}): {description}',
  'address.unknown': '页面已跳转；当前载体无法读取新的 URL。',
} satisfies Record<string, string>

/** Browser dictionary key union. */
export type SidebarBrowserKey = keyof typeof zh

/** English dictionary with the same keys. */
export const en = {
  'native.desktop': 'PC',
  'native.mobile': 'Mobile',
  'native.viewport': 'Browser viewport resolution',
  'native.viewport.apply': 'Apply resolution',
  'native.viewport.invalid': 'Enter width × height within 240–4096.',
  'native.unavailable': 'Android browser unavailable: {reason}',
  'native.isolation.unavailable': 'Browser works; identity isolation unavailable (single profile fallback)',
  'native.close': 'Close native browser tab',
  'native.retry': 'Refresh browser status',
  'native.operation.failed': 'Browser operation did not complete: {reason}',
  'type.label': 'Browser',
  'guide.title': 'Browser',
  'guide.description': 'Browse web pages',
  'shortcut.noSession': 'Open a session first',
  'address.placeholder': 'Enter an HTTP(S) address',
  'address.changed': 'URL changed',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  go: 'Go',
  external: 'Open in system browser',
  'sandbox.disable': 'Disable sandbox restrictions',
  'sandbox.enable': 'Restore sandbox restrictions',
  'sandbox.warning': 'Sandbox restrictions are disabled; the page can navigate the top-level app and use downloads, modal dialogs, and input locks.',
  start: 'Enter an HTTP(S) address to start browsing',
  loading: 'Opening…',
  'restore.previous': 'Previously opened',
  'restore.action': 'Restore page',
  'error.empty': 'Enter an address.',
  'error.invalid': 'That address is invalid or too long.',
  'error.protocol': 'Only HTTP and HTTPS addresses are supported; use Document Preview for local files.',
  'error.credentials': 'Addresses cannot contain a username or password.',
  'error.application-origin': 'The embedded browser cannot open the DSH application itself.',
  'load.failed': 'The page could not load; reload or open it in the system browser.',
  'load.failed.detail': 'Page load failed ({code}): {description}',
  'address.unknown': 'The page navigated; this carrier cannot read its new URL.',
} satisfies Record<SidebarBrowserKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar Browser labels, navigation controls, and failures. */
    androidSidebarBrowser: SidebarBrowserKey
  }
}
