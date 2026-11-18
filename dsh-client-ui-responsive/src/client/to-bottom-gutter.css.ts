/** Style only the upstream floating return action, outside transcript layout. */
export const TO_BOTTOM_GUTTER_CSS: string = `
[data-conversation-scroll] {
  --dsh-chat-back-bottom: calc(var(--dsh-composer-height, 152px) + 12px);
}
[data-conversation-scroll] [class*='_toBottomSlot'] {
  bottom: var(--dsh-chat-back-bottom);
}
[data-conversation-scroll] [class*='_toBottomSlot'] > button {
  width: auto;
  min-width: 44px;
  height: 44px;
  gap: 4px;
  padding-inline: 10px;
  flex-shrink: 0;
  margin-top: -44px;
  font: inherit;
  font-size: 12px;
}
[data-conversation-scroll] [class*='_toBottomSlot'] > button::before {
  content: 'Back';
}
html[lang|='zh' i] [data-conversation-scroll] [class*='_toBottomSlot'] > button::before,
html:not([lang]) [data-conversation-scroll] [class*='_toBottomSlot'] > button::before,
html[lang=''] [data-conversation-scroll] [class*='_toBottomSlot'] > button::before {
  content: '返回';
}
`;
