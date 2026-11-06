/**
 * The CSP a widget is registered with. The runtime hands the framework the
 * widget's own declaration and nothing more; the framework adds the server's
 * origin. No stylesheet origin is merged in on the app's behalf.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Manifest, registerApp } from "../src/server.js";

/** The parts of a server `registerApp` touches, recording each tool it registers. */
function stubServer() {
	const tools: Array<{ name: string; view?: { csp?: unknown } }> = [];
	const server = {
		express: { get() {} },
		use() {},
		registerTool(config: { name: string; view?: { csp?: unknown } }) {
			tools.push(config);
		},
	};
	return { tools, server: server as unknown as Parameters<typeof registerApp>[0] };
}

function widget(csp?: { resourceDomains?: string[] }): Manifest["widgets"][number] {
	return {
		name: "hello",
		def: { title: "Hello", description: "Says hello", data: {}, ...(csp && { csp }) },
	} as Manifest["widgets"][number];
}

describe("registerApp", () => {
	test("a widget with no csp is registered with none", async () => {
		const { tools, server } = stubServer();
		await registerApp(server, { tools: [], widgets: [widget()], flows: [], docs: false });
		assert.equal(tools[0]?.view?.csp, undefined);
	});

	test("a widget's own csp is passed through unchanged", async () => {
		const { tools, server } = stubServer();
		const csp = { resourceDomains: ["https://images.example.com"] };
		await registerApp(server, { tools: [], widgets: [widget(csp)], flows: [], docs: false });
		assert.deepEqual(tools[0]?.view?.csp, csp);
	});
});
