/** 交付文件卡片胶囊的文案（中英双语，命名空间 androidFileCard）。 */
export const zh = {
  openExternal: '用其他应用打开：{name}',
  share: '转发该文件',
}
export const en: typeof zh = {
  openExternal: 'Open with another app: {name}',
  share: 'Share this file',
}
export type FileCardKey = keyof typeof zh
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { androidFileCard: FileCardKey }
}
