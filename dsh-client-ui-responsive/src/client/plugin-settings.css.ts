const WEB_SEARCH = '[data-plugin-panel] [data-plugin-item-detail="web-search"]:not(:has([class*="_detailActions"] > :not([data-slot]), [class*="_detailActions"] [data-slot] > *))'

const COMPACT_HEADER = '[data-plugin-bar]:not([data-natural], [class*="_pageBarWithTabs"]) > [class*="_pageHead"]:has(> [data-plugin-toolbar]:not([hidden]))'

export const PLUGIN_SETTINGS_CSS = `
[data-plugin-panel] [data-plugin-group="basic"] [data-plugin-item] [class*="_cardHead"]:has(button)::after {
  content: "";
  width: 6px;
  height: 6px;
  flex: none;
  margin-inline: 4px;
  border-right: 1px solid currentColor;
  border-top: 1px solid currentColor;
  color: var(--dsw-alias-label-tertiary);
  transform: rotate(45deg);
  pointer-events: none;
}
@container (width < 640px) {
  ${COMPACT_HEADER} {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    row-gap: 8px;
  }
  ${COMPACT_HEADER} > [class*="_pageHeading"] { display: contents; }
  ${COMPACT_HEADER} [class*="_pageTitle"] { grid-area: 1 / 2; }
  ${COMPACT_HEADER} > [data-plugin-toolbar] { grid-area: 1 / 3; }
  ${COMPACT_HEADER} [class*="_pageIntro"] {
    grid-area: 2 / 2 / auto / -1;
  }
  [data-plugin-panel] [data-plugin-toolbar] button[class*="_addPrimary"] {
    width: auto;
    min-width: 36px;
    gap: 5px;
    padding-inline: 9px;
    white-space: nowrap;
  }
  [data-plugin-panel] [data-plugin-toolbar] button[class*="_addPrimary"] [class*="_toolbarLabel"] {
    display: inline;
  }
}
${WEB_SEARCH} {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  gap: 0 8px;
  padding-block-start: var(--plugin-page-top-inset);
}
${WEB_SEARCH} > :is([class*="_detailTop"], [class*="_detailMain"]) {
  display: contents;
}
${WEB_SEARCH} [class*="_crumb"]:is(button) {
  grid-column: 1 / -1;
  grid-row: 1;
  justify-self: start;
  margin-block-end: 16px;
}
${WEB_SEARCH} [class*="_detailHead"] {
  grid-column: 1;
  grid-row: 2;
  margin: 0;
}
${WEB_SEARCH} [class*="_detailHead"] [class*="_cardIcon"],
${WEB_SEARCH} [class*="_detailHead"] [class*="_cardIcon"] svg {
  width: 20px;
  height: 20px;
  background: none;
  border: 0;
}
${WEB_SEARCH} > [class*="_detailMain"] > [class*="_titleRow"] {
  grid-column: 2;
  grid-row: 2;
}
${WEB_SEARCH} > [class*="_detailMain"] > [class*="_detailDesc"] {
  margin-block-start: 8px;
}
${WEB_SEARCH} > :is([class*="_detailMain"], [class*="_detailSections"]),
${WEB_SEARCH} > [class*="_detailMain"] > :is([class*="_detailDesc"], [class*="_detailName"]) {
  grid-column: 1 / -1;
}
${WEB_SEARCH} > [class*="_detailSections"] {
  margin-block-start: 20px;
}
body > [role="menu"][data-anchor-side][data-dsh-plugin-select-menu] {
  inset: var(--dsh-select-top) auto var(--dsh-select-bottom) var(--dsh-select-left);
  width: var(--dsh-select-width);
  min-width: 0;
  max-width: var(--dsh-select-width);
  max-height: var(--dsh-select-height);
  align-self: auto;
  justify-self: auto;
}
`
