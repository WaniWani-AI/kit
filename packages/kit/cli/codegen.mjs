/**
 * Turn an app folder into a complete framework project.
 *
 * The plumbing comes from the distribution template repo, consumed as-is at a
 * pinned commit (see `./template.mjs`). Nothing is forked into this package, so
 * what a customer deploys is the same tree that is published, readable, and
 * cloneable on GitHub. Only files that depend on the app's contents are
 * generated here.
 *
 * The template owns the server. It constructs it, registers whatever tools it
 * ships, and runs it; the generator writes one file into that tree —
 * `src/waniwani.ts` — holding the app's identity and its registrations. A tool
 * added to the template therefore reaches every app built on it, which is the
 * same one-publish mechanism that carries a bug fix.
 *
 * Two layouts come out of the same generator:
 *
 * - `build` — writes `.waniwani/`, the equivalent of `.next/`. Disposable,
 *   gitignored, regenerated on every command. The app source is copied under
 *   `src/app/` so the output is self-contained, and `@waniwani/kit` is an
 *   ordinary dependency of it.
 *
 * - `eject` — writes the same plumbing into the app repo itself, moving the
 *   app's source under `src/app/` as it goes (the framework compiles from
 *   `src/` and nothing outside it can be an input). Here the runtime is
 *   vendored in as readable source and every `@waniwani/kit` specifier is
 *   rewritten to point at it, so the result is an ordinary project on the
 *   underlying framework, with no dependency on this CLI, this package, or
 *   Waniwani.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, floorOf, installable } from "./peers.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_SRC = join(PACKAGE_ROOT, "src");
/** This package's own manifest, which is where every version below comes from. */
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));
const PACKAGE_VERSION = MANIFEST.version;

/**
 * A version this package declares, read back out so it is stated once.
 *
 * Every version the generator forces on an app is a version the generator was
 * built and verified against, which makes this manifest the only honest source
 * for it. Writing the same range a second time as a literal down in `PINS` gave
 * one fact two homes, and a bump could update either one alone: the manifest
 * carried `skybridge@^1.3.5` while the pin forced `1.4.0`, and they agreed only
 * because that is what the lockfile happened to resolve.
 *
 * Missing throws rather than defaults. `undefined` here would land in a
 * generated `package.json` as a dependency with no version and fail at install
 * time in someone else's project, a long way from the rename that caused it.
 */
function declared(name, field = "dependencies") {
	const version = MANIFEST[field]?.[name];
	if (!version) {
		throw new Error(
			`@waniwani/kit declares no ${field}.${name}, and the generator pins apps to it — ` +
				"add it back to packages/kit/package.json or drop it from PINS",
		);
	}
	return version;
}

/**
 * The template comes across whole, minus an explicit list.
 *
 * The direction matters more than the contents. A denylist fails loudly: a
 * plumbing file the template grows arrives in every app on its own, and
 * anything that does not belong shows up in the next build and costs one line
 * to exclude. An allowlist fails silently in the other direction — a new
 * plumbing file is dropped without a word, and the gap surfaces in production.
 * The same silence lets `package.json` be taken wholesale while the files its
 * scripts and devDependencies reference are not, which leaves every generated
 * project holding dangling references.
 *
 * A template can carry its own list in `waniwani.template.json`, and that is
 * the version that counts: the contract lives in the repo where the change
 * happens, so a PR adding a plumbing file declares it in the same commit. The
 * defaults below cover a template that ships no manifest.
 */
const MANIFEST_FILE = "waniwani.template.json";

/**
 * Never copied, whatever the manifest says.
 *
 * `package.json` and `tsconfig.json` are absent on purpose — they are copied
 * and then overwritten by generated versions, so excluding them would only make
 * the ordering harder to follow.
 */
const ALWAYS_EXCLUDE = [
	".git/",
	"node_modules/",
	MANIFEST_FILE,
	// The generator rewrites package.json — merging the app's dependencies and
	// applying its own pins — so a lockfile for the template's own dependency
	// set describes a tree the output does not have. Worse than no lockfile.
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
];

/**
 * The fallback list, for a template with no manifest of its own.
 *
 * `src/` is absent from it, all of it. What a template registers in
 * `src/server.ts` is shipped rather than demonstrative: it reaches every app
 * built on the template, and adding a tool there is how one reaches all of them
 * at once. The generator adds to that tree instead of replacing it.
 */
const DEFAULT_EXCLUDE = [
	// Build output, if the template has any committed. Copying it forward would
	// ship dead bundles for views that do not exist.
	"public/",
	"dist/",
	// The template's identity, not the app's. Its MIT LICENSE in a customer's
	// private repo is confusing at best.
	"LICENSE",
	"README.md",
];

/**
 * Additionally excluded from `.waniwani/`, which is disposable build output
 * rather than a repo a human works in.
 */
const DEFAULT_BUILD_EXCLUDE = [
	// A .gitignore inside the output would stop `vercel deploy` uploading
	// anything at all.
	".gitignore",
	// Authoring skills and editor settings earn their place in a repo someone
	// edits. In an upload they are dead weight.
	".claude/",
	".agents/",
	".vscode/",
	"skills-lock.json",
];

/**
 * Files an ejected repo already owns. The template's version is written only
 * when the app has none, so ejecting never overwrites a decision the app made.
 */
const DEFAULT_PRESERVE = [".env.example", ".nvmrc", "biome.json", ".editorconfig"];

/**
 * The template's shape, asserted rather than assumed. Copying is driven by the
 * denylist, but a template missing one of these has moved in a way the
 * generator cannot absorb, and failing here beats shipping a broken project.
 *
 * The style entry is load-bearing rather than decorative: it is the Tailwind
 * entry every generated view imports, so a template without it builds green and
 * serves widgets with no styling at all — every utility class in every `ui.tsx`
 * resolving to nothing. That is worth failing for at the same volume as a
 * missing `vite.config.ts`.
 */
const STYLE_ENTRY = "src/index.css";
const REQUIRED = ["vite.config.ts", "package.json", "tsconfig.json", STYLE_ENTRY];

/**
 * The seam the template has to call, and the file it lives in.
 *
 * Without the call there is no error to see: the generator still writes
 * `src/waniwani.ts`, the build still succeeds, and the server still starts —
 * serving the template's own tools and none of the app's, under the template's
 * name. A green build that ships the wrong product is worth failing for.
 */
const SEAM = { file: "src/server.ts", symbol: "registerApp" };

/**
 * Dependency decisions the runtime makes on every app's behalf, overriding
 * whatever the template declares. This is the fleet-wide fix mechanism: a
 * version problem is corrected once here rather than in 30 repos.
 *
 * Each entry carries its reason, and the CLI reports what it changed.
 */
/**
 * Forced to what this package declares: the generated code is built against
 * these, and `declared()` is what keeps the two statements of that one fact
 * from drifting apart.
 */
const PINS = {
	dependencies: {
		skybridge: {
			version: declared("skybridge"),
			why: "the template's range floats within 1.x; the runtime is built and verified against this one",
		},
	},
	devDependencies: {
		"@skybridge/devtools": {
			version: declared("@skybridge/devtools", "devDependencies"),
			why: "must match the framework",
		},
	},
};

/**
 * Peer floors, checked against what the merge produced rather than forced over
 * it.
 *
 * `@waniwani/sdk` was a `PINS` entry, which made this generator the authority
 * on an app's SDK version. It was the wrong authority twice over: nothing under
 * `src/` imports the SDK, so the version was never verified against anything
 * here, and an app that disagreed kept its own choice and ended up with two
 * copies in the tree — `createFlow()` compiling against the app's while this
 * runtime registered the result against the kit's. It is a required peer now
 * (see the manifest's `//sdk` note), so the app or the template names the
 * version and this states the floor underneath both.
 *
 * Absent is filled in, and below the floor is reported. Nothing is forced
 * upward: an app on a newer SDK than the template asked for is an app that
 * upgraded, and overwriting that is how the second copy got there in the first
 * place. The floor an app can act on is checked earlier and without a template
 * download, in `checkPeers` in `./validate.mjs`; this covers the version a
 * template contributed, which that check cannot see.
 */
const FLOORS = {
	dependencies: {
		"@waniwani/sdk": {
			why: "below this, npm will not install the SDK next to skybridge 1.4.0 — see the manifest's //sdk note",
		},
	},
};

/** Added only when absent, so a template that declares a newer one keeps it. */
const ENSURED = {
	dependencies: {},
	devDependencies: {
		// Both are undeclared dependencies of the framework's dev command: it spawns
		// `tsx src/server.ts` under nodemon and imports nodemon directly, while
		// declaring neither.
		tsx: { version: "^4.20.6", why: "the dev command shells out to tsx" },
		nodemon: { version: "^3.1.10", why: "the dev command imports nodemon" },
	},
};

/**
 * What the vendored runtime needs declared, for the eject layout only.
 *
 * A build reaches the runtime through `@waniwani/kit`, so express, cors and
 * their types arrive as that package's own dependencies — which is why it
 * declares them (see its `//dependencies` and `//express` notes). Ejecting drops
 * the package and copies `src/` in as source, and the imports come with it: the
 * vendored tree imports `express` and `cors` by name, and `tsc` needs their
 * types. Nothing was putting either back, so an ejected project installed and
 * then failed to compile on ten TS7006/TS7016 errors, with express and cors
 * present in `node_modules` only as a transitive hoist out of the framework.
 *
 * Only the two the runtime imports and the app does not already get: `skybridge`
 * and `zod` are the other bare specifiers under `src/`, and both are declared
 * for every layout already.
 */
const VENDORED = {
	dependencies: {
		express: { version: declared("express"), why: "the vendored runtime imports express" },
		cors: { version: declared("cors"), why: "the vendored runtime mounts CORS per endpoint" },
	},
	devDependencies: {
		"@types/express": {
			version: declared("@types/express"),
			why: "the vendored runtime is typed against express",
		},
		"@types/cors": { version: declared("@types/cors"), why: "same, for cors" },
	},
};

/**
 * Scripts the generated layout needs, added only when the template has no
 * script by that name. The template's own scripts are left untouched.
 */
const SCRIPT_ADDITIONS = {
	typecheck: { command: "tsc --noEmit", why: "no typecheck script in the template" },
};

/**
 * Scripts that point at files an app does not have. The template's package.json
 * is taken wholesale, so a script serving only the example survives the copy
 * and lands in every project as a command that fails when run.
 */
const SCRIPT_REMOVALS = {
	"kb:ingest": {
		why: "ingests knowledge-base/, which is the example's; an app has no such folder",
	},
};

/**
 * Where each layout puts things, relative to the project root.
 *
 * Both put the app's source under `src/app/`, and they have no choice. The
 * framework compiles with `rootDir` pinned to `${configDir}/src` and emits an entry
 * wrapper that does a literal `await import("./server.js")` next to it, so the
 * compiled server has to land at `dist/server.js` and every input has to sit
 * under `src/`. Source left at the repo root is outside `rootDir` and fails to
 * compile (TS6059); widening `rootDir` to `.` compiles but pushes the server to
 * `dist/src/server.js`, where the wrapper cannot find it.
 *
 * So the layouts differ in where they write and how they reach the runtime, not
 * in how they arrange source:
 *
 * - `build` writes to `.waniwani/` and depends on `@waniwani/kit` by name.
 * - `eject` writes to the app repo and vendors the runtime as source.
 */
const LAYOUTS = {
	build: { appDir: "src/app", runtimeDir: "src/_runtime", vendored: false },
	eject: { appDir: "src/app", runtimeDir: "src/_runtime", vendored: true },
};

/** Where the app's source sits, as seen from `src/`. */
function appFrom(layout) {
	return `./${basename(layout.appDir)}`;
}

/** Files and folders that are never part of an app's source. */
const NOT_SOURCE = new Set([
	".waniwani",
	"node_modules",
	"package.json",
	"dist",
	"public",
	".env",
	".env.local",
	// Generated in an ejected repo. Copying them back in would fold one eject's
	// output into the next one's input.
	"src",
	".skybridge",
	".vercel",
	// The repo's own, not the app's. An in-place eject moves what it copies, and
	// a README that reappears under `src/app/` is a bad surprise.
	"README.md",
	"LICENSE",
	// Lockfiles describe the repo's install, and the generated package.json is
	// not the one they were resolved against.
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
]);

/**
 * Files the generator writes itself, on top of whatever the template ships.
 *
 * `src/server.ts` is not among them. The template owns it, registers its own
 * tools in it, and reads `src/waniwani.ts` — the one file this generates into
 * the template's tree.
 */
const GENERATED = ["src/waniwani.ts", "tsconfig.json", ".template.json"];

/** `select-plan` -> `selectPlan`, for generated identifiers. */
function camel(name) {
	return name.replace(/[-_](.)/g, (_, char) => char.toUpperCase()).replace(/[^a-zA-Z0-9]/g, "");
}

/** Every file under `dir`, depth first. */
function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			yield* walk(path);
		} else {
			yield path;
		}
	}
}

function write(file, contents) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

/** Every file under `dir` as a path relative to it, slash-separated. */
function* relativeFiles(dir, prefix = "") {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const rel = prefix ? `${prefix}/${entry}` : entry;
		if (statSync(path).isDirectory()) {
			yield* relativeFiles(path, rel);
		} else {
			yield rel;
		}
	}
}

/**
 * A pattern ending in `/` matches a directory and everything under it;
 * anything else matches one exact path. Deliberately not globs — an exclusion
 * list is read far more often than it is written, and `server/src/faq/` says
 * what it does without anyone having to reason about precedence.
 */
function matches(path, patterns) {
	return patterns.some((pattern) =>
		pattern.endsWith("/") ? path === pattern.slice(0, -1) || path.startsWith(pattern) : path === pattern,
	);
}

/** The template's own exclusion list, when it ships one. */
function readManifest(template) {
	const path = join(template.dir, MANIFEST_FILE);
	if (!existsSync(path)) return null;
	try {
		return parseJsonc(readFileSync(path, "utf-8"));
	} catch (cause) {
		throw new Error(`the template's ${MANIFEST_FILE} is not valid JSON: ${cause.message}`);
	}
}

/**
 * What this template says stays behind, falling back to the defaults when it
 * says nothing. A manifest replaces the defaults rather than extending them —
 * a template that has thought about the question should not have to work
 * around a list written for one that has not.
 *
 * @returns `{ exclude, preserve, manifest }`
 */
function resolveExclusions(template, layoutName) {
	const manifest = readManifest(template);

	return {
		manifest,
		exclude: [
			...ALWAYS_EXCLUDE,
			...(manifest?.exclude ?? DEFAULT_EXCLUDE),
			...(layoutName === "build" ? (manifest?.buildExclude ?? DEFAULT_BUILD_EXCLUDE) : []),
		],
		preserve: manifest?.preserve ?? DEFAULT_PRESERVE,
	};
}

/**
 * Add whatever the template ignores that the app does not already, without
 * disturbing a line the app wrote. An ejected repo inherits `dist/`,
 * `public/assets/`, and `*.tsbuildinfo` this way instead of committing them.
 */
function mergeGitignore(destination, source) {
	const existing = existsSync(destination) ? readFileSync(destination, "utf-8") : "";
	const known = new Set(existing.split("\n").map((line) => line.trim()));
	const additions = readFileSync(source, "utf-8")
		.split("\n")
		.filter((line) => line.trim() && !line.trim().startsWith("#") && !known.has(line.trim()));

	if (additions.length === 0) return false;
	const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
	writeFileSync(destination, `${existing}${prefix}\n# from the waniwani template\n${additions.join("\n")}\n`);
	return true;
}

/**
 * Copy the template into the output, minus the exclusions.
 *
 * Precedence is template < app < generated: this runs before the app's source
 * and before the generated files, so both win any collision. `preserve` is the
 * one exception, and it only applies when ejecting — there the destination is
 * the app's own repo, so a file it already owns outranks the template's. In a
 * build the destination is generated, and letting a previous build's copy win
 * would freeze the template at whatever version first produced the directory.
 */
function copyTemplate(template, root, { layout, exclude, preserve }) {
	const copied = [];

	for (const file of relativeFiles(template.dir)) {
		if (matches(file, exclude)) continue;

		const destination = join(root, file);

		if (layout.vendored && existsSync(destination)) {
			if (matches(file, preserve)) continue;
			if (file === ".gitignore") {
				if (mergeGitignore(destination, join(template.dir, file))) copied.push(file);
				continue;
			}
		}

		mkdirSync(dirname(destination), { recursive: true });
		cpSync(join(template.dir, file), destination);
		copied.push(file);
	}

	return copied;
}

/** Config files in the wild carry comments; `JSON.parse` does not. */
function parseJsonc(source) {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;

	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		const next = source[i + 1];

		if (inLine) {
			if (char === "\n") {
				inLine = false;
				out += char;
			}
			continue;
		}
		if (inBlock) {
			if (char === "*" && next === "/") {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += char;
			if (char === "\\") {
				out += source[++i] ?? "";
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === "/" && next === "/") {
			inLine = true;
			i++;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlock = true;
			i++;
			continue;
		}
		out += char;
	}

	// Trailing commas are common in hand-edited configs.
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readTemplateJson(template, file) {
	const path = join(template.dir, file);
	if (!existsSync(path)) {
		throw new Error(
			`the template at ${template.source} has no ${file} — the generator expects one`,
		);
	}
	return parseJsonc(readFileSync(path, "utf-8"));
}

/**
 * Rewrite `@waniwani/kit` imports to relative paths into the vendored runtime,
 * so the output runs under plain node with no path mapping.
 *
 * The quotes are part of the pattern, and the subpath alternation is closed:
 * `@waniwani/sdk` and `@waniwani/kit/anything-else` cannot match, so the app's
 * other Waniwani imports survive an eject untouched.
 */
function rewriteRuntimeImports(source, fromFile, outDir, runtimeDir) {
	const toRuntime = (file) => {
		const path = relative(dirname(fromFile), join(outDir, runtimeDir, file)).replace(/\\/g, "/");
		return path.startsWith(".") ? path : `./${path}`;
	};

	return source.replace(/(["'])@waniwani\/kit(\/(?:web|server))?\1/g, (_match, quote, subpath) => {
		const file = subpath === "/web" ? "web.js" : subpath === "/server" ? "server.js" : "index.js";
		return `${quote}${toRuntime(file)}${quote}`;
	});
}

/** Point every copied or in-place source file at the vendored runtime. */
function rewriteTree(dir, outDir, runtimeDir) {
	for (const file of walk(dir)) {
		if (!/\.(ts|tsx|mts|js|jsx)$/.test(file)) continue;
		const contents = readFileSync(file, "utf-8");
		const rewritten = rewriteRuntimeImports(contents, file, outDir, runtimeDir);
		if (rewritten !== contents) {
			writeFileSync(file, rewritten);
		}
	}
}

/**
 * Copy the app source into the output. The whole folder comes across, not just
 * the convention directories, so an app can keep shared modules (`lib/`,
 * `data/`, whatever) and import them relatively as in any other project.
 *
 * `cpSync` refuses to copy a directory into itself and the build output lives
 * inside the app, so the tree is walked by hand.
 */
function copyAppSource(from, to) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from)) {
		if (!isAppSource(from, entry)) continue;
		const source = join(from, entry);
		const destination = join(to, entry);
		if (statSync(source).isDirectory()) {
			copyAppSource(source, destination);
		} else {
			cpSync(source, destination);
		}
	}
}

/**
 * One definition of "the app's source", so a move cannot delete something the
 * copy did not take. Dotfiles are tooling rather than source, except the ones an
 * app repo needs.
 */
function isAppSource(dir, entry) {
	if (NOT_SOURCE.has(entry)) return false;
	if (entry.startsWith(".") && entry !== ".env.example") return false;
	return existsSync(join(dir, entry));
}

/**
 * Delete the originals after an in-place eject has copied them under `src/app/`.
 * Driven by the same predicate as the copy, so the two cannot disagree about
 * what counts as source.
 *
 * @returns the top-level entries removed, for the CLI to report
 */
function removeAppSource(appRoot) {
	const removed = [];
	for (const entry of readdirSync(appRoot)) {
		if (!isAppSource(appRoot, entry)) continue;
		rmSync(join(appRoot, entry), { recursive: true, force: true });
		removed.push(entry);
	}
	return removed;
}

/**
 * Origins the template's Tailwind entry loads from, for the widget CSP.
 *
 * Every generated view imports `src/index.css`, so whatever it reaches out to is
 * reached out to by every widget in every app. A host that enforces the widget
 * CSP — ChatGPT does — drops those requests unless the tool declares the origin,
 * and a blocked webfont does not error: the design token `--font-sans: "Inter"`
 * just falls through to `system-ui`, and the widget looks subtly wrong. Reading
 * it off the stylesheet keeps the two in step without an app author knowing the
 * template's font is a font at all.
 *
 * Companions cover the split-origin case, where fetching the declared URL
 * produces requests to a second host that no amount of reading this file can
 * reveal: `fonts.googleapis.com` serves a stylesheet whose `src` points at
 * `fonts.gstatic.com`. Declaring the first without the second buys nothing.
 */
const STYLE_ORIGIN_COMPANIONS = {
	"https://fonts.googleapis.com": ["https://fonts.gstatic.com"],
};

function templateStyleDomains(template) {
	const css = readFileSync(join(template.dir, STYLE_ENTRY), "utf-8");
	const origins = new Set();

	for (const match of css.matchAll(/https:\/\/[^\s"')]+/g)) {
		let origin;
		try {
			origin = new URL(match[0]).origin;
		} catch {
			continue;
		}
		origins.add(origin);
		for (const companion of STYLE_ORIGIN_COMPANIONS[origin] ?? []) {
			origins.add(companion);
		}
	}

	return [...origins].sort();
}

// ------------------------------------------------------------ generated files

function generateServerApp(app, layout, { runtime, styleDomains, version }) {
	const from = appFrom(layout);

	const imports = [
		`import { config as loadEnv } from "dotenv";`,
		`import type { McpServer } from "skybridge/server";`,
		`import { registerApp as register } from "${runtime.server}";`,
		`import config from "${from}/waniwani.config.js";`,
		...app.tools.map((t) => `import tool_${camel(t.name)} from "${from}/tools/${t.name}.js";`),
		...app.widgets.map(
			(w) => `import widget_${camel(w.name)} from "${from}/widgets/${w.name}/widget.js";`,
		),
		...app.flows.map((f) => `import flow_${camel(f.name)} from "${from}/flows/${f.name}.js";`),
		...app.endpoints.map(
			(e) => `import endpoint_${camel(e.segments.join("-"))} from "${from}/api/${e.segments.join("/")}.js";`,
		),
	].filter(Boolean);

	const list = (items) => (items.length === 0 ? "[]" : `[\n\t\t${items.join(",\n\t\t")},\n\t]`);

	return `// Generated from the app folder. The seam \`src/server.ts\` reads: the
// template owns the server, and this is what the app adds to it.
${imports.join("\n")}

// The app's .env may sit at the project root or one level above it, depending
// on whether this is a generated build or an ejected project.
loadEnv({ path: ["../.env", ".env"], quiet: true });

// The version the app's package.json carries is the fallback, so a bumped
// release shows up in the connector UI without a second edit here.
export const app = {
	name: config.name,
	title: config.title,
	version: config.version ?? ${JSON.stringify(version ?? "0.0.0")},
	instructions: config.instructions,
	// Forwarded whole, for the template to read if it has anything to read them
	// with: \`search\` tunes the search tool a template ships, \`tracking\` reaches
	// the SDK's withWaniwani(). A template that uses neither ignores both, so
	// emitting them unconditionally keeps one generator working across templates
	// that read them and templates that do not.
	search: config.search,
	tracking: config.tracking,
};

export async function registerApp(server: McpServer): Promise<void> {
	await register(server, {
		tools: ${list(app.tools.map((t) => `{ name: "${t.name}", def: tool_${camel(t.name)} }`))},
		widgets: ${list(app.widgets.map((w) => `{ name: "${w.name}", def: widget_${camel(w.name)} }`))},
		flows: ${list(app.flows.map((f) => `flow_${camel(f.name)}`))},
		// Served by the same Express app as /mcp, at the path each file's position
		// produced. For the browser — a widget's fetch — not for the model.
		endpoints: ${list(
			app.endpoints.map(
				(e) => `{ path: "${e.path}", def: endpoint_${camel(e.segments.join("-"))} }`,
			),
		)},
		// Read off the template's ${STYLE_ENTRY}, which every view imports.
		styleDomains: ${list(styleDomains.map((origin) => `"${origin}"`))},
	});
}
`;
}

function generateWidgetShim(widget, layout) {
	// From `src/views/` up to `src/`, then out to the app's source.
	const from = `../${basename(layout.appDir)}`;
	const dir = `${from}/widgets/${widget.name}`;

	// The one stylesheet, and the only one: the template's Tailwind entry, which
	// carries the `@theme` tokens, the `dark` variant, and the base layer. Each
	// view is a separate bundle, so every one of them pulls it in for itself, and
	// Tailwind emits only the utilities that view's source actually uses.
	//
	// No app CSS is imported here on purpose. A widget's styling is utility
	// classes in its `ui.tsx`, which is one file to read instead of two and one
	// place for a class name to exist. It also sidesteps Tailwind v4's
	// `@reference` requirement: `@apply` in a CSS file that does not itself
	// import Tailwind is a build error, and an app's CSS could never import the
	// entry by a path that is valid both in the author's repo and in this tree.
	//
	// The framework discovers views by scanning for a default export and mounts them
	// itself — a file without one is scanned as invalid and dropped from the
	// bundle, taking its manifest entry with it and failing only at
	// `resources/read`. The detector is a regex over the source, and it matches
	// neither `export { default } from "…"` nor a bare re-export, so the import
	// and the export are written out separately.
	return `// Generated from widgets/${widget.name}/. The mounted view entry.
import "../index.css";
import Component from "${dir}/ui.js";

export default Component;
`;
}

/**
 * The template's tsconfig, with the two changes the generated layout needs.
 * Everything else — target, strictness, JSX — stays whatever the template says.
 */
function generateTsconfig(template, layout) {
	const base = readTemplateJson(template, "tsconfig.json");

	return {
		...base,
		// The template resolves the framework through its own node_modules; the
		// output's node_modules lives at the deployment root instead.
		extends: "skybridge/tsconfig",
		compilerOptions: {
			...base.compilerOptions,
			// Generated code is not the app author's to fix.
			noUnusedLocals: false,
			noUnusedParameters: false,
		},
		// Both layouts keep everything under `src/`, which the template's own
		// include already covers. The dotted directory holds generated view types.
		include: ["src", ".skybridge/**/*.d.ts"],
		exclude: ["node_modules", "dist", ".waniwani"],
	};
}

/**
 * The template's biome config scopes itself to `server/**` and `web/**` — the
 * only source it has. An app's source lives elsewhere, so a copied config
 * lints nothing the author wrote and `npm run lint` passes vacuously.
 *
 * @returns the adjusted config, or null if the template ships none
 */
function generateBiome(template, layout) {
	const path = join(template.dir, "biome.json");
	if (!existsSync(path)) return null;

	const base = parseJsonc(readFileSync(path, "utf-8"));
	const includes = base.files?.includes;
	if (!Array.isArray(includes)) return base;

	// Negated patterns are exclusions and have to stay last to keep their effect.
	const positive = includes.filter((pattern) => !pattern.startsWith("!"));
	const negative = includes.filter((pattern) => pattern.startsWith("!"));
	const app = [`${layout.appDir}/**`];

	return {
		...base,
		files: {
			...base.files,
			includes: [
				...positive,
				...app.filter((pattern) => !positive.includes(pattern)),
				// Generated and vendored code is not the app author's to fix.
				`!${layout.runtimeDir}/**`,
				"!src/server.ts",
				"!src/views/**",
				...negative,
			],
		},
	};
}

/**
 * The template's package.json is the source of truth for dependencies and
 * scripts; the runtime layers its overrides on top.
 *
 * @returns `{ packageJson, overrides }` — overrides for the CLI to report
 */
function generatePackageJson(app, appPackageJson, template, layout) {
	const base = readTemplateJson(template, "package.json");
	const overrides = [];

	/**
	 * Merge the template's declarations with the app's, then apply the
	 * runtime's. An app that declares a pinned package itself keeps its own
	 * choice — it is their repo — but the disagreement is reported.
	 */
	const apply = (kind, appDeps) => {
		const merged = { ...base[kind], ...appDeps };

		for (const [name, { version, why }] of Object.entries(PINS[kind] ?? {})) {
			if (appDeps[name] && appDeps[name] !== version) {
				overrides.push({
					name,
					to: appDeps[name],
					why: `the app pins this itself — the runtime is built against ${version}`,
					conflict: true,
				});
				continue;
			}
			if (merged[name] !== version) {
				overrides.push({ name, from: base[kind]?.[name], to: version, why });
			}
			merged[name] = version;
		}

		for (const [name, { version, why }] of Object.entries(ENSURED[kind] ?? {})) {
			if (merged[name]) continue;
			merged[name] = version;
			overrides.push({ name, to: version, why });
		}

		// Same rule as ENSURED — an app or template declaring its own keeps it —
		// but only where the runtime arrives as source rather than as a package.
		if (layout.vendored) {
			for (const [name, { version, why }] of Object.entries(VENDORED[kind] ?? {})) {
				if (merged[name]) continue;
				merged[name] = version;
				overrides.push({ name, to: version, why });
			}
		}

		for (const [name, { why }] of Object.entries(FLOORS[kind] ?? {})) {
			if (!merged[name]) {
				merged[name] = installable(name);
				overrides.push({ name, to: merged[name], why });
				continue;
			}
			if (compare(merged[name], name) === "below") {
				overrides.push({
					name,
					to: merged[name],
					why: `below ${floorOf(name)}, which this kit needs: ${why}`,
					conflict: true,
				});
			}
		}

		return merged;
	};

	const scripts = { ...base.scripts };
	for (const [name, { command, why }] of Object.entries(SCRIPT_ADDITIONS)) {
		if (scripts[name]) continue;
		scripts[name] = command;
		overrides.push({ name: `scripts.${name}`, to: command, why });
	}
	for (const [name, { why }] of Object.entries(SCRIPT_REMOVALS)) {
		if (!scripts[name]) continue;
		delete scripts[name];
		overrides.push({ name: `scripts.${name}`, removed: true, why });
	}

	// An ejected project drops @waniwani/kit — its runtime is vendored in as
	// source. A build keeps it: the generated `src/waniwani.ts` imports it by
	// name like any other dependency.
	const declared = appPackageJson?.dependencies ?? {};
	const { "@waniwani/kit": runtimeDep, ...rest } = declared;
	const appDependencies = layout.vendored ? rest : declared;

	// A workspace protocol resolves only inside this monorepo, and the output is
	// meant to install anywhere. Fall back to the version of the CLI producing it.
	if (appDependencies["@waniwani/kit"]?.startsWith("workspace:")) {
		appDependencies["@waniwani/kit"] = `^${PACKAGE_VERSION}`;
		overrides.push({
			name: "@waniwani/kit",
			from: runtimeDep,
			to: `^${PACKAGE_VERSION}`,
			why: "a workspace dependency does not resolve outside this repo",
		});
	}

	const name = appPackageJson?.name ?? basename(app.root);

	return {
		packageJson: {
			...base,
			// A build's package.json describes `.waniwani/`, which is not the app.
			name: layout.vendored ? name : `${name}-build`,
			version: appPackageJson?.version ?? base.version,
			description: undefined,
			private: true,
			type: "module",
			scripts,
			dependencies: apply("dependencies", appDependencies),
			devDependencies: apply("devDependencies", appPackageJson?.devDependencies ?? {}),
		},
		overrides,
	};
}

/**
 * Refuse a template whose server never calls into the generated seam.
 *
 * A textual check rather than a structural one: it runs before anything is
 * written, on a file the generator does not own, and every way of satisfying it
 * is a way of actually calling the function.
 */
function assertSeam(template) {
	const path = join(template.dir, SEAM.file);
	if (!existsSync(path)) {
		throw new Error(
			`the template at ${template.source} has no ${SEAM.file} — ` +
				"its layout moved and the generator needs updating",
		);
	}

	if (readFileSync(path, "utf-8").includes(SEAM.symbol)) return;

	throw new Error(
		`the template at ${template.source} never calls ${SEAM.symbol}(), so this app's\n` +
			`  tools, widgets and flows would be built and then silently dropped.\n\n` +
			`  Add to its ${SEAM.file}:\n\n` +
			`    import { app, registerApp } from "./waniwani.js";\n\n` +
			`    const server = new McpServer(\n` +
			`      { name: app.name, title: app.title, version: app.version },\n` +
			`      { capabilities: {}, instructions: app.instructions },\n` +
			`    );\n\n` +
			`    await ${SEAM.symbol}(server);   // before withWaniwani()\n`,
	);
}

/** What the previous build recorded in `.template.json`, if there was one. */
function readProvenance(root) {
	const path = join(root, ".template.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// A corrupt provenance file costs a stale file or two, not a build.
		return null;
	}
}

/**
 * What a git-connected Vercel project needs at the app root, written there when
 * the app has none.
 *
 * The build output lands in `.waniwani/`, which is gitignored and absent from
 * the clone, so a hosted build has to run the kit itself and move the tree to
 * the one path where Vercel adopts the Build Output API. Every line here is
 * about this kit's own layout, which is why the file is generated rather than
 * taken from the template: the template knows nothing about `waniwani build` or
 * `.waniwani/`.
 *
 * The `routes` entry is the part that is not obvious. Vercel reserves a root
 * `api/` directory and compiles every file under it into a serverless function
 * of its own, which for an app folder means one broken function per endpoint
 * (`defineEndpoint({ ... })` is an object, not a Vercel handler) sitting in the
 * filesystem layer ahead of the server that actually serves them. A legacy
 * `routes` entry is emitted before that layer, so `/api/*` reaches the kit's
 * function and Vercel's own are never routed to. There is no way to stop it
 * building them: it reads the file list before the build command runs, so a
 * build that deletes the directory fails with `File not found`, and
 * `outputDirectory` does not suppress it either.
 */
const VERCEL_JSON = {
	$schema: "https://openapi.vercel.sh/vercel.json",
	// Otherwise the project's framework preset decides, and a preset looking for a
	// dependency an app folder does not have fails the build outright.
	framework: null,
	buildCommand:
		"waniwani build && rm -rf .vercel/output && cp -R .waniwani/.vercel/output .vercel/output",
	// Ahead of Vercel's filesystem layer, which is where its own api/ functions sit.
	routes: [{ src: "/api(/.*)?", dest: "/mcp" }],
};

/**
 * @returns true when the file was written, for the CLI to report
 */
function ensureVercelJson(appRoot) {
	const file = join(appRoot, "vercel.json");
	// An app that has edited its own deploy config keeps it. Overwriting would
	// throw away a `maxDuration`, a region, or a cron someone needed.
	if (existsSync(file)) return false;
	writeFileSync(file, `${JSON.stringify(VERCEL_JSON, null, 2)}\n`);
	return true;
}

/** Keep `.waniwani/` out of the app repo, the way `.next/` is kept out. */
function ignoreBuildOutput(appRoot) {
	const file = join(appRoot, ".gitignore");
	const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
	if (existing.split("\n").some((line) => line.trim().replace(/\/$/, "") === ".waniwani")) {
		return;
	}
	const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
	writeFileSync(file, `${existing}${prefix}.waniwani/\n`);
}

// ----------------------------------------------------------------- generation

/**
 * Plumbing files that already exist in `outDir`, so eject never clobbers.
 *
 * Which files count depends on the template, so this needs a resolved one.
 * Files the app is allowed to own — the `preserve` set, and `.gitignore`,
 * which is merged rather than replaced — are not clashes.
 */
export function existingPlumbing(outDir, template) {
	const { exclude, preserve } = resolveExclusions(template, "eject");

	const fromTemplate = [...relativeFiles(template.dir)].filter(
		(file) => !matches(file, exclude) && !matches(file, preserve) && file !== ".gitignore",
	);

	return [...new Set([...fromTemplate, ...GENERATED])].filter((file) =>
		existsSync(join(outDir, file)),
	);
}

/**
 * @param app the scanned app
 * @param options.template a resolved template from `resolveTemplate()`
 * @param options.layout `"build"` (default) or `"eject"`
 * @param options.outDir defaults to `<app>/.waniwani` for build, `<app>` for eject
 * @returns `{ outDir, written, overrides }`
 */
export function generate(app, { template, layout: layoutName = "build", outDir } = {}) {
	if (!template?.dir) {
		throw new Error("generate() needs a resolved template — call resolveTemplate() first");
	}

	const layout = LAYOUTS[layoutName];
	const root = outDir ?? (layoutName === "build" ? join(app.root, ".waniwani") : app.root);
	const written = [];
	const emit = (file, contents) => {
		write(join(root, file), contents);
		written.push(file);
	};

	for (const file of REQUIRED) {
		if (existsSync(join(template.dir, file))) continue;
		throw new Error(
			`the template at ${template.source} has no ${file} — ` +
				"its layout moved and the generator needs updating",
		);
	}

	assertSeam(template);

	const { exclude, preserve, manifest } = resolveExclusions(template, layoutName);

	mkdirSync(root, { recursive: true });

	// A build depends on the published package like any other dependency.
	// Ejecting vendors it as readable source instead — that is the whole point
	// of ejecting, and it is what leaves the result with no Waniwani in it.
	const vendored = layout.vendored;
	const dir = `./${basename(layout.runtimeDir)}`;
	// Relative specifiers carry the extension ESM resolution needs; the package
	// is reached through its own exports map.
	const runtime = vendored
		? { server: `${dir}/server.js`, index: `${dir}/index.js` }
		: { server: "@waniwani/kit/server", index: "@waniwani/kit" };

	if (vendored) {
		const runtimeOut = join(root, layout.runtimeDir);
		rmSync(runtimeOut, { recursive: true, force: true });
		cpSync(RUNTIME_SRC, runtimeOut, { recursive: true });
		written.push(`${layout.runtimeDir}/`);
	}

	// The app's source moves under `src/app/` in both layouts — the framework's
	// `rootDir` leaves no alternative. Ejecting in place is therefore a move
	// rather than a copy: the originals go once the copy is on disk, so the repo
	// is left with one copy of every file rather than two that can drift.
	const appOut = join(root, layout.appDir);
	rmSync(appOut, { recursive: true, force: true });
	copyAppSource(app.root, appOut);
	const moved = root === app.root ? removeAppSource(app.root) : [];

	// Only an ejected tree needs rewriting: a build reaches the runtime by
	// package name, which resolves without help.
	if (vendored) {
		rewriteTree(appOut, root, layout.runtimeDir);
	}

	// Straight out of the template repo, byte for byte.
	const previous = readProvenance(root);
	const fromTemplate = copyTemplate(template, root, { layout, exclude, preserve });

	// `.waniwani/` is not wiped between builds — `node_modules/` and `dist/`
	// live there — so a file the template drops would otherwise sit in the
	// output forever, and switching templates would leave the two mixed.
	// Ejecting is left alone: that is a real repo, and git tracks deletions.
	if (layoutName === "build") {
		const current = new Set([...fromTemplate, ...GENERATED]);
		for (const file of previous?.files ?? []) {
			if (current.has(file)) continue;
			rmSync(join(root, file), { force: true });
		}
	}

	const appPackageJsonPath = join(app.root, "package.json");
	const appPackageJson = existsSync(appPackageJsonPath)
		? JSON.parse(readFileSync(appPackageJsonPath, "utf-8"))
		: undefined;

	emit(
		"src/waniwani.ts",
		generateServerApp(app, layout, {
			runtime,
			styleDomains: templateStyleDomains(template),
			version: appPackageJson?.version,
		}),
	);
	// `src/views/` is shared: the template's own views sit alongside the app's,
	// so it cannot be wiped. Only the entries a previous build wrote are
	// removed, which is what clears a widget the app has since deleted.
	const views = app.widgets.map((widget) => `src/views/${widget.name}.tsx`);
	for (const stale of previous?.views ?? []) {
		if (views.includes(stale) || fromTemplate.includes(stale)) continue;
		rmSync(join(root, stale), { force: true });
	}
	for (const widget of app.widgets) {
		emit(`src/views/${widget.name}.tsx`, generateWidgetShim(widget, layout));
	}

	const { packageJson, overrides } = generatePackageJson(app, appPackageJson, template, layout);

	emit("tsconfig.json", `${JSON.stringify(generateTsconfig(template, layout), null, 2)}\n`);
	emit("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

	// Only adjust a config this build actually placed. When an ejected repo
	// keeps its own, the app's scoping decisions are the app's to make.
	if (fromTemplate.includes("biome.json")) {
		emit("biome.json", `${JSON.stringify(generateBiome(template, layout), null, 2)}\n`);
	}

	// Provenance: which template produced this tree, and which files came from
	// it — the second half is what lets the next build clean up after itself.
	emit(
		".template.json",
		`${JSON.stringify(
			{
				source: template.source,
				ref: template.ref,
				sha: template.sha,
				local: template.local,
				manifest: manifest ? MANIFEST_FILE : undefined,
				// Which generator wrote this tree, and the versions it was built
				// against. A deployed app misbehaving is the case this serves:
				// the tree itself then answers which template commit and which
				// SDK it was built from, without a guess from the app's lockfile
				// or from whatever the CLI happens to pin today.
				//
				// Two fields because there are two kinds of answer. `pins` is
				// what this generator forced, and `peers` is what the app or the
				// template chose while this generator only stated a floor — the
				// SDK moved from the first to the second when it became a peer,
				// and it is the one most worth reading back.
				kit: PACKAGE_VERSION,
				pins: Object.fromEntries(
					Object.values(PINS).flatMap((group) =>
						Object.entries(group).map(([name, pin]) => [name, pin.version]),
					),
				),
				peers: Object.fromEntries(
					Object.entries(FLOORS).flatMap(([kind, group]) =>
						Object.keys(group).map((name) => [name, packageJson[kind]?.[name]]),
					),
				),
				// What survived to the end, copied and generated alike. The
				// copy is the raw list minus whatever a generated file replaced,
				// and the generated half is here so that a build which stops
				// emitting one — `src/docs.ts` when docs left the framework —
				// cleans up the copy the previous build left behind.
				files: [...new Set([...fromTemplate, ...GENERATED])].filter((file) =>
					existsSync(join(root, file)),
				),
				// Tracked separately because `src/views/` is shared with the
				// template — the next build needs to know which entries were
				// ours before it removes any.
				views,
			},
			null,
			2,
		)}\n`,
	);

	let vercelJson = false;
	if (layoutName === "build") {
		// A .gitignore inside the output would stop `vercel deploy` uploading
		// anything, so the ignore goes in the app repo instead.
		ignoreBuildOutput(app.root);
		// Same reasoning for the deploy config: what Vercel reads on a git build is
		// the app repo's root, not the output directory.
		vercelJson = ensureVercelJson(app.root);
	}

	return {
		outDir: root,
		written,
		overrides,
		fromTemplate,
		moved,
		vercelJson,
		manifest: Boolean(manifest),
	};
}
