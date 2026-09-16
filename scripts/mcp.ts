/**
 * A minimal MCP client over Streamable HTTP, for the repo's own scripts.
 *
 * `probe.ts` and `template-contract.ts` both talk JSON-RPC to a served build,
 * and the session header and SSE framing are the same in each. One copy, so a
 * change in how the framework answers is fixed in one place.
 *
 * The responses are typed as `any` on purpose. This asserts on a live server's
 * JSON-RPC payloads, and writing out the MCP result shapes here would be a
 * second, unverified copy of a schema the SDK already owns — one that would go
 * stale silently while the scripts kept passing.
 */

/* biome-ignore-all lint/suspicious/noExplicitAny: live JSON-RPC payloads, see above */

export type Client = {
	/** One JSON-RPC call. The session id from the first answer rides on the rest. */
	rpc: (method: string, params: unknown) => Promise<any>;
	/** The `initialize` handshake, with a client name the server logs. */
	initialize: (name: string) => Promise<any>;
};

export function createClient(url: string): Client {
	let sessionId: string | undefined;

	async function rpc(method: string, params: unknown): Promise<any> {
		const headers: Record<string, string> = {
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

	return {
		rpc,
		initialize: (name) =>
			rpc("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name, version: "1" },
			}),
	};
}
