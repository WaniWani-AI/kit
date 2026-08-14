/**
 * A public hostname for a dev server on this machine.
 *
 * The MCP endpoint has to be reachable from the internet before anything else
 * can drive it: the WaniWani chat backend runs on Vercel and cannot see
 * `localhost`, and neither can Claude Desktop or ChatGPT. Cloudflare answers
 * that with a named tunnel per agent, provisioned server-side at agent creation,
 * so the hostname is `<slug>.waniwani.dev` and stays that way across runs and is
 * safe to paste into an MCP client's config.
 *
 * The API owns the pairing: it repoints the tunnel's ingress at the port passed
 * to it, then mints a connector token for that one tunnel. This file runs
 * cloudflared against the token and reports when the edge has the connection.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

const TUNNEL_READY_TIMEOUT_MS = 30_000;
const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_POLL_MS = 500;

/**
 * Bind the wildcard, matching how a Node server binds, so a listener already on
 * `::` or `0.0.0.0` reads as a conflict. A check against 127.0.0.1 misses those.
 */
export function isPortAvailable(port) {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => server.close(() => resolve(true)));
		server.listen(port);
	});
}

/** The first free port at or above `start`. */
export async function findAvailablePort(start, attempts = 20) {
	for (let port = start; port < start + attempts; port++) {
		if (await isPortAvailable(port)) return port;
	}
	throw new Error(`no free port between ${start} and ${start + attempts - 1}`);
}

/**
 * Wait until something answers on `url`.
 *
 * Any response counts, including a 404: the question is whether the dev server
 * has the port, and the tunnel's ingress is pointed at it before it does.
 */
export async function waitForLocalServer(url, timeoutMs = SERVER_READY_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fetch(url);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_MS));
		}
	}
	throw new Error(`the dev server did not answer on ${url} within ${timeoutMs / 1000}s`);
}

/**
 * Resolve the cloudflared wrapper at call time.
 *
 * It is an optional dependency, and its install step fetches a platform binary
 * that a CI image or a container build has no use for. A static import would
 * make the whole CLI fail to load wherever that install was skipped, so the cost
 * lands on the one command that needs it.
 */
async function loadCloudflared() {
	try {
		return await import("cloudflared");
	} catch {
		throw new Error(
			"the tunnel needs the `cloudflared` package, which is not installed.\n" +
				"  It ships as an optional dependency, so an install run with --omit=optional skips it.\n" +
				"  Add it with `npm install cloudflared`.",
		);
	}
}

/** The package ships a wrapper, so the binary itself is fetched on first use. */
async function cloudflaredBinary() {
	const { bin, install } = await loadCloudflared();
	if (!existsSync(bin)) await install(bin);
	return bin;
}

/**
 * Run the agent's named tunnel under a connector token.
 *
 * The token encodes which tunnel to serve and the ingress was set when it was
 * issued, so there is no `--url` to pass. Resolution waits for cloudflared to
 * confirm an edge connection, since anything earlier races traffic against
 * connector readiness.
 */
export async function startNamedTunnel({ hostname, token }) {
	const bin = await cloudflaredBinary();
	const child = spawn(bin, ["tunnel", "--no-autoupdate", "run", "--token", token], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn(value);
		};

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			settle(reject, new Error(`cloudflared did not connect within ${TUNNEL_READY_TIMEOUT_MS / 1000}s`));
		}, TUNNEL_READY_TIMEOUT_MS);

		// cloudflared logs this line on each successful edge handshake, and the
		// first one means the hostname is serving traffic.
		const onOutput = (chunk) => {
			if (chunk.toString().includes("Registered tunnel connection")) {
				settle(resolve, {
					hostname,
					publicUrl: `https://${hostname}`,
					stop: () => {
						if (child.exitCode === null) child.kill("SIGTERM");
					},
				});
			}
		};

		child.stdout?.on("data", onOutput);
		child.stderr?.on("data", onOutput);
		child.once("error", (error) => settle(reject, error));
		child.once("exit", (code) => {
			settle(reject, new Error(`cloudflared exited with code ${code ?? "unknown"} before connecting`));
		});
	});
}
