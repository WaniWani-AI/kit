/**
 * The peer ranges this package declares, and what to do with them.
 *
 * `@waniwani/sdk`, react, react-dom and zod reach an app as peers rather than
 * as this package's own dependencies, so the app holds one copy and this
 * package states only the floor underneath it. Three callers need that floor
 * and each needs it differently: `init.ts` writes an installable range into a
 * new app, `validate.ts` checks the range an existing app already wrote, and
 * `codegen.ts` fills one in when neither the app nor the template declared
 * one. One module so the parsing exists once.
 *
 * Deliberately not a semver dependency. What appears in a real app's manifest
 * is an exact version, a caret, a tilde or a `>=` floor, and comparing those
 * against a floor is the whole job. Anything this cannot parse is reported as
 * unknown rather than guessed at — see `compare`.
 */

import { MANIFEST } from "./manifest.js";

/** A parsed version, with a prerelease tail that sorts below its release. */
interface Version {
	parts: [number, number, number];
	prerelease?: string;
}

/** The versions a dependency spec allows: `high` is exclusive, null unbounded. */
interface Window {
	low: Version;
	high: Version | null;
	exact?: boolean;
}

/** How a dependency spec sits against this package's floor. See `compare`. */
export type Verdict = "ok" | "reachable" | "below" | "prerelease" | "unknown";

/**
 * A peer range this package declares, read back out so it is stated once.
 *
 * Missing throws. A floor that silently defaulted would let every check below
 * pass vacuously, which is worse than the rename that removed it.
 */
export function peerRange(name: string): string {
	const range = MANIFEST.peerDependencies?.[name];
	if (!range) {
		throw new Error(
			`@waniwani/kit declares no peerDependencies.${name}, and its own tooling reads that floor — ` +
				"add it back to packages/kit/package.json, or drop the entry that reads it",
		);
	}
	return range;
}

/**
 * A peer range turned into something an app can depend on.
 *
 * A peer range is a floor, `>=19`, and a floor in an app's dependencies
 * installs the next major on the day it lands. Cap it. Anything already ranged,
 * `^4`, passes through as it is.
 *
 * The prerelease tail is part of the pattern because a floor can carry one, and
 * `>=0.19.9-beta.0` falling through uncapped would put the very floor this
 * exists to cap into a new app's manifest. `^0.19.9-beta.0` keeps the
 * prerelease reachable and still stops at `0.20.0`.
 */
export function installable(name: string): string {
	const range = peerRange(name);
	const floor = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/.exec(range.trim());
	return floor ? `^${floor[1]}.${floor[2] ?? 0}.${floor[3] ?? 0}${floor[4] ?? ""}` : range;
}

/** `1.2.3-beta.0` → `{ parts: [1,2,3], prerelease: "beta.0" }` */
function parseVersion(input: string): Version | null {
	const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(input.trim());
	if (!match) return null;
	return {
		parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
		prerelease: match[4],
	};
}

/** Ordering on major.minor.patch, with a prerelease sorting below its release. */
function order(a: Version, b: Version): -1 | 0 | 1 {
	for (let i = 0; i < 3; i++) {
		if (a.parts[i] !== b.parts[i]) return (a.parts[i] as number) < (b.parts[i] as number) ? -1 : 1;
	}
	if (a.prerelease && !b.prerelease) return -1;
	if (!a.prerelease && b.prerelease) return 1;
	return 0;
}

/**
 * The window a dependency spec opens, as `{ low, high }`, where `high` is
 * exclusive and `null` means unbounded.
 *
 * Caret follows semver's 0.x rule, which is the one that matters for the SDK:
 * `^0.19.5` stops at `0.20.0`, so an SDK minor is a breaking change.
 */
function window(spec: string): Window | null {
	const trimmed = spec.trim();
	if (trimmed === "*" || trimmed === "" || trimmed === "latest") {
		return { low: { parts: [0, 0, 0] }, high: null };
	}

	const ranged = /^(\^|~|>=)\s*(.+)$/.exec(trimmed);
	if (!ranged) {
		const exact = parseVersion(trimmed.replace(/^=\s*/, ""));
		return exact ? { low: exact, high: exact, exact: true } : null;
	}

	const low = parseVersion(ranged[2] as string);
	if (!low) return null;
	if (ranged[1] === ">=") return { low, high: null };

	const [major, minor] = low.parts;
	// `~1.2.3` caps at the next minor. `^1.2.3` caps at the next major, except
	// under 0.x where the minor is the compatibility boundary.
	const high: Version =
		ranged[1] === "~" || major === 0
			? { parts: [major, minor + 1, 0] }
			: { parts: [major + 1, 0, 0] };
	return { low, high };
}

/**
 * How a dependency spec sits against a peer floor.
 *
 * - `"ok"` — every version the spec allows is at or above the floor.
 * - `"reachable"` — the spec allows the floor, and also allows something below
 *   it. A fresh install lands above the floor and a lockfile written earlier
 *   can hold the tree below it, so this is a warning rather than an error.
 * - `"below"` — no version the spec allows reaches the floor. This one cannot
 *   resolve to a working tree.
 * - `"prerelease"` — a prerelease, at or above the floor by number, which npm's
 *   semver rules still exclude from a range carrying no prerelease of its own.
 *   Both npm and bun warn on it, so reporting it as `ok` would have this check
 *   disagreeing with the tool that actually resolves the tree.
 * - `"unknown"` — an expression this module does not parse (a union, a git
 *   URL, `workspace:*`). Reported as-is rather than assumed to be either.
 */
export function compare(spec: string | null | undefined, name: string): Verdict {
	const range = peerRange(name);
	const floorMatch = /^>=\s*(.+)$/.exec(range.trim());
	const floor = parseVersion(floorMatch ? (floorMatch[1] as string) : range.replace(/^[\^~=]\s*/, ""));
	const allowed = spec == null ? null : window(spec);
	if (!floor || !allowed) return "unknown";

	// A prerelease is opt-in under semver: `0.19.9-beta.0` does not satisfy
	// `>=0.19.8`, because the range names no prerelease at that version. The
	// floor carrying one of its own is someone pinning a prerelease on purpose,
	// and then the plain comparison is what they asked for.
	if (allowed.low.prerelease && !floor.prerelease) return "prerelease";
	if (order(allowed.low, floor) >= 0) return "ok";
	if (allowed.high === null || order(allowed.high, floor) > 0) return "reachable";
	return "below";
}

/** The floor itself, for a message that has to name it. */
export function floorOf(name: string): string {
	return peerRange(name);
}

/**
 * The lowest version a spec allows, normalised, or null if unparseable.
 *
 * `scripts/bump-deps.ts` asks the question this answers, and it is the mirror
 * of `compare`: that one checks a spec against this package's floor, while a
 * floor bump needs to know whether the *template's* floor has risen above it.
 */
export function floorVersion(spec: string | null | undefined): string | null {
	const allowed = spec == null ? null : window(spec);
	return allowed?.low ? allowed.low.parts.join(".") : null;
}

/** Ordering on two version strings, for a caller with no window to compare. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return null;
	return order(left, right);
}
