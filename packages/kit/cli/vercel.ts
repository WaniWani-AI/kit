/**
 * The Vercel boundary.
 *
 * Vercel adopts a build's output when it finds a Build Output API tree at
 * `.vercel/output` in the project's root directory, and nowhere else. The
 * framework emits that tree inside the generated project, which is gitignored
 * and absent from a clone, so the last thing a build does is move it up to the
 * app root — the one path Vercel reads.
 *
 * That move is what removes the need for a `vercel.json` in an app repo. With
 * the tree where Vercel looks for it, a git-connected project needs no deploy
 * config at all: the `Other` preset runs the `build` script from `package.json`,
 * which is `waniwani build`, and the output is adopted as built. Every decision
 * a deploy config would carry is taken here instead, once, for every app on
 * this kit.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** One entry of the Build Output API's routing table. */
interface OutputRoute {
	src?: string;
	dest?: string;
	handle?: string;
}

interface OutputConfig {
	routes?: OutputRoute[];
}

/** Where the framework writes its tree, and where Vercel reads one. */
const OUTPUT = join(".vercel", "output");

/**
 * Every request under `/api` reaches the server this kit built.
 *
 * Vercel reserves a root `api/` directory and compiles every file under one
 * into a serverless function of its own, which for an app folder means one
 * broken function per endpoint — `defineEndpoint({ ... })` is an object, not a
 * Vercel handler — sitting in the filesystem layer ahead of the server that
 * actually serves them. The reservation cannot be waived: the file list is read
 * before the build command runs, so a build that deletes the directory fails
 * with `File not found`, and `outputDirectory` does not suppress the builder.
 *
 * What it can be beaten by is precedence. This route goes in ahead of the
 * `filesystem` handler, which is where those functions sit, so `/api/*` never
 * reaches them.
 *
 * `/.well-known/*` gets no companion route, and needs none. Vercel reserves
 * nothing under it, the build writes no static file there, so the filesystem
 * phase misses and the catch-all below it — the one the framework already emits
 * — carries the request to the same function. A route here would say what is
 * already true.
 */
const API_ROUTE = "/api(/.*)?";

/**
 * Move the framework's Build Output tree from the generated project up to the
 * app root, and route `/api/*` at the server on the way.
 *
 * @returns the directory Vercel will read, or null when the build emitted no tree
 */
export function stageBuildOutput(generatedDir: string, appRoot: string): string | null {
	const from = join(generatedDir, OUTPUT);
	if (!existsSync(from)) return null;

	const to = join(appRoot, OUTPUT);
	if (from !== to) {
		// `.vercel/` also holds the CLI's project link, so only the output half is
		// cleared. Rename over a copy: same filesystem, and it leaves nothing
		// behind to fall out of date.
		rmSync(to, { recursive: true, force: true });
		mkdirSync(dirname(to), { recursive: true });
		try {
			renameSync(from, to);
		} catch {
			cpSync(from, to, { recursive: true });
			rmSync(from, { recursive: true, force: true });
		}
		// The framework recreates its own `.vercel/` on every build, so what the
		// move leaves behind is an empty directory that means nothing.
		rmSync(dirname(from), { recursive: true, force: true });
	}

	routeApiAtTheServer(to);
	return to;
}

/**
 * Insert the `/api` route ahead of the filesystem handler in the tree's own
 * routing table.
 *
 * The destination is read from the config rather than named here: the framework
 * decides what its function is called, and a route pointing at a name it has
 * since changed would black-hole every request.
 */
function routeApiAtTheServer(outputDir: string): void {
	const file = join(outputDir, "config.json");
	if (!existsSync(file)) return;

	let config: OutputConfig;
	try {
		config = JSON.parse(readFileSync(file, "utf-8")) as OutputConfig;
	} catch {
		return;
	}
	const routes = config.routes;
	if (!Array.isArray(routes)) return;
	if (routes.some((route) => route.src === API_ROUTE)) return;

	const filesystem = routes.findIndex((route) => route.handle === "filesystem");
	if (filesystem === -1) return;

	// The catch-all below the filesystem handler is the server. Anything under
	// `/api` that the app did not build is already going there.
	const server = routes.slice(filesystem).find((route) => route.dest && !route.handle);
	if (!server?.dest) return;

	routes.splice(filesystem, 0, { src: API_ROUTE, dest: server.dest });
	writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
