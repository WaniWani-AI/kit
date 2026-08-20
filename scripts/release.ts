#!/usr/bin/env bun
/**
 * Bump `@waniwani/kit`, commit, tag, push. The tag is what releases: pushing
 * `v*` starts `.github/workflows/release.yml`, which builds and publishes.
 *
 *   bun scripts/release.ts patch|minor|major|beta|alpha
 *
 * A script rather than the SDK's one-line `npm version && git push
 * --follow-tags`, because that line quietly does nothing here. `npm version`
 * writes a commit and a tag only when it runs at the root of the git
 * repository, and the package it would tag lives in `packages/kit`. Run there,
 * it bumps the manifest and stops — no commit, no tag, so `git push
 * --follow-tags` pushes nothing and no release ever starts. The bump has to be
 * asked for without git (`--no-git-tag-version`) and the commit and tag made
 * here, from the root.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = join(REPO_ROOT, "packages/kit");
const MANIFEST = join(PACKAGE_DIR, "package.json");
const RELEASE_BRANCH = "main";

const BUMPS = ["patch", "minor", "major", "beta", "alpha"];

const capture = (command: string, args: string[], cwd = REPO_ROOT): string =>
	execFileSync(command, args, { cwd, encoding: "utf-8" }).trim();

// The commands here fail for ordinary reasons — a branch with no upstream, a
// rejected push — and each already says so on stderr in its own words. A node
// stack trace on top of that buries the sentence that matters.
const run = (command: string, args: string[], cwd = REPO_ROOT): void => {
	try {
		execFileSync(command, args, { cwd, stdio: "inherit" });
	} catch (error) {
		process.exit((error as { status?: number }).status ?? 1);
	}
};

const fail: (message: string) => never = (message) => {
	console.error(`release: ${message}`);
	process.exit(1);
};

const bump = process.argv[2] as string | undefined;
if (!bump || !BUMPS.includes(bump))
	fail(`expected one of ${BUMPS.join(", ")}, got ${bump ?? "nothing"}`);

// Tracked changes are the one failure worth catching early: the commit below
// takes only the manifest, so anything else in flight would be left out of the
// tag it ends up shipping under. Untracked files are exempt — they cannot be
// swept in either way, and a scratch file is no reason to block a release.
if (capture("git", ["status", "--porcelain", "--untracked-files=no"])) {
	fail("tracked changes in the working tree — commit or stash first");
}

const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== RELEASE_BRANCH && !process.env.RELEASE_ANY_BRANCH) {
	fail(`on ${branch}, not ${RELEASE_BRANCH} — set RELEASE_ANY_BRANCH=1 to release anyway`);
}

const versionArgs =
	bump === "beta" || bump === "alpha"
		? ["version", "prerelease", "--preid", bump]
		: ["version", bump];

// `--no-workspaces` because npm looks past the package it was pointed at:
// finding a workspace root above `packages/kit`, it resolves the whole tree,
// reaches `examples/oney` and dies on the `workspace:*` range bun wrote there
// (EUNSUPPORTEDPROTOCOL). Nothing about bumping one manifest needs the tree.
// `--no-git-tag-version` because the commit and tag are made below — npm makes
// neither from a subdirectory anyway.
run("npm", [...versionArgs, "--no-git-tag-version", "--no-workspaces"], PACKAGE_DIR);

const version = (JSON.parse(readFileSync(MANIFEST, "utf-8")) as { version: string }).version;
const tag = `v${version}`;

// Only the manifest. `bun.lock` records this version too, but a stale entry
// there costs nothing — `bun install --frozen-lockfile` accepts it — and
// refreshing the lock in a release commit would sweep in whatever unrelated
// dependency drift had accumulated since the last install.
run("git", ["commit", "-m", tag, MANIFEST]);

// Annotated (`-a`), which is not a matter of taste: `--follow-tags` pushes
// annotated tags and silently ignores lightweight ones. A lightweight tag here
// leaves the release tag sitting on this machine, the push reporting success,
// and no workflow run to show for it.
run("git", ["tag", "-a", tag, "-m", tag]);
run("git", ["push", "--follow-tags"]);

console.log(`\nreleased ${tag} — https://github.com/WaniWani-AI/kit/actions/workflows/release.yml`);
