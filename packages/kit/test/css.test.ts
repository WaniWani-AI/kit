/**
 * The stylesheet scan behind three checks: the template's `src/index.css`
 * before codegen, a font package during `waniwani check`, and `dist/` after a
 * build. Each asks which hosts other than the server a widget would reach.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fetchedBy, isRemote, remoteOrigins, remoteOriginsUnder } from "../cli/css.js";

describe("remoteOrigins", () => {
	test("reads @import and url() targets, quoted or not", () => {
		const css = `@import url("https://fonts.googleapis.com/css2?family=Inter");
@import 'https://use.typekit.net/abc.css';
@font-face { src: url(//cdn.example.com/a.woff2) format("woff2"); }`;
		assert.deepEqual(remoteOrigins(css), [
			"https://cdn.example.com",
			"https://fonts.googleapis.com",
			"https://use.typekit.net",
		]);
	});

	test("matches whatever the case", () => {
		const css = `@IMPORT URL("HTTPS://FONTS.GOOGLEAPIS.COM/css2");
.a { background: Url(Http://Example.com/x.png); }`;
		assert.deepEqual(remoteOrigins(css), ["http://example.com", "https://fonts.googleapis.com"]);
	});

	test("ignores comments, data: URIs, relative paths and bare specifiers", () => {
		const css = `/*! tailwindcss | https://tailwindcss.com */
@import "tailwindcss";
@import "./fonts.css";
.x { background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"); }
@font-face { src: url(./files/a.woff2); }`;
		assert.deepEqual(remoteOrigins(css), []);
	});
});

describe("fetchedBy", () => {
	test("tells an @import from a url()", () => {
		assert.deepEqual(fetchedBy(`@import "./a.css"; .b { src: url(./b.woff2); }`), [
			{ kind: "import", target: "./a.css" },
			{ kind: "url", target: "./b.woff2" },
		]);
	});
});

describe("isRemote", () => {
	for (const target of ["https://a.example/x", "HTTP://a.example", "//a.example/x"]) {
		test(`${target} is remote`, () => assert.ok(isRemote(target)));
	}
	for (const target of ["./a.woff2", "a.woff2", "/assets/a.woff2", "data:font/woff2;base64,AA"]) {
		test(`${target} is not`, () => assert.ok(!isRemote(target)));
	}
});

describe("remoteOriginsUnder", () => {
	test("collects every .css under a folder and nothing else", () => {
		const dir = mkdtempSync(join(tmpdir(), "waniwani-css-"));
		mkdirSync(join(dir, "assets/nested"), { recursive: true });
		writeFileSync(join(dir, "assets/style.css"), `@font-face { src: url(./a.woff2); }`);
		writeFileSync(join(dir, "assets/nested/x.css"), `@import "https://fonts.googleapis.com/x";`);
		writeFileSync(join(dir, "assets/app.js"), `const u = "https://fonts.gstatic.com";`);
		assert.deepEqual(remoteOriginsUnder(dir), ["https://fonts.googleapis.com"]);
	});

	test("a folder that does not exist has none", () => {
		assert.deepEqual(remoteOriginsUnder(join(tmpdir(), "waniwani-no-such-dir")), []);
	});
});
