/**
 * The WaniWani account boundary.
 *
 * `tunnel` is the one command in this CLI that talks to app.waniwani.ai, and it
 * needs two facts: who the developer is, and which agent this repo is bound to.
 * Both already have a home that `@waniwani/cli` writes and `@waniwani/sdk`
 * reads, so this file invents no third place to look:
 *
 *   ~/.config/waniwani/settings.json   credentials and the instance they were
 *                                      issued for. One login per machine, mode
 *                                      0600, honours XDG_CONFIG_HOME.
 *   ./waniwani.json                    orgId, projectId, apiUrl, devPort. The
 *                                      file `waniwani connect` writes, and the
 *                                      one the SDK loads at runtime.
 *
 * `.waniwani/` holds neither of them. In the kit that directory is build output:
 * every command regenerates it, the app's .gitignore covers it, and `eject` says
 * to delete it. A refresh token written there lasts until the next `waniwani
 * dev`. This is the same reasoning that moved the login CLI's own credentials
 * out of it.
 *
 * `WANIWANI_API_KEY` is ignored here on purpose. A kit app usually carries that
 * key for tracking, where it is scoped to the project's production environment,
 * while the tunnel and dev-session routes are about the human at the terminal.
 * Auth is therefore the OAuth token, refreshed in place when it has aged out.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dim } from "./log.mjs";

const DEFAULT_API_URL = "https://app.waniwani.ai";

const CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const SETTINGS_FILE = join(CONFIG_HOME, "waniwani", "settings.json");
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** A token this close to expiry is treated as expired, so a long run doesn't 401 mid-flight. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * The CLI that owns logging in and binding a repo to an agent.
 *
 * Those two flows are an OAuth2 PKCE round trip with a local callback server,
 * and a pair of pickers over the org's agents. Both live in `@waniwani/cli`
 * already, and both write exactly the files above, so this CLI drives it for
 * them instead of carrying a second copy that has to stay in step.
 */
const LOGIN_CLI = "@waniwani/cli";

function readSettings() {
	try {
		return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
	} catch {
		return {};
	}
}

function writeSettings(settings) {
	mkdirSync(dirname(SETTINGS_FILE), { recursive: true, mode: DIR_MODE });
	writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, "\t"));
	chmodSync(SETTINGS_FILE, FILE_MODE);
}

/**
 * The repo's `waniwani.json`, or null when it has never been connected.
 *
 * Only the JSON file counts. An app folder also has a `waniwani.config.ts`, and
 * in the kit that is the app itself (`defineApp`), which has nothing to say
 * about org or agent ids.
 */
export function readProjectConfig(appRoot) {
	const file = join(appRoot, "waniwani.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch (error) {
		throw new Error(`${file} is not valid JSON: ${error.message}`);
	}
}

/** Which instance to talk to, most specific wins. Mirrors the login CLI's order. */
function resolveApiUrl(project) {
	return process.env.WANIWANI_API_URL || project?.apiUrl || readSettings().apiUrl || DEFAULT_API_URL;
}

function isExpired(settings) {
	if (!settings.expiresAt) return true;
	return new Date(settings.expiresAt).getTime() - EXPIRY_SKEW_MS < Date.now();
}

/**
 * Trade the refresh token for a new access token and persist both.
 *
 * `resource` is RFC 8707 and load-bearing: without it the OAuth server issues an
 * opaque token, which then fails JWKS validation on every API call.
 */
async function refreshTokens(apiUrl) {
	const settings = readSettings();
	if (!settings.refreshToken || !settings.clientId) return null;

	const response = await fetch(`${apiUrl}/api/auth/oauth2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: settings.refreshToken,
			client_id: settings.clientId,
			resource: apiUrl,
		}).toString(),
	});
	if (!response.ok) return null;

	const tokens = await response.json();
	writeSettings({
		...settings,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
	});
	return tokens.access_token;
}

/**
 * The stored token when it is usable against `apiUrl`, else null.
 *
 * A token issued for another instance counts as no token at all: the US and EU
 * deployments have separate identities, so carrying one over produces a 401 that
 * reads like a broken account.
 */
async function usableToken(apiUrl) {
	const settings = readSettings();
	if (!settings.accessToken) return null;
	if (settings.apiUrl && settings.apiUrl !== apiUrl) return null;
	if (!isExpired(settings)) return settings.accessToken;
	return refreshTokens(apiUrl);
}

/** The login CLI's entry file when it is installed alongside us, else null. */
function localLoginCli() {
	try {
		return fileURLToPath(import.meta.resolve(LOGIN_CLI));
	} catch {
		return null;
	}
}

/**
 * Hand the terminal to the login CLI for one subcommand.
 *
 * An installed copy is run through `node` by absolute path. Both packages
 * publish a `waniwani` binary, so going through `node_modules/.bin` would leave
 * it to install order which of the two answers.
 */
async function runLoginCli(subcommand) {
	const entry = localLoginCli();
	const [command, args] = entry
		? [process.execPath, [entry, subcommand]]
		: ["npx", ["-y", `${LOGIN_CLI}@latest`, subcommand]];

	console.log(dim(`[waniwani] running ${LOGIN_CLI} ${subcommand}…`));
	const code = await new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("close", (exit) => resolve(exit ?? 1));
		child.on("error", () => resolve(1));
	});
	if (code !== 0) {
		throw new Error(`\`waniwani ${subcommand}\` exited with code ${code}`);
	}
}

/**
 * Resolve the account this repo runs against, filling in whatever is missing.
 *
 * A machine with no credentials gets the login flow, and a repo with no
 * `waniwani.json` gets the connect flow, both in the terminal the user is
 * already sitting in. When they come back the files are on disk and every later
 * run of this command is silent.
 */
export async function connectAccount(appRoot) {
	let project = readProjectConfig(appRoot);
	let apiUrl = resolveApiUrl(project);

	if (!(await usableToken(apiUrl))) {
		await runLoginCli("login");
		project = readProjectConfig(appRoot);
		apiUrl = resolveApiUrl(project);
		if (!(await usableToken(apiUrl))) {
			throw new Error(`no credentials at ${SETTINGS_FILE} after logging in`);
		}
	}

	if (!project?.projectId) {
		await runLoginCli("connect");
		project = readProjectConfig(appRoot);
	}
	if (!project?.projectId) {
		throw new Error(`no projectId in ${join(appRoot, "waniwani.json")}: run \`waniwani connect\` to bind this repo to an agent`);
	}

	return {
		apiUrl,
		projectId: project.projectId,
		devPort: project.devPort,
		playgroundUrl: `${apiUrl}/agents/${project.projectId}/playground?localMode=1`,
	};
}

/**
 * An authenticated client for one instance.
 *
 * Responses come back in the API's `{ success, data, error }` envelope, so the
 * payload is unwrapped here and a failure is raised as an ordinary Error the
 * CLI's top-level handler prints. A 401 buys one refresh and one retry, which
 * covers a token that aged out during a long dev session.
 */
export function createClient(apiUrl) {
	const send = async (method, path, body, retry = true) => {
		const token = await usableToken(apiUrl);
		if (!token) {
			throw new Error("not logged in: run `waniwani login`");
		}

		const response = await fetch(`${apiUrl}${path}`, {
			method,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		if (response.status === 204) return undefined;

		const text = await response.text();
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new Error(`${method} ${path} failed with ${response.status}: ${text.slice(0, 200)}`);
		}

		if (response.ok && !payload.error) return payload.data;

		if (response.status === 401 && retry && (await refreshTokens(apiUrl))) {
			return send(method, path, body, false);
		}

		const error = payload.error;
		const message =
			(typeof error === "object" && error?.message) ||
			payload.message ||
			(typeof error === "string" ? error : null) ||
			`${method} ${path} failed with ${response.status}`;
		throw new Error(message);
	};

	return {
		post: (path, body) => send("POST", path, body),
		patch: (path) => send("PATCH", path),
		delete: (path) => send("DELETE", path),
	};
}
