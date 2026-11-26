/** Bilingual copy for the right-sidebar file external-open & share menu. */
export const zh = {
  trigger: '文件操作',
  openExternal: '在外部应用打开',
  shareFile: '分享文件',
  unavailable: '当前环境不支持此操作',
  noReceiver: '没有可打开或接收此文件的应用',
  notReadable: '文件无法读取',
  notAllowed: '该路径不允许共享给外部应用',
  failed: '操作失败，请重试',
}
export const en: typeof zh = {
  trigger: 'File actions',
  openExternal: 'Open in another app',
  shareFile: 'Share file',
  unavailable: 'This action is unavailable here',
  noReceiver: 'No app can handle this file',
  notReadable: 'File cannot be read',
  notAllowed: 'This path cannot be shared externally',
  failed: 'Action failed, please retry',
}
export type SidebarFileActionsKey = keyof typeof zh
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { androidSidebarFileActions: SidebarFileActionsKey }
}
