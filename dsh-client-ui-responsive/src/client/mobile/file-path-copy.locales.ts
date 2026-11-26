/** Bilingual copy for 450ms long-press preview path copying. */
export const zh = {
  copied: '已复制文件路径',
  failed: '复制文件路径失败',
}
export const en: typeof zh = {
  copied: 'File path copied',
  failed: 'Failed to copy file path',
}
export type FilePathCopyKey = keyof typeof zh
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { androidFilePathCopy: FilePathCopyKey }
}
