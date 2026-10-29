/**
 * What codegen writes for `fonts`: the stylesheet every view imports, and the
 * app stylesheet itself, written when the app sets `fonts` and removed when it
 * stops.
 *
 * The template here is the least the generator accepts, which keeps the test
 * about the generator rather than about whichever template is pinned.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { existingPlumbing, generate } from "../cli/codegen.js";
import { scanApp } from "../cli/scan.js";
import type { AppFonts, Template } from "../cli/types.js";

function write(root: string, files: Record<string, string>): void {
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
}

function fixture(): { appRoot: string; template: Template } {
	const base = mkdtempSync(join(tmpdir(), "waniwani-codegen-"));
	const templateDir = join(base, "template");
	write(templateDir, {
		"package.json": JSON.stringify({ name: "template", dependencies: {} }),
		"tsconfig.json": JSON.stringify({ compilerOptions: {}, include: ["src"] }),
		"vite.config.ts": "export default {};\n",
		"src/index.css": '@import "tailwindcss";\n',
		"src/server.ts": 'import { registerApp } from "./waniwani.js";\n',
	});
	const appRoot = join(base, "app");
	write(appRoot, {
		"package.json": JSON.stringify({ name: "app", dependencies: {} }),
		"waniwani.config.ts": 'export default { name: "app" };\n',
		"widgets/hello/widget.ts": "export default {};\n",
		"widgets/hello/ui.tsx": "export default function Hello() { return null; }\n",
		"fonts/brand.woff2": "",
	});
	return { appRoot, template: { dir: templateDir, source: templateDir, local: true } };
}

const FONTS: AppFonts = { sans: { family: "Brand", files: [{ src: "fonts/brand.woff2" }] } };

describe("generate with fonts", () => {
	test("views import the app stylesheet, which imports the template's", () => {
		const { appRoot, template } = fixture();
		const { outDir } = generate(scanApp(appRoot), { template, fonts: FONTS });

		const view = readFileSync(join(outDir, "src/views/hello.tsx"), "utf-8");
		assert.match(view, /^import "\.\.\/waniwani\.css";$/m);
		const css = readFileSync(join(outDir, "src/waniwani.css"), "utf-8");
		assert.match(css, /@import "\.\/index\.css";/);
		assert.match(css, /url\("\.\/app\/fonts\/brand\.woff2"\)/);
		assert.ok(existsSync(join(outDir, "src/app/fonts/brand.woff2")));
	});

	test("without fonts, views import index.css and a stale app stylesheet is removed", () => {
		const { appRoot, template } = fixture();
		generate(scanApp(appRoot), { template, fonts: FONTS });
		const { outDir } = generate(scanApp(appRoot), { template });

		const view = readFileSync(join(outDir, "src/views/hello.tsx"), "utf-8");
		assert.match(view, /^import "\.\.\/index\.css";$/m);
		assert.ok(!existsSync(join(outDir, "src/waniwani.css")));
	});

	test("reports the template stylesheet's third-party origins", () => {
		const { appRoot, template } = fixture();
		writeFileSync(
			join(template.dir, "src/index.css"),
			'@IMPORT URL("https://fonts.googleapis.com/css2?family=Inter");\n@import "tailwindcss";\n',
		);
		const { styleOrigins } = generate(scanApp(appRoot), { template });
		assert.deepEqual(styleOrigins, ["https://fonts.googleapis.com"]);
	});

	test("an eject names an existing src/waniwani.css as a clash", () => {
		const { appRoot, template } = fixture();
		write(appRoot, { "src/waniwani.css": "" });
		assert.ok(existingPlumbing(appRoot, template).includes("src/waniwani.css"));
	});
});
