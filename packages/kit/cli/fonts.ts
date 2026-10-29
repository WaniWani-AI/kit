/**
 * An app's own typefaces: `fonts` in `defineApp()`.
 *
 * The template's `src/index.css` is shared by every app, so it carries the
 * system font stack and nothing a client owns. A client's brand face is
 * declared per app instead, and codegen writes it into a stylesheet of the
 * app's own that layers over the template's.
 *
 * A face is always self-hosted: from an npm package the app installs (the
 * Fontsource packages are the usual source) or from font files in the app
 * folder. Vite emits the files next to `style.css` with relative URLs, so they
 * load from the server's own origin, which every widget's CSP already allows.
 * A URL to anyone else is refused, because every widget would send the end
 * user's IP there and the CSP would block it anyway.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, isAbsolute, join, normalize, sep } from "node:path";
import type { AppFont, AppFonts, FontFile } from "./types.js";

/**
 * The fallback behind each role, and the stack a role keeps when the app sets
 * no face for it. `sans` is the template's stack; `serif` and `mono` are
 * Tailwind's own defaults.
 */
export const FONT_STACKS: Record<keyof AppFonts, string> = {
	sans: 'ui-sans-serif, -apple-system, system-ui, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
	serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
	mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

const ROLES = Object.keys(FONT_STACKS) as Array<keyof AppFonts>;

/** What the browser can load as a webfont, by extension. */
const FORMATS: Record<string, string> = {
	".woff2": "woff2",
	".woff": "woff",
	".ttf": "truetype",
	".otf": "opentype",
};

/**
 * A family name goes into a quoted CSS string. Quotes, backslashes and the
 * characters that end a declaration or a block would let it write CSS of its
 * own, so a name is letters, digits, spaces and the punctuation real names use.
 */
const FAMILY_RE = /^[\p{L}\p{N} _.&+-]+$/u;

/** A number, or a `min max` range for a variable face. */
const WEIGHT_RE = /^\d{1,4}(?: \d{1,4})?$/;

/** Anything that names a host: `https://`, `http://`, `//`, or another scheme. */
function isRemote(spec: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith("//");
}

/** The two things `checkFonts` reports through, so it can be driven by a test. */
export interface FontReport {
	error(where: string, message: string, hint?: string): void;
	warn(where: string, message: string, hint?: string): void;
}

/**
 * Validate `fonts` from the loaded app config.
 *
 * @param value the `fonts` field as loaded, unchecked
 * @param appRoot the folder `waniwani.config.ts` sits in; file paths are relative to it
 * @param where the config file, as diagnostics name it
 * @returns the fonts when every face is valid, otherwise `undefined` with the errors reported
 */
export function checkFonts(
	value: unknown,
	appRoot: string,
	where: string,
	report: FontReport,
): AppFonts | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		report.error(where, "`fonts` must be an object", "fonts: { sans: { family, package } }");
		return undefined;
	}

	let ok = true;
	const fonts: AppFonts = {};
	for (const [role, face] of Object.entries(value)) {
		if (!ROLES.includes(role as keyof AppFonts)) {
			report.error(
				where,
				`unknown font role \`${role}\``,
				`fonts takes ${ROLES.map((name) => `\`${name}\``).join(", ")}, one per Tailwind font utility`,
			);
			ok = false;
			continue;
		}
		const checked = checkFace(face, `fonts.${role}`, appRoot, where, report);
		if (checked) {
			fonts[role as keyof AppFonts] = checked;
		} else {
			ok = false;
		}
	}
	return ok ? fonts : undefined;
}

function checkFace(
	face: unknown,
	field: string,
	appRoot: string,
	where: string,
	report: FontReport,
): AppFont | undefined {
	if (!face || typeof face !== "object") {
		report.error(
			where,
			`\`${field}\` must be an object`,
			"{ family, package } or { family, files }",
		);
		return undefined;
	}
	const { family, package: pkg, files } = face as Record<string, unknown>;

	if (typeof family !== "string" || !FAMILY_RE.test(family.trim())) {
		report.error(
			where,
			`\`${field}.family\` must be a font family name`,
			"letters, digits, spaces and - _ . & + only — the name the face's @font-face declares",
		);
		return undefined;
	}
	if ((pkg === undefined) === (files === undefined)) {
		report.error(
			where,
			`\`${field}\` needs exactly one of \`package\` and \`files\``,
			"`package` names an installed npm package such as @fontsource/lato; `files` lists font files in the app folder",
		);
		return undefined;
	}

	if (pkg !== undefined) {
		const specs = typeof pkg === "string" ? [pkg] : pkg;
		if (!Array.isArray(specs) || specs.length === 0 || !specs.every((s) => typeof s === "string")) {
			report.error(where, `\`${field}.package\` must be a package name or a list of them`);
			return undefined;
		}
		const resolved = specs.map((spec) => checkPackage(spec, field, appRoot, where, report));
		if (resolved.some((file) => file === undefined)) return undefined;
		warnOnFamily(family.trim(), resolved as string[], field, where, report);
		return { family: family.trim(), package: specs };
	}

	if (!Array.isArray(files) || files.length === 0) {
		report.error(where, `\`${field}.files\` must list at least one font file`);
		return undefined;
	}
	const checked = files.map((file, index) =>
		checkFile(file, `${field}.files[${index}]`, appRoot, where, report),
	);
	if (checked.some((file) => file === undefined)) return undefined;
	return { family: family.trim(), files: checked as FontFile[] };
}

/** @returns the stylesheet the specifier resolves to, or `undefined` once reported */
function checkPackage(
	spec: string,
	field: string,
	appRoot: string,
	where: string,
	report: FontReport,
): string | undefined {
	if (isRemote(spec)) {
		report.error(
			where,
			`\`${field}.package\` is a URL: ${spec}`,
			"a font CDN receives every end user's IP and the widget CSP blocks it — install the face from npm (e.g. @fontsource/<font>) or ship its files in the app folder",
		);
		return undefined;
	}
	if (spec.startsWith(".") || isAbsolute(spec)) {
		report.error(
			where,
			`\`${field}.package\` is a path: ${spec}`,
			"files in the app folder go in `files`, not `package`",
		);
		return undefined;
	}
	try {
		return createRequire(join(appRoot, "package.json")).resolve(spec);
	} catch {
		report.error(
			where,
			`\`${field}.package\` is not installed: ${spec}`,
			`add it to the app's dependencies: npm install ${packageName(spec)}`,
		);
		return undefined;
	}
}

/** `@scope/name/400.css` -> `@scope/name`, `name/400.css` -> `name`. */
function packageName(spec: string): string {
	const parts = spec.split("/");
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

/**
 * A family that no imported stylesheet declares renders in the fallback face,
 * silently. The usual cause is a variable package, whose family carries a
 * suffix (`Inter Variable`), so the names the stylesheets do declare are the
 * hint.
 */
function warnOnFamily(
	family: string,
	stylesheets: string[],
	field: string,
	where: string,
	report: FontReport,
): void {
	const declared = new Set<string>();
	for (const file of stylesheets) {
		const css = readFileSync(file, "utf-8");
		for (const match of css.matchAll(/font-family:\s*['"]?([^'";}]+?)['"]?\s*;/g)) {
			declared.add(match[1] as string);
		}
	}
	if (declared.size === 0 || declared.has(family)) return;
	report.warn(
		where,
		`\`${field}.family\` is "${family}", which the package does not declare`,
		`it declares ${[...declared].map((name) => `"${name}"`).join(", ")}`,
	);
}

function checkFile(
	file: unknown,
	field: string,
	appRoot: string,
	where: string,
	report: FontReport,
): FontFile | undefined {
	const entry = typeof file === "string" ? { src: file } : file;
	if (!entry || typeof entry !== "object") {
		report.error(where, `\`${field}\` must be a path or { src, weight, style }`);
		return undefined;
	}
	const { src, weight, style } = entry as Record<string, unknown>;

	if (typeof src !== "string" || src.length === 0) {
		report.error(where, `\`${field}.src\` must be a path to a font file`);
		return undefined;
	}
	if (isRemote(src)) {
		report.error(
			where,
			`\`${field}.src\` is a URL: ${src}`,
			"a font CDN receives every end user's IP and the widget CSP blocks it — download the file into the app folder (e.g. fonts/) and point at it",
		);
		return undefined;
	}
	const path = normalize(src);
	if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
		report.error(
			where,
			`\`${field}.src\` is outside the app folder: ${src}`,
			"only the app folder is copied into the build, so the file has to live in it",
		);
		return undefined;
	}
	const format = FORMATS[extname(path).toLowerCase()];
	if (!format) {
		report.error(
			where,
			`\`${field}.src\` is not a webfont: ${src}`,
			`use ${Object.keys(FORMATS).join(", ")} — woff2 is the smallest`,
		);
		return undefined;
	}
	if (!existsSync(join(appRoot, path))) {
		report.error(where, `\`${field}.src\` does not exist: ${src}`);
		return undefined;
	}

	const weightText = weight === undefined ? undefined : String(weight);
	if (weightText !== undefined && !WEIGHT_RE.test(weightText)) {
		report.error(
			where,
			`\`${field}.weight\` must be a number or a "min max" range`,
			'400, or "100 900" for a variable face',
		);
		return undefined;
	}
	if (style !== undefined && style !== "normal" && style !== "italic") {
		report.error(where, `\`${field}.style\` must be "normal" or "italic"`);
		return undefined;
	}

	return {
		src: path.split(sep).join("/"),
		...(weightText !== undefined && { weight: weightText }),
		...(style !== undefined && { style }),
	};
}

/** `"Lato"` -> `"\"Lato\""`. The family was checked against `FAMILY_RE`. */
function quoted(family: string): string {
	return `"${family}"`;
}

/**
 * The app's stylesheet: the template's, then the app's faces over it.
 *
 * Generated rather than kept as a file because its lines are the app's config.
 * It goes through the same Tailwind entry as the template's, so the `@theme`
 * block here overrides the template's tokens for this app only, and the
 * `font-sans` / `font-serif` / `font-mono` utilities pick the face up.
 *
 * @param fonts validated by `checkFonts`
 * @param appDir where the app's source sits relative to this stylesheet, e.g. `./app`
 */
export function generateFontsCss(fonts: AppFonts, appDir: string): string {
	const imports: string[] = [];
	const faces: string[] = [];
	const tokens: string[] = [];

	for (const role of ROLES) {
		const face = fonts[role];
		if (!face) continue;

		if ("package" in face) {
			for (const spec of face.package) {
				imports.push(`@import "${spec}";`);
			}
		} else {
			for (const file of face.files) {
				const format = FORMATS[extname(file.src).toLowerCase()] as string;
				faces.push(
					[
						"@font-face {",
						`\tfont-family: ${quoted(face.family)};`,
						`\tsrc: url("${appDir}/${file.src}") format("${format}");`,
						...(file.weight ? [`\tfont-weight: ${file.weight};`] : []),
						...(file.style ? [`\tfont-style: ${file.style};`] : []),
						"\tfont-display: swap;",
						"}",
					].join("\n"),
				);
			}
		}

		tokens.push(`\t--font-${role}: ${quoted(face.family)}, ${FONT_STACKS[role]};`);
	}

	return [
		"/* Generated from `fonts` in waniwani.config.ts. Every view imports this",
		"   instead of index.css: the template's styles, then the app's own faces,",
		"   self-hosted, over its font tokens. */",
		'@import "./index.css";',
		...imports,
		"",
		...faces.flatMap((face) => [face, ""]),
		"@theme {",
		...tokens,
		"}",
		"",
	].join("\n");
}
