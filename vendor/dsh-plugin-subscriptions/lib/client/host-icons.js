/** A decorative glyph the host lacks renders nothing rather than crashing. */
const NoIcon = () => null;
/**
 * Resolve one 16px glyph under either host naming.
 * @param icons - the host primitives module (`import * as`), read by name.
 * @param name - the glyph name without prefix or size, e.g. `Sparkle`.
 * @returns the host's component, or one rendering nothing.
 */
export function hostIcon(icons, name) {
    const exports = icons;
    return exports[`Icon${name}Regular`] ?? exports[`Icon${name}16`] ?? NoIcon;
}
