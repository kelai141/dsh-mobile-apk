/** 交付文件卡片胶囊的文案（中英双语，命名空间 androidFileCard）。 */
export const zh = {
  openExternal: '用其他应用打开：{name}',
  share: '转发该文件',
  noReceiver: '没有应用能处理此文件。仍可点文件名尝试在侧栏预览。',
  notReadable: '文件已移动、被删除或无法读取。',
  notShareable: '此文件所在的目录不允许向其他应用分享。',
  failed: '未能打开或分享此文件，请重试。',
}
export const en: typeof zh = {
  openExternal: 'Open with another app: {name}',
  share: 'Share this file',
  noReceiver: 'No app can handle this file. Tap its name to try the sidebar preview.',
  notReadable: 'This file was moved, deleted, or cannot be read.',
  notShareable: 'This file is in a folder that cannot be shared with other apps.',
  failed: 'Could not open or share this file. Try again.',
}
export type FileCardKey = keyof typeof zh
export function fileCardErrorKey(error: string | undefined): FileCardKey {
  if (error === 'no-receiver') return 'noReceiver'
  if (error === 'io') return 'notReadable'
  if (error === 'uri-denied') return 'notShareable'
  return 'failed'
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { androidFileCard: FileCardKey }
}
