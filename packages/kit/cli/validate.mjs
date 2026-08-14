/**
 * The build check.
 *
 * Structural rules first (cheap, from the filesystem), then the modules are
 * actually imported so a broken export or a flow that fails to compile is
 * reported here rather than as a stack trace at request time.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";

const NAME_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

class Report {
	constructor(root) {
		this.root = root;
		this.errors = [];
		this.warnings = [];
	}

	error(where, message, hint) {
		this.errors.push({ where, message, hint });
	}

	warn(where, message, hint) {
		this.warnings.push({ where, message, hint });
	}

	get ok() {
		return this.errors.length === 0;
	}
}

function rel(root, file) {
	return relative(root, file) || ".";
}

/** Everything the filesystem alone can tell us. */
function checkStructure(app, report) {
	const { root } = app;

	if (!app.configFile) {
		report.error(
			"waniwani.config.ts",
			"missing app config",
			"create waniwani.config.ts with `export default defineApp({ name: '...' })`",
		);
	}

	if (app.tools.length + app.widgets.length + app.flows.length + app.docs.length === 0) {
		report.error(
			".",
			"this app exposes nothing",
			"add a tool (tools/<name>.ts), a widget (widgets/<name>/), a flow (flows/<name>.ts), or docs (docs/<slug>.md)",
		);
	}

	for (const widget of app.widgets) {
		const where = rel(root, widget.dir);
		if (!widget.contract) {
			report.error(
				where,
				"missing widget.ts",
				"every widget folder needs a widget.ts with `export default defineWidget({ ... })`",
			);
		}
		if (!widget.ui) {
			report.error(
				where,
				"missing ui.tsx",
				"every widget folder needs a ui.tsx with a default-exported React component",
			);
		}
	}

	// A widget's folder name is its MCP tool name and its bundle entry name, so
	// it has to survive both.
	const named = [
		...app.tools.map((t) => ({ kind: "tool", name: t.name, where: rel(root, t.file) })),
		...app.widgets.map((w) => ({ kind: "widget", name: w.name, where: rel(root, w.dir) })),
	];

	const seen = new Map();
	for (const entry of named) {
		if (!NAME_RE.test(entry.name)) {
			report.error(
				entry.where,
				`"${entry.name}" is not a valid MCP tool name`,
				"use lowercase letters, digits, dashes and underscores",
			);
		}
		const previous = seen.get(entry.name);
		if (previous) {
			report.error(
				entry.where,
				`name "${entry.name}" is already taken by ${previous.kind} ${previous.where}`,
				"tool and widget names share one namespace — rename one of them",
			);
		}
		seen.set(entry.name, entry);
	}

	// Flows point at widgets by name. Catching a typo here beats catching it
	// when a user is halfway through a conversation.
	const widgetNames = new Set(app.widgets.map((w) => w.name));
	for (const flow of app.flows) {
		const source = readFileSync(flow.file, "utf-8");
		for (const match of source.matchAll(/showWidget\(\s*\{[^}]*?tool:\s*["'`]([^"'`]+)["'`]/gs)) {
			const target = match[1];
			if (!widgetNames.has(target)) {
				report.error(
					rel(root, flow.file),
					`showWidget references the widget "${target}", which does not exist`,
					widgetNames.size > 0
						? `known widgets: ${[...widgetNames].join(", ")}`
						: "this app has no widgets/ folder",
				);
			}
		}
	}
}

/** Import each module and check the shape of what it exports. */
async function checkModules(app, report) {
	const { root } = app;

	if (app.configFile) {
		const config = await load(app.configFile, rel(root, app.configFile), report);
		if (config && !config.name) {
			report.error(
				rel(root, app.configFile),
				"defineApp() is missing `name`",
				"the MCP server name, e.g. name: 'oney-split-payment'",
			);
		}
	}

	for (const tool of app.tools) {
		const where = rel(root, tool.file);
		const def = await load(tool.file, where, report);
		if (!def) continue;
		if (typeof def.run !== "function") {
			report.error(where, "tool is missing run()", "export default defineTool({ ..., run })");
		}
		if (!def.description) {
			report.error(
				where,
				"tool is missing a description",
				"the description is how the model decides to call it — say when to use it",
			);
		}
		if (!def.title) {
			report.warn(where, "tool is missing a title", "titles show up in connector UIs");
		}
	}

	for (const widget of app.widgets) {
		if (!widget.contract) continue;
		const where = rel(root, widget.contract);
		const def = await load(widget.contract, where, report);
		if (!def) continue;
		if (!def.data || typeof def.data !== "object") {
			report.error(
				where,
				"widget is missing a `data` schema",
				"data is the single schema for input, output, and the component's props",
			);
		}
		if (!def.description) {
			report.error(
				where,
				"widget is missing a description",
				"the description is how the model decides to show it",
			);
		}
	}

	for (const flow of app.flows) {
		const where = rel(root, flow.file);
		const def = await load(flow.file, where, report);
		if (!def) continue;
		if (!def.name || !def.config || typeof def.handler !== "function") {
			report.error(
				where,
				"this is not a compiled flow",
				"export default createFlow({ ... }).addEdge(...).compile()",
			);
		}
	}
}

/**
 * App modules are TypeScript, and they import each other with the `.js`
 * specifiers TypeScript's ESM output requires — `../lib/plans.js` for a file on
 * disk called `plans.ts`. Node's built-in type stripping does not remap those,
 * so validation registers tsx's resolver before importing anything out of the
 * app folder. Bun does the remapping on its own, which is what hid this while
 * the CLI still ran under bun.
 *
 * Registration is global to the process and idempotent here, so it happens once
 * on the first load rather than at startup — `waniwani start` never validates.
 */
let resolverRegistered = false;
async function registerTypeScriptResolver() {
	if (resolverRegistered) return;
	resolverRegistered = true;
	const { register } = await import("tsx/esm/api");
	register();
}

async function load(file, where, report) {
	try {
		await registerTypeScriptResolver();
		const module = await import(`${file}?t=${Date.now()}`);
		const def = module.default;
		if (!def) {
			report.error(where, "no default export", "the runtime loads this module's default export");
			return null;
		}
		return def;
	} catch (error) {
		report.error(where, "failed to load", error instanceof Error ? error.message : String(error));
		return null;
	}
}

export async function validateApp(app) {
	const report = new Report(app.root);
	checkStructure(app, report);
	// Importing broken modules produces noise on top of structural errors.
	if (report.ok) {
		await checkModules(app, report);
	}
	return report;
}
