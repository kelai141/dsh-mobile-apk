#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
//#region lib/types/installed-bin.js
/**
* Installed CLI entry for disk launchers and embedded runtimes.
* @module @deepseek-ai/dsh/installed-bin
*/
var __rewriteRelativeImportExtension = function(path, preserveJsx) {
	if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
		return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
	});
	return path;
};
/**
* Run the CLI in the importing carrier's module tree.
* @param options - Installation-owned runtime options.
* @returns Settlement of the selected command.
*/
async function runCli(options) {
	await (await import("./bin-CwxESKe-.js")).runCli(options);
}
if (import.meta.main) {
	const entry = process.platform === "win32" ? pathToFileURL(realpathSync.native(import.meta.filename)).href : import.meta.url;
	if (entry === import.meta.url) await runCli();
	else await (await import(__rewriteRelativeImportExtension(entry))).runCli();
}
//#endregion
export { runCli };
