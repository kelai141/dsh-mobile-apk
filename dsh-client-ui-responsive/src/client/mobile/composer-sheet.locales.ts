/** 加号底部 sheet 的自有文案（中英双语，命名空间 androidComposerSheet）。 */
export const zh = {
  sheetLabel: '添加内容',
  camera: '拍照',
  photo: '照片',
  file: '本地文件',
  more: '更多操作',
  close: '关闭',
  // 原生拍照回执（issue #1288 第 4 条）。码值来自壳侧 PhotoCapture.CODE_*，
  // 页面只负责「把码翻成人话」，不猜原因、不静默吞掉失败。
  photoStarting: '正在打开相机…',
  photoAccepted: '已拍照，正在加入会话',
  photoCancelled: '已取消拍照',
  photoPermissionDenied: '没有相机权限，无法拍照——请在系统「应用信息 → 权限 → 相机」里开启后重试',
  photoUnavailable: '这台设备没有可用的相机应用',
  photoBusy: '相机正在被占用或无法启动——关掉其它正在用相机的应用后重试',
  photoFailed: '相机没有写出照片——请重拍一次',
  photoCompressFailed: '照片压缩失败——原图已保留，可稍后重试',
  photoInFlight: '上一次拍照还没结束，请稍候',
  photoNotWired: '拍照通道未接线',
  photoUnknown: '拍照失败（未知原因）',
}
export const en: typeof zh = {
  sheetLabel: 'Add content',
  camera: 'Camera',
  photo: 'Photos',
  file: 'Local files',
  more: 'More actions',
  close: 'Close',
  photoStarting: 'Opening the camera…',
  photoAccepted: 'Photo taken; adding it to the conversation',
  photoCancelled: 'Photo capture cancelled',
  photoPermissionDenied: 'No camera permission, so a photo cannot be taken. Allow Camera in system App info, then retry.',
  photoUnavailable: 'This device has no camera app available',
  photoBusy: 'The camera is busy or failed to start. Close other apps using the camera, then retry.',
  photoFailed: 'The camera wrote no photo. Try again.',
  photoCompressFailed: 'Compressing the photo failed; the original is kept so you can retry.',
  photoInFlight: 'The previous capture is still running',
  photoNotWired: 'The capture channel is not wired',
  photoUnknown: 'Photo capture failed (unknown reason)',
}
export type ComposerSheetKey = keyof typeof zh
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { androidComposerSheet: ComposerSheetKey }
}
