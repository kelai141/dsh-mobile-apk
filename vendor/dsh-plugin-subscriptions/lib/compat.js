/**
 * Single-build compatibility with both published dsh lines (issue #53).
 *
 * dsh 0.1.2-alpha renamed `CallId` to `ToolCallId` in `@deepseek-ai/dsh-llm`.
 * A named import of either symbol is an ESM link-time failure on the other
 * line (the module executes before any code runs, so the whole profile boot
 * dies). A namespace import never link-fails, and both constructors are pure
 * type brands (`id as Branded`), so one runtime lookup serves both lines.
 *
 * `RpcResult` also moved homes: rc.2 ships it from the removed
 * `@deepseek-ai/dsh-host-apiproxy/api`, the alpha as `ConnectionRpcResult`
 * from `@deepseek-ai/dsh-client-connection`. Both are the same structural
 * shape, so this local mirror avoids importing from either package.
 */
import * as llm from '@deepseek-ai/dsh-llm';
/** Brand a string as a tool-call id: alpha's `ToolCallId`, rc.2's `CallId`. */
export const ToolCallId = (() => {
    const exports = llm;
    return (exports['ToolCallId'] ?? exports['CallId']);
})();
