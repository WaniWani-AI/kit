/**
 * The generated tree's lockfile, so `docker build .waniwani` installs one tree.
 * bun writes it whatever the app installs with: the template's `Dockerfile` is
 * `FROM oven/bun:1` and copies `package.json bun.lock*`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export const LOCKFILES = [
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
];

const LOCKFILE = "bun.lock";
const LOCKFILE_ONLY = ["install", "--lockfile-only"];

export type LockResult = { locked: true; file: string } | { locked: false; reason: string };

/** `--frozen-lockfile` in that Dockerfile fails on a drifted lockfile; an absent one builds. */
export function clearLockfiles(dir: string): void {
	for (const name of LOCKFILES) {
		rmSync(join(dir, name), { force: true });
	}
}

export function lockDependencies(outDir: string): LockResult {
	const command = `\`bun ${LOCKFILE_ONLY.join(" ")}\``;
	const result = spawnSync("bun", LOCKFILE_ONLY, {
		cwd: outDir,
		stdio: "ignore",
		// Installed through npm, bun is a .cmd shim on Windows, which execvp cannot run.
		shell: process.platform === "win32",
	});

	const error = result.error as NodeJS.ErrnoException | undefined;
	const failed =
		error?.code === "ENOENT"
			? "bun is not on PATH"
			: (error?.message ??
				(result.status === 0 ? undefined : `${command} exited ${result.status}`));

	if (failed || !existsSync(join(outDir, LOCKFILE))) {
		clearLockfiles(outDir);
		return { locked: false, reason: failed ?? `${command} wrote no ${LOCKFILE}` };
	}
	return { locked: true, file: LOCKFILE };
}
