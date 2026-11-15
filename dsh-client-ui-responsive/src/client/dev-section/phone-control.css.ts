/**
 * Styles owned by the phone-control section.
 *
 * The section follows the General Settings row rhythm: flat background, full-width rows, a hairline
 * divider, title on the left and state or chevron on the right. Cards, pills for ordinary actions and
 * multicolumn button walls stay out of the primary surface; secondary views keep the same rows.
 */
export const PHONE_CONTROL_CSS: string = `
[data-plugin='dev-phone-control'] {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

[data-plugin='dev-phone-control'] .dsh-pc-screen {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

[data-plugin='dev-phone-control'] .dsh-pc-screen-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

[data-plugin='dev-phone-control'] .dsh-pc-segment {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
  padding: 2px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}

[data-plugin='dev-phone-control'] .dsh-pc-segment > button {
  min-width: 0;
  min-height: 36px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

[data-plugin='dev-phone-control'] .dsh-pc-segment > button[aria-checked='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3);
}

[data-plugin='dev-phone-control'] .dsh-pc-segment > button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

[data-plugin='dev-phone-control'] .dsh-pc-segment > button:focus-visible,
[data-plugin='dev-phone-control'] .dsh-pc-row-main:focus-visible,
[data-plugin='dev-phone-control'] .dsh-pc-row:focus-visible,
[data-plugin='dev-phone-control'] .dsh-pc-inline:focus-visible,
[data-plugin='dev-phone-control'] .dsh-pc-back:focus-visible {
  outline: 2px solid #4d6bfe;
  outline-offset: 2px;
}

[data-plugin='dev-phone-control'] .dsh-pc-scope-line {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

[data-plugin='dev-phone-control'] .dsh-pc-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 16px 0;
  border: 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: inherit;
  text-align: left;
}

button.dsh-pc-row {
  cursor: pointer;
}

[data-plugin='dev-phone-control'] .dsh-pc-row-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

[data-plugin='dev-phone-control'] .dsh-pc-text {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

[data-plugin='dev-phone-control'] .dsh-pc-side {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  max-width: 48%;
}

[data-plugin='dev-phone-control'] .dsh-pc-state {
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  text-align: right;
  overflow-wrap: anywhere;
}

[data-plugin='dev-phone-control'] .dsh-pc-state[data-unreadable='true'] {
  color: var(--dsw-alias-state-error-primary);
}

[data-plugin='dev-phone-control'] .dsh-pc-chevron {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 18px;
  line-height: 18px;
}

[data-plugin='dev-phone-control'] .dsh-pc-inline {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #4d6bfe;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}

[data-plugin='dev-phone-control'] .dsh-pc-inline:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

[data-plugin='dev-phone-control'] .dsh-pc-subhead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 4px 0 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

[data-plugin='dev-phone-control'] .dsh-pc-subhead > strong {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

[data-plugin='dev-phone-control'] .dsh-pc-back {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  min-height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

[data-plugin='dev-phone-control'] .dsh-pc-back > span {
  font-size: 18px;
  line-height: 18px;
}

[data-plugin='dev-phone-control'] .dsh-pc-actions {
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

[data-plugin='dev-phone-control'] .dsh-pc-primary {
  min-height: 40px;
  padding: 0 14px;
}

[data-plugin='dev-phone-control'] .dsh-pc-detail-title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
}

[data-plugin='dev-phone-control'] .dsh-pc-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

[data-plugin='dev-phone-control'] .dsh-pc-detail:last-child {
  border-bottom: 0;
}

[data-plugin='dev-phone-control'] .dsh-pc-detail p {
  margin: 0;
  overflow-wrap: anywhere;
}

[data-plugin='dev-phone-control'] .dsh-pc-destructive {
  margin-top: 8px;
}

[data-plugin='dev-phone-control'] .dsh-pc-plain {
  gap: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

@media (max-width: 380px) {
  [data-plugin='dev-phone-control'] .dsh-pc-side {
    max-width: 52%;
  }
  [data-plugin='dev-phone-control'] .dsh-pc-segment > button {
    font-size: 12px;
  }
}
`
