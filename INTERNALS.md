# Internals

How `@waniwani/kit` is put together, for whoever maintains it. The app author's
view is in [README.md](README.md).

## Why the kit exists

30+ MCP repos each carried their own copy of the runtime: server bootstrap,
framework wiring, Vercel adapter, Express error handling, `tsconfig`, Vite
config, Dockerfile. Fixing one runtime bug meant touching all 30 repos and
reviewing all 30 changes, which is why six or seven known bugs sat unfixed.

With the runtime in a package, a fix costs one publish and one dependency bump.
An app repo receives it without changing a line of its own source.

## Repo layout

```
packages/kit/
├── src/index.ts     defineApp / defineTool / defineWidget / defineEndpoint, the authoring API
├── src/server.ts    registerApp(), the shared runtime and the one place to fix bugs
├── src/web.tsx      useWidget() and the re-exported framework hooks
└── cli/             index · init · template · scan · validate · codegen · framework · env · log
examples/oney/       an example app: 1 widget, 1 tool, 1 flow
scripts/probe.mjs    exercise a running MCP server without a chat client
ci/                  a workflow for the template repo
```

## One CLI does the talking

The generated project runs on [Skybridge](https://www.npmjs.com/package/skybridge),
whose CLI narrates itself: a branded banner on `dev`, `build` and `start`,
pointers at its own hosted tunnel and playground, a support link, and an
analytics event per command. An app author is using `waniwani`, so
[cli/framework.mjs](packages/kit/cli/framework.mjs) holds all of that back at
three seams:

- **`dev`** runs Skybridge's dev command with `--plain`, which swaps its
  interactive UI for one plain line per diagnostic on stderr, then rewrites that
  stream line by line. URLs and TypeScript errors get restated in our format,
  and everything else gets dropped.
- **`build`** loads Skybridge's build steps, which are plain data behind its UI,
  and drives them here while printing progress itself. When that list fails to
  load it shells out to Skybridge's own build command, so a self-narrating build
  still happens.
- **`start`** prints its banner with ordinary `console.log`, so stdout gets
  rewritten the same way as dev's stderr.

What comes out is `waniwani`'s: the wordmark from `waniwani login` over a ramp
derived from the brand accent `#04d916`, then the build check and the endpoints.
The wordmark is the login CLI's art at half height, its six rows of full blocks
folded two-into-one with `▀`/`▄`/`█`, which keeps the letterforms exactly at a
cost of three lines instead of six. Colour is 24-bit where the terminal
announces it and the nearest 256-colour cube entries otherwise, both computed
from the accent, so art and ramp cannot drift. A terminal that is narrow, piped,
in CI, or running `NO_COLOR` gets the wordmark on one line.

Telemetry is off by both switches Skybridge honours, on every subprocess.
Details of the plumbing itself, such as which template resolved, how many files
it copied and which dependencies the runtime overrode, print as diagnostics
under `WANIWANI_DEBUG=1`.

None of this hides Skybridge. It sits in `package.json` like any other
dependency, the generated project names it in its `tsconfig`, and
`waniwani eject` hands over a repo openly built on it. Only prose changes:
module specifiers, the telemetry variable and the patterns that have to match
Skybridge's own strings all stay as they are.

One coupling is worth knowing about. `build` reaches into Skybridge's build-step
module by absolute path, since that module sits outside the package's `exports`
map. Skybridge's `bin` is already coupled the same way, against a version
codegen pins exactly. A shape change there costs the formatting and leaves the
build working.

## Why eject moves the source

Skybridge compiles with `rootDir` pinned to `${configDir}/src` and emits an
entry wrapper next to the output that does a literal
`await import("./server.js")`. Source at the repo root falls outside `rootDir`
and does not compile:

```
src/waniwani.ts(8,35): error TS6059: File '…/tools/check-eligibility.ts' is not
under 'rootDir' '…/src'. 'rootDir' is expected to contain all source files.
```

Widening `rootDir` to `.` compiles, and then `tsc` emits `dist/src/server.js`
where the wrapper cannot find it, giving `ERR_MODULE_NOT_FOUND` at startup. So
the compiled server has to land at `dist/server.js`, which means every input has
to sit under `src/`. Both layouts share `appDir: "src/app"` for that reason,
which also deleted the last of the two-layout branching: one `include`, one
biome scope, and no generated `nodemon.json`, since Skybridge's default watch of
`src` already covers the tree.

## The template stays a separate repo

`WaniWani-AI/mcp-distribution-template` is consumed as-is at build time, at a
pinned commit. Nothing is forked into this package, so what customers deploy is
the same tree anyone can read, clone and deploy by hand.

```
template github:WaniWani-AI/mcp-distribution-template @ d4244f9 (pinned, cached)
```

The default is a commit, not a branch, and that is load-bearing. A published
version of this package is frozen, so what it generates has to be frozen with
it: while the default was `#beta`, the ref was re-resolved on the customer's
machine at every command, which left a push to that branch able to change the
output of every installed copy, and the assertions that catch a layout move
(`REQUIRED` and `assertSeam`) firing in someone else's terminal. A pinned commit
moves that failure into this repo's CI. Bumping it is a one-line diff that
`scripts/bump-deps.mjs` proposes and `scripts/template-contract.mjs` proves.

A ref that is already a 40-character SHA skips the resolve call, so a pinned
build needs GitHub only the first time, for the tarball.

The resolver downloads the repo tarball, caches it by commit SHA under
`~/.cache/waniwani/templates/`, and records what it used in
`.waniwani/.template.json`, alongside the version of this kit that generated the
tree and the versions it pinned while doing it. A dev loop resolves once at
startup and leaves the network alone from then on.

```bash
waniwani build                                          # pinned default
waniwani build --template github:OWNER/REPO#v2.0.0      # a tag or SHA
waniwani build --template ../mcp-distribution-template  # a local clone
WANIWANI_TEMPLATE=... waniwani build                    # or via the environment
```

### What comes from where

| From the template, byte for byte | Generated from the app |
|---|---|
| `vite.config.ts` | `src/waniwani.ts` (registration) |
| `src/server.ts` (the entry, which calls `registerApp`) | `src/views/*.tsx` (view entries) |
| `src/index.css` (Tailwind entry and design tokens) | `src/app/**` (the app's source, copied) |
| `alpic.json` | `vercel.json` (at the app root, once) |
| `Dockerfile`, `.dockerignore`, `.nvmrc` | |
| `package.json` → deps and scripts | |
| `tsconfig.json` → compiler options | |

The template's own registration, example tools and widgets stay behind, since
those are the parts an app replaces. `REQUIRED` is `vite.config.ts`,
`package.json`, `tsconfig.json` and `src/index.css`. The seam the template has
to call is `registerApp` in `src/server.ts`; when that call goes missing the
build still succeeds and the server still starts, serving the template's tools
under the template's name, which is why a missing seam fails the build. The
stylesheet is required for the same reason in a different register: without it
the build stays green and every widget renders with every utility class in its
`ui.tsx` resolving to nothing.

### Failure modes are loud

```
✗ the template at github:WaniWani-AI/mcp-distribution-template#beta has no vite.config.ts
  — its layout moved and the generator needs updating
```

A bad ref gets reported as a bad ref, and the cache stays out of it:

```
✗ GitHub returned 422 for WaniWani-AI/mcp-distribution-template@nope
```

An unreachable network falls back to the newest cached copy, and says so.

### The runtime's overrides are visible

The template's `package.json` is the source of truth for dependencies. The
runtime layers decisions on top and reports every one, which puts the fleet-wide
fix mechanism in the build output:

```
runtime overrides on top of the template
  · skybridge → 1.4.0
    the template's range floats within 1.x; the runtime is built and verified against this one
  · @waniwani/sdk → ^0.19.5
    flows and tracking need the current SDK
  · tsx + ^4.20.6      the dev command shells out to tsx
  · nodemon + ^3.1.10  the dev command imports nodemon
```

**Pinned** packages are forced, at the versions this package declares for
itself: `PINS` reads them back out of `packages/kit/package.json` rather than
restating them, so the version an app is forced onto is the one the generator was
built against by construction. Stating it twice is how `skybridge` came to be
declared at `^1.3.5` here while every app was pinned to `1.4.0`, a disagreement
that stayed invisible because the lockfile happened to resolve the two to the
same tree. Both are exact now, and equal. **Ensured** packages get added only when absent,
so a template shipping a newer `tsx` keeps it. An app that pins a package itself
wins, and the disagreement is flagged. Scripts get the same treatment in both
directions: a `typecheck` script is added when missing, and a script pointing at
files an app does not have (`kb:ingest`, which serves the template's own
example) is dropped, since it would otherwise land in every project as a command
that fails when run.

Every line here concerns the plumbing, so `dev` and `build` print it only under
`WANIWANI_DEBUG=1`. `eject` always prints it in full, because at that point the
plumbing becomes the app's to maintain.

### Fixes the template repo wants

Overrides that exist because of something worth fixing upstream, at which point
the override lines disappear:

- `tsx` and `nodemon` are undeclared dependencies of Skybridge's dev command. It
  spawns `tsx src/server.ts` under nodemon and imports nodemon directly, while
  declaring neither.
- The Skybridge range floats within `1.x`, while the generated code is built
  against one version. Pin it.

### Catching drift where it happens

Every assertion lives in one script,
[scripts/template-contract.mjs](scripts/template-contract.mjs). It builds the
kit, generates and builds the example app against a template, checks the emitted
CSS carries the template's Tailwind utilities, serves the result and calls every
tool, then ejects and builds again with no WaniWani tooling in the tree.

Two triggers run it, and the direction is what differs:

- **`.github/workflows/ci.yml`**, against the commit `cli/template.mjs` pins.
  `bun run build` next to it is `tsc`, which cannot notice that a template's
  layout moved or that the framework changed under a version bump — both only
  surface once the generator has run. This is what makes a bump reviewable.
- **[ci/template-contract.yml](ci/template-contract.yml)**, which lives in the
  template repo, on every pull request into `beta`, against the pull request's
  own template. A layout change that would break the generator fails the
  template's own CI, ahead of any release.

One script rather than two copies of the checks: two copies can drift into
checking different things and both report green, which is the failure this whole
section exists to prevent. Editing the assertions means editing the script, and
the two workflows are a few lines of checkout each.

```bash
bun run contract                                  # against the pinned commit
node scripts/template-contract.mjs --template ../mcp-distribution-template
node scripts/template-contract.mjs --skip-eject   # drops the slow npm install
```

### Bumping the pins

`scripts/bump-deps.mjs` owns the three versions nothing else can. Dependabot
reads `packages/kit/package.json` and cannot see the template commit, which is a
`github:` specifier inside a JavaScript module; and the framework and SDK
versions in that manifest are not ordinary dependency ranges, because
`codegen.mjs` reads them back out and forces them on every generated app. A bump
to any of the three is a generator decision.

```
$ bun run bump
1 pin behind:

  template  d4244f9 → 7bff210
```

`--write` applies it. `.github/workflows/bump-deps.yml` runs that weekly, runs
the contract over the result, and opens one pull request carrying the diff and
the verdict — including when the verdict is red, because "the template has moved
somewhere the generator cannot follow" is the case a maintainer most needs to
see.

## Verified

```
bun run check     ✓ 1 widget, 1 tool, 1 flow
bun run build     ✓ views bundled, server compiled, assets copied
bun run start     ✓ MCP on /mcp
node scripts/probe.mjs http://localhost:PORT/mcp
                  ✓ initialize, tools/list, tools/call, resources/read
```

`api/` was verified against a running server rather than by reading the
generated tree. A `POST` returned its handler's JSON with
`Access-Control-Allow-Origin: *`, the body arrived parsed, a `GET` at the same
path answered 405 with `Allow: POST`, a preflight answered 204 advertising only
`POST`, and a malformed body answered a 400 carrying JSON rather than Express's
HTML page. `api/cal/slots.ts` mounted at `/api/cal/slots`, so the path follows
the file.

The same convention was then verified inside a real app, the WaniWani website
MCP, whose booking widget fetches two of its own endpoints. Live Cal.com slots
came back through `/api/cal/slots` for two timezones with different region
routing, the widget rendered its calendar from them in the framework's
playground with nothing in the console, and `/api/cal/book` rejected a request
with missing fields at 400. That port is also what surfaced the `.env` ordering
problem: the app's flow reads `WANIWANI_API_KEY` at import time, and both
`waniwani check` and `waniwani start` failed on it before the CLI started
loading the file itself.

The emitted stylesheet was read to confirm Tailwind resolves the app's classes
rather than merely running: `text-ink` and `text-ink-muted` compile from the
template's `@theme`, the `dark:` utilities compile against `.dark` rather than
`prefers-color-scheme`, and Inter is imported. `resources/read` returns the
widget CSP with `fonts.googleapis.com` and `fonts.gstatic.com` in
`resourceDomains`. Dropping a `styles.css` into the app folder fails
`waniwani check` at both the root and widget levels.

The generated project was copied outside the workspace, installed with a plain
`npm install`, built and served, so it depends on nothing but published
packages. `.waniwani/` is an ordinary npm project carrying a `vercel.json`,
which is what lets `vercel deploy` inside it work with no special support.

Eject was verified end to end from a real tarball install with bun off the
`PATH`: eject in place, `npm install`, `npm run build`, `npm run start`, and
`tools/list` returning every tool. Also verified with `--out` to a fresh
directory, where a plain `npm install && npm run build` produced the same
Tailwind output as the generated build.

`waniwani init` was verified outside the workspace against the published
package: `init demo` wrote the folder, `npm install` resolved every version it
declares from npm, `waniwani check` passed, and `waniwani build` compiled the
server and bundled the widget. Its versions come from this package's own
manifest, so the scaffold cannot declare a `@waniwani/kit`, `@waniwani/sdk`,
react or zod range the CLI writing it was not built against. Running it a second
time in the same folder exits 1 and names the files it would have overwritten.
In a directory already holding a `package.json`, a `.gitignore` and a
`README.md`, the manifest gained the scripts and dependencies it lacked while
keeping its own `dev` script, the ignore file gained the lines it lacked with
`node_modules` recognised through its missing trailing slash, and the README was
left alone. A `"type": "commonjs"` manifest is warned about and left as it is.

Placement was verified on all four paths through a pty: `init oney` created
`oney/`, `init .` scaffolded in place even with a different name typed at the
prompt, a bare `init` answered with the offered default scaffolded in place, and
a bare `init` answered with a name of its own created `./oney/` under the folder
it was run from.

## Known gaps

App-author-facing gaps are in the README's [Status](README.md#status) section.
These are the ones that concern the kit itself.

- **The SDK is pinned to a prerelease.** `packages/kit/package.json` declares
  `@waniwani/sdk` at `0.19.9-beta.0`, exactly, and so does `examples/oney`. That
  release is what carries the two peer widenings the eject path needs
  ([WAN-888](https://linear.app/waniwani/issue/WAN-888)): `0.19.8` peers
  `@modelcontextprotocol/ext-apps@~1.5.0` while `skybridge@1.4.0` depends on
  `^1.7.4`, and `@modelcontextprotocol/sdk@~1.29.0` while this kit declares
  `^1.29.0`, which resolves to 1.30.0. Bun treats both as optional peers and
  installs; npm refuses with ERESOLVE, one at a time, so fixing the first reveals
  the second.

  This has to become a stable range before the kit is released — a prerelease
  does not satisfy a caret range, so `^0.19.9` would not resolve it and every app
  would silently install `0.19.8` again. `bun run bump` holds a prerelease rather
  than proposing `@latest` over it, and says so, precisely so the pin is not
  mistaken for current.

- **An app's own declaration beats the kit's pin, so a fleet-wide SDK bump does
  not reach a scaffolded app.** `generatePackageJson` gives way to the app when
  the two disagree — it is their repo, and the disagreement is reported — but
  `waniwani init` writes `@waniwani/sdk` into every app it scaffolds
  (`init.mjs`), at whatever the kit declared that day. From then on that app is
  outside the mechanism `PINS` exists to provide: bumping the SDK here changes
  nothing for it. Bumping the SDK to a prerelease is what surfaced this, since
  the example app kept `^0.19.5` and the ejected tree resolved `0.19.8` while the
  kit pinned the beta.

### Found by the contract, on its first run

The eject step is the reason to keep it strict. Three separate breaks were
sitting in a path the README documents, none of them visible from `tsc`:

1. The template's `beta` head did not compile against the generator, and `#beta`
   was the default, so `@waniwani/kit@0.1.5` fails at `waniwani build` with
   nothing changed on the customer's side. Fixed by pinning a commit, and by
   `generateServerApp` now emitting the `search` and `tracking` that the head's
   `src/server.ts` reads.
2. The two SDK peer ranges above.
3. **The ejected tree declared neither `express`, `cors` nor their types.** A
   build reaches those as `@waniwani/kit`'s own dependencies; ejecting drops the
   package and copies `src/` in as source, and nothing put them back. The result
   installed and then failed `tsc` on ten TS7006/TS7016 errors, with express and
   cors present in `node_modules` only as a transitive hoist out of the
   framework. `VENDORED` in `codegen.mjs` now declares them for the eject layout,
   read out of this package's manifest like every other pin.
- **`@waniwani/cli` still owns the `waniwani` bin on npm.** It publishes
  `login`, `logout`, `switch`, `connect` and a `dev` of its own at `0.1.15`. The
  plan is to absorb those commands here and deprecate it. Until then, installing
  both collides.

### Found by porting a real app

The WaniWani website MCP was moved onto the kit from a hand-written Skybridge
repo. These are the gaps that port hit and left standing.

- **A template tool cannot be replaced by an app tool of the same name.** The
  template registers `faq`, and the app arrived with its own `faq`, tuned to the
  product and with its own empty-result copy. Both registered means the MCP SDK
  throws on the duplicate, so the app's version was dropped. Neither
  `defineApp()` nor `registerApp()` offers a way to shadow or disable what the
  template ships.
- **An app cannot configure `withWaniwani`.** The template calls it with no
  options, and `registerApp()` runs before it by design, so the app's
  `flushAfterToolCall: true` and its `toolType` mapping (`faq` to `"support"`,
  `demo_qualification` to `"availability"`) had nowhere to go. The flush matters
  on serverless, where a frozen instance can drop queued events.
- **Flows get no annotations.** The runtime fills in the `title` that Claude's
  Connectors Directory requires for tools and widgets, and a flow is registered
  from the SDK unchanged, so `demo_qualification` reaches `tools/list` with
  `annotations: null`.
- **The build check prints a flow's filename, and the MCP tool takes its name
  from the flow's `id`.** `flows/demo-qualification.ts` compiled with
  `id: "demo_qualification"` prints as `flow demo-qualification` and registers as
  `demo_qualification`. Anyone renaming a flow to change the tool name edits the
  wrong thing.
- **Vercel reserves a root `api/` directory, and the reservation cannot be
  waived.** Every file under one becomes a serverless function of Vercel's own,
  sitting in the filesystem layer ahead of the server the kit built, and
  `defineEndpoint({ ... })` is an object rather than a Vercel handler. Three ways
  out were tried: `outputDirectory` does not suppress the builder, deleting the
  directory inside the build command fails the deployment (`File not found:
  api/cal/book.ts`, so the file list is read before the command runs), and there
  is no documented switch. What works is a legacy `routes` entry, which Vercel
  emits before that layer, so `/api/*` reaches the kit's function and the ones
  Vercel built are unreachable. They are still built and deployed, which costs
  build time and two dead functions per app. The generated `vercel.json` carries
  the entry, so this is handled rather than open, but an app that already had a
  `vercel.json` of its own keeps it and does not get the fix.
- **The emitted Vercel function pins `nodejs22.x`** whatever the project's Node
  version says, because the framework writes `.vc-config.json` and prebuilt
  output outranks the project setting. An app declaring `engines.node >= 24`
  runs on 22 in production without a word.
- **A widget's Storybook stories have no home.** Everything outside the
  convention folders is copied under `src/app/` and compiled, so a
  `.stories.tsx` needs Storybook's types in the generated project and a
  Storybook config the template does not carry. The port dropped its stories and
  its `.storybook/`.
- **`.waniwani/` collides with `@waniwani/cli`.** That CLI keeps its login state
  in `.waniwani/settings.json` inside the app repo, which is the directory the
  build output now owns. A build does not delete the file, but anything that
  clears the output directory takes the tokens with it.

## Publishing

The package is `@waniwani/kit@0.0.1` and is unpublished. What an installed copy
needs, all of which is in place:

- **`dist/` is what resolves.** `exports` points at built JavaScript and `.d.ts`,
  because Node refuses to strip types for files under `node_modules/`, giving
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. A workspace symlink hides this
  completely: the realpath lands outside `node_modules`, type stripping applies,
  and everything works right up until the first real install.
- **`src/` still ships**, as the readable source `waniwani eject` vendors.
- **`tsx`, `typescript` and the `@types` packages are runtime dependencies.**
  Skybridge shells out to `tsc` and `tsx` by bare name and resolves types from
  the app repo's tree, while declaring none of them. An app repo owns no build
  config, so this package is the only thing that can put them there.
- **The CLI runs under `node`.** It registers tsx's resolver before importing
  app modules, because app source uses the `.js` specifiers TypeScript requires
  and Node's type stripping leaves them unremapped.

Verified by packing a tarball, installing it into an empty directory with bun
off the `PATH`, building the example app, and probing the running server:

```
npm pack && npm i ../waniwani-kit-0.0.1.tgz
waniwani build     ✓ views bundled, server compiled, Vercel output emitted
waniwani start     ✓ MCP on /mcp, tools/list returns 200
```
