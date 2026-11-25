/** Touch selection suppression & monochrome toast styles for 450ms path copy. */
export const FILE_PATH_COPY_CSS = `
[data-textpreview-path] {
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  cursor: pointer;
}
.dsh-path-copy-toast {
  position: fixed;
  left: 50%;
  bottom: max(72px, calc(var(--dsh-android-system-bottom, 0px) + 56px));
  transform: translateX(-50%);
  z-index: 2147483003;
  max-width: min(320px, calc(100vw - 32px));
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .22));
  background: var(--dsw-alias-bg-layer-2, var(--dsw-specific-sidebar-fill, #242424));
  color: var(--dsw-alias-label-primary, #f3f3f3);
  font-size: 12.5px;
  line-height: 1.35;
  text-align: center;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .24);
  pointer-events: none;
}
`
