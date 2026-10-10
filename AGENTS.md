# AGENTS.md

Instructions for any coding agent working in this repository. Vendor-neutral and canonical:
if a tool-specific file (`CLAUDE.md`, `.opencode/`, …) disagrees with this one, this one wins.
Human-facing prose lives in `CONTRIBUTING.md` and on the docs site; this file is the short,
enforceable version.

Polaris Key is a **contract-first, seven-language monorepo**: one Cloudflare Worker plus SDKs for
Node, React, Python, Swift, Godot and Kotlin, all agreeing on a single frozen wire format. Everything below
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
  ui-core/           @polaris-key/ui-core      the JS UI kits' headless layer (no DOM): one view
                                               model per UI-KITS §4.1 component, SignInModel,
                                               theme + ProductIdentity (./theme), the terminal's
                                               views (./terminal); runs every ui-matrix.json row
  worker/            @polaris-key/worker       the Cloudflare Worker (core/ + services/<slug>/)
  admin/             @polaris-key/admin        the admin SPA + customer portal (React + Vite)
  cli/               @polaris-key/cli          the `pkey` CLI (manifests, bundle mint, CI publishing,
                                               `pkey sdk` per-SDK config, `pkey mirror` catalog mirrors;
                                               the mirror renderers live in src/mirrors.ts)
  sdk-node/          @polaris-key/node         full client + CLI adapters
  sdk-react/         @polaris-key/react        browser-OIDC + desktop-over-node + login UI
  docs/              @polaris-key/docs         the Astro Starlight docs site served at /docs
  brand/             @polaris-key/brand        design system: tokens, Rubik fonts, marks, launch-kit assets
                                               (spec: docs/design/BRAND.md)
  ui-qa/             @polaris-key/ui-qa        UI-kit visual QA (private): pnpm ui:lint (the §7.3
                                               modernity lint, string lint, per-kit source lints),
                                               pnpm ui:report (spec: docs/design/UI-KITS.md §7)
sdks/
  python/            polaris-key (PyPI)        full client + CLI adapters
  swift/             PolarisKey (SwiftPM)      native CryptoKit + SwiftUI login
  godot/             Godot addon               pure-GDScript verify and a headless runner
  kotlin/            Gradle build              :core (JVM: verify, cache, sync, stages, devices),
                                               the :license :config :identity :release services,
                                               :update and :packs, the umbrella :sdk + the
                                               :conformance runner; Android: the standalone
                                               :platform backend, the :android glue, the
                                               Compose :ui kit and :godot (the Godot binding,
                                               in sdks/godot/native/android, on :platform only)
conformance/         corpus/v2 ONLY (one signer's golden vectors) + the Node and browser runners
                     + parity/ (features.json registry, errors.json + enums.json; each SDK
                       keeps its own parity.json)
                     + transcripts/ (HTTP conversations recorded through the Worker router)
tools/               sign-corpus.ts (the corpus driver) over corpus/<family>.ts + corpus/reference/ ·
                     gen-mirrors.ts (front end over cli/src/mirrors.ts) · parity-check.ts · gen-transcripts.mjs ·
                     gen-services.ts + services.json · gen-sdk-constants.ts
actions/publish/     the polaris-key/publish GitHub Action (committed dist/ bundle of the CLI)
products/            per-product data (catalog.json + product.json) + gen-seed
docs/                RUNBOOK · DEPLOYMENT · PRIVACY
                     security/ (threat model, wire contract v4, audit + findings)
                     superpowers/ (design specs + implementation plans, historical)
```

**`docs/` is much smaller than it used to be.** Four long-form documents moved into the docs
site and are no longer at their old paths — follow the move rather than recreating them:

| Was                        | Now                                                                | Served at                        |
| -------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| `docs/CONCEPTS.md`         | `packages/docs/src/content/docs/start/concepts.md`                 | `/docs/start/concepts/`          |
| `docs/ADOPTER-GUIDE.md`    | `packages/docs/src/content/docs/start/first-product.md` (appended) | `/docs/start/first-product/`     |
| `docs/CONFIG-AUTHORING.md` | `packages/docs/src/content/docs/build/manifest/product.md`         | `/docs/build/manifest/product/`  |
| `products/README.md`       | `packages/docs/src/content/docs/build/manifest/register.md`        | `/docs/build/manifest/register/` |

`CONTRIBUTING.md` was slimmed to match: setup, the green gate and the pre-commit hook stay in
the repo; the monorepo map, the wave model, the corpus and the release flow now live under
`packages/docs/src/content/docs/contribute/`.

The `pnpm` + `turbo` JS workspace covers `packages/*`, `tools`, `products`, and the Node and
browser conformance runners. Python, Swift, Godot and Kotlin are standalone toolchains under
`sdks/`.

Inside the Worker, `src/core/` is the always-on substrate and each `src/services/<slug>/` is one
opt-in service (`license`, `config`, `release`, `distribution`, `update`, `identity`, `sync`). The services
are declared
once, as rows of `tools/services.json`; `pnpm gen services` generates every language's slug
constants from it. `src/mount.ts` is the composition root; `src/router.ts` builds
`SERVICE_NAMESPACES` from the generated `SERVICE_SLUGS`. Release, Distribution and Update form a
chain (release ← distribution ← update, coherence codes `distribution_requires_release` and
`update_requires_distribution`), and Cloud Sync (`sync`) requires Config and Identity
(`sync_requires_config`, `sync_requires_identity`); services read one another's state only through Core's
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
pnpm gen --check                 # every generator's drift gate, from the registry (tools/generators.ts):
                                 # corpus, transcripts, services, constants, platform inventory, storefront CI,
                                 # settings, brand, Action bundle (after pnpm build), docs reference,
                                 # parity, program INDEX, registry docs
pnpm ui:lint                     # UI-kit modernity + string + kit-source lint (needs Chromium; CI job ui-kits)
pnpm ui:report                   # UI kits side by side per state; fails only on a React/elements pixel drift
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

# The React drop-in kit at every size in Chromium (CI job react-kit): no sideways scroll, the main
# action in the first viewport, 24 px targets, text that scales with the root font. Set
# PKEY_KIT_SHOTS=<dir> to also write each render to <dir>/react.<screen>/<size>-<scheme>.png.
pnpm --filter @polaris-key/react test:browser

( cd sdks/python && .venv/bin/python -m pytest -q )   # Python (CPython 3.9 + 3.14 on ubuntu, macOS in CI)
( cd sdks/swift && swift build && swift test )        # Swift
sdks/godot/tools/run_tests.sh    # Godot (GODOT_BIN, optional GODOT_TEMPLATE; CI runs both)
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :core:test :license:test :config:test \
    :identity:test :release:test :update:test :packs:test :sdk:test :conformance:test )  # Kotlin (JDK 17;
                                 # :conformance runs every suite on JCA and again with Tink forced)

pnpm format                      # prettier check over md/json too (format:fix to apply)
```

`pnpm test:all` runs turbo test + Python pytest + Swift `swift test` + the Godot runner + the
Kotlin JVM module and `:conformance` tests in one shot (the Android modules need an Android SDK;
see `sdks/kotlin/README.md`). Note that
`pnpm build` does **not** typecheck the worker (esbuild strips types), so `pnpm typecheck` is not
redundant with it — that gap once hid five broken type-only imports.

The committed `.husky/pre-commit` hook runs a lightweight subset (`pnpm gen --fast --check`, the cheap
families, and `pnpm typecheck`). A green hook is not a green gate.

## Hard rules

**1. Never hand-edit generated corpus files.** `conformance/corpus/v2/{cases.json,
gate-matrix.json,fingerprint.json,stage-matrix.json,headers.json,config-matrix.json,
update-matrix.json,outlet-matrix.json,plan-matrix.json,feed-url-matrix.json,
sync-scenarios.json,device-label.json,presentation-matrix.json,ui-matrix.json}`, `conformance/corpus/v2/content/cases.json`
and the one generator-owned mirror at `sdks/godot/tests/corpus/v2/` are output (an exported Godot
pack reads only `res://`; `content/` is not mirrored). Every other runner, Swift included, reads
`conformance/` in place: the Swift tests find it through `CorpusLocator` (`#filePath`), so there is
no Swift copy (P0-44 retired `sdks/swift/Tests/PolarisKeyTests/Resources/`). The generator is
`tools/sign-corpus.ts`, a driver over one module per family in `tools/corpus/` and the
independent reference implementations in `tools/corpus/reference/`.
Regenerate with `pnpm gen corpus` and commit the result in the same change.
`pnpm gen corpus --check` regenerates in memory and fails on any difference, the mirror included,
on a stray JSON file in either directory, and on the retired Swift mirror's directory. `conformance/corpus/v2/content/blobs/` is the opposite:
generator **inputs** (the zstd blobs, the `pkey-chunks/1` indexes and bundles, and `refs.json`),
hash-checked against `content/cases.json`'s `blobs` table and never rewritten by a normal or
`--check` run; only the explicit `--rebuild-content-blobs` mode, pinned to zstd 1.5.7, writes them,
and it may only **add** blobs and `refs.json` entries: it throws, writing nothing, if an existing
one would change (plans/P4-10.md decision 15). Changing an existing blob is a PR of its own. Never weaken a runner to make a change "pass". The same
holds for the HTTP transcripts: `conformance/transcripts/*.json` and their Godot mirror at
`sdks/godot/tests/transcripts/` are recorded by the Worker's scenario tests (`packages/worker/test/transcripts/`) through
`pnpm gen transcripts`; a Worker change that alters a recorded response regenerates them in the
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
feature is not done until every implementation passes (client-core, Node, React, Python, Swift,
Godot, and Kotlin for the features its parity manifest has implemented).

**3. Generated files carry a GENERATED banner — regenerate, never hand-edit.** `tools/generators.ts` declares every family once; `pnpm gen` regenerates them and `pnpm gen --check` is the one drift gate:

<!-- generators:start (generated by `pnpm gen registry-docs`; do not edit) -->

| Family               | Regenerate                    | Writes                                                                            |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `corpus`             | `pnpm gen corpus`             | Signed conformance corpus (v2) and its one Godot mirror                           |
| `ui-matrix`          | `pnpm gen ui-matrix`          | UI-kit state matrix (the corpus's ui-matrix.json)                                 |
| `services`           | `pnpm gen services`           | Service table in every language                                                   |
| `channels`           | `pnpm gen channels`           | Distribution-channel catalogue                                                    |
| `transcripts`        | `pnpm gen transcripts`        | HTTP transcripts recorded through the Worker router, and their Godot mirror       |
| `constants`          | `pnpm gen constants`          | SDK constants: error codes, headers, enums, feature ids, core copy                |
| `platform-inventory` | `pnpm gen platform-inventory` | Platform inventory from the tagged Env members                                    |
| `storefront-ci`      | `pnpm gen storefront-ci`      | CLI copy of the Worker's storefront CI plane                                      |
| `settings`           | `pnpm gen settings`           | Settings reference page and console search index                                  |
| `brand`              | `pnpm gen brand`              | Brand tokens, launch kit, kit copy and per-SDK theme files                        |
| `action-bundle`      | `pnpm gen action-bundle`      | The publish Action's committed esbuild bundle of the CLI                          |
| `docs-reference`     | `pnpm gen docs-reference`     | Docs reference pages generated from the validators, routes, migrations and corpus |
| `registry-docs`      | `pnpm gen registry-docs`      | This registry as a docs page and the AGENTS.md generated-files table              |
| `parity`             | `pnpm gen parity`             | Parity gate: every SDK's parity.json against the feature registry                 |
| `graph-index`        | `pnpm gen graph-index`        | Omniplatform program INDEX.md from workpackages.json                              |
| `mirrors`            | `pnpm gen mirrors`            | Typed config mirrors for a product catalog, in five languages                     |
| `sdk-samples`        | `pnpm gen sdk-samples`        | `pkey sdk` configuration samples, one per SDK                                     |
| `docs-csp`           | `pnpm gen docs-csp`           | Docs-site CSP hashes                                                              |
| `design-mockups`     | `pnpm gen design-mockups`     | Static design mockups built from their \_src directories                          |
| `ux-coverage`        | `pnpm gen ux-coverage`        | UX coverage and wave pages from ux-coverage.json                                  |

Inputs and outputs per family: `packages/docs/src/content/docs/reference/generators.mdx`.

<!-- generators:end -->

All are committed on purpose (reviewable diffs; the site and packages build without running
generators) and all have a freshness check, `pnpm gen --check`, so a hand edit fails CI rather than
shipping. The worker suite's `ciPlaneGenerated`, `platformInventory` (which also fails when `Env`,
`wrangler.toml` and the names `src/` reads disagree) and `settings-generated` tests, and
`packages/cli/test/sdkConfig.test.ts` for the `pkey sdk` samples, are the other half. A new
generator is one entry in `tools/generators.ts`; a test fails when a GENERATED banner has no
entry. The
Action bundle inlines `@polaris-key/manifest`, `@polaris-key/catalog` and `@polaris-key/protocol`
from their built `dist/`, so a change to any of them, or to the CLI, rebundles after `pnpm build`. A new error code needs an entry in `conformance/parity/errors.json` first: the
constants generator refuses a Worker code it lacks (and a boot-stage code pinned in
`stage-matrix.json`), and each SDK's registry test refuses an SDK code it lacks. The service table is the one declaration
of the opt-in services; adding one is the checklist at
`packages/docs/src/content/docs/contribute/layout.md` ("Adding a service").

**4. Terminology comes from the concepts page.** `packages/docs/src/content/docs/start/concepts.md`
(served at `/docs/start/concepts/`) is the canonical glossary — the former `docs/CONCEPTS.md`,
moved into the site. Device, not machine. Tier, not plan. **Product** is the record in Polaris
Key (the console's product, the manifest, the API); **app** is the developer's build that embeds an
SDK, and what consumers use. "Create the product in the console" and "Add licensing to your app"
are both right; "create the app in the console" is wrong, and Help says "app" throughout. The
style guide (`docs/research/2026-10-08-docs/style-guide.md` §4, published as Contribute → Writing
docs) holds the rest of the writing rules. When code and the glossary disagree, the glossary wins;
open a PR to reconcile. **"Profile" is already taken twice**
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
CI tokens `pkeyci_`, registry tokens `pkeyr_`, headers `X-PKey-*`, env `PKEY_CONFIG_*`, issuer `key.plrs.im`. The `@plrs` / `polaris-suite` /
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
- **`packages/docs/src/content/docs/`** — the published site, in three doors
  (`docs/research/2026-10-08-docs/README.md` §3.1): **Help** for people using an app built on
  Polaris Key (`help/`); **Developers** (`start/`, `build/`, `features/<feature>/`, `reference/`);
  **Operate** (`operate/console/`, `operate/platform/`, `contribute/`). The door and the access tier
  of a page come from its directory (`src/lib/doors.ts`), never from frontmatter. A page that moves
  is a row in `packages/docs/site-map.json`, which also lists the hidden stubs that reserve every
  planned path; `node scripts/site-map.mjs apply` performs the rows and
  `pnpm --filter @polaris-key/docs lint:docs` runs the lints against `lint-debt.json`, which only
  shrinks. Long-form adopter and authoring material lives here, not in `docs/`.

```sh
pnpm --filter @polaris-key/docs dev       # local preview at /docs
pnpm --filter @polaris-key/docs gen       # regenerate the reference/*.mdx pages
pnpm --filter @polaris-key/docs gen:check # fail if any generated page is stale
pnpm --filter @polaris-key/docs lint:docs # the writing lints; fails on a hit lint-debt.json does not hold
pnpm --filter @polaris-key/docs build     # astro build + CSP hashes + slug manifest
```

The `build` script does four things in order: `astro build`, then `redirect-fragments.mjs` (keeps
a link's `#fragment` through a moved-page redirect), then `collect-csp-hashes.mjs` (writes the
worker's `docsCsp.generated.ts`), then `emit-slug-manifest.mjs` (writes `dist/docs-slugs.json`, with
each page's frontmatter and anchors, which the console's help-link drift gate reads, and takes the
stubs out of the sitemap). Skipping the build and editing either output by hand fails CI.

## Conventions when writing docs pages

- Frontmatter values are **quoted** (`title: "…"`, `description: "…"`).
- Never leave a bare `{` or `}` in MDX prose — MDX evaluates it as JSX. Braces inside backticked
  code spans are literal and need no escape.
- Internal links are absolute and end in a slash: `/docs/features/managed-config/catalog/`.
- Code blocks are compiled. A `ts`, `tsx`, `js` or `python` fence on a page listed in
  `packages/docs/test/snippets/covered.ts` compiles in its SDK lane against the built packages (the
  Python lane needs `sdks/python/.venv`); ` ```ts run ` also executes it. A code span naming an
  export (`LicenseGate`, `useLicenseGate`, `register_argparse()`) must be one the SDK exports, or
  its line must say "planned". `no-compile` opts a block out on other pages, never on a covered
  one. Conventions: `packages/docs/test/snippets/extract.ts`.
- Console help links live in exactly two tables (`packages/admin/src/console/nav.ts` and
  `packages/admin/src/lib/docsLinks.ts`) and are gated against the built slug manifest. Renaming
  a page means updating those tables in the same change.
