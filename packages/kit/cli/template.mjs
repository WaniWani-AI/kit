/**
 * Resolve the distribution template.
 *
 * The template is a separate public repo, consumed as-is. Nothing is forked
 * into this package: the generator downloads the repo at a pinned commit,
 * caches it, and copies the plumbing out of it. What ships to customers is the
 * same tree anyone can read on GitHub, clone, and deploy by hand.
 *
 * Sources:
 *   github:OWNER/REPO#REF   a GitHub repo at a branch, tag, or SHA (default)
 *   /path/to/checkout       a local clone, for working on the template itself
 *
 * Override per command with `--template <source>` or `WANIWANI_TEMPLATE`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `beta`, not `main`. The generator is written against the template's current
 * layout — `vite.config.ts`, `src/server.ts`, `src/views/` — and `main` is still
 * the older `server/` + `web/` + `api/` split, which it cannot absorb. When beta
 * merges down, this goes back to a ref on `main` (a tag, ideally — see the
 * README's known gaps).
 */
export const DEFAULT_TEMPLATE = "github:WaniWani-AI/mcp-distribution-template#beta";

const CACHE_ROOT = join(homedir(), ".cache", "waniwani", "templates");

/** `github:owner/repo#ref` -> its parts. */
function parseGithub(source) {
	const match = /^github:([^/]+)\/([^#]+)(?:#(.+))?$/.exec(source);
	if (!match) return null;
	return { owner: match[1], repo: match[2], ref: match[3] ?? "main" };
}

/**
 * Resolve a ref to a commit SHA, so a cache entry is content-addressed and two
 * builds of the same ref cannot silently differ.
 */
async function resolveSha({ owner, repo, ref }) {
	let response;
	try {
		response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}`, {
			headers: { Accept: "application/vnd.github.sha" },
		});
	} catch (cause) {
		// Unreachable network. A cached template is a reasonable answer.
		throw Object.assign(new Error(`cannot reach GitHub: ${cause.message}`), { offline: true });
	}

	// A bad ref is the caller's mistake, not a network problem — falling back
	// to a cached template here would hide the typo.
	if (!response.ok) {
		throw new Error(
			`GitHub returned ${response.status} for ${owner}/${repo}@${ref}` +
				(response.status === 404 ? " — check the repo name and ref, or that it is public" : ""),
		);
	}
	return (await response.text()).trim();
}

async function download({ owner, repo, sha }, destination) {
	const response = await fetch(
		`https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`,
	);
	if (!response.ok) {
		throw new Error(`could not download ${owner}/${repo}@${sha}: ${response.status}`);
	}

	const archive = join(tmpdir(), `waniwani-template-${sha}.tar.gz`);
	writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

	// Extract into a staging directory first, so an interrupted run cannot
	// leave a half-populated cache entry that later builds would trust.
	const staging = `${destination}.partial`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });

	const result = spawnSync("tar", ["-xzf", archive, "-C", staging, "--strip-components=1"]);
	rmSync(archive, { force: true });
	if (result.status !== 0) {
		rmSync(staging, { recursive: true, force: true });
		throw new Error(`could not extract the template archive: ${result.stderr?.toString().trim()}`);
	}

	rmSync(destination, { recursive: true, force: true });
	spawnSync("mv", [staging, destination]);
}

/** The newest cache entry for a repo, used when the network is unavailable. */
function newestCached(owner, repo) {
	if (!existsSync(CACHE_ROOT)) return null;
	const prefix = `${owner}-${repo}-`;
	const entries = readdirSync(CACHE_ROOT)
		.filter((name) => name.startsWith(prefix))
		.map((name) => ({ name, mtime: statSync(join(CACHE_ROOT, name)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	return entries[0] ? join(CACHE_ROOT, entries[0].name) : null;
}

/**
 * @param source `github:owner/repo#ref` or a local path
 * @returns `{ dir, source, ref, sha, cached, local }`
 */
export async function resolveTemplate(source = DEFAULT_TEMPLATE) {
	const github = parseGithub(source);

	if (!github) {
		const dir = resolve(source);
		if (!existsSync(dir)) {
			throw new Error(`template not found: ${dir}`);
		}
		return { dir, source, local: true };
	}

	const { owner, repo, ref } = github;
	mkdirSync(CACHE_ROOT, { recursive: true });

	let sha;
	try {
		sha = await resolveSha(github);
	} catch (error) {
		const fallback = error.offline && newestCached(owner, repo);
		if (!fallback) throw error;
		return {
			dir: fallback,
			source,
			ref,
			sha: fallback.split("-").pop(),
			cached: true,
			offline: true,
		};
	}

	const dir = join(CACHE_ROOT, `${owner}-${repo}-${sha}`);
	const cached = existsSync(dir);
	if (!cached) {
		await download({ owner, repo, sha }, dir);
	}

	return { dir, source, ref, sha, cached };
}

/** One-line description of what a build used, for logs and provenance files. */
export function describeTemplate(template) {
	if (template.local) return `${template.dir} (local)`;
	const state = template.offline ? "offline, cached" : template.cached ? "cached" : "downloaded";
	return `${template.source} @ ${template.sha?.slice(0, 7)} (${state})`;
}
