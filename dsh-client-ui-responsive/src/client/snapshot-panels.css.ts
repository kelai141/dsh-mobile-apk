/**
 * Snapshot manager ancestor repair (#288), installed with SnapshotPanelsObserver.
 * The display:contents slot wrapper keeps the header a flex item, so z-index needs no position or
 * transform override. Level 16 clears transcript CodeBlock banners (6), composer
 * chrome (7/9), and local trajectory details (12); it stays below the separate
 * frame overlay seat (20), mobile drawer (30), and fullscreen right panel (40).
 * No width gate: the Android shell also displays the manager in landscape.
 * The marked session-header title row loses containment only while its owned
 * snapshot manager is open. Old WebViews otherwise anchor fixed descendants to
 * that short row; raising z-index alone leaves a 64/70px mask. Removing the class
 * restores the upstream query container on close. No transcript container changes.
 */
export const SNAPSHOT_PANELS_CSS: string = `
div[data-phase] > div[data-slot="conversation.header"] > header[data-window-drag].dsh-mobile-snapshot-header-raised {
  z-index: 16;
}

div[data-phase] > div[data-slot="conversation.header"] > header[data-window-drag].dsh-mobile-snapshot-header-raised > div[data-slot="conversation.session.header"] > div.dsh-mobile-snapshot-title-row-uncontained {
  container-type: normal;
  contain: none;
}
`
