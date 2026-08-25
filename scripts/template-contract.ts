#!/usr/bin/env bun
/**
 * The contract between the generator and the distribution template.
 *
 * The template is consumed as-is at a pinned commit, so a change to its layout
 * can break every app built from it. This builds a real app against a template,
 * serves it, calls every tool, then ejects and builds again with no Waniwani
 * tooling in the tree. What it asserts is what a customer would otherwise
 * discover:
 *
 *   bun scripts/template-contract.ts                    # the pinned template
 *   bun scripts/template-contract.ts --template ../t    # a local checkout
 *   bun scripts/template-contract.ts --template github:WaniWani-AI/mcp-distribution-template#main
 *
 * It is one script rather than two workflows because both directions of drift
 * ask the same question. `.github/workflows/ci.yml` runs it against the commit
 * this repo pins, which is what makes a bump reviewable; the copy of
 * `ci/template-contract.yml` that lives in the template repo runs it against a
 * pull request into that repo's `main`, which catches a layout change where it
 * happens, ahead of any release. A single script means the two cannot check
 * different things and both report green.
 *
 * `--skip-eject` drops the last step, which is the slow one (a real `npm
 * install` into a fresh directory). For local iteration, not for CI.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The CLI's own colours. Reused rather than rebuilt so an ESC byte is written
// in exactly one place in this repo (see the note in packages/kit/cli/log.ts).
// The source, not `dist/`: the first step below is what builds `dist/`, and an
// import is evaluated long before it runs.
import { bold, dim, green, red } from "../packages/kit/cli/log.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KIT_DIR = join(REPO_ROOT, "packages/kit");
/** The compiled bin, which step one produces. */
const CLI = join(KIT_DIR, "dist/cli/index.js");

/**
 * Utilities that prove the template's Tailwind setup reached the app's source.
 *
 * A template that keeps `src/index.css` but drops the Tailwind plugin from
 * `vite.config.ts` builds green and serves every widget unstyled: nothing
 * errors, the utility classes resolve to nothing. The generator cannot see that
 * from the filesystem, so the assertion is on the emitted CSS. `text-ink` is a
 * `@theme` token and the example's `ui.tsx` is the only place it appears, so
 * finding it proves both the style entry and the scan. `.dark` proves the
 * variant compiles against the class rather than `prefers-color-scheme`.
 */
const CSS_MARKERS = ["text-ink", "inset-ring", ".dark"];

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const flags: Record<string, string | boolean | undefined> = {};
for (let i = 0; i < argv.length; i++) {
	const [name, inline] = (argv[i] as string).slice(2).split("=") as [string, string | undefined];
	const takesValue = ["template", "app", "port"].includes(name);
	flags[name] = takesValue ? (inline ?? argv[++i]) : true;
}

const app = resolve(REPO_ROOT, (flags.app as string | undefined) ?? "examples/oney");
const port = Number(flags.port ?? 4000);

/**
 * A local template path is resolved here rather than passed through.
 *
 * The steps below run with a cwd of their own, and the template repo's workflow
 * checks the two repos out side by side and names the template relatively. A
 * relative path would resolve against whichever cwd the step happened to use.
 */
const requested = flags.template as string | undefined;
const template = requested?.startsWith("github:")
	? requested
	: requested
		? resolve(requested)
		: undefined;

const templateArgs = template ? ["--template", template] : [];

// -------------------------------------------------------------------- harness

let step = 0;

function heading(title: string): void {
	step += 1;
	console.log(`\n${bold(`${step}. ${title}`)}`);
}

/** Exit with the reason, so CI shows a sentence rather than a stack. */
function fail(reason: string, detail?: string): never {
	console.error(`\n${red(`✗ ${reason}`)}`);
	if (detail) console.error(detail);
	process.exit(1);
}

/**
 * `tolerate` returns the exit code instead of exiting, for a step whose failure
 * is the input to a second attempt rather than the end of the run.
 */
function run(
	command: string,
	args: string[],
	{
		cwd = REPO_ROOT,
		reason,
		tolerate = false,
	}: { cwd?: string; reason?: string; tolerate?: boolean } = {},
): number {
	console.log(dim(`$ ${command} ${args.join(" ")}`));
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.error) fail(`could not run ${command}: ${result.error.message}`);
	if (result.status !== 0 && !tolerate) {
		fail(reason ?? `${command} ${args[0]} exited ${result.status}`);
	}
	return result.status ?? 1;
}

/**
 * Install the ejected tree, and distinguish the two ways that fails.
 *
 * Ejecting hands someone an ordinary npm project, so `npm install` failing there
 * is a customer-facing break either way. Which break it is decides who fixes it,
 * and the two look identical in an npm log: a dependency that cannot resolve at
 * all is the generated manifest's problem, while a peer range one of our own
 * published packages has left behind resolves fine once npm stops enforcing it.
 * Retrying with `--legacy-peer-deps` separates them, and the run still fails —
 * what changes is that the message names who fixes it.
 *
 * It says nothing about whether the tree then builds. That is the next step's
 * question, and a `--legacy-peer-deps` install reaching it proves only that npm
 * was willing to lay the tree down.
 */
function installEjected(cwd: string): void {
	if (run("npm", ["install"], { cwd, tolerate: true }) === 0) return;

	console.log(dim("\nnpm refused; retrying with --legacy-peer-deps to see which failure this is"));
	if (run("npm", ["install", "--legacy-peer-deps"], { cwd, tolerate: true }) !== 0) {
		fail(
			"the ejected tree declares something npm cannot resolve",
			"not a peer conflict: a dependency in the generated package.json does not exist at the version it asks for",
		);
	}

	fail(
		"the ejected tree installs only with --legacy-peer-deps",
		"a peer range in one of the published packages is behind what the framework now depends on, so " +
			"ejecting resolves under bun and is refused by npm. The fix is a release of the package holding " +
			"the stale range, not a change here. The npm log above names both sides of the conflict.",
	);
}

/** Poll the MCP endpoint until it answers `initialize`, or give up. */
async function waitForServer(url: string, attempts = 60): Promise<boolean> {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "contract", version: "1" },
					},
				}),
			});
			if (response.ok) return true;
		} catch {
			// Not up yet. The server is starting in a child process.
		}
		await new Promise((done) => setTimeout(done, 1000));
	}
	return false;
}

// ---------------------------------------------------------------------- steps

/**
 * The framework imports `globSync` from `node:fs`, which arrived in Node 22 and
 * is what the generated project's own `engines` field is really about. On an
 * older runtime its CLI fails inside oclif's command loader, and what surfaces
 * is `command build not found` under a SyntaxError about `node:fs` — which reads
 * like the template moved. Say the real reason instead.
 */
const MINIMUM_NODE = 24;

/**
 * The `node` on PATH, which is the one every step below spawns.
 *
 * Not `process.versions.node`: this script runs under bun, and bun reports the
 * Node version it emulates rather than the binary it would exec. Those two are
 * unrelated numbers, and the one that decides whether the framework's CLI loads
 * is the binary's.
 */
const nodeVersion = spawnSync("node", ["--version"], { encoding: "utf-8" })
	.stdout?.trim()
	.replace(/^v/, "");
if (!nodeVersion) {
	fail("no `node` on PATH", "every step below shells out to it");
}
if (Number(nodeVersion.split(".")[0]) < MINIMUM_NODE) {
	fail(
		`this needs Node ${MINIMUM_NODE} or newer, and \`node\` on PATH is ${nodeVersion}`,
		"the generated project declares the same floor in its engines field, and the framework's CLI does not load below it",
	);
}

console.log(`node      ${nodeVersion}`);
console.log(`template  ${template ?? "the commit packages/kit/cli/template.ts pins"}`);
console.log(`app       ${app}`);

// `dist/` is gitignored, so a fresh checkout has none, and nothing in `bun
// install` builds a workspace package. Without this the app's every import of
// `@waniwani/kit` resolves to a file that is not there, and the build fails
// before it reaches the template at all.
// `npm`, though this repo installs with bun: the script it runs is two plain
// `tsc` invocations, so the two are equivalent here, and npm ships with node.
// One less thing that has to be on PATH for the contract to be runnable.
//
// It is also what produces `CLI`. Every step below shells out to the compiled
// bin rather than the TypeScript behind it, which is deliberate: the thing a
// customer installs is the compiled tree, so that is the thing this asserts on.
heading("Build the kit");
run("npm", ["run", "build"], { cwd: KIT_DIR, reason: "the kit does not compile" });

heading("Generate and build the example app against the template");
run("node", [CLI, "build", app, ...templateArgs], {
	reason: "the app does not build against this template",
});

heading("Check the app's Tailwind utilities reached the bundle");
const assetsDir = join(app, ".waniwani/dist/assets/assets");
if (!existsSync(assetsDir)) {
	fail(`no bundled assets at ${assetsDir}`, "the build's output layout moved");
}
const stylesheet = readdirSync(assetsDir).find((file) => /^style-.*\.css$/.test(file));
if (!stylesheet) {
	fail(`no style-*.css in ${assetsDir}`, "the template's style entry did not reach the build");
}
const css = readFileSync(join(assetsDir, stylesheet), "utf-8");
const missing = CSS_MARKERS.filter((marker) => !css.includes(marker));
if (missing.length > 0) {
	fail(
		`${missing.join(", ")} missing from ${stylesheet}`,
		"the template's Tailwind setup is not reaching the app's source: widgets would build green and serve unstyled",
	);
}
console.log(`  ✓ ${CSS_MARKERS.join(", ")} in ${stylesheet}`);

heading("Serve it and call every tool");
const url = `http://localhost:${port}/mcp`;
// Its own process group, so the framework's children go down with it. Killing
// the CLI alone leaves the server holding the port, and every later run of this
// script then fails on an address already in use.
const server = spawn("node", [CLI, "start", app], {
	cwd: REPO_ROOT,
	env: { ...process.env, PORT: String(port) },
	stdio: "inherit",
	detached: true,
});

let exited: number | null = null;
server.on("exit", (code) => {
	exited = code ?? 1;
});

const stopServer = () => {
	if (exited !== null || server.pid === undefined) return;
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {
		// Already gone.
	}
};
process.on("exit", stopServer);

if (!(await waitForServer(url))) {
	stopServer();
	fail(
		`the server never answered at ${url}`,
		exited === null ? "it is still running but not serving" : `it exited ${exited}`,
	);
}

run("bun", [join(REPO_ROOT, "scripts/probe.ts"), url], {
	reason: "the served app does not answer the MCP calls a client makes",
});
stopServer();

if (flags["skip-eject"]) {
	console.log(`\n${dim("skipping the eject step")}`);
} else {
	heading("Eject and build with no Waniwani tooling");
	// A fresh directory, so what gets installed and built is the ejected tree
	// and nothing the workspace would have hoisted into it.
	const ejected = mkdtempSync(join(tmpdir(), "waniwani-contract-"));
	try {
		run("node", [CLI, "eject", app, "--out", ejected, ...templateArgs], {
			reason: "eject does not produce a tree from this template",
		});
		installEjected(ejected);
		run("npm", ["run", "build"], {
			cwd: ejected,
			reason: "the ejected tree does not build on its own",
		});
	} finally {
		rmSync(ejected, { recursive: true, force: true });
	}
}

console.log(`\n${green("✓ the template holds up its end")}`);
