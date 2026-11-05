/** Copy for the narrow right-panel navigation. */
export const zh = {
  tabs: '打开的工作面板',
  toggle: '展开或收起工作面板标签',
  close: '关闭标签：{title}',
  reorder: '长按拖动排序；键盘可按 Alt 加上下方向键排序',
  moved: '已调整标签顺序',
  conversation: '对话',
  browser: '浏览器',
  terminal: '终端',
  vdisplay: '虚拟屏',
  tool: '工具面板',
  split: '分栏',
  splitLabel: '创建双工作区',
  float: '小窗',
  floatLabel: '将当前标签小窗化',
}
export const en: typeof zh = {
  tabs: 'Open work panels',
  toggle: 'Expand or collapse work panel tabs',
  close: 'Close tab: {title}',
  reorder: 'Hold and drag to reorder; use Alt and arrow keys on a keyboard',
  moved: 'Tab order updated',
  conversation: 'Conversation',
  browser: 'Browser',
  terminal: 'Terminal',
  vdisplay: 'Virtual display',
  tool: 'Tool panel',
  split: 'Split',
  splitLabel: 'Create a second workspace',
  float: 'Float',
  floatLabel: 'Float the current tab',
}
export type BubbleKey = keyof typeof zh
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { androidSidebarBubbles: BubbleKey }
}
