/** Tool names owned by this plugin and their collision fallbacks. */
export const TOOL_ALIASES = {
    x_search: 'dsh_subscriptions_x_search',
    video_generate: 'dsh_subscriptions_video_generate',
    image_generate: 'dsh_subscriptions_image_generate',
};
/** Register a tool under its canonical name, then a plugin-scoped alias. */
export function registerWithAlias(registry, definition, warn = message => console.warn(message)) {
    try {
        return { name: definition.name, dispose: registry.register(definition) };
    }
    catch (error) {
        const alias = TOOL_ALIASES[definition.name];
        if (alias === undefined)
            throw error;
        try {
            return { name: alias, dispose: registry.register({ ...definition, name: alias }) };
        }
        catch (aliasError) {
            warn(`dsh-plugin-subscriptions: tool ${JSON.stringify(definition.name)} and alias ${JSON.stringify(alias)} are already registered; skipping (${aliasError instanceof Error ? aliasError.message : String(aliasError)})`);
            return undefined;
        }
    }
}
