/**
 * Image-lightbox zoom stylesheet.
 *
 * The gesture belongs to the picture. `touch-action: none` on the preview image is what hands
 * the browser's own pan/pinch arbitration over to the module's pointer handlers, and it is
 * scoped to `img[data-dsh-lightbox-zoom]` — the picture the module has marked — so the
 * surrounding surface keeps its normal behaviour (the mask stays the documented close path,
 * the close control stays a plain tap target).
 *
 * The attribute, not an ancestor chain, is the hook: upstream ships two preview shapes
 * (flat backdrop and backdrop > stage) and a structural selector would only cover one.
 *
 * `will-change: transform` keeps the scaled picture on its own compositor layer: a pinch
 * writes a new transform on every move, and repainting the decoded image each frame is what
 * makes a naive implementation feel like it is dragging the whole screen.
 */
export const LIGHTBOX_ZOOM_CSS: string = `
/* The preview surface blocks page pinch as a whole: a pinch that starts on the mask must
   not fall through to the browser (the mask is the documented close path, not a viewport
   handle), and the picture then serves its own zoom. */
[data-dsh-lightbox-surface] {
  touch-action: none;
}

img[data-dsh-lightbox-zoom] {
  touch-action: none;
  will-change: transform;
  -webkit-user-select: none;
  user-select: none;
  -webkit-user-drag: none;
  -webkit-touch-callout: none;
}
`
