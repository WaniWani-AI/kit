/**
 * `fonts` in `defineApp()`: what `waniwani check` accepts and refuses, and the
 * stylesheet codegen writes from what it accepts.
 *
 * The packages these resolve are the ones the example app installs, so a test
 * that needs `@fontsource/lato` finds it the way an app would.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFonts, type FontReport, fontCdnsIn, generateFontsCss } from "../cli/fonts.js";

const ONEY = fileURLToPath(new URL("../../../examples/oney", import.meta.url));

function collect(): FontReport & { errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	return {
		errors,
		warnings,
		error: (_where, message) => errors.push(message),
		warn: (_where, message) => warnings.push(message),
	};
}

/** An app folder holding one font file, `fonts/brand.woff2`. */
function appWithFile(): string {
	const root = mkdtempSync(join(tmpdir(), "waniwani-fonts-"));
	mkdirSync(join(root, "fonts"));
	writeFileSync(join(root, "fonts/brand.woff2"), "");
	return root;
}

/**
 * An app folder with one installed font package, `fake-font`, whose files are
 * given as `{ path: contents }`. `declared` is the field of package.json that
 * names it, `dependencies` unless a test says otherwise.
 */
function appWithPackage(
	files: Record<string, string>,
	declared: "dependencies" | "devDependencies" = "dependencies",
): string {
	const root = mkdtempSync(join(tmpdir(), "waniwani-fonts-"));
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ [declared]: { "fake-font": "1.0.0" } }),
	);
	const dir = join(root, "node_modules/fake-font");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "fake-font", main: "index.css" }),
	);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), contents);
	}
	return root;
}

const FACE = `@font-face { font-family: 'Fake'; src: url(./files/fake.woff2) format('woff2'); }`;

describe("checkFonts", () => {
	test("no fonts is no error", () => {
		const report = collect();
		assert.equal(checkFonts(undefined, ONEY, "waniwani.config.ts", report), undefined);
		assert.deepEqual(report.errors, []);
	});

	test("an installed package is accepted, as a list", () => {
		const report = collect();
		const fonts = checkFonts(
			{ sans: { family: "Lato", package: "@fontsource/lato/400.css" } },
			ONEY,
			"waniwani.config.ts",
			report,
		);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.warnings, []);
		assert.deepEqual(fonts, { sans: { family: "Lato", package: ["@fontsource/lato/400.css"] } });
	});

	test("a family the package does not declare is a warning naming the one it does", () => {
		const report = collect();
		checkFonts(
			{ sans: { family: "Lato Variable", package: "@fontsource/lato/400.css" } },
			ONEY,
			"waniwani.config.ts",
			report,
		);
		assert.deepEqual(report.errors, []);
		assert.equal(report.warnings.length, 1);
	});

	for (const url of [
		"https://fonts.googleapis.com/css2?family=Lato",
		"http://example.com/lato.css",
		"//fonts.googleapis.com/css2?family=Lato",
	]) {
		test(`a URL is refused as a package: ${url}`, () => {
			const report = collect();
			const fonts = checkFonts(
				{ sans: { family: "Lato", package: url } },
				ONEY,
				"waniwani.config.ts",
				report,
			);
			assert.equal(fonts, undefined);
			assert.match(report.errors[0] ?? "", /is a URL/);
		});

		test(`a URL is refused as a file: ${url}`, () => {
			const report = collect();
			const fonts = checkFonts(
				{ sans: { family: "Lato", files: [url] } },
				appWithFile(),
				"waniwani.config.ts",
				report,
			);
			assert.equal(fonts, undefined);
			assert.match(report.errors[0] ?? "", /is a URL/);
		});
	}

	test("a package the app does not have is refused", () => {
		const report = collect();
		checkFonts(
			{ sans: { family: "Nope", package: "@fontsource/not-a-font-at-all" } },
			ONEY,
			"waniwani.config.ts",
			report,
		);
		assert.match(report.errors[0] ?? "", /not in the app's dependencies/);
	});

	test("a package that ships its files is accepted", () => {
		const report = collect();
		const fonts = checkFonts(
			{ sans: { family: "Fake", package: "fake-font" } },
			appWithPackage({ "index.css": FACE }),
			"w",
			report,
		);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(fonts, { sans: { family: "Fake", package: ["fake-font"] } });
	});

	test("a package only in devDependencies is refused", () => {
		const report = collect();
		checkFonts(
			{ sans: { family: "Fake", package: "fake-font" } },
			appWithPackage({ "index.css": FACE }, "devDependencies"),
			"w",
			report,
		);
		assert.match(report.errors[0] ?? "", /not in the app's dependencies: fake-font/);
	});

	for (const [label, files] of [
		[
			"imports a CDN",
			{ "index.css": `@import url("https://fonts.googleapis.com/css2?family=Fake");` },
		],
		[
			"points a face at a host",
			{ "index.css": "@font-face { src: URL(//cdn.example.com/a.woff2); }" },
		],
		[
			"imports a stylesheet that does",
			{
				"index.css": `@import "./latin.css";`,
				"latin.css": `@import "https://fonts.googleapis.com/css2?family=Fake";`,
			},
		],
	] as const) {
		test(`a package that ${label} is refused`, () => {
			const report = collect();
			const fonts = checkFonts(
				{ sans: { family: "Fake", package: "fake-font" } },
				appWithPackage(files),
				"w",
				report,
			);
			assert.equal(fonts, undefined);
			assert.match(report.errors[0] ?? "", /loads from https:\/\//);
		});
	}

	for (const spec of ['fake-font/x.css"); body { color: red', "fake-font/x.css?y", "fake font"]) {
		test(`a package specifier that could write CSS is refused: ${spec}`, () => {
			const report = collect();
			checkFonts({ sans: { family: "Fake", package: spec } }, appWithPackage({}), "w", report);
			assert.match(report.errors[0] ?? "", /not a package name/);
		});
	}

	for (const src of ['fonts/b").woff2', "fonts/b#x.woff2", "fonts/b?x.woff2", "fonts/b%20.woff2"]) {
		test(`a file path that could change the URL is refused: ${src}`, () => {
			const report = collect();
			checkFonts({ sans: { family: "B", files: [src] } }, appWithFile(), "w", report);
			assert.match(report.errors[0] ?? "", /characters a font path cannot use/);
		});
	}

	test("a role set to undefined is a role left out", () => {
		const report = collect();
		const fonts = checkFonts(
			{ sans: { family: "B", files: ["fonts/brand.woff2"] }, serif: undefined },
			appWithFile(),
			"w",
			report,
		);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(Object.keys(fonts ?? {}), ["sans"]);
	});

	test("a file in the app folder is accepted with its weight and style", () => {
		const report = collect();
		const fonts = checkFonts(
			{
				serif: {
					family: "Brand Serif",
					files: [{ src: "./fonts/brand.woff2", weight: "100 900", style: "italic" }],
				},
			},
			appWithFile(),
			"waniwani.config.ts",
			report,
		);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(fonts, {
			serif: {
				family: "Brand Serif",
				files: [{ src: "fonts/brand.woff2", weight: "100 900", style: "italic" }],
			},
		});
	});

	for (const [label, face, message] of [
		["a missing file", { family: "B", files: ["fonts/missing.woff2"] }, /does not exist/],
		["a file outside the app", { family: "B", files: ["../brand.woff2"] }, /outside the app/],
		["a file that is not a font", { family: "B", files: ["fonts/brand.css"] }, /not a webfont/],
		["both sources", { family: "B", package: "x", files: ["fonts/brand.woff2"] }, /exactly one/],
		["neither source", { family: "B" }, /exactly one/],
		["a family that could write CSS", { family: 'B"; } body { x: "', files: [] }, /family/],
		[
			"a bad weight",
			{ family: "B", files: [{ src: "fonts/brand.woff2", weight: "bold" }] },
			/weight/,
		],
	] as const) {
		test(`${label} is refused`, () => {
			const report = collect();
			const fonts = checkFonts({ sans: face }, appWithFile(), "waniwani.config.ts", report);
			assert.equal(fonts, undefined);
			assert.match(report.errors[0] ?? "", message);
		});
	}

	test("an unknown role is refused", () => {
		const report = collect();
		checkFonts(
			{ heading: { family: "B", files: ["fonts/brand.woff2"] } },
			appWithFile(),
			"w",
			report,
		);
		assert.match(report.errors[0] ?? "", /unknown font role/);
	});
});

describe("generateFontsCss", () => {
	const css = generateFontsCss(
		{
			sans: { family: "Lato", package: ["@fontsource/lato/400.css", "@fontsource/lato/700.css"] },
			mono: { family: "Brand Mono", files: [{ src: "fonts/mono.woff2", weight: "400" }] },
		},
		"./app",
	);

	test("imports the template's entry before anything else", () => {
		assert.match(css, /^(?:[^@]|\n)*@import "\.\/index\.css";/);
		assert.ok(css.indexOf('@import "./index.css"') < css.indexOf('@import "@fontsource'));
	});

	test("imports each package stylesheet", () => {
		assert.ok(css.includes('@import "@fontsource/lato/400.css";'));
		assert.ok(css.includes('@import "@fontsource/lato/700.css";'));
	});

	test("declares a file face with a relative URL into the app's source", () => {
		assert.ok(css.includes('src: url("./app/fonts/mono.woff2") format("woff2");'));
		assert.ok(css.includes("font-weight: 400;"));
	});

	test("puts each family in front of its role's fallback stack", () => {
		assert.match(css, /--font-sans: "Lato", ui-sans-serif,/);
		assert.match(css, /--font-mono: "Brand Mono", ui-monospace,/);
		assert.doesNotMatch(css, /--font-serif/);
	});

	test("names no other origin", () => {
		assert.doesNotMatch(css, /https?:|\/\/[a-z]/i);
	});
});

describe("fontCdnsIn", () => {
	test("names each source file that loads a font CDN, and skips output", () => {
		const root = mkdtempSync(join(tmpdir(), "waniwani-cdn-"));
		mkdirSync(join(root, "lib"));
		mkdirSync(join(root, ".waniwani"));
		mkdirSync(join(root, "node_modules"));
		writeFileSync(
			join(root, "lib/format.ts"),
			`link.href = "https://fonts.googleapis.com/css2?family=Lato"; // fonts.gstatic.com`,
		);
		writeFileSync(join(root, "lib/ok.ts"), `export const x = 1;`);
		writeFileSync(join(root, ".waniwani/x.js"), `"https://fonts.googleapis.com"`);
		writeFileSync(join(root, "node_modules/x.js"), `"https://use.typekit.net"`);
		assert.deepEqual(fontCdnsIn(root), [
			{ file: join(root, "lib/format.ts"), hosts: ["fonts.googleapis.com", "fonts.gstatic.com"] },
		]);
	});
});
