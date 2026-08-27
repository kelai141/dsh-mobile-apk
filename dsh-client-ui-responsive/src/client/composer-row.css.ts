/**
 * Composer control-row narrow-screen fixes:
 * - The model-selection pill is 176px fixed; on phones below the 400px
 *   breakpoint it overlaps the permission/access pill (device-observed on
 *   360dp phones). Cap its width and ellipsize so both stay tappable.
 * - The row is flex-wrap: wrap (upstream InputBar). On 360dp the left group
 *   (add + access-mode, 88px) + gap (12px) + trailing group (model pill +
 *   context meter + send, 204px at pill 118px) = 304px > 302px content width
 *   (318px card - 16px padding), so the trailing group wraps to a second
 *   line and the add/access controls misalign vertically with the model
 *   picker (issue #54). Capping the pill at 104px shrinks the trailing group
 *   to 182px (282px total), keeping the whole toolbar on one line; the pill's
 *   own content (label + effort + chevron, ~98px) still fits without
 *   truncation. Verified on-device (vivo V2425A, 360dp): tools y 627→670 and
 *   aligns with the model trigger.
 */
export const COMPOSER_ROW_CSS: string = `
@media (max-width: 400px) {
  [data-composer-card] [aria-label*='选择模型'],
  [data-composer-card] [aria-label*='model'] {
    max-width: 104px;
  }
  [data-composer-card] [aria-label*='选择模型'] span,
  [data-composer-card] [aria-label*='model'] span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
`
