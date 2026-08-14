#!/usr/bin/env node
/**
 * The `waniwani` CLI.
 *
 *   waniwani init     scaffold a new app folder and install it
 *   waniwani check    validate the app folder
 *   waniwani dev      check, generate, run the dev server, watch for changes
 *   waniwani build    check, generate, build for production
 *   waniwani start    run the production build
 *   waniwani eject    write the plumbing into the repo and hand it over
 *
 * Every command scans the app folder, validates it, and generates a complete
 * framework project under `.waniwani/`. The app repo owns content; this CLI and
 * the runtime own everything else.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existingPlumbing, generate } from "./codegen.mjs";
import { loadAppEnv } from "./env.mjs";
import { init } from "./init.mjs";
import { banner, bold, dim, green, printReport, red, yellow } from "./log.mjs";
import { scanApp } from "./scan.mjs";
import { devFilter, FRAMEWORK_ENV, frameworkBin, loadBuildSteps, runBuildSteps, startFilter } from "./framework.mjs";
import { DEFAULT_TEMPLATE, describeTemplate, resolveTemplate } from "./template.mjs";
import { validateApp } from "./validate.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8")).version;

/** The commands a human sits and watches. `check` and `eject` are often scripted. */
const BANNERED = new Set(["init", "dev", "build", "start"]);

/**
 * Diagnostics about this CLI's own machinery — which template was resolved, how
 * many files it copied, which dependencies were overridden, stack traces. None
 * of it is actionable from an app folder, so it is off unless asked for.
 */
const DEBUG = Boolean(process.env.WANIWANI_DEBUG);

/**
 * Every `node_modules/.bin` from the generated project up to the filesystem
 * root. The framework shells out to `vite` and `tsc` by bare name.
 */
function binPath(from) {
	const dirs = [];
	let current = resolve(from);
	while (true) {
		dirs.push(join(current, "node_modules", ".bin"));
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return [...dirs, process.env.PATH].join(":");
}

/**
 * Spawn a child under this CLI's PATH and environment.
 *
 * `stdoutFilter`/`stderrFilter` pipe that one stream through a line rewriter
 * instead of inheriting it — the mechanism that keeps the framework's own
 * narration out of this CLI's output (see ./framework.mjs). Every unfiltered
 * stream is inherited, so an app's logs and tsc's diagnostics arrive untouched.
 *
 * `shell` is for the framework's build steps, which name their command as one
 * string rather than an argv.
 */
function run(command, args, { cwd, env, shell = false, stdoutFilter, stderrFilter } = {}) {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, {
			cwd,
			shell,
			stdio: ["inherit", stdoutFilter ? "pipe" : "inherit", stderrFilter ? "pipe" : "inherit"],
			env: { ...process.env, PATH: binPath(cwd), ...FRAMEWORK_ENV, ...env },
		});
		for (const [stream, filter] of [
			[child.stdout, stdoutFilter],
			[child.stderr, stderrFilter],
		]) {
			if (!filter) continue;
			stream.setEncoding("utf8");
			stream.on("data", filter.write);
			// Registered before the resolving listener, so a held partial line is
			// emitted before the command reports its exit code.
			child.on("close", filter.flush);
		}
		child.on("close", (code) => resolvePromise(code ?? 1));
		child.on("error", (error) => {
			console.error(red(`failed to run ${command}: ${error.message}`));
			resolvePromise(1);
		});
	});
}

/** The template source, most specific wins. */
function templateSource(flags) {
	return flags.template ?? process.env.WANIWANI_TEMPLATE ?? DEFAULT_TEMPLATE;
}

/**
 * Report what the runtime changed about the template's package.json. This is
 * the fleet-wide fix mechanism made visible: every line is a decision taken
 * once here instead of in 30 repos.
 *
 * Every line is about the plumbing rather than the app, so `dev` and `build`
 * print it only under WANIWANI_DEBUG. `eject` prints it unconditionally —
 * there the plumbing becomes the app's to maintain.
 */
function printOverrides(overrides) {
	if (overrides.length === 0) return;
	console.log(`\n${dim("runtime overrides on top of the template")}`);
	for (const { name, from, to, why, conflict, removed } of overrides) {
		const marker = conflict ? yellow("!") : dim("·");
		const change = removed ? "removed" : from ? `${from} → ${to}` : `+ ${to}`;
		console.log(`  ${marker} ${name} ${dim(change)}`);
		console.log(`    ${dim(why)}`);
	}
}

async function prepare(appRoot, flags, { quiet = false } = {}) {
	const app = scanApp(appRoot);
	const report = await validateApp(app);

	if (!quiet) {
		printReport(app, report);
	}
	if (!report.ok) {
		return null;
	}

	// Where the plumbing came from, how much of it there was, and which
	// dependencies the runtime overrode are all facts about our own machinery.
	// An app author can act on none of them, so they are diagnostics: on under
	// WANIWANI_DEBUG, off otherwise. A stale or unreachable template is different
	// — that one changes what they are running, so it always shows.
	const template = await resolveTemplate(templateSource(flags));
	if (!quiet && DEBUG) {
		console.log(`\n${dim("template")} ${describeTemplate(template)}`);
	}
	if (!quiet && template.offline) {
		console.log(`${yellow("!")} ${dim("GitHub unreachable — using the cached template")}`);
	}

	const { outDir, overrides, fromTemplate, manifest, vercelJson } = generate(app, { template });
	// Written into the app's own repo rather than the output, so it is worth a
	// line even outside debug: it is a tracked file that appeared.
	if (!quiet && vercelJson) {
		console.log(`${green("+")} ${bold("vercel.json")} ${dim("— deploy config for a git-connected project")}`);
	}
	if (!quiet && DEBUG) {
		console.log(
			`${dim(`${fromTemplate.length} files copied`)} ${dim(
				manifest ? "· exclusions from the template's manifest" : "· exclusions from the built-in defaults",
			)}`,
		);
		printOverrides(overrides);
	}
	return { app, outDir, template };
}

/**
 * Build the generated project for production: compile the server, bundle the
 * views, and emit a Vercel Build Output tree under `.vercel/output/` — no
 * adapter, no vercel.json, nothing for this CLI to stage afterwards.
 *
 * The framework's own `build` command renders exactly these steps inside a
 * branded UI, so the steps are driven here and reported in this CLI's format.
 * When the step list can't be loaded, shelling out is the fallback: the build
 * still runs, it just narrates itself.
 */
async function build(outDir) {
	const steps = await loadBuildSteps(outDir);
	if (!steps) {
		return run("node", [frameworkBin(), "build"], { cwd: outDir });
	}

	console.log(`\n${dim("building for production")}`);
	return runBuildSteps(steps, {
		root: outDir,
		// The steps name their command as one string (`tsc -b --force`), and reach
		// for `tsc` and `vite` by bare name.
		runShell: (command) => run(command, [], { cwd: outDir, shell: true }),
	});
}

/**
 * Write the plumbing into the app repo and step out of the way. What comes out
 * is an ordinary project on the underlying framework, driven by its own CLI: a
 * Dockerfile, a vercel.json, and the runtime vendored as readable source. No
 * dependency on this CLI or on Waniwani remains.
 */
async function eject(appRoot, flags) {
	const app = scanApp(appRoot);
	const report = await validateApp(app);
	printReport(app, report);
	if (!report.ok) return 1;

	const outDir = flags.out ? resolve(flags.out) : appRoot;
	const inPlace = outDir === appRoot;

	// Which files count as plumbing depends on what the template ships, so the
	// template has to be resolved before the question can be asked.
	const template = await resolveTemplate(templateSource(flags));
	console.log(`\n${dim("template")} ${describeTemplate(template)}`);

	const clashes = existingPlumbing(outDir, template);
	if (clashes.length > 0 && !flags.force) {
		console.error(`\n${red("✗")} ${bold("would overwrite existing files")}\n`);
		for (const file of clashes) {
			console.error(`  ${file}`);
		}
		console.error(`\n${dim("pass --force to overwrite, or --out <dir> to write elsewhere")}`);
		return 1;
	}

	const { written, overrides, fromTemplate, moved } = generate(app, {
		template,
		layout: "eject",
		outDir,
	});

	console.log(`\n${green("✓")} ${bold("Ejected")} ${dim(`→ ${outDir}`)}\n`);
	for (const file of written) {
		console.log(`  ${file}`);
	}
	console.log(`  ${dim(`+ ${fromTemplate.length} files from the template`)}`);
	printOverrides(overrides);

	console.log(`\n${bold("What changed")}`);
	if (moved.length > 0) {
		console.log(
			`  ${dim("·")} your source ${bold("moved")} under ${bold("src/app/")}: ${moved.join(", ")}`,
		);
		console.log(
			`    ${dim("the framework compiles from src/ — nothing outside it can be an input")}`,
		);
	}
	console.log(`  ${dim("·")} the runtime is now yours, vendored as source in ${bold("src/_runtime/")}`);
	console.log(`  ${dim("·")} @waniwani/kit imports point at src/_runtime/ — drop the dependency`);
	console.log(
		`  ${dim("·")} widgets/<name>/ no longer becomes a view — add ${bold("src/views/<name>.tsx")} by hand`,
	);
	if (inPlace) {
		console.log(`  ${dim("·")} ${bold(".waniwani/")} is dead weight — delete it`);
	}

	console.log(`\n${bold("From here")}`);
	console.log(`  npm install && npm run dev`);
	console.log(`\n${yellow("!")} ${dim("one way — nothing turns an ejected repo back")}`);
	return 0;
}

/**
 * Mirror app-folder edits into the build output; nodemon and Vite do the rest.
 * The template is resolved once at startup and reused, so a dev loop never
 * touches the network.
 */
function watchApp(appRoot, template) {
	let pending = null;
	const rebuild = () => {
		clearTimeout(pending);
		pending = setTimeout(async () => {
			const app = scanApp(appRoot);
			const report = await validateApp(app);
			if (!report.ok) {
				printReport(app, report);
				return;
			}
			// Rewriting the output restarts nodemon and triggers Vite HMR.
			generate(app, { template });
			console.log(dim(`[waniwani] regenerated ${new Date().toLocaleTimeString()}`));
		}, 120);
	};

	for (const dir of ["tools", "widgets", "flows", "api"]) {
		const path = join(appRoot, dir);
		if (existsSync(path)) {
			watch(path, { recursive: true }, rebuild);
		}
	}
	const config = join(appRoot, "waniwani.config.ts");
	if (existsSync(config)) {
		watch(config, rebuild);
	}
}

/**
 * The framework's dev server, under this CLI's narration.
 *
 * `--plain` trades the framework's interactive UI for one plain line per
 * diagnostic on stderr, which is what makes the output rewritable. It also drops
 * the framework's auto-open of its own DevTools page in the browser; the URL is
 * printed instead.
 */
function devServer(outDir) {
	return run("node", [frameworkBin(), "dev", "--plain"], {
		cwd: outDir,
		stderrFilter: devFilter(),
	});
}

/** Flags that take a value; everything else is a boolean switch. */
const VALUE_FLAGS = new Set(["out", "template", "name"]);

/**
 * `--out dir` / `--template=github:o/r#ref` alongside a positional app directory.
 *
 * `--no-install` sets `install` to false, so a switch that is on by default is
 * read as one flag with two states instead of two flags a caller can set to
 * contradict each other.
 */
function parseArgs(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const [name, inline] = arg.slice(2).split("=");
		if (name.startsWith("no-")) {
			flags[name.slice(3)] = false;
			continue;
		}
		flags[name] = VALUE_FLAGS.has(name) ? (inline ?? argv[++i]) : true;
	}
	return { flags, positional };
}

async function main() {
	const [command = "dev", ...rest] = process.argv.slice(2);
	const { flags, positional } = parseArgs(rest);
	const appRoot = resolve(positional[0] ?? process.cwd());

	if (BANNERED.has(command)) {
		banner(PACKAGE_VERSION);
	}

	// Before anything is spawned, so every child inherits the app's variables
	// whatever order its modules evaluate in. `init` has no app to read yet.
	if (command !== "init") {
		loadAppEnv(appRoot);
	}

	if (command === "init") {
		// Whether a directory was named matters only here: with none, the answer to
		// the one question decides where the app goes.
		process.exit(await init(appRoot, flags, { targeted: positional.length > 0 }));
	}

	if (command === "check") {
		const app = scanApp(appRoot);
		const report = await validateApp(app);
		printReport(app, report);
		process.exit(report.ok ? 0 : 1);
	}

	if (command === "dev") {
		const prepared = await prepare(appRoot, flags);
		if (!prepared) process.exit(1);
		watchApp(appRoot, prepared.template);
		process.exit(await devServer(prepared.outDir));
	}

	if (command === "build") {
		const prepared = await prepare(appRoot, flags);
		if (!prepared) process.exit(1);
		const code = await build(prepared.outDir);
		if (code !== 0) process.exit(code);
		console.log(`\n${green("✓")} built ${bold(prepared.outDir)}`);
		process.exit(0);
	}

	if (command === "start") {
		const outDir = join(appRoot, ".waniwani");
		if (!existsSync(join(outDir, "dist"))) {
			console.error(red("no build output — run `waniwani build` first"));
			process.exit(1);
		}
		process.exit(
			await run("node", [frameworkBin(), "start"], { cwd: outDir, stdoutFilter: startFilter() }),
		);
	}

	if (command === "eject") {
		process.exit(await eject(appRoot, flags));
	}

	console.error(red(`unknown command: ${command}`));
	console.error(dim("usage: waniwani <init|check|dev|build|start|eject> [dir]"));
	process.exit(1);
}

try {
	await main();
} catch (error) {
	// Template resolution and generation failures are expected conditions —
	// a bad ref, an unreachable network, a template whose shape moved.
	console.error(`\n${red("✗")} ${error instanceof Error ? error.message : String(error)}`);
	if (DEBUG) {
		console.error(error);
	} else {
		console.error(dim("set WANIWANI_DEBUG=1 for the stack trace"));
	}
	process.exit(1);
}
