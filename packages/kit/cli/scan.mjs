/**
 * Discover an app by walking its folders. Convention, not configuration.
 *
 *   waniwani.config.ts
 *   tools/<name>.ts
 *   widgets/<name>/{widget.ts,ui.tsx}
 *   flows/<name>.ts
 *   docs/<slug>.md
 *
 * There is no CSS in that list. Styling is Tailwind, from the distribution
 * template's `src/index.css` — its `@theme` tokens and its `dark` variant — and
 * a widget writes utility classes in `ui.tsx`. Stray `styles.css` files are
 * collected only so the build check can tell an author they are dead.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const CODE_EXT = new Set([".ts", ".tsx", ".mts"]);

function listFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => !entry.startsWith(".") && !entry.startsWith("_"))
		.map((entry) => join(dir, entry))
		.filter((path) => statSync(path).isFile());
}

function listDirs(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => !entry.startsWith(".") && !entry.startsWith("_"))
		.map((entry) => join(dir, entry))
		.filter((path) => statSync(path).isDirectory());
}

function stripExt(path) {
	return basename(path, extname(path));
}

/** `# Title` on the first heading line, falling back to the slug. */
function docTitle(body, slug) {
	const heading = body.split("\n").find((line) => line.startsWith("# "));
	return heading ? heading.slice(2).trim() : slug;
}

export function scanApp(root) {
	const configFile = [join(root, "waniwani.config.ts"), join(root, "waniwani.config.js")].find(
		existsSync,
	);

	const tools = listFiles(join(root, "tools"))
		.filter((file) => CODE_EXT.has(extname(file)))
		.map((file) => ({ name: stripExt(file), file }));

	const widgets = listDirs(join(root, "widgets")).map((dir) => {
		const name = basename(dir);
		const contract = [join(dir, "widget.ts"), join(dir, "widget.tsx")].find(existsSync);
		const ui = [join(dir, "ui.tsx"), join(dir, "ui.jsx")].find(existsSync);
		return { name, dir, contract, ui };
	});

	const flows = listFiles(join(root, "flows"))
		.filter((file) => CODE_EXT.has(extname(file)))
		.map((file) => ({ name: stripExt(file), file }));

	const docs = listFiles(join(root, "docs"))
		.filter((file) => extname(file) === ".md")
		.map((file) => {
			const slug = stripExt(file);
			const body = readFileSync(file, "utf-8").trim();
			return { slug, file, title: docTitle(body, slug), body };
		});

	// The two paths an author is most likely to expect the kit to pick up. It
	// imports neither, so a file at either one is styling that never reaches the
	// browser — the kind of silent no-op the build check exists to name.
	const strayStyles = [
		join(root, "styles.css"),
		...widgets.map((widget) => join(widget.dir, "styles.css")),
	].filter(existsSync);

	return { root, configFile, tools, widgets, flows, docs, strayStyles };
}
