#!/usr/bin/env node
/**
 * A shim, and a temporary one.
 *
 * The contract itself is `./template-contract.ts`. This file exists because the
 * template repo's own workflow runs `node scripts/template-contract.mjs` against
 * whatever is on this repo's `main` at the time — see `ci/template-contract.yml`,
 * whose source copy lives here. Renaming the script without this would break a
 * workflow in another repo the moment the rename merged, and the failure would
 * land on somebody else's pull request.
 *
 * So the order is: this ships, the template repo's workflow moves to
 * `bun scripts/template-contract.ts`, and then this file is deleted. Nothing
 * else calls it — every workflow and script in this repo already names the
 * TypeScript directly.
 *
 * Bun rather than node because the target is TypeScript and this repo's tooling
 * runs on bun. Every workflow that reaches this script already sets it up.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "template-contract.ts");

const result = spawnSync("bun", [script, ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error) {
	console.error(
		`scripts/template-contract.mjs: could not run bun — ${result.error.message}\n` +
			"this shim delegates to template-contract.ts; add oven-sh/setup-bun to the workflow, " +
			"or call `bun scripts/template-contract.ts` directly.",
	);
	process.exit(1);
}

process.exit(result.status ?? 1);
