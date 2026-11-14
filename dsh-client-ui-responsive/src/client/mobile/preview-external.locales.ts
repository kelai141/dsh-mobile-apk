/** Copy for the Android action below the document preview's unsupported notice. */
export const zh = {
  open: '在外部应用打开',
  unavailable: '当前环境无法调用外部应用，请在安卓应用内打开。',
  noReceiver: '没有应用能打开此文件，请先安装支持该格式的应用。',
  notReadable: '文件已移动、被删除或无法读取。',
  notAllowed: '此文件所在的目录不允许向外部应用开放。',
  failed: '未能打开此文件，请重试。',
}
export const en: typeof zh = {
  open: 'Open in external app',
  unavailable: 'External apps are unavailable here. Open this in the Android app.',
  noReceiver: 'No app can open this file. Install an app that supports this format.',
  notReadable: 'This file was moved, deleted, or cannot be read.',
  notAllowed: 'Files in this folder cannot be opened in external apps.',
  failed: 'Could not open this file. Try again.',
}
export type PreviewExternalKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { androidPreviewExternal: PreviewExternalKey }
}
