/**
 * Discover an app by walking its folders. Convention, not configuration.
 *
 *   waniwani.config.ts
 *   tools/<name>.ts
 *   widgets/<name>/{widget.ts,ui.tsx}
 *   flows/<name>.ts
 *   api/<path>.ts
 *
 * There is no CSS in that list. Styling is Tailwind, from the distribution
 * template's `src/index.css` — its `@theme` tokens and its `dark` variant — and
 * a widget writes utility classes in `ui.tsx`. Stray `styles.css` files are
 * collected only so the build check can tell an author they are dead.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { App, AppEndpoint, AppModule, AppWidget } from "./types.js";

const CODE_EXT = new Set([".ts", ".tsx", ".mts"]);

function listFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => !entry.startsWith(".") && !entry.startsWith("_"))
		.map((entry) => join(dir, entry))
		.filter((path) => statSync(path).isFile());
}

function listDirs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => !entry.startsWith(".") && !entry.startsWith("_"))
		.map((entry) => join(dir, entry))
		.filter((path) => statSync(path).isDirectory());
}

function stripExt(path: string): string {
	return basename(path, extname(path));
}

/**
 * Every code file under `dir`, depth first, as `{ file, segments }` where
 * `segments` is its path below `dir` with the extension gone.
 *
 * `api/` is the one convention folder that nests: an HTTP path has more than
 * one segment, and the only place it can come from without a registry is the
 * filesystem.
 */
function listTree(dir: string, trail: string[] = []): { file: string; segments: string[] }[] {
	if (!existsSync(dir)) return [];

	return readdirSync(dir)
		.filter((entry) => !entry.startsWith(".") && !entry.startsWith("_"))
		.flatMap((entry) => {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				return listTree(path, [...trail, entry]);
			}
			if (!CODE_EXT.has(extname(path))) return [];
			return [{ file: path, segments: [...trail, stripExt(path)] }];
		});
}

/**
 * The URL an endpoint file is served at: its position under the app root,
 * `/api` included, since that is the folder's name.
 *
 * `index` names the directory itself, so `api/cal/index.ts` answers `/api/cal`
 * — the one place a filename is not taken verbatim, and the convention every
 * web framework already uses.
 */
function endpointPath(segments: string[]): string {
	const parts = segments.at(-1) === "index" ? segments.slice(0, -1) : segments;
	return `/api/${parts.join("/")}`.replace(/\/$/, "") || "/api";
}

export function scanApp(root: string): App {
	const configFile = [join(root, "waniwani.config.ts"), join(root, "waniwani.config.js")].find(
		existsSync,
	);

	const tools: AppModule[] = listFiles(join(root, "tools"))
		.filter((file) => CODE_EXT.has(extname(file)))
		.map((file) => ({ name: stripExt(file), file }));

	const widgets: AppWidget[] = listDirs(join(root, "widgets")).map((dir) => {
		const name = basename(dir);
		const contract = [join(dir, "widget.ts"), join(dir, "widget.tsx")].find(existsSync);
		const ui = [join(dir, "ui.tsx"), join(dir, "ui.jsx")].find(existsSync);
		return { name, dir, contract, ui };
	});

	const flows: AppModule[] = listFiles(join(root, "flows"))
		.filter((file) => CODE_EXT.has(extname(file)))
		.map((file) => ({ name: stripExt(file), file }));

	const endpoints: AppEndpoint[] = listTree(join(root, "api")).map(({ file, segments }) => ({
		path: endpointPath(segments),
		segments,
		file,
	}));

	// The two paths an author is most likely to expect the kit to pick up. It
	// imports neither, so a file at either one is styling that never reaches the
	// browser — the kind of silent no-op the build check exists to name.
	const strayStyles = [
		join(root, "styles.css"),
		...widgets.map((widget) => join(widget.dir, "styles.css")),
	].filter(existsSync);

	return { root, configFile, tools, widgets, flows, endpoints, strayStyles };
}
