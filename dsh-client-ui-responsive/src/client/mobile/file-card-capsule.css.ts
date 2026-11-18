/** Keep file actions beside the preview, including in the folded list. */
export const FILE_CARD_CAPSULE_CSS = `
[data-changed-files][data-single]:has(> [data-dsh-file-capsule]),
[data-changed-files] li:has(> [data-dsh-file-capsule]) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch;
}
[data-changed-files] :is([data-dsh-file-capsule], [data-dsh-file-capsule-status]) {
  box-sizing: border-box;
}
[data-dsh-file-capsule] {
  grid-area: 1 / 2;
  display: flex;
  align-items: center;
  padding-inline-end: 4px;
}
[data-changed-files][data-single] > [data-dsh-file-capsule] {
  background: var(--changes-fill);
}
[data-dsh-file-capsule] > button {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
}
[data-dsh-file-capsule] > button:active,
[data-dsh-file-capsule] > button:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, .16));
}
[data-dsh-file-capsule] svg { width: 17px; height: 17px; }
[data-dsh-file-capsule-chip] { display: contents; }
[data-dsh-file-capsule-separator] { display: none; }
[data-dsh-file-capsule-status] {
  grid-column: 1 / -1;
  margin: 0;
  padding: 2px 14px 8px;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  overflow-wrap: anywhere;
}
[data-dsh-file-capsule-status]:empty { display: none; }
`
