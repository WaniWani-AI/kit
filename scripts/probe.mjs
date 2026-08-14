#!/usr/bin/env node
/**
 * Poke a running MCP server: initialize, list the tools, call one, and read a
 * widget resource. Checks a build end to end without a chat client.
 *
 *   node scripts/probe.mjs http://localhost:3000/mcp
 */

const url = process.argv[2] ?? "http://localhost:3000/mcp";
let sessionId;

async function rpc(method, params) {
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
	});

	const header = response.headers.get("mcp-session-id");
	if (header) sessionId = header;

	const body = await response.text();

	// Streamable HTTP lets the server answer either way, and it does: a plain
	// JSON body, or one wrapped in an SSE `data:` frame.
	const frame = body.split("\n").find((line) => line.startsWith("data: "));
	const raw = frame ? frame.slice(6) : body.trim();
	if (!raw) return null;

	const payload = JSON.parse(raw);
	if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
	return payload.result;
}

const init = await rpc("initialize", {
	protocolVersion: "2025-06-18",
	capabilities: {},
	clientInfo: { name: "probe", version: "1" },
});
console.log(`server   ${init.serverInfo.name} ${init.serverInfo.version}`);

const { tools } = await rpc("tools/list", {});
console.log(`\ntools    ${tools.length}`);
for (const tool of tools) {
	const view = tool._meta?.["openai/outputTemplate"] ?? tool._meta?.["ui/resourceUri"];
	console.log(`  ${tool.name.padEnd(20)} ${view ? `→ ${view}` : ""}`);
}

const { resources } = await rpc("resources/list", {});
console.log(`\nwidgets  ${resources.length}`);
for (const resource of resources) {
	console.log(`  ${resource.name.padEnd(20)} ${resource.uri}`);
}

console.log("\ncall     check-eligibility { amount: 249.9 }");
const eligibility = await rpc("tools/call", {
	name: "check-eligibility",
	arguments: { amount: 249.9, country: "FR" },
});
console.log(JSON.stringify(eligibility.structuredContent, null, 2));

console.log("\ncall     select-plan");
const widget = await rpc("tools/call", {
	name: "select-plan",
	arguments: {
		amount: 249.9,
		merchant: "Boulanger",
		plans: eligibility.structuredContent.plans.map((plan) => ({
			...plan,
			label: `${plan.instalments}×`,
			tagline: plan.fee === 0 ? "Interest free" : "Small fee",
		})),
	},
});
console.log(`  outputTemplate ${widget._meta?.["openai/outputTemplate"] ?? "(none)"}`);
console.log(`  structured     ${Object.keys(widget.structuredContent ?? {}).join(", ")}`);
console.log(`  text           ${widget.content[0].text.split("\n")[0]}`);

console.log("\ncall     split_payment (flow)");
const flow = await rpc("tools/call", {
	name: "split_payment",
	arguments: { action: "start" },
});
console.log(`  ${flow.content[0].text.split("\n").slice(0, 3).join("\n  ")}`);

const html = await rpc("resources/read", { uri: resources[0].uri });
console.log(`\nresource ${resources[0].uri}`);
console.log(`  ${html.contents[0].text.length} bytes of HTML`);
