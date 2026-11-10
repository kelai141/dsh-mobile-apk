/**
 * #1145: reserve a side lane for the return-to-bottom control for the whole transcript.
 * Bottom padding only protects the last line; earlier text still scrolls underneath a
 * sticky button. Keeping the lane when following the tail avoids rewrapping on scroll.
 * The upstream slot aligns its right edge with the unpadded chat column, so reserving
 * 44px + 8px inside that column keeps both narrow and max-width layouts disjoint.
 */
export const TO_BOTTOM_GUTTER_CSS: string = `
[data-conversation-scroll] [data-chat-flow] {
  box-sizing: border-box;
  padding-right: 52px;
}
[data-conversation-scroll] [class*='_toBottomSlot'] > button {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  margin-top: -44px;
}
`;
