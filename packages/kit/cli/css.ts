/**
 * What a stylesheet makes the browser fetch, and from where.
 *
 * Three callers read CSS for the same question: the template's `src/index.css`
 * before codegen, a font package's stylesheets during the check, and the built
 * `dist/` after a build. Each asks which hosts other than the server a widget
 * would reach, so the answer lives once.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** One target the browser fetches: an `@import`, or a `url()` anywhere else. */
export interface Fetched {
	kind: "import" | "url";
	target: string;
}

/**
 * `@import "x"`, `@import url(x)` and `url(x)`, any case, quoted or not.
 * Comments are stripped first, so a URL a comment names is not a fetch.
 */
export function fetchedBy(css: string): Fetched[] {
	const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const fetched: Fetched[] = [];
	const pattern = /(@import\s+(?:url\(\s*)?|url\(\s*)(["']?)([^"')\s]+)\2/gi;
	for (const match of source.matchAll(pattern)) {
		fetched.push({
			kind: (match[1] as string).toLowerCase().startsWith("@import") ? "import" : "url",
			target: match[3] as string,
		});
	}
	return fetched;
}

/**
 * Whether a target names a host of its own: `https://`, `http://`, or a
 * protocol-relative `//`. A `data:` URI is not a fetch, and a relative path
 * resolves against the server.
 */
export function isRemote(target: string): boolean {
	return /^(?:https?:)?\/\//i.test(target);
}

/** The origins a stylesheet fetches from other than the server, sorted. */
export function remoteOrigins(css: string): string[] {
	const origins = new Set<string>();
	for (const { target } of fetchedBy(css)) {
		if (!isRemote(target)) continue;
		// A protocol-relative `//host/...` takes the base's scheme; the base itself
		// never wins, since every remote target carries its own host.
		let origin: string;
		try {
			origin = new URL(target, "https://localhost").origin;
		} catch {
			continue;
		}
		origins.add(origin);
	}
	return [...origins].sort();
}

/**
 * The remote origins every `.css` file under `dir` fetches from, for the check
 * at the end of a build: whatever reached the bundle, from the template, a font
 * package, or anywhere else Vite followed an import.
 */
export function remoteOriginsUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const origins = new Set<string>();
	const walk = (current: string) => {
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			if (statSync(path).isDirectory()) {
				walk(path);
			} else if (entry.endsWith(".css")) {
				for (const origin of remoteOrigins(readFileSync(path, "utf-8"))) origins.add(origin);
			}
		}
	};
	walk(dir);
	return [...origins].sort();
}
