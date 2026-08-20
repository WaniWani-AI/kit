/**
 * `waniwani init`, the first command anyone runs.
 *
 * What it writes is an app folder that already passes `waniwani check` and
 * already renders something: a config, a tool, and the widget that displays what
 * the tool returned. The point of scaffolding a working pair instead of an empty
 * folder is that the tool-to-widget hand-off is the one piece of this framework
 * nobody guesses correctly from the type signatures.
 *
 *   waniwani init my-app          create my-app/ and scaffold in it
 *   waniwani init .               scaffold in the current directory
 *   waniwani init                 ask for a name, and put the app where the
 *                                 answer says: a name of its own creates
 *                                 ./<name>/, the offered default (the current
 *                                 folder's name) scaffolds in place
 *
 *   --name <name>    the MCP server name, default the directory name
 *   --minimal        config and one tool, no widget
 *   --yes            take every default, ask nothing
 *   --no-install     skip the dependency install
 *   --force          overwrite app files that are already there
 *
 * Running it inside a repo that already has files is expected and supported.
 * A `package.json` is merged rather than replaced, a `.gitignore` gains the
 * lines it lacks, and a `README.md` or `.env.example` that exists is left
 * alone. Only the app's own source files count as a collision, and those stop
 * the command until `--force` says otherwise.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { bold, dim, green, red, yellow } from "./log.mjs";
import { installable } from "./peers.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));

/** A directory name as an MCP server name: `My App` becomes `my-app`. */
function slugify(input) {
	const slug = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "my-app";
}

/** `my-app` becomes `My app`, for the human-facing title. */
function titleize(slug) {
	const words = slug.replace(/[-_]+/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A title, made safe to drop into the generated TypeScript and Markdown.
 * Backticks, quotes, backslashes and `$` are the characters that would end a
 * string or a template literal early, and a product name needs none of them.
 */
function cleanTitle(input) {
	return input
		.replace(/[`"'\\$]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * What a new app depends on.
 *
 * Every version is read off this package's own manifest: `@waniwani/kit` at the
 * version of the CLI doing the scaffolding, and the four peers at the floors
 * this package declares, capped by `installable` so a floor does not install
 * the next major on the day it lands. A scaffold that wrote its own numbers
 * here would be the one file in the folder that can be wrong the day it is
 * created.
 *
 * `@waniwani/sdk` is written out even though a required peer is auto-installed
 * without it, because the app imports it directly — `flows/*.ts` calls
 * `createFlow` — and a package you import belongs in your own manifest rather
 * than arriving because something else asked for it.
 */
function dependencies() {
	return {
		"@waniwani/kit": `^${MANIFEST.version}`,
		"@waniwani/sdk": installable("@waniwani/sdk"),
		react: installable("react"),
		"react-dom": installable("react-dom"),
		zod: installable("zod"),
	};
}

// ------------------------------------------------------------ scaffold content

/**
 * The tool name and the widget name the scaffold uses. They appear in five
 * files, including inside prose the model reads, so they are named once.
 */
const TOOL = "search-products";
const WIDGET = "product-list";

function packageJson(app) {
	return `${JSON.stringify(
		{
			name: app.name,
			private: true,
			type: "module",
			scripts: {
				check: "waniwani check",
				dev: "waniwani dev",
				build: "waniwani build",
				start: "waniwani start",
			},
			dependencies: dependencies(),
		},
		null,
		2,
	)}\n`;
}

function appConfig(app) {
	return `import { defineApp } from "@waniwani/kit";

export default defineApp({
	// The MCP server name. Hosts show \`title\` to humans and use this one as the id.
	name: ${JSON.stringify(app.name)},
	title: ${JSON.stringify(app.title)},
});
`;
}

function tool() {
	return `import { defineTool } from "@waniwani/kit";
import { z } from "zod";

/**
 * The filename is the tool name, so this file is \`${TOOL}\`. Rename the
 * file and the tool renames with it.
 *
 * Swap CATALOGUE for whatever answers the question for real: a fetch, a
 * database, an internal API. \`run\` may be async.
 */
const CATALOGUE = [
	{ id: "aeron", name: "Aeron chair", price: 1290, blurb: "Mesh task chair, twelve-year warranty." },
	{ id: "sayl", name: "Sayl chair", price: 545, blurb: "Suspension back, the light one." },
	{ id: "nevi", name: "Nevi sit-stand desk", price: 890, blurb: "Electric, 70 to 120 cm." },
	{ id: "ollin", name: "Ollin monitor arm", price: 235, blurb: "Single arm, holds up to 9 kg." },
];

export default defineTool({
	// Shown to humans in connector UIs.
	title: "Search the catalogue",
	// The only thing the model reads before deciding to call this, so it says
	// when to call it and what not to do instead.
	description:
		"Find products matching what the shopper asked for. Call this before naming any product or quoting any price, and never answer either from memory. Pass the shopper's own words as the query.",
	// Zod shapes, written as plain objects instead of z.object({ ... }).
	input: {
		query: z.string().describe("What the shopper asked for, in their words, e.g. 'a chair under 600'."),
	},
	output: {
		products: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				price: z.number().describe("Price in euros."),
				blurb: z.string(),
			}),
		),
	},
	// Becomes MCP annotations. This tool reads and does nothing else.
	hints: { readOnly: true },
	run: ({ query }) => {
		const terms = query.toLowerCase().split(/\\s+/).filter(Boolean);
		const matched = CATALOGUE.filter((product) =>
			terms.some((term) => \`\${product.name} \${product.blurb}\`.toLowerCase().includes(term)),
		);
		// The whole catalogue when nothing matched, so an early conversation has
		// something on screen while you are still wiring this up.
		return { products: matched.length > 0 ? matched : CATALOGUE };
	},
});
`;
}

function widgetContract() {
	return `import { defineWidget } from "@waniwani/kit";
import { z } from "zod";

const product = z.object({
	id: z.string(),
	name: z.string(),
	price: z.number().describe("Price in euros."),
	blurb: z.string().describe("One line about the product."),
});

/**
 * The folder name is the tool name, so this widget is \`${WIDGET}\`.
 *
 * \`data\` is one schema doing three jobs: the tool's input, its structured
 * output, and the props \`useWidget()\` hands ui.tsx. Server and UI cannot drift.
 *
 * This file is imported by the server and by the browser bundle, so it stays
 * free of React and CSS. The component sits next to it in ui.tsx.
 */
export default defineWidget({
	title: "Product list",
	description:
		"Show the product cards. Call this once ${TOOL} has returned products, passing them through unmodified. Frame it in one short sentence before calling, e.g. \\"Here's what fits.\\" The widget renders every name and price itself, so do NOT list them in text.",
	data: {
		query: z.string().describe("What the shopper asked for. Shown as the heading."),
		products: z.array(product).describe("Products returned by ${TOOL}, unmodified."),
	},
	hints: { readOnly: true },
	// Text handed to the model alongside the rendered widget. Use it to say what
	// the model should not repeat, and what it should wait for.
	llmText: (data) =>
		\`The product list is on screen with \${data.products.length} products. It renders every name and price itself, so do NOT repeat them in text.

Wait for the shopper to pick one, then answer about that product.\`,
});
`;
}

function widgetUi() {
	return `import { useLayout, useSendFollowUpMessage, useWidget } from "@waniwani/kit/web";
import widget from "./widget.js";

const euros = (value: number) =>
	new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(value);

export default function ProductList() {
	// Typed off the widget's own \`data\` schema. No generated helpers, no server
	// type import.
	const { data } = useWidget(widget);
	const sendFollowUp = useSendFollowUpMessage();

	// The host hands the colour scheme to the view instead of to the browser, so
	// \`prefers-color-scheme\` is the wrong signal and Tailwind's \`dark:\` variant is
	// wired to a \`dark\` class (see the template's src/index.css). Every widget puts
	// that class on its own root: a view is its own bundle in its own iframe, so
	// there is no shared ancestor to hang it off.
	const { theme } = useLayout();
	const root = theme === "dark" ? "dark" : "";

	// \`data\` arrives as soon as the host has the tool input, which on most hosts is
	// before the server has responded. Render optimistically.
	if (!data) {
		return <div className={\`\${root} font-sans text-sm text-slate-500\`}>Loading…</div>;
	}

	return (
		<div className={\`\${root} font-sans text-slate-900 dark:text-slate-100\`}>
			<h1 className="mb-3 text-lg font-semibold tracking-tight">{data.query}</h1>

			<div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5">
				{data.products.map((product) => (
					<button
						type="button"
						key={product.id}
						// A click becomes a message from the shopper, which is what moves
						// the conversation on.
						onClick={() => sendFollowUp(\`Tell me more about the \${product.name}.\`)}
						className="flex cursor-pointer flex-col items-start gap-1 rounded-2xl border-[1.5px] border-slate-200 bg-white p-3.5 text-left transition duration-150 hover:-translate-y-px hover:border-slate-400 hover:shadow-lg hover:shadow-slate-900/10 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-500"
						// What the model reads in place of the pixels.
						data-llm={\`\${product.name}, \${euros(product.price)}: \${product.blurb}\`}
					>
						<span className="text-[22px] font-bold tracking-tight">{euros(product.price)}</span>
						<span className="font-semibold">{product.name}</span>
						<span className="text-[13px] text-slate-500 dark:text-slate-400">{product.blurb}</span>
					</button>
				))}
			</div>
		</div>
	);
}
`;
}

function envExample() {
	return `# Optional. Without it the app still runs: flows use MemoryKvStore and
# withWaniwani degrades to a no-op. With it, flow state is hosted and tracking
# reaches app.waniwani.ai.
WANIWANI_API_KEY=
WANIWANI_PUBLIC_KEY=
`;
}

function gitignore() {
	return `node_modules/
.waniwani/
.env
.env.local
`;
}

function readme(app) {
	return `# ${app.title}

An MCP app built with [@waniwani/kit](https://www.npmjs.com/package/@waniwani/kit).
You own the folders below. The server, the transport, the bundling and the deploy
files are the kit's.

\`\`\`
waniwani.config.ts        the app's name and title, plus optional instructions
tools/*.ts                one file per tool; the filename is the tool name
widgets/<name>/           widget.ts for the contract, ui.tsx for the component
flows/*.ts                multi-step conversations, from @waniwani/sdk
\`\`\`

## Commands

\`\`\`bash
npm run dev        # dev server, regenerating on every change
npm run check      # validate the folder without building
npm run build      # production build
npm run start      # run the production build
\`\`\`

\`.waniwani/\` is build output, the way \`.next/\` is. Every command regenerates it
and it stays out of git.
`;
}

/**
 * The files a new app gets.
 *
 * `whenPresent` decides what happens to one that is already on disk:
 * `undefined` is a collision that stops the command, `merge` folds the
 * scaffold's contribution into what is there, and `keep` leaves it untouched.
 */
function scaffold(app, { minimal }) {
	const files = [
		{ path: "package.json", contents: packageJson(app), whenPresent: "merge", merge: mergePackageJson },
		{ path: ".gitignore", contents: gitignore(), whenPresent: "merge", merge: mergeGitignore },
		{ path: ".env.example", contents: envExample(), whenPresent: "keep" },
		{ path: "README.md", contents: readme(app), whenPresent: "keep" },
		{ path: "waniwani.config.ts", contents: appConfig(app) },
		{ path: `tools/${TOOL}.ts`, contents: tool() },
	];

	if (!minimal) {
		files.push(
			{ path: `widgets/${WIDGET}/widget.ts`, contents: widgetContract() },
			{ path: `widgets/${WIDGET}/ui.tsx`, contents: widgetUi() },
		);
	}

	return files;
}

// -------------------------------------------------------------------- merging

/**
 * Add the scripts and dependencies an app needs to a manifest that is already
 * there, and touch nothing else. A key the repo already declares is the repo's
 * decision, including a `dev` script that runs something other than this CLI.
 *
 * @returns the keys added, for the CLI to report
 */
function mergePackageJson(file, contents) {
	const existing = JSON.parse(readFileSync(file, "utf-8"));
	const generated = JSON.parse(contents);
	const added = [];

	const fold = (section) => {
		const merged = { ...existing[section] };
		for (const [key, value] of Object.entries(generated[section])) {
			if (merged[key]) continue;
			merged[key] = value;
			added.push(`${section}.${key}`);
		}
		return merged;
	};

	const next = {
		...existing,
		// App modules are ESM. A repo that says commonjs is warned about instead of
		// rewritten, since flipping it changes how the rest of that repo loads.
		type: existing.type ?? "module",
		scripts: fold("scripts"),
		dependencies: fold("dependencies"),
	};
	if (!existing.type) added.push("type");

	if (added.length > 0) {
		writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
	}
	return added;
}

/**
 * Add the lines the app does not ignore yet, leaving every line it wrote alone.
 * A trailing slash is not part of the comparison, so a repo ignoring
 * `node_modules` does not gain `node_modules/` next to it.
 *
 * @returns the lines added, for the CLI to report
 */
function mergeGitignore(file, contents) {
	const existing = readFileSync(file, "utf-8");
	const bare = (line) => line.trim().replace(/\/$/, "");
	const known = new Set(existing.split("\n").map(bare));

	const additions = contents
		.split("\n")
		.filter((line) => line.trim() && !line.trim().startsWith("#") && !known.has(bare(line)));

	if (additions.length === 0) return [];
	const prefix = !existing || existing.endsWith("\n") ? "" : "\n";
	writeFileSync(file, `${existing}${prefix}${additions.join("\n")}\n`);
	return additions;
}

// ------------------------------------------------------------------- the shell

function write(file, contents) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

/** One question, with the default in parentheses and Enter taking it. */
async function ask(question, fallback) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(`${question} ${dim(`(${fallback})`)} `);
		return answer.trim() || fallback;
	} finally {
		rl.close();
	}
}

/**
 * The package manager that invoked this command, which npm, pnpm, yarn and bun
 * all announce in `npm_config_user_agent`. Nothing to detect from lockfiles: a
 * new folder has none, and a `waniwani init` inside an existing repo was still
 * typed with one of the four.
 */
function packageManager() {
	const agent = process.env.npm_config_user_agent ?? "";
	return ["bun", "pnpm", "yarn", "npm"].find((name) => agent.startsWith(name)) ?? "npm";
}

/** How each manager runs a binary out of node_modules, for the closing lines. */
const RUNNERS = { npm: "npx", pnpm: "pnpm", yarn: "yarn", bun: "bunx" };

function install(root, manager) {
	console.log(`\n${dim(`installing with ${manager}…`)}`);
	return new Promise((resolvePromise) => {
		const child = spawn(manager, ["install"], {
			cwd: root,
			stdio: "inherit",
			// npm and yarn are .cmd shims on Windows, which execvp cannot run.
			shell: process.platform === "win32",
		});
		child.on("close", (code) => resolvePromise(code === 0));
		child.on("error", () => resolvePromise(false));
	});
}

/**
 * Scaffold an app folder, install its dependencies, and say what to run.
 *
 * @param appRoot the directory to scaffold, created if it does not exist
 * @param flags parsed CLI flags
 * @param options.targeted a directory was named on the command line
 * @returns a process exit code
 */
export async function init(appRoot, flags, { targeted = true } = {}) {
	const interactive = process.stdin.isTTY && !flags.yes && !flags.name;
	const suggested = slugify(basename(appRoot));

	// One question, and both fields come out of the answer: `Acme Shop` gives the
	// server the name `acme-shop` and keeps `Acme Shop` as the title. An answer
	// that is already a slug gets a title with a capital on the front.
	const answer = flags.name ?? (interactive ? await ask("App name", suggested) : suggested);
	const name = slugify(answer);
	const typed = cleanTitle(answer);
	const app = { name, title: typed && typed !== name ? typed : titleize(name) };

	// A name typed at the prompt with no directory to put it in names the
	// directory as well: `oney` in ~/Projects means ~/Projects/oney, which is how
	// create-next-app's one question reads. Taking the offered default leaves
	// everything where it is, since that default is the current folder's own name,
	// and `waniwani init .` names the current folder outright.
	const root = !targeted && interactive && name !== suggested ? join(appRoot, name) : appRoot;

	const files = scaffold(app, { minimal: Boolean(flags.minimal) });

	// Nothing is written until every collision is known, so a refusal leaves the
	// directory exactly as it was.
	const clashes = files.filter((file) => !file.whenPresent && existsSync(join(root, file.path)));
	if (clashes.length > 0 && !flags.force) {
		console.error(`\n${red("✗")} ${bold("already an app folder here")}\n`);
		for (const file of clashes) {
			console.error(`  ${file.path}`);
		}
		console.error(`\n${dim("pass --force to overwrite, or init into a new directory")}`);
		return 1;
	}

	mkdirSync(root, { recursive: true });

	const actions = [];
	for (const file of files) {
		const target = join(root, file.path);

		if (!existsSync(target)) {
			write(target, file.contents);
			actions.push([green("+"), file.path, null]);
			continue;
		}
		if (file.whenPresent === "keep") {
			actions.push([dim("·"), file.path, "yours, left alone"]);
			continue;
		}
		if (file.whenPresent === "merge") {
			const changed = file.merge(target, file.contents);
			actions.push([
				changed.length > 0 ? yellow("~") : dim("·"),
				file.path,
				changed.length > 0 ? `+ ${changed.join(", ")}` : "nothing to add",
			]);
			continue;
		}
		// A collision the caller chose to overwrite.
		write(target, file.contents);
		actions.push([yellow("~"), file.path, "overwritten"]);
	}

	console.log(`\n${green("✓")} ${bold(app.name)} ${dim(`→ ${root}`)}\n`);
	for (const [marker, path, note] of actions) {
		console.log(`  ${marker} ${path}${note ? ` ${dim(note)}` : ""}`);
	}

	// The merge leaves a script the repo already had alone, so the way into the dev
	// loop is whatever survived that: `npm run dev` when it is ours, the CLI by
	// name when the repo's own `dev` runs something else.
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
	const ours = manifest.scripts?.dev === "waniwani dev";

	if (manifest.type !== "module") {
		console.log(
			`\n${yellow("!")} ${bold("package.json")} says ${bold(`"type": "${manifest.type}"`)}`,
		);
		console.log(`  ${dim('app modules are ESM: set it to "module" or the build cannot load them')}`);
	}

	const manager = packageManager();
	// A scaffold with no node_modules still checks out and still reads, so a
	// failed install is reported and the folder is kept.
	const installed = flags.install === false ? null : await install(root, manager);

	console.log(`\n${bold("From here")}`);
	// `init apps/store` is scaffolded two levels down, so the path is the one to
	// print rather than the directory's own name.
	const from = relative(process.cwd(), root);
	if (from) {
		console.log(`  cd ${from}`);
	}
	if (installed === false) {
		console.log(`  ${yellow(`${manager} install`)} ${dim("(the first attempt failed)")}`);
	} else if (installed === null) {
		console.log(`  ${manager} install`);
	}
	console.log(`  ${ours ? `${manager} run dev` : `${RUNNERS[manager]} waniwani dev`}`);

	console.log(`\n${bold("Then")}`);
	console.log(`  ${dim("·")} edit ${bold(`tools/${TOOL}.ts`)} to answer with your own data`);
	if (!flags.minimal) {
		console.log(`  ${dim("·")} edit ${bold(`widgets/${WIDGET}/ui.tsx`)} for how it looks on screen`);
	}
	console.log(`  ${dim("·")} add ${bold("flows/<name>.ts")} for a multi-step conversation`);
	return 0;
}
