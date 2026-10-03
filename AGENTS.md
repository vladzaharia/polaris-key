# AGENTS.md

Instructions for any coding agent working in this repository. Vendor-neutral and canonical:
if a tool-specific file (`CLAUDE.md`, `.opencode/`, …) disagrees with this one, this one wins.
Human-facing prose lives in `CONTRIBUTING.md` and on the docs site; this file is the short,
enforceable version.

Polaris Key is a **contract-first, five-language monorepo**: one Cloudflare Worker plus SDKs for
Node, Python, Swift and React, all agreeing on a single frozen wire format. Everything below
follows from that one fact — **the wire contract is the source of truth, and every language must
verify it identically.**

## Repo map

```
packages/
  shared-protocol/   @polaris-key/protocol     per-service wire types (subpath exports)
  shared-jws/        @polaris-key/jws          frozen EdDSA compact-JWS encode/verify
  shared-catalog/    @polaris-key/catalog      data-driven config catalog + value validation
  shared-manifest/   @polaris-key/manifest     `.pkey/` manifest parsing + validation + schemas
  client-core/       @polaris-key/client-core  isomorphic verify/trust/gate/clock floor
  worker/            @polaris-key/worker       the Cloudflare Worker (core/ + services/<slug>/)
  admin/             @polaris-key/admin        the admin SPA + customer portal (React + Vite)
  cli/               @polaris-key/cli          the `pkey` CLI (manifests, bundle mint, CI publishing)
  sdk-node/          @polaris-key/node         full client + CLI adapters
  sdk-react/         @polaris-key/react        browser-OIDC + desktop-over-node + login UI
  docs/              @polaris-key/docs         the Astro Starlight docs site served at /docs
  brand/             @polaris-key/brand        design system: tokens, Rubik fonts, marks, launch-kit assets
                                               (spec: docs/design/BRAND.md)
sdks/
  python/            polaris-key (PyPI)        full client + CLI adapters
  swift/             PolarisKey (SwiftPM)      native CryptoKit + SwiftUI login
  godot/             Godot addon               pure-GDScript verify and a headless runner
conformance/         corpus/v2 ONLY (one signer's golden vectors) + the Node and browser runners
                     + parity/ (features.json registry, errors.json + enums.json; each SDK
                       keeps its own parity.json)
                     + transcripts/ (HTTP conversations recorded through the Worker router)
tools/               sign-corpus.ts · gen-mirrors.ts · parity-check.ts · gen-transcripts.mjs ·
                     gen-services.ts + services.json · gen-sdk-constants.ts
actions/publish/     the polaris-key/publish GitHub Action (committed dist/ bundle of the CLI)
products/            per-product data (catalog.json + product.json) + gen-seed
docs/                RUNBOOK · DEPLOYMENT · PRIVACY
                     security/ (threat model, wire contract v4, audit + findings)
                     superpowers/ (design specs + implementation plans, historical)
```

**`docs/` is much smaller than it used to be.** Four long-form documents moved into the docs
site and are no longer at their old paths — follow the move rather than recreating them:

| Was                        | Now                                                          | Served at                         |
| -------------------------- | ------------------------------------------------------------ | --------------------------------- |
| `docs/CONCEPTS.md`         | `packages/docs/src/content/docs/start/concepts.md`           | `/docs/start/concepts/`           |
| `docs/ADOPTER-GUIDE.md`    | `packages/docs/src/content/docs/build/onboarding.md`         | `/docs/build/onboarding/`         |
| `docs/CONFIG-AUTHORING.md` | `packages/docs/src/content/docs/build/manifest/authoring.md` | `/docs/build/manifest/authoring/` |
| `products/README.md`       | `packages/docs/src/content/docs/build/registering.md`        | `/docs/build/registering/`        |

`CONTRIBUTING.md` was slimmed to match: setup, the green gate and the pre-commit hook stay in
the repo; the monorepo map, the wave model, the corpus and the release flow now live under
`packages/docs/src/content/docs/contribute/`.

The `pnpm` + `turbo` JS workspace covers `packages/*`, `tools`, `products`, and the Node and
browser conformance runners. Python, Swift and Godot are standalone toolchains under `sdks/`.

Inside the Worker, `src/core/` is the always-on substrate and each `src/services/<slug>/` is one
opt-in service (`license`, `config`, `release`, `distribution`, `update`, `identity`). The services
are declared
once, as rows of `tools/services.json`; `pnpm gen:services` generates every language's slug
constants from it. `src/mount.ts` is the composition root; `src/router.ts` builds
`SERVICE_NAMESPACES` from the generated `SERVICE_SLUGS`. Release, Distribution and Update form a
chain (release ← distribution ← update, coherence codes `distribution_requires_release` and
`update_requires_distribution`); services read one another's state only through Core's
read-only descriptor hooks in `src/core/hooks.ts` (`releaseCatalog`, `delivery`,
`outletCapabilities`), which answer `null` while the providing service is off.

## Toolchain constraint: Node 22

**Use Node 22.** `engines` pins `>=22` and CI runs 22, but the real constraint is sharper: the
worker suite drives D1 through the native `better-sqlite3`, which does not build on a newer Node
major — the whole worker package then fails to _collect_ rather than failing a test, which looks
like an unrelated breakage. If your default Node is newer, prefix every command:

```sh
mise exec node@22 -- pnpm test
```

## The green gate

Run these before proposing a change as done. They are what CI runs
(`.github/workflows/ci.yml`), plus `pnpm format`, which CI does not run because `pnpm lint`
already covers the source files.

```sh
pnpm build                       # build all JS packages (turbo)
pnpm gen:corpus -- --check       # conformance drift gate (must regenerate in place)
pnpm gen:transcripts -- --check  # HTTP-transcript drift gate (re-records through the Worker router)
pnpm gen:services -- --check     # service-table drift gate (tools/services.json → every language)
pnpm gen:constants -- --check    # SDK-constants drift gate (error codes, headers, enums, feature ids)
pnpm gen:brand -- --check        # brand-token drift gate (packages/brand → CSS, Tailwind, TS, JSON, GDScript, Swift)
pnpm --filter @polaris-key/cli bundle:action -- --check  # Action-bundle drift gate (after pnpm build)
pnpm parity:check                # every SDK's parity.json agrees with the feature registry
pnpm typecheck
pnpm test                        # all JS/TS suites (worker, SDKs, admin, conformance, shared)
                                 # except the browser runner below
pnpm lint                        # per-package prettier check
pnpm --filter @polaris-key/admin build
pnpm --filter @polaris-key/worker assemble  # admin + docs built into the worker's [assets] root
pnpm --filter @polaris-key/docs check:links # internal link + anchor integrity on the built site
pnpm --filter @polaris-key/worker test adminCspParity  # console CSP parity (after the admin build):
                                 # the SPA shells' inline-script hashes == packages/worker/src/adminCsp.ts
                                 # (also inside `pnpm test`; the admin half is test/theme.test.tsx)

# The workerd smoke job. Node permits the runtime code generation workerd forbids, so a green
# `pnpm test` cannot prove the Worker runs in the runtime it ships to.
pnpm --filter @polaris-key/worker typecheck:workerd
pnpm --filter @polaris-key/worker test:workerd

# The browser conformance runner (CI jobs browser, browser-firefox, browser-webkit). Root
# `pnpm test` leaves it out because it needs a Playwright browser; install Chromium once with
# `pnpm --filter @polaris-key/conformance-browser exec playwright install chromium`.
pnpm test:browser                # add `-- --browser=firefox` or `-- --browser=webkit`

( cd sdks/python && .venv/bin/python -m pytest -q )   # Python (CPython 3.9 + 3.14 on ubuntu, macOS in CI)
( cd sdks/swift && swift build && swift test )        # Swift
sdks/godot/tools/run_tests.sh    # Godot (GODOT_BIN, optional GODOT_TEMPLATE; CI runs both)

pnpm format                      # prettier check over md/json too (format:fix to apply)
```

`pnpm test:all` runs turbo test + Python pytest + Swift `swift test` + the Godot runner in one
shot. Note that
`pnpm build` does **not** typecheck the worker (esbuild strips types), so `pnpm typecheck` is not
redundant with it — that gap once hid five broken type-only imports.

The committed `.husky/pre-commit` hook runs a lightweight subset (`pnpm gen:corpus -- --check`,
`pnpm gen:services -- --check` and `pnpm typecheck`). A green hook is not a green gate.

## Hard rules

**1. Never hand-edit generated corpus files.** `conformance/corpus/v2/{cases.json,
gate-matrix.json,fingerprint.json,stage-matrix.json,headers.json,config-matrix.json,
update-matrix.json,outlet-matrix.json,plan-matrix.json}`, `conformance/corpus/v2/content/cases.json`
and the generator-owned mirrors at
`sdks/swift/Tests/PolarisKeyTests/Resources/v2/` and `sdks/godot/tests/corpus/v2/` are output
(`content/` is not mirrored: every runner reads it from the checkout).
Regenerate with `pnpm gen:corpus` and commit the result in the same change.
`pnpm gen:corpus -- --check` regenerates in memory and fails on any difference, mirrors included,
and on a stray JSON file in any of them. `conformance/corpus/v2/content/blobs/` is the opposite:
generator **inputs** (the zstd blobs, the `pkey-chunks/1` indexes and bundles, and `refs.json`),
hash-checked against `content/cases.json`'s `blobs` table and never rewritten by a normal or
`--check` run; only the explicit `--rebuild-content-blobs` mode, pinned to zstd 1.5.7, writes them,
and it may only **add** blobs and `refs.json` entries: it throws, writing nothing, if an existing
one would change (plans/P4-10.md decision 15). Changing an existing blob is a PR of its own. Never weaken a runner to make a change "pass". The same
holds for the HTTP transcripts: `conformance/transcripts/*.json` and their mirrors at
`sdks/swift/Tests/PolarisKeyTests/Resources/transcripts/` and `sdks/godot/tests/transcripts/` are
recorded by the Worker's scenario tests (`packages/worker/test/transcripts/`) through
`pnpm gen:transcripts`; a Worker change that alters a recorded response regenerates them in the
same change, and the SDK replayers then show which SDKs must follow.

**2. A wire change bumps `PROTOCOL_VERSION` and regenerates the corpus.** The constant lives in
`packages/shared-protocol/src/core.ts` and is currently **4**; the normative spec is
`docs/security/WIRE-CONTRACT-V4.md`. The signed document set is licence / config / trust /
bundle / feed / release (`pkey-license+jws`, `pkey-config+jws`, `pkey-trust+jws`,
`pkey-bundle+jws`, `pkey-feed+jws`, `pkey-release+jws`). Licence and config documents share one
envelope (`iss` + `aud` + `deviceId` + `issuedAt` / `expiresAt` / `graceUntil`). The trust
manifest and the feed are device-less. A release record is signed by a CI-held release key,
never a product key, and verified only against the keys the app pins. Changing the encoding is
a deliberate, all-languages event: contract → catalog → corpus → SDKs, in that order, and a
feature is not done until all five implementations pass.

**3. Generated files carry a GENERATED banner — regenerate, never hand-edit.** Six families:

| File(s)                                                                                                                                 | Written by                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/worker/src/docsCsp.generated.ts`                                                                                              | the docs build (`scripts/collect-csp-hashes.mjs`)                                                                             |
| `packages/docs/src/content/docs/reference/*.mdx`                                                                                        | `pnpm --filter @polaris-key/docs gen`                                                                                         |
| `*services.generated.ts`, `_services.py`, `ServiceSlug.generated.swift`, `services_generated.gd`                                        | `pnpm gen:services` from `tools/services.json`                                                                                |
| `constants.generated.ts`, `constants_generated.py`, `Constants.generated.swift`, `constants_generated.gd`                               | `pnpm gen:constants` from `conformance/parity/` (errors, enums, features), the service table and `@polaris-key/protocol/core` |
| `actions/publish/dist/index.js`                                                                                                         | `pnpm --filter @polaris-key/cli bundle:action` (esbuild) from `@polaris-key/cli` and the built workspace packages it imports  |
| `packages/brand/{css/tokens.css,css/theme.css,tokens.json,src/generated/*}`, `brand_tokens_generated.gd`, `BrandTokens.generated.swift` | `pnpm gen:brand` from `packages/brand/src/tokens/` and the launch-kit copy in `packages/brand/kit/`                           |

All are committed on purpose (reviewable diffs; the site and packages build without running
generators) and all have a freshness check (`pnpm gen:services -- --check` for the service
table, `pnpm gen:constants -- --check` for the SDK constants, `pnpm gen:brand -- --check` for the
brand tokens, `pnpm --filter @polaris-key/cli bundle:action -- --check` for the Action bundle), so a hand edit fails CI rather than shipping. The
Action bundle inlines `@polaris-key/manifest`, `@polaris-key/catalog` and `@polaris-key/protocol`
from their built `dist/`, so a change to any of them, or to the CLI, rebundles after `pnpm build`. A new error code needs an entry in `conformance/parity/errors.json` first: the
constants generator refuses a Worker code it lacks (and a boot-stage code pinned in
`stage-matrix.json`), and each SDK's registry test refuses an SDK code it lacks. The service table is the one declaration
of the opt-in services; adding one is the checklist at
`packages/docs/src/content/docs/contribute/layout.md` ("Adding a service").

**4. Terminology comes from the concepts page.** `packages/docs/src/content/docs/start/concepts.md`
(served at `/docs/start/concepts/`) is the canonical glossary — the former `docs/CONCEPTS.md`,
moved into the site. Device, not machine. Product, not app. Tier, not plan. When code and the
glossary disagree, the glossary wins; open a PR to reconcile. **"Profile" is already taken twice**
— the reusable managed-payload baseline, and `DocProfile` in the signed payload. Do not overload
it a third time.

**5. Products are DATA. Never add a product-specific key to code.** A product describes itself in
a `.pkey/` directory in its own repo (`schema`, `product`, `release`); the monorepo's
`products/<slug>/` files are the in-repo fixture form. Adding or changing a product must never
require a worker redeploy. If you are about to write `if (product === "djdl")`, stop.

**6. Service boundaries are enforced by a test.** `packages/worker/test/boundaries.test.ts` walks
every file under `src/services/` and refuses anything outside: a service may import `../../core/…`,
its own directory, declared package dependencies, and `node:*` builtins. The **only** sanctioned
cross-service edge is `update → release`. Everything else goes through a core-mediated interface
— for one service reading another's state, the descriptor hooks in `src/core/hooks.ts`.
(It is a test and not a lint rule because this repo has no ESLint — `pnpm lint` is Prettier.)

**7. Raw hardware values are hashed on-device and never transmitted.** A fingerprint is a set of
per-component hashes; the server recomputes the composite `hwid` and never trusts the client's
copy. There is no installed-application enumeration — a probe answers only for product-declared
companion apps. See `docs/PRIVACY.md`.

**8. The naming is Polaris Key.** Packages `@polaris-key/*`, PyPI `polaris-key`, SwiftPM
`PolarisKey`, CLI bin `pkey`, manifest dir `.pkey/`, license keys `pkey_`, device tokens `pkeyt_`,
headers `X-PKey-*`, env `PKEY_CONFIG_*`, issuer `key.plrs.im`. The `@plrs` / `polaris-suite` /
`plrs` / `.polaris/` states that appear in mid-branch history and in
`docs/superpowers/plans/2026-08-26-polaris-suite-services.md` are **dead** — Amendment A1 reverted
the naming layer. Read the spec's closeout, not that plan, for final state.

**9. A validation rule needs a mutation-table entry.** The `.pkey/` manifest validator
(`packages/shared-manifest/src/index.ts`) and the published JSON Schemas
(`packages/shared-manifest/schemas/v1/*.schema.json`) are parity-tested by
`packages/shared-manifest/test/schema-parity.test.ts`. It extracts error codes from the validator
_source_, so adding a rule without a mutation-table entry fails. Each entry declares whether the
schema can express the rule (`schema: "rejects"`) or not (`schema: "accepts"`), which documents
validator-only cross-reference rules explicitly instead of silently.

**10. A new route needs a spec entry.** `packages/worker/openapi/polaris-key.v3.yaml` is
coverage-tested against the router by `packages/worker/test/routeCoverage.test.ts` in three
directions: every `Route` kind is mapped or explicitly narrative-only, every canonical service
route and the four permanent aliases exist with the right methods, and the spec contains no path
outside the expected set (documenting a route that does not exist is drift too). Add a route ⇒
update the spec **and** the `routeCoverage` table.

**11. The docs site is gated; the repo is the agent-readable source.** `key.plrs.im/docs` sits
behind the platform-admin session (`packages/worker/src/docs.ts`) — there is no public docs
origin and no `llms.txt`. An agent reads this file and the repo, not the deployed site.

## Where docs live, and how to build the site

- **`AGENTS.md`** (this file) — canonical repo conventions for agents.
- **`CONTRIBUTING.md`** — setup, the green gate, the pre-commit hook. Everything else it used to
  carry now lives under `packages/docs/src/content/docs/contribute/`.
- **`README.md`** — what the platform is, the frozen wire contract, architecture at a glance.
- **`docs/design/BRAND.md`** — the design-system spec every UI surface follows (marks, colour,
  section accents, theme mechanics, the section bit); `packages/brand` is its implementation.
- **`docs/`** — operator material (`RUNBOOK`, `DEPLOYMENT`, `PRIVACY`), `docs/security/` (threat
  model, wire contract v4, audit + findings), and `docs/superpowers/` (historical specs and
  plans — read the specs' **closeouts**, not the plans, for shipped state).
- **`packages/docs/src/content/docs/`** — the published site: `start/`, `users/`, `services/`,
  `build/`, `admin/`, `agents/`, `reference/`, `contribute/`. Long-form adopter and authoring
  material lives here now, not in `docs/`.

```sh
pnpm --filter @polaris-key/docs dev       # local preview at /docs
pnpm --filter @polaris-key/docs gen       # regenerate the reference/*.mdx pages
pnpm --filter @polaris-key/docs gen:check # fail if any generated page is stale
pnpm --filter @polaris-key/docs build     # astro build + CSP hashes + slug manifest
```

The `build` script does three things in order: `astro build`, then `collect-csp-hashes.mjs`
(writes the worker's `docsCsp.generated.ts`), then `emit-slug-manifest.mjs` (writes
`dist/docs-slugs.json`, which the console's help-link drift gate reads). Skipping the build and
editing either output by hand fails CI.

## Conventions when writing docs pages

- Frontmatter values are **quoted** (`title: "…"`, `description: "…"`).
- Never leave a bare `{` or `}` in MDX prose — MDX evaluates it as JSX. Braces inside backticked
  code spans are literal and need no escape.
- Internal links are absolute and end in a slash: `/docs/services/config/catalog/`.
- Console help links live in exactly two tables (`packages/admin/src/console/nav.ts` and
  `packages/admin/src/lib/docsLinks.ts`) and are gated against the built slug manifest. Renaming
  a page means updating those tables in the same change.
