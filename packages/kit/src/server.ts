/**
 * The shared MCP runtime.
 *
 * Every Waniwani MCP app runs this exact code. App repos contain no server
 * bootstrap, so a runtime fix is one package bump away for all of them — no
 * 30-repo sweep, no per-repo verification.
 *
 * The server itself belongs to the distribution template, which constructs it,
 * registers whatever tools it ships, and runs it. The CLI generates one file
 * against that seam — `src/waniwani.ts` — which imports the app's modules and
 * hands them to `registerApp()`. Nothing else.
 */

import { McpServer, type ViewName } from "skybridge/server";
import { z } from "zod";
import type { DocEntry, Shape, ToolHints, WidgetCsp } from "./index.js";

/**
 * The manifest holds definitions with unrelated schemas side by side, so the
 * handler signatures are widened here. `never` in the parameter position
 * accepts any concrete handler; the call sites cast back.
 */
type AnyToolDefinition = {
	title: string;
	description: string;
	input?: Shape;
	output?: Shape;
	hints?: ToolHints;
	run: (input: never) => unknown;
};

type AnyWidgetDefinition = {
	title: string;
	description: string;
	data: Shape;
	hints?: ToolHints;
	csp?: WidgetCsp;
	llmText?: (data: never) => string;
	load?: (input: never) => unknown;
};

/** A flow compiled by `createFlow(...).compile()` from `@waniwani/sdk/mcp`. */
export type CompiledFlow = {
	name: string;
	// biome-ignore lint/suspicious/noExplicitAny: the SDK's own tool config shape
	config: any;
	// biome-ignore lint/suspicious/noExplicitAny: the SDK's own handler shape
	handler: any;
};

export type Manifest = {
	tools: Array<{ name: string; def: AnyToolDefinition }>;
	widgets: Array<{ name: string; def: AnyWidgetDefinition }>;
	flows: CompiledFlow[];
	docs: DocEntry[];
};

/**
 * Translate `hints` into MCP annotations. `title` is always present because
 * Claude's Connectors Directory rejects tools without one.
 */
function annotations(title: string, hints: ToolHints | undefined, defaults: ToolHints) {
	const merged = { ...defaults, ...hints };
	return {
		title,
		readOnlyHint: merged.readOnly ?? false,
		destructiveHint: merged.destructive ?? false,
		openWorldHint: merged.openWorld ?? false,
		idempotentHint: merged.idempotent ?? false,
	};
}

/** Normalise whatever a tool handler returned into an MCP `CallToolResult`. */
function toolResult(value: unknown) {
	if (typeof value === "string") {
		return { content: [{ type: "text" as const, text: value }] };
	}
	if (value && typeof value === "object" && "content" in value) {
		return value as { content: Array<{ type: "text"; text: string }> };
	}
	const structuredContent = (value ?? {}) as Record<string, unknown>;
	return {
		structuredContent,
		content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
	};
}

/**
 * Default model-facing text for a widget. Widgets render their own detail, so
 * the model is told to stop narrating it — the single most common cause of a
 * widget being read aloud twice.
 */
function defaultWidgetText(name: string) {
	return `The ${name} widget is now rendered for the user. It displays all the detail itself — do NOT list or repeat its contents in text. Acknowledge it in one short sentence, then wait for the user to interact with it.`;
}

function widgetError(name: string, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[waniwani] widget "${name}" failed to load:`, error);
	return {
		isError: true as const,
		content: [
			{
				type: "text" as const,
				text: `The ${name} widget could not load its data (${message}). Tell the user something went wrong on our side and offer to try again — do not invent the data.`,
			},
		],
	};
}

function registerDocsTool(server: McpServer, docs: DocEntry[]) {
	const corpus = docs.map((doc) => ({
		...doc,
		haystack: `${doc.title}\n${doc.body}`.toLowerCase(),
	}));

	server.registerTool(
		{
			name: "search_docs",
			title: "Search the documentation",
			description:
				"Search this product's documentation and answer general questions — pricing, eligibility, policies, how things work. Always search before answering, and answer only from what comes back. Never invent facts that are not in the results.",
			inputSchema: { question: z.string().describe("The user's question, in their own words.") },
			outputSchema: {
				results: z.array(z.object({ slug: z.string(), title: z.string(), body: z.string() })),
			},
			annotations: annotations("Search the documentation", undefined, { readOnly: true }),
		},
		async ({ question }) => {
			const terms = question
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((term) => term.length > 2);

			const results = corpus
				.map((doc) => ({
					doc,
					score: terms.reduce((sum, term) => sum + (doc.haystack.includes(term) ? 1 : 0), 0),
				}))
				.filter(({ score }) => score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, 3)
				.map(({ doc }) => ({ slug: doc.slug, title: doc.title, body: doc.body }));

			if (results.length === 0) {
				const text = "Nothing in the documentation covers that question.";
				return { structuredContent: { results: [] }, content: [{ type: "text" as const, text }] };
			}

			return {
				structuredContent: { results },
				content: [
					{
						type: "text" as const,
						text: results.map((r) => `## ${r.title}\n${r.body}`).join("\n\n---\n\n"),
					},
				],
			};
		},
	);
}

/**
 * Register an app's tools, widgets, flows, and docs onto a server the template
 * built.
 *
 * The template owns construction, its own tools, `withWaniwani`, and `run()`.
 * This adds to that server rather than replacing it, so a tool the template
 * ships reaches every app built on it — one publish, not thirty edits — and an
 * app's own tools sit alongside it.
 */
export async function registerApp(server: McpServer, manifest: Manifest): Promise<McpServer> {
	const { tools, widgets, flows, docs } = manifest;

	// Widgets: one `data` schema drives the input schema, the structured output,
	// and the type the component receives.
	//
	// A widget is a tool with a view attached. The view's component name is the
	// widget's folder name, which is also the name of the entry the generator
	// writes into `src/views/` — one name, from the filesystem, so a widget
	// cannot be registered against a component that was never bundled.
	for (const { name, def } of widgets) {
		server.registerTool(
			{
				name,
				title: def.title,
				description: def.description,
				inputSchema: def.data,
				outputSchema: def.data,
				annotations: annotations(def.title, def.hints, { readOnly: true }),
				view: {
					component: name as ViewName,
					description: def.description,
					csp: def.csp,
				},
			},
			async (input) => {
				try {
					const data = (def.load ? await def.load(input as never) : input) as Record<
						string,
						unknown
					>;
					return {
						structuredContent: data,
						content: [
							{
								type: "text" as const,
								text: def.llmText?.(data as never) ?? defaultWidgetText(name),
							},
						],
					};
				} catch (error) {
					return widgetError(name, error);
				}
			},
		);
	}

	for (const { name, def } of tools) {
		server.registerTool(
			{
				name,
				title: def.title,
				description: def.description,
				inputSchema: def.input ?? {},
				outputSchema: def.output,
				annotations: annotations(def.title, def.hints, { readOnly: false }),
			},
			async (input) => {
				try {
					return toolResult(await def.run(input as never));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`[waniwani] tool "${name}" failed:`, error);
					return {
						isError: true as const,
						content: [
							{
								type: "text" as const,
								text: `The ${name} tool failed (${message}). Tell the user it did not work and offer to retry — do not invent a result.`,
							},
						],
					};
				}
			},
		);
	}

	// Flows arrive from the SDK shaped for the MCP SDK's `(name, config, handler)`
	// call, which the framework replaced with a single config carrying the name.
	for (const flow of flows) {
		server.registerTool({ ...flow.config, name: flow.name }, flow.handler);
	}

	if (docs.length > 0) {
		registerDocsTool(server, docs);
	}

	// `withWaniwani` is deliberately not called here. It wraps every registered
	// handler in place, so it has to run after the last registration — which is
	// the template's, not this function's. `src/server.ts` calls it.
	return server;
}
