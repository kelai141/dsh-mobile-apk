import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Plugin-local image gallery for generated-image toolviews.
 *
 * Since web-app rc.8, `@deepseek-ai/dsh-client-ui-attachment`'s browser module
 * exports only its cordis plugin surface (`apply`/`inject`) — the React
 * components are no longer package values, so importing `ImageGallery` from it
 * yields `undefined` at runtime and crashes the toolview inside the slot error
 * boundary (the whole call row disappears). This module re-implements the
 * gallery contract the toolview needs (loader-driven thumbnails, retry on
 * failure, click-to-open lightbox) with the same sizing rules as the platform
 * component, keeping this plugin independent of harness component exports.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
/** Display box for a lone image (platform rule): long edge 240px with the
 * rendered aspect ratio clamped to [0.25, 4] — the overflow is cropped by
 * `object-fit: cover` — and never upscaled past the image's natural size. The
 * crop anchor keeps the top of very tall images and the left of very wide
 * ones, where the informative content usually starts. */
function singleFit(attachment) {
    const natural = attachment.width / attachment.height;
    const ratio = Math.min(4, Math.max(0.25, natural));
    const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 };
    const scale = Math.min(1, attachment.width / box.width, attachment.height / box.height);
    return {
        width: Math.max(1, Math.round(box.width * scale)),
        height: Math.max(1, Math.round(box.height * scale)),
        objectPosition: natural < 0.25 ? 'center top' : natural > 4 ? 'left center' : 'center',
    };
}
const styles = {
    gallery: { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-start' },
    frame: {
        display: 'grid', placeItems: 'center', overflow: 'hidden', padding: 0,
        border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: 8,
        background: 'var(--dsw-alias-interactive-bg-hover-solid)', cursor: 'zoom-in',
    },
    tile: { width: 64, height: 64 },
    img: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
    loading: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '0 8px' },
    error: {
        fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2-darkmode-thin)', borderRadius: 8,
        background: 'transparent', padding: '6px 10px',
    },
    overlay: {
        position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center',
        background: 'rgba(0, 0, 0, 0.72)', padding: 24,
    },
    overlayImg: { maxWidth: '92vw', maxHeight: '92vh', objectFit: 'contain', borderRadius: 4 },
    close: {
        position: 'absolute', top: 12, right: 12, width: 32, height: 32, display: 'grid',
        placeItems: 'center', border: 'none', borderRadius: '50%', cursor: 'pointer',
        background: 'rgba(255, 255, 255, 0.16)', color: '#fff', fontSize: 16, lineHeight: 1,
    },
};
/**
 * Full-viewport original-image preview: backdrop or close-control click and
 * Escape all dismiss; the image itself is inert so a click on it does not
 * fall through to the backdrop dismissal.
 */
function ImageLightbox({ src, alt, labels, onClose }) {
    useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape')
            onClose(); };
        window.addEventListener('keydown', onKey);
        return () => { window.removeEventListener('keydown', onKey); };
    }, [onClose]);
    return (_jsxs("div", { role: "dialog", "aria-label": labels.dialog, style: styles.overlay, onClick: onClose, children: [_jsx("img", { src: src, alt: alt, style: styles.overlayImg, onClick: event => { event.stopPropagation(); } }), _jsx("button", { type: "button", "aria-label": labels.close, style: styles.close, onClick: onClose, children: "\u00D7" })] }));
}
/**
 * Compact history renderer with retryable loading and click-to-open original
 * preview. A lone image renders at its `singleFit` size; an image among
 * several renders as a fixed 64px square tile.
 */
export function MessageImage({ attachment, load, variant, labels }) {
    const [src, setSrc] = useState(null);
    const [error, setError] = useState(false);
    const [open, setOpen] = useState(false);
    // Retry re-arms the one load effect below, so every attempt — first load or
    // retry — runs under the same liveness guard and the same reset.
    const [attempt, setAttempt] = useState(0);
    const retry = useCallback(() => { setAttempt(a => a + 1); }, []);
    const close = useCallback(() => { setOpen(false); }, []);
    const fit = useMemo(() => (variant === 'single' ? singleFit(attachment) : undefined), [attachment, variant]);
    useEffect(() => {
        let live = true;
        setError(false);
        setSrc(null);
        void load(attachment).then((url) => { if (live)
            setSrc(url); }).catch(() => { if (live)
            setError(true); });
        return () => { live = false; };
    }, [attachment, load, attempt]);
    const label = attachment.name ?? labels.image;
    if (error) {
        return _jsx("button", { type: "button", style: styles.error, onClick: retry, children: labels.loadFailed });
    }
    const box = fit === undefined ? styles.tile : { width: fit.width, height: fit.height };
    return (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", style: { ...styles.frame, ...box }, title: labels.open, "aria-label": labels.openNamed(label), onClick: () => { if (src !== null)
                    setOpen(true); }, children: src === null
                    ? _jsx("span", { style: styles.loading, children: labels.loading })
                    : _jsx("img", { src: src, alt: label, style: { ...styles.img, objectPosition: fit?.objectPosition } }) }), open && src !== null && _jsx(ImageLightbox, { src: src, alt: label, labels: labels.lightbox, onClose: close })] }));
}
/** Wrapping image group: a lone image renders large, several render as 64px
 * square tiles (same rule as the platform gallery). */
export function ImageGallery({ images, load, labels }) {
    if (images.length === 0)
        return null;
    const variant = images.length === 1 ? 'single' : 'tile';
    return (_jsx("div", { style: styles.gallery, children: images.map((image, index) => (_jsx(MessageImage, { attachment: image.attachment, load: load, variant: variant, labels: labels }, `${image.attachment.attachmentId}:${index}`))) }));
}
