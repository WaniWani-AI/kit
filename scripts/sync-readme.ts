#!/usr/bin/env bun
/**
 * Copy the repo README into the published package.
 *
 * The root README *is* this package's documentation — it opens with
 * `# @waniwani/kit` and covers the whole surface. npm only ever packs a README
 * sitting next to the manifest, so the npm page would otherwise be blank while
 * the real thing lives one directory up.
 *
 * A copy rather than a second hand-written README: two files describing one
 * package drift, and the one nobody opens is the one on npm. The copy is
 * gitignored and rewritten by every build, so it cannot go stale.
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(REPO_ROOT, "README.md");
const TARGET = join(REPO_ROOT, "packages/kit/README.md");

copyFileSync(SOURCE, TARGET);

// Relative links resolve against the repo on GitHub and against nothing at all
// on npm, where the README is rendered on its own page. Rewriting them to
// absolute GitHub URLs is the difference between a working link and a 404.
const BLOB = "https://github.com/WaniWani-AI/kit/blob/main/";
const readme = readFileSync(TARGET, "utf-8").replace(
	/\]\((?!https?:|#|mailto:)([^)]+)\)/g,
	(_match: string, href: string) => `](${BLOB}${href.replace(/^\.\//, "")})`,
);
writeFileSync(TARGET, readme);
