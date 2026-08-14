/**
 * The Waniwani MCP authoring API.
 *
 * This is everything an app author imports. There is no server bootstrap, no
 * transport, no MCP wiring, no build config in an app repo — the runtime owns
 * all of it (see `./server.ts`) and the CLI generates the glue (see `../cli/`).
 *
 * An app is a folder:
 *
 *   waniwani.config.ts          defineApp({ ... })
 *   tools/<name>.ts             export default defineTool({ ... })
 *   widgets/<name>/widget.ts    export default defineWidget({ ... })
 *   widgets/<name>/ui.tsx       export default function Component() { ... }
 *   flows/<name>.ts             export default createFlow({ ... }).compile()
 *   api/<path>.ts               export default defineEndpoint({ ... })
 */

import type { RequestHandler } from "express";
import type { z } from "zod";

/** A Zod object shape — `{ name: z.string() }`, not `z.object({ ... })`. */
export type Shape = z.ZodRawShape;

/** The TypeScript type a `Shape` describes. */
export type Infer<S extends Shape> = z.infer<z.ZodObject<S>>;

/**
 * Behavioural hints handed to the host LLM. The runtime translates these into
 * MCP `annotations` and always fills in the `title` that Claude's Connectors
 * Directory requires, so an app repo cannot get that wrong.
 */
export type ToolHints = {
	/** The tool only reads. Defaults to `true` for widgets, `false` for tools. */
	readOnly?: boolean;
	/** The tool can destroy data. */
	destructive?: boolean;
	/** The tool reaches out to the open internet. */
	openWorld?: boolean;
	/** Calling twice with the same input has the same effect as calling once. */
	idempotent?: boolean;
};

// ---------------------------------------------------------------- app config

export type AppConfig = {
	/** MCP server name, e.g. `oney-split-payment`. */
	name: string;
	/** Shown to humans in connector UIs. */
	title?: string;
	/** Defaults to the app `package.json` version. */
	version?: string;
	/**
	 * Server-level instructions handed to the host LLM once, before any tool
	 * call. Tone, guardrails, what this app is for.
	 */
	instructions?: string;
};

export function defineApp(config: AppConfig): AppConfig {
	return config;
}

// ---------------------------------------------------------------------- tools

/**
 * What a tool handler may return. A string becomes the model-facing text; an
 * object becomes `structuredContent` plus a JSON text fallback. Returning a
 * full MCP `CallToolResult` is still allowed for the rare tool that needs it.
 */
export type ToolResult =
	| string
	| Record<string, unknown>
	| { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> };

export type ToolDefinition<S extends Shape = Shape, R extends ToolResult = ToolResult> = {
	title: string;
	/** LLM-facing. When to call this, and what it does. */
	description: string;
	input?: S;
	output?: Shape;
	hints?: ToolHints;
	run: (input: Infer<S>) => R | Promise<R>;
};

export function defineTool<S extends Shape, R extends ToolResult>(
	def: ToolDefinition<S, R>,
): ToolDefinition<S, R> {
	return def;
}

// -------------------------------------------------------------------- widgets

export type WidgetCsp = {
	/** Domains the widget may `fetch()`. */
	connectDomains?: string[];
	/** Domains the widget may load images/fonts/scripts from. */
	resourceDomains?: string[];
};

/**
 * A widget contract. This file is imported by *both* the server and the
 * browser bundle, so it must stay free of React and CSS — the component lives
 * next to it in `ui.tsx`.
 *
 * `data` is the single schema for the widget: it is the tool's input schema,
 * its output schema, and the type `useWidget()` hands the component. One
 * schema, so server and UI cannot drift.
 */
export type WidgetDefinition<S extends Shape = Shape> = {
	title: string;
	/** LLM-facing. When to show this widget, and how to frame it. */
	description: string;
	data: S;
	hints?: ToolHints;
	csp?: WidgetCsp;
	/**
	 * Text handed to the model alongside the rendered widget. Use it to tell
	 * the model what NOT to repeat, and what to wait for.
	 */
	llmText?: (data: Infer<S>) => string;
	/**
	 * Optional server-side loader, for widgets whose data comes from an API
	 * rather than from the model. Defaults to echoing the input through.
	 */
	load?: (input: Infer<S>) => Infer<S> | Promise<Infer<S>>;
};

export function defineWidget<S extends Shape>(def: WidgetDefinition<S>): WidgetDefinition<S> {
	return def;
}

// ------------------------------------------------------------------ endpoints

/**
 * HTTP methods an endpoint can be restricted to. `undefined` accepts every
 * method, which is what an Express `use()` mount does.
 */
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

/**
 * A plain HTTP endpoint served by the same server as the MCP tools.
 *
 * This exists for the browser, not for the model. A widget runs in a
 * cross-origin iframe and can `fetch()` its own server at
 * `window.skybridge.serverUrl` — for a booking, a price lookup, a webhook
 * receiver — and the model never sees the call. Anything the *model* should be
 * able to reach belongs in `tools/`, not here.
 *
 * The path comes from the file's location, `/api` prefix included:
 * `api/cal/slots.ts` is served at `/api/cal/slots`.
 */
export type EndpointDefinition = {
	/**
	 * Restrict the endpoint to these methods, answering anything else with 405.
	 * Defaults to accepting every method.
	 */
	method?: HttpMethod | HttpMethod[];
	/**
	 * Answer cross-origin requests, preflight included. On by default: a widget
	 * is served from a different origin than the server it calls, so an endpoint
	 * without CORS is one the widget cannot reach.
	 */
	cors?: boolean;
	/**
	 * Parse a JSON request body into `req.body`. On by default — the framework
	 * installs no body parser of its own, so an endpoint without this reads
	 * `req.body` as `undefined`.
	 */
	json?: boolean;
	/** An Express handler. Throwing is safe: the runtime answers 500 and logs. */
	handler: RequestHandler;
};

export function defineEndpoint(def: EndpointDefinition): EndpointDefinition {
	return def;
}
