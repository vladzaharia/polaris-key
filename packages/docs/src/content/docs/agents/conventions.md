---
title: "Conventions and drift gates"
description: "The green gate and the hard rules, distilled — plus the seven drift gates, what each catches, and the command that runs it."
sidebar:
  order: 3
---

The source for everything on this page is **`AGENTS.md` at the repository root**. This is the
distilled version, for reading; that is the authoritative version, for obeying. When they
disagree, `AGENTS.md` wins.

## Node 22, always

The worker suite drives D1 through the native `better-sqlite3`, which does not build on a newer
Node major. When it fails, the whole worker package fails to **collect** rather than failing a
test — so the breakage looks unrelated to whatever you changed. If your default Node is newer,
prefix every command:

```sh
mise exec node@22 -- pnpm test
```

## The green gate

What CI runs, plus `pnpm format` (CI skips it because `pnpm lint` already covers the source
files):

```sh
pnpm build
pnpm gen:corpus -- --check
pnpm gen:services -- --check
pnpm gen:constants -- --check
pnpm --filter @polaris-key/cli bundle:action -- --check
pnpm parity:check
pnpm typecheck
pnpm test
pnpm lint
pnpm --filter @polaris-key/admin build
pnpm --filter @polaris-key/worker assemble
pnpm --filter @polaris-key/docs check:links
pnpm --filter @polaris-key/worker typecheck:workerd
pnpm --filter @polaris-key/worker test:workerd
pnpm test:browser
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
sdks/godot/tools/run_tests.sh
pnpm format
```

`pnpm test:all` collapses turbo test + pytest + `swift test` + the Godot runner into one command.
The Godot runner needs an editor (`GODOT_BIN`, or `godot` on `PATH`); CI also runs it from an
exported release template. Two things worth
knowing:

- **`pnpm build` does not typecheck the worker** — esbuild strips types. `pnpm typecheck` is not
  redundant with it. That gap once hid five broken type-only imports.
- **`pnpm test` cannot prove the worker runs in workerd** — Node permits the runtime code
  generation workerd forbids. The `test:workerd` and `typecheck:workerd` pair is the smoke job
  that catches it.

The `.husky/pre-commit` hook runs only `pnpm gen:corpus -- --check`, `pnpm gen:services -- --check`
and `pnpm typecheck`. It is
deliberately lightweight. A green hook is not a green gate.

## The hard rules, in one line each

1. **Never hand-edit the corpus.** `conformance/corpus/v2/` and its Swift and Godot mirrors are
   output.
2. **A wire change bumps `PROTOCOL_VERSION` and regenerates the corpus.** It is currently 4; the
   signed set is license / config / trust / bundle / feed / release, and a release record is
   signed by a CI-held release key, never a product key.
3. **Generated files carry a GENERATED banner.** Regenerate; never hand-edit.
4. **Terminology comes from [the concepts page](/docs/start/concepts/).** And "profile" is
   already taken twice — do not overload it a third time.
5. **Products are data.** If you are about to write a product-specific key into code, stop.
6. **Service boundaries are a test, not a convention.** A service may import `core/`, its own
   directory, declared packages and `node:*` builtins. The only sanctioned cross-service edge is
   `update → release`.
7. **Raw hardware values are hashed on-device and never transmitted.**
8. **The naming is Polaris Key** — `@polaris-key/*`, `pkey`, `.pkey/`, `pkey_`, `pkeyt_`,
   `X-PKey-*`, `key.plrs.im`. The `@plrs` / `polaris-suite` / `.polaris/` states in mid-branch
   history are dead.
9. **A validation rule needs a mutation-table entry.**
10. **A new route needs an OpenAPI entry and a coverage-table row.**
11. **The site is gated; the repo is the agent-readable source.** There is no `llms.txt` — see
    [the section index](/docs/agents/) for why.

## The drift-gate inventory

Seven gates exist because seven things can silently fall out of step. Each one turns "someone forgot"
into a red build.

### 1. Conformance corpus

|             |                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Catches** | A wire-affecting change that was not reflected in the golden vectors, and any hand edit to `conformance/corpus/v2/` (`cases.json`, `gate-matrix.json`, `fingerprint.json`, `stage-matrix.json`, `headers.json`, `config-matrix.json`) or the mirrors at `sdks/swift/Tests/PolarisKeyTests/Resources/v2/` and `sdks/godot/tests/corpus/v2/` |
| **How**     | Regenerates all six files in memory from a fixed keypair and case list, then compares against what is committed — mirrors included; a JSON file in a mirror that the generator does not write fails as a stray                                                                                                                             |
| **Command** | `pnpm gen:corpus -- --check` (drop `--check` to write)                                                                                                                                                                                                                                                                                     |

A red drift job means: regenerate and commit it in the same change. Never weaken a runner to make
a change pass.

### 2. Manifest schema parity

|             |                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Catches** | A validator rule added without a fixture; a published JSON Schema that has drifted from the validator; a schema that claims to catch a rule and does not                                                                                                                                         |
| **How**     | `packages/shared-manifest/test/schema-parity.test.ts` extracts error codes from the validator **source** and requires a mutation-table entry per code. Each entry declares `schema: "rejects"` or `schema: "accepts"`, so validator-only cross-reference rules are documented rather than silent |
| **Command** | `pnpm --filter @polaris-key/manifest test`                                                                                                                                                                                                                                                       |

### 3. Router ↔ OpenAPI route coverage

|             |                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catches** | A new route kind nobody classified; a canonical service route or permanent alias missing from the spec; **and** a spec path with no route behind it — documenting a route that does not exist is drift too |
| **How**     | `packages/worker/test/routeCoverage.test.ts` reads `packages/worker/openapi/polaris-key.v3.yaml` and the router source, and checks all three directions against a pinned service table                     |
| **Command** | `pnpm --filter @polaris-key/worker test routeCoverage`                                                                                                                                                     |

### 4. Docs CSP parity

|             |                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catches** | A stale `packages/worker/src/docsCsp.generated.ts` — someone rebuilt the site and skipped the hash-collection step, leaving a policy that would block (or over-allow) inline script on the live site |
| **How**     | `packages/worker/test/docsCspParity.test.ts` recomputes SHA-256 CSP hashes straight from `packages/docs/dist` and compares them with the committed hash sets                                         |
| **Command** | `pnpm --filter @polaris-key/docs build && pnpm --filter @polaris-key/worker test docsCspParity`                                                                                                      |

Skips cleanly when the docs `dist` does not exist. In CI the docs build runs first, so it is
always live there — but it is **not** live in a fresh clone.

### 5. Generated-reference freshness

|             |                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catches** | A hand edit to any page under `packages/docs/src/content/docs/reference/`, and a source change (a new validation code, migration, or route) that was not regenerated |
| **How**     | `packages/docs/test/generated.test.ts` re-runs every emitter in `scripts/gen-reference.mjs` and byte-compares against the committed page                             |
| **Command** | `pnpm --filter @polaris-key/docs gen:check` (or `gen` to write, then `pnpm --filter @polaris-key/docs test`)                                                         |

The pages are committed on purpose: reviewable diffs, and the site builds without running
generators.

### 6. Docs slugs ↔ console help links

|             |                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catches** | A console help link pointing at a page that stopped existing — and, from the other side, a docs restructure that renamed a page the console still links                                                                                                                                                                                                                                                                                              |
| **How**     | The docs build writes `packages/docs/dist/docs-slugs.json` (every route the worker can serve as a page). `packages/worker/test/docsLinks.test.ts` sweeps the two declaration sources — `packages/admin/src/route.ts` (`NavItem.docs`) and `packages/admin/src/lib/docsLinks.ts` (`DOCS_LINKS`) — and asserts each `/docs/...` path is in that manifest. `packages/admin/test/docsLinks.test.ts` separately pins the console-side resolution contract |
| **Command** | `pnpm --filter @polaris-key/docs build && pnpm --filter @polaris-key/worker test docsLinks`                                                                                                                                                                                                                                                                                                                                                          |

Also skips cleanly when the slug manifest is absent.

### 7. Console CSP parity

|             |                                                                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catches** | An inline script in the console or portal shell (`packages/admin/index.html`, `manage.html`) that the SPA CSP does not allow, or an allowance left behind after the script changed. Today there is one inline script, the pre-paint theme script                                                               |
| **How**     | `packages/worker/src/adminCsp.ts` lists the scripts' SHA-256 hashes for `appSecurityHeaders`. `packages/admin/test/theme.test.tsx` hashes the script in both HTML sources and requires it to be listed; `packages/worker/test/adminCspParity.test.ts` sweeps the built shells and requires the set to be equal |
| **Command** | `pnpm --filter @polaris-key/admin test theme`, then `pnpm --filter @polaris-key/admin build && pnpm --filter @polaris-key/worker test adminCspParity`                                                                                                                                                          |

The worker half skips cleanly when the admin `dist` is absent; the admin half always runs.

## Two structural gates that are not about drift

Worth knowing because they fail for reasons that look mysterious:

- **Service boundaries** — `packages/worker/test/boundaries.test.ts` walks every file under
  `src/services/` and refuses cross-service imports and reach-backs into legacy top-level
  modules. It is a test rather than a lint rule because this repo has no ESLint toolchain —
  `pnpm lint` is Prettier — and a test runs on the gate that already covers every commit, needs
  no new dependencies, and can explain _why_ in its failure message.
- **Docs gate** — `/docs` is served by the worker behind the platform-admin session
  (`packages/worker/src/docs.ts`); `docsGate.test.ts` pins that. An unauthenticated request gets
  the login page, not the docs.

## Writing docs pages

- Quote frontmatter values: `title: "…"`, `description: "…"`.
- Never leave a bare brace in MDX prose — MDX evaluates it as JSX. Inside backticked code spans
  braces are literal and need no escaping.
- Internal links are absolute and end in a slash: `/docs/services/config/catalog/`.
- Renaming a page means updating `route.ts` and `docsLinks.ts` in the same change, or gate 6
  fails.
