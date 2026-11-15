/**
 * #1145: reserve a side lane for the return-to-bottom control.
 * Bottom padding only protects the last line; earlier text still scrolls underneath a
 * sticky button.
 *
 * #1782（用户，真机 V2425A 1260x2800）：正文整体被挤窄，右侧留出一条空白通道，且那条
 * 通道与右下「回到底部」圆钮的直径正好贴合 —— 就是这里给按钮预留的。
 *
 * 设备实测（CDP，420 CSS px 视口 = 用户机 1260px / density 3）：
 *   flow [data-chat-flow]   padding-right = 52px  -> 正文右缘 335.1
 *   上游 _scroll            padding 16px 32px     -> 已有右侧净空 32px
 *   上游 _toBottomSlot      padding-right 32px（max(clearance+16, 居中项)）
 * 也就是**上游已经自己算好了净空**：它把按钮放在那条 padding 的内侧、与正文列右缘对齐。
 * 我们这条 padding-right 是在已经对齐的列里再压一次，正文因此恒定少 52px。
 *
 * 为什么不能直接删掉：删掉后实测按钮压住正文 44px（按钮 l=337.3 / 正文右缘 381.3）。
 *
 * 所以净空只在**按钮真的在屏上时**才留：上游按「是否脱离尾部」挂载 _toBottomSlot，
 * 它存在 <=> 按钮可见。用 :has() 按这个事实开合，正文在跟随尾部（绝大多数时间）吃满整列。
 *
 * 与 #1145 的差异：原注释说跟随尾部时也留着通道以免滚动重排。代价是正文永远少 52px ——
 * 用户报障的正是这个永久损失。滚动时的一次重排是可接受、有界的代价；永久窄列不是。
 *
 * 不选「把通道挪到 _toBottomSlot 上」：该槽 height:0 且不含正文，在它上面留白只会把按钮
 * 往左推（更压正文），并不会让正文变宽。
 */
export const TO_BOTTOM_GUTTER_CSS: string = `
[data-conversation-scroll]:has([class*='_toBottomSlot']) [data-chat-flow] {
  box-sizing: border-box;
  padding-right: 52px; /* 44px 按钮 + 8px */
}
[data-conversation-scroll] [class*='_toBottomSlot'] > button {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  margin-top: -44px;
}
`;
