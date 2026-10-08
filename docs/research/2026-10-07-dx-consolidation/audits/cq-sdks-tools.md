# Audit: code quality of client-core, the SDKs, the shared packages, the CLI and Action, tools and conformance

_DX consolidation, 2026-10-07. Tree read: `/Users/vlad/Repos/pk-wt/dx-plan` (v0.8.31 plus batch 5,
HEAD `38d3acc68`), plus the in-flight branches HA-12, UK-13, UK-14 and LX-08. Nothing outside this
file was changed; no gate was run. Line counts exclude `node_modules`, build output and, where
stated, generated files._

## Summary

The wire is in excellent shape: one corpus, one transcript set and `parity:check` hold six SDKs to
identical verdicts, and the parity matrix is close to complete (66 to 76 of 84 features implemented
per SDK). The problems sit **on top of** the wire, and they all come from the same root: **every
feature is built six times and nothing generates or checks the part a developer actually touches.**

- **The SDK lanes are now over half of the open program.** 72 open work packages in the `sdk`,
  `ui`, `godot`, `parity` and `native` lanes total **112 to 162 engineer-weeks** of the 201 to 294
  left. Several features are split into two to four packages that each walk all six SDKs through
  the same files.
- **The TypeScript layer duplicates itself.** Node and React each carry their own copy of the
  discovery parser, the service map, the activation-refusal mapping (with _different_ kind
  spellings), the boot loop, the copy runtime and 2,264 lines of byte-identical generated
  constants and copy, because any edit to `client-core` is plan mode
  (`tools/gen-sdk-constants.ts:55`, `packages/sdk-react/src/core/services.ts:3`).
- **"Names identical up to casing, generated not remembered" (PARITY §2.1) is not enforced.** The
  six SDKs disagree on the construction call, the option names (`productSlug` / `product`,
  `expectedServices` / `expectServices`, `trust.pinnedKeys` / `trust` / `pinnedKeys` /
  `pinned_trust_keys`), and the config verbs (`getConfig` / `get_config` / `config` / `get_value`).
  Cloud Sync is planned as a **second** config write API (`setConfig`, `clearConfig`) beside the
  existing `config.local` verbs.
- **Onboarding has four snippet renderers that disagree** (`pkey sdk`, the console quick start, the
  Node-only legacy `pkey sdk` snippet, the hand-written docs quickstarts). Godot gets a `.tres` from the
  console and a `.gd` from the CLI. The fix, `renderSdkSetup` (UX-60), exists only in
  EXPERIENCE.md, not in the program.
- **The tooling has a generator zoo and CI sprawl.** Thirteen generator families, five invocation
  styles and four hand-kept lists of drift gates that already disagree; a 20,470-line corpus
  generator; 24 CI job instances (6 macOS, 2 Windows) on every pull request with no path filter.
- **The CLI and Action are flag-heavy.** `--product` and `--base-url` are demanded even inside a
  repository whose `.pkey/product` names both; developer auth means pasting the console session
  cookie into `PKEY_ADMIN_COOKIE`; the Action has 36 inputs.

**The single most important change:** make the conformance registries the source of the _API_ as
well as the wire. Add `conformance/parity/api.json` (canonical symbol per feature, accepted
idiomatic exceptions) with a generated per-SDK surface test, move every environment-neutral
TypeScript helper into `client-core` once, and normalise the six SDK surfaces in one 0.9 pass
**before** LX-19, U-06/U-07/U-20/U-21, I-10a/I-10b and CM-15 add about forty new symbols to each
SDK. Then put one generator registry and one CI scope map under everything. None of it touches
`PROTOCOL_VERSION`.

---

## Current state (with file references)

### Packages and sizes

| Unit                                              | Non-generated source lines | Notes                                                                                           |
| ------------------------------------------------- | -------------------------: | ----------------------------------------------------------------------------------------------- |
| `packages/client-core`                            |                     16,817 | TS reference core: verify, trust, gate, stages, feed, record, decide, outlet, packs, cloud-sync |
| `packages/sdk-node`                               |                     14,788 | plus 12,391 generated (`kitCopy.generated.ts` 9,955; constants 1,612; copy 824)                 |
| `packages/sdk-react`                              |                     16,214 | plus 2,492 generated (constants 1,668; copy 824)                                                |
| `sdks/python`                                     |                     31,467 | plus `kit_copy_generated.py` 7,640, `constants_generated.py` 1,776                              |
| `sdks/swift`                                      |                     33,150 | 11 SwiftPM products, umbrella `PolarisKey`                                                      |
| `sdks/kotlin`                                     |                    ~31,700 | 16 Gradle modules, umbrella `:sdk`                                                              |
| `sdks/godot`                                      |                     41,580 | pure GDScript including Ed25519 (`core/crypto/ed25519.gd` 1,339)                                |
| `packages/cli` (`pkey` + Action)                  |                     26,873 | Action bundle `actions/publish/dist/index.js` 1.58 MB                                           |
| `packages/shared-{protocol,jws,catalog,manifest}` |                     18,720 | `shared-manifest/src/index.ts` alone is 5,896                                                   |
| `tools/`                                          |                     32,894 | `sign-corpus.ts` 20,470; `gen-content-corpus.ts` 5,893                                          |

Every SDK reimplements verification, the gate, the stage machine, the update decision, the feed and
release-record checks, outlet detection, the content decision and the packs engine. The packs engine
alone is about 12,400 lines across five languages (`client-core/src/packs/engine.ts` 3,230,
`python/.../update/packs/engine.py` 2,799, `swift/.../PolarisKeyPacks/Engine.swift` 2,527,
`godot/.../packs/engine.gd` 2,233, `kotlin/.../packs/Engine.kt` 1,615). The corpus pins all of it.

### The registries that already work

`conformance/parity/` holds `features.json` (84 features), `errors.json` (154 codes: 56 wire, 98
client), `enums.json` (27 enums), `copy.<locale>.json` (8 locales) and the manifest schema. Each SDK
keeps a `parity.json`; `tools/parity-check.ts` (777 lines) requires every implemented entry to have a
test tagged `@pkey-feature <id>` and every `planned` entry to name an open work package.
`tools/gen-sdk-constants.ts` (2,025 lines) emits constants and core copy into seven targets. Status
today (implemented / N/A / planned): Node 70/8/6, React 66/12/6, Python 70/8/6, Swift 72/6/6, Kotlin
73/6/5, Godot 76/2/6. The planned entries point at I-15, I-10a, I-10b, PX-W9b, SP-15, SP-28, SP-29,
SP-30 and UK-07.

### What the registries do not cover: the API a developer types

Generated `pkey sdk` samples, read side by side (`conformance/runners/node/sdkConfigSample.ts`,
`packages/sdk-react/test/sdkConfigSample.ts`, `sdks/python/tests/sdk_config_sample.py`,
`sdks/swift/Tests/PolarisKeyTests/SdkConfigSample.swift`,
`sdks/kotlin/sdk/src/test/kotlin/polaris/generated/PolarisConfig.kt`,
`sdks/godot/tests/sdk_config/polaris_key_config.gd`):

| Concept          | Node                                   | React                                    | Python                              | Swift                                                                           | Kotlin                              | Godot                        |
| ---------------- | -------------------------------------- | ---------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------- |
| Create           | `await PolarisKeyClient.create({...})` | `<PolarisKeyProvider {...}>`             | `PolarisKeyClient.create(**CONFIG)` | `try PolarisKeyClient(options:)` and `PolarisKeyClient.create(options:)` (both) | `PolarisKeyClient.create(options)`  | `PolarisKey.configure(opts)` |
| Product          | `productSlug`                          | `productSlug`                            | `product_slug`                      | `productSlug`                                                                   | `core = CoreOptions(productSlug)`   | `product`                    |
| Trust pins       | `trust: { pinnedKeys }`                | not passed (host verifies)               | `trust=` (flat map)                 | `pinnedKeys`                                                                    | `core.pinnedKeys`                   | `pinned_trust_keys`          |
| Release pins     | `update.pinnedReleaseKeys`             | not passed                               | `update=UpdateClientOptions(...)`   | not in client options (separate `UpdateClientOptions`)                          | `update = UpdateClientOptions(...)` | `pinned_release_keys`        |
| Offline services | `expectedServices`                     | **`expectServices`** (`Provider.tsx:67`) | `expected_services`                 | `expectedServices`                                                              | `expectedServices`                  | `expected_services`          |

Config verbs (`sdk-node/src/config/client.ts:137`, `python/.../config/client.py:89,105,148`,
`swift/.../PolarisKeyConfig/ConfigClient.swift:214-359`, `kotlin/.../config/ConfigClient.kt:182-280`,
`godot/.../services/config.gd:134-269`):

| Operation          | Node                                        | Python                                        | Swift                                                      | Kotlin                | Godot                  |
| ------------------ | ------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- | --------------------- | ---------------------- |
| Read a value       | `getConfig(k, d)` (also `client.getConfig`) | `get_config(k, d)` (also `client.get_config`) | `config(k, default:)` plus `bool/int/double/string/decode` | `config(k, d)`        | `get_value(k, d)`      |
| Read a secret      | `getSecret`                                 | `get_secret`                                  | `secret`                                                   | `secret`              | `get_secret`           |
| Where it came from | `getConfigSource`                           | `get_config_source`                           | `configSource`                                             | `configSource`        | `get_source`           |
| Set locally        | `set`                                       | `set`                                         | `set`                                                      | `set`                 | `set_value`            |
| Clear all          | none                                        | none                                          | `clearAll`                                                 | `clearAll`            | `clear_all`            |
| Setting state      | `setting(k)`, `isLocked`                    | `setting`                                     | `settingState`, `isLocked`                                 | `setting` (StateFlow) | `setting`, `is_locked` |
| Service on?        | `enabled` (getter)                          | `enabled`                                     | `isEnabled()`                                              | `isEnabled()`         | `enabled`              |

Licence verbs: Node, Python and Godot use `activateWithKey` / `activate_with_key`, `getEntitlements`,
`getProfile`, `getLicenseId`; Swift and Kotlin use `activate(key:)`, `entitlements`, `profile`,
`licenseId`. Godot lacks `entitlement_value` and `license_info`. The activation result kinds are
kebab-case in Node (`"device-limit"`, `sdk-node/src/license/endpoints.ts:72-95`) and camelCase in
React (`"deviceLimit"`, `sdk-react/src/core/activation.ts:19-33`), both TypeScript.

PARITY §2.1 (`PARITY.md:95`) and the porter role (`.claude/agents/pkey-sdk-porter.md:31`) promise
"names identical up to casing … generated, not remembered". Nothing generates or checks a name.

### TypeScript duplicated between Node, React and the Worker

| Logic                                 | Copy 1                                     | Copy 2                                                                                                            | Why it is duplicated                                                                                                                          |
| ------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK constants (1,440 identical lines) | `sdk-node/src/constants.generated.ts`      | `sdk-react/src/constants.generated.ts`                                                                            | "Editing `shared-protocol` or `client-core` is plan mode … gives Node and React a generated module each" (`tools/gen-sdk-constants.ts:55-58`) |
| Core copy (824 identical lines)       | `sdk-node/src/copy.generated.ts`           | `sdk-react/src/copy.generated.ts`                                                                                 | same                                                                                                                                          |
| Copy runtime                          | `sdk-node/src/core/copy.ts` (166)          | `sdk-react/src/core/copy.ts` (471)                                                                                | same                                                                                                                                          |
| Service map, fail-closed (D-21)       | `sdk-node/src/discovery.ts` (335)          | `sdk-react/src/core/services.ts` (131) + `browser/discovery.ts` (152)                                             | "A MIRROR … duplicated rather than imported" (`services.ts:3-6`); "identical on purpose" (`discovery.ts:4-6`)                                 |
| Activation refusal mapping (§3.1)     | `sdk-node/src/license/endpoints.ts:72-200` | `sdk-react/src/core/activation.ts` (168)                                                                          | different kind spellings in one language                                                                                                      |
| One-call boot loop (`ui.boot`)        | `sdk-node/src/boot.ts` (267)               | `sdk-react/src/core/boot.ts` (279)                                                                                | React's header says it runs "as `@polaris-key/node`'s `client.boot()` drives it"                                                              |
| QR encoder                            | `packages/worker/src/core/qr.ts` (504)     | `sdk-node/src/qr/encoder.ts` (467)                                                                                | its comment points at a Worker path that no longer exists (`encoder.ts:6`)                                                                    |
| Version comparison                    | `client-core/src/version.ts`, `semver.ts`  | `worker/src/core/entitlements.ts:45`, `worker/src/services/release/resolve.ts:114`, `admin/src/lib/version.ts:64` | no shared home outside client-core                                                                                                            |
| Wire error envelope reading           | 10 TS files (Node 7, React 3)              | Python ~12 sites, Godot ~40, Kotlin ~30                                                                           | the Worker emits two shapes (below)                                                                                                           |

The Worker emits a flat `{"error":"code"}` from 185 call sites (`errorResponse`) and a nested
`{"error":{"code":…}}` from 39 (`wireError`), by design (`worker/src/core/errors.ts:67-99`). Every
SDK parses both, at many sites, instead of through one reader.

### Snippet and config renderers

| Renderer                                                      | Languages | Notes                                                                                                                      |
| ------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/sdkConfig.ts` (`pkey sdk --lang`)           | 6         | Typed config module from discovery and `.pkey/release`; generated samples checked by `cli/test/sdkConfig.test.ts`          |
| `packages/admin/src/console/pages/core/sdkQuickStart.ts`      | 6         | "Interim until UX-60's `renderSdkSetup` and UX-61's Connect your app replace it" (lines 1-16); Godot as `polaris_key.tres` |
| `packages/cli/src/manifest.ts:272` `sdkSnippet`               | Node only | printed by `pkey sdk` without `--lang`, defaulting the base URL to `https://key.example.com` (`index.ts:846-858`)          |
| `packages/docs/src/content/docs/build/quickstart/*.md`        | 7 pages   | hand-written; Swift's uses `create(options:)` while the generated sample uses `init(options:)`                             |
| `sdks/*/README.md` (rendered by `build/sdks/*.mdx`)           | 6         | 5,652 lines of README across SDKs and packages                                                                             |
| Godot setup dock (`addons/polaris_key/editor/setup_tools.gd`) | Godot     | shells out to `pkey sdk --lang godot` (good), writes `polaris_key_config.gd` while the console says `.tres`                |

SETUP.md D15 already decided on one generator (`renderSdkSetup` in `@polaris-key/manifest`) for the
console, the CLI, the Godot dock and the Gradle plugin. EXPERIENCE.md lists it as UX-60 (and UX-61,
UX-62), but none of the UX-\* packages are in `workpackages.json`.

### Samples

`examples/` holds `node-cli`, `node-electron`, `node-express`, `python-cli`, `python-renpy` and a
`ui/README.md`; Godot has `sdks/godot/examples/minimal`; Kotlin has `sdks/kotlin/samples/cli`. Swift
and React have none. Only Node (`sdk-node/test/examples.test.ts`) and Python
(`tests/test_samples.py`) samples are tested.

### Generators and drift gates

| Family              | Entry point                                                                                                                           | Outputs                                                                            | Freshness check                                        | In CI       | In `gate.sh` | Pre-commit |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------- | ------------ | ---------- |
| corpus              | `tools/sign-corpus.ts` (+ `gen-content-corpus.ts`, `sync-scenarios.ts`, `gen-content-chunks.ts`; HA-12 adds `presentation-matrix.ts`) | `conformance/corpus/v2/*` + Swift and Godot mirrors                                | `gen:corpus -- --check`                                | yes         | yes          | yes        |
| transcripts         | `tools/gen-transcripts.mjs` (drives Worker scenario tests)                                                                            | `conformance/transcripts/*` + Swift and Godot mirrors                              | `-- --check` **and** inside the worker suite           | yes (twice) | yes          | no         |
| services            | `tools/gen-services.ts`                                                                                                               | slug constants in 6 languages + `shared-manifest`                                  | `-- --check`                                           | yes         | yes          | yes        |
| constants + copy    | `tools/gen-sdk-constants.ts`                                                                                                          | 7 constants modules + 7 copy modules                                               | `-- --check`                                           | yes         | yes          | no         |
| brand + kit copy    | `packages/brand/scripts/gen.ts`, `gen-kit.ts`, `kit-copy.ts`                                                                          | CSS, Tailwind, TS, JSON, GDScript, Swift, Kotlin tokens; kit copy tables in 6 SDKs | `gen:brand -- --check`                                 | yes         | yes          | no         |
| settings            | `packages/worker/scripts/gen-settings.ts`                                                                                             | `reference/settings.mdx`, `admin/src/console/settings.generated.ts`                | `-- --check` and a worker test                         | yes         | **no**       | no         |
| platform inventory  | `packages/worker/scripts/gen-platform-inventory.ts`                                                                                   | `worker/src/platformInventory.generated.ts`                                        | `-- --check` and a worker test                         | yes         | yes          | no         |
| storefront CI plane | `packages/worker/scripts/gen-storefront-ci.ts`                                                                                        | `cli/src/storefronts/ciPlane.generated.ts`                                         | `-- --check` and a worker test                         | test only   | yes          | no         |
| docs reference      | `packages/docs/scripts/gen-reference.mjs`                                                                                             | 8 `reference/*.mdx` pages                                                          | `gen:check` and `docs/test/generated.test.ts`          | test only   | scoped       | no         |
| docs CSP            | `packages/docs/scripts/collect-csp-hashes.mjs` (docs build)                                                                           | `worker/src/docsCsp.generated.ts`                                                  | `docsCspParity.test.ts`                                | test        | test         | no         |
| Action bundle       | `packages/cli/scripts/bundle-action.mjs`                                                                                              | `actions/publish/dist/index.js`                                                    | `bundle:action -- --check`                             | yes         | yes          | no         |
| SDK samples         | `PKEY_UPDATE_SAMPLES=1 pnpm --filter @polaris-key/cli test sdkConfig`                                                                 | 6 sample files                                                                     | the CLI test                                           | test        | test         | no         |
| mirrors             | `tools/gen-mirrors.ts` (front end over `cli/src/mirrors.ts`)                                                                          | Kotlin test fixture only                                                           | none: the root script needs arguments (`ci.yml:71-81`) | no          | no           | no         |

Four lists name the gates (AGENTS.md "The green gate", `.github/workflows/ci.yml:28-90`,
`/Users/vlad/Repos/pk-wt/_lead/gate.sh`, `.husky/pre-commit`) and they disagree: `gen:settings` is
not in `gate.sh`, `gen:storefront-ci` is not a CI step, the pre-commit hook runs three. Core copy is
emitted twice into every SDK: as `copy.generated.*` by `gen:constants` and as `core.*` keys inside
the kit copy tables by `gen:brand` (3,204 `core.*` lines in both `kitCopy.generated.ts` and
`kit_copy_generated.py`).

### Monolith files (non-generated)

`tools/sign-corpus.ts` 20,470 (52 sections, from raw JWS vectors to `feed-url-matrix.json`, with its
own reference verifier, comparator and decision functions); `packages/shared-manifest/src/index.ts`
5,896; `tools/gen-content-corpus.ts` 5,893; `packages/client-core/src/packs/engine.ts` 3,230;
`conformance/runners/node/suites.ts` 2,357; `tools/sync-scenarios.ts` 2,236;
`packages/sdk-react/src/browser/browserAdapter.ts` 2,090; `packages/cli/src/index.ts` 1,928 (a
`switch` dispatcher at 450-510 and a hand-written help text at 1683-1773). HA-12's
`tools/presentation-matrix.ts` already follows the better pattern: a family module imported by
`sign-corpus.ts`.

### Conformance mirrors

`conformance/corpus/v2` is 11 MB; its Swift mirror (`sdks/swift/Tests/PolarisKeyTests/Resources/v2`)
and Godot mirror (`sdks/godot/tests/corpus/v2`) are 6.7 MB each; transcripts are mirrored twice more.
Swift's own `ContentConformanceTests.swift:24-35` already reads the checkout through `#filePath`,
so the Swift mirror is a convention, not a necessity. HA-12 adds `presentation-matrix.json` (5,060
lines) to all three.

### CLI and Action

- `pkey` has 17 top-level commands and about 50 subcommands, parsed by a hand-written `parseArgs`
  (`cli/src/index.ts:450-560`). Only `pkey sdk` reads the product slug from `.pkey/product`
  (`index.ts:865-881`); `release`, `distribution`, `feeds`, `listing`, `assets`, `transport` and
  `bundle` demand `--product` (`index.ts:697, 750, 792, 971, 999, 1366, 1464`) and `--base-url`.
- Developer auth for `pkey bundle` and `pkey listing import` is the console session cookie pasted
  into `PKEY_ADMIN_COOKIE` ("devtools -> Application -> Cookies", `cli/src/bundle.ts:64-67,
255-322`). CI commands use OIDC or `PKEY_CI_TOKEN`; `pkey feeds setup` uses registry tokens.
- `pkey doctor` validates `.pkey/` and, only when given `--base-url --product`, fetches discovery
  and prints it (`index.ts:743-780`). It checks no pins, release keys or trusted publisher.
- `pkey sdk` without `--lang` prints the legacy Node snippet against `https://key.example.com`.
- The Action (`actions/publish/action.yml`) has **36 inputs** and two outputs; `product` "must equal
  .pkey/product's slug". `cli/src/action.ts:29-66` maps them by hand onto six modes (app, pack,
  package, transport, storefront, assets).
- UK-14 (in a fix round) adds `cli/src/help.ts` (1,275 lines): one command table for help and
  completion. It is the natural seed for a full command registry.

### CI

Seven workflows, 2,298 lines. `ci.yml` has 15 jobs that expand to 24 instances on every pull
request with no `paths` filter: `js`, `workerd`, `node-floor`, `browser`, `console`, `ui-kits`,
`browser-firefox`, `browser-webkit` (macOS), `python` ×3 (one macOS), `swift` (macOS),
`apple` (macOS 26), `kotlin`, `kotlin-desktop` ×3 (macOS, Windows), `android`, `godot` ×6 (macOS and
Windows smokes). The checkout, pnpm, Node 22 and install steps are repeated 17 times with no
composite action. `swift` and `apple` both run `swift test` on the same package. The `js` job runs
the adapter-conformance tests and the transcript check a second time as named steps after `pnpm test`
already ran them. The only scope logic (run an SDK suite only when the branch touches it) lives in
the lead's private `gate.sh`.

### Lint

The repository has Prettier and the UI kit source lint (`packages/ui-qa/bin/kit-lint.mjs`). There is
no ESLint or unused-export check for TypeScript, no ruff or mypy for Python (which ships `py.typed`),
no ktlint or detekt, no swift-format lint and no gdlint. Duplicates and dead code are found by audits
like this one.

### Dogfooding

Our own SDKs publish prereleases on a `main` channel with `-main.N` versions
(`.github/workflows/publish-sdks.yml:6`, `tools/sdk-version.mjs:115-126`); the platform's canonical
channels are `stable`, `beta`, `pr` and `dev` (`shared-protocol/src/core.ts:325-333`). `pkey feeds
prune` exists but no workflow runs it, so `-main.N` builds accumulate on the feeds.

---

## Problems (ranked)

1. **High. Six-fold SDK work dominates the backlog, and features are cut so the same files are
   walked several times.** 72 open SDK-side packages, 112 to 162 engineer-weeks. Identity alone has
   PX-W9b, I-10a, I-10b and UK-44 each touching activation and sign-in in six SDKs (UK-44 strictly
   depends on I-10a and I-10b); licensing has LX-19 and I-24b on two separate wire amendments
   (LX-18, I-24a), each a full corpus regeneration; Cloud Sync has U-06, U-07, U-20, U-21, U-08,
   U-13, U-25, U-22, U-23 and U-14. Each pass also edits every `parity.json`, constants module and
   UI kit.
2. **High. Node and React duplicate environment-neutral logic because `client-core` is plan mode.**
   The CLAUDE.md trigger ("`shared-protocol`, `shared-jws`, `client-core` …", `CLAUDE.md:80`) covers
   the whole package, so builders put neutral helpers in both SDKs instead. The fail-closed service
   map and discovery parser exist twice and are held together by a test; activation kinds are
   spelled two ways in one language; 2,264 generated lines are byte-identical.
3. **High. The developer-facing API is not registered, generated or checked.** The tables above
   show six construction calls, five spellings of the trust pins and four config read verbs.
   Upcoming packages (LX-19's `entitlement()`, `grants()`, `licenseExpiresAt()`; U-06's settings;
   CM-15's `offers()`, `purchase()`, `manageBilling()`; UK-44's `signIn.start`; I-15's
   `signIn({redirect})`) will add about forty symbols to each SDK with nothing to keep them aligned.
4. **High. Cloud Sync plans a second config write API.** `plans/U-01.md:296` and `:415-433` name
   `config.setConfig`, `clearConfig`, `settingState` and `onChange({keys, origin})` for Node,
   `set_config` for Python and `config.set_value` for Godot, while `config.local` (SP-13, SP-18,
   SP-24, done) already ships `set`, `clear`, `setting` and `onConfigChange`. The owner asked for
   the opposite: "using existing conventions like managed configs … and not duplicate logic".
5. **Medium-high. Four SDK setup renderers disagree, and the agreed fix is not in the program.**
   See "Snippet and config renderers". UX-60 (`renderSdkSetup`), UX-61 (Connect your app) and UX-62
   (`renderCiWorkflow`) exist only in EXPERIENCE.md's package table, not in `workpackages.json`.
6. **Medium. The generator zoo.** Thirteen families, five styles (`-- --check`, `gen:check`, a
   vitest freshness test, an environment variable, none), four disagreeing lists, two generators
   writing the same core copy into every SDK, a root `gen:mirrors` script that cannot run without
   arguments, and drift checks that run twice in CI.
7. **Medium. Monolith files.** `sign-corpus.ts` at 20,470 lines is the main merge-conflict magnet
   for every corpus package (HA-12, LX-18, I-24a, CM-14); `shared-manifest/src/index.ts` at 5,896
   is the same for every validator rule; `cli/src/index.ts` couples dispatch, parsing and help.
8. **Medium. CI sprawl.** 24 job instances per pull request regardless of what changed, six
   on macOS and two on Windows; no composite setup; duplicated `swift test`; duplicated test runs;
   scope logic only in a private script.
9. **Medium. CLI and Action friction.** Redundant `--product` and `--base-url`; cookie-pasting auth;
   36 Action inputs hand-mapped to flags; `pkey doctor` that verifies nothing an integration needs;
   a legacy `pkey sdk` mode with a placeholder origin.
10. **Medium. Two strings systems per SDK.** `core.copy` (`copy.generated.*`) and the kit copy
    tables both carry the core copy; Node ships a 9,955-line generated kit copy module.
11. **Medium. UI-kit sequencing creates duplicate headless layers and overlapping hosts.** UK-14
    adds `sdk-node/src/cli/models.ts` (693 lines, "layer c") and UK-13 adds
    `polaris_key/ui/core/models.py` (499 lines) before UK-03's `@polaris-key/ui-core` exists, while
    UK-12 still plans to create `polaris_key.ui.core`. SP-31 (bridge v4 host in
    `@polaris-key/node/electron`) and UK-06 (`@polaris-key/electron` replacing that bridge) overlap;
    UK-21 (Tauri sidecar plugin) and X-02 (Tauri Rust plugin) overlap.
12. **Low-medium. Mirrored conformance data.** 7 MB of Swift mirror that Swift tests do not need,
    and every new matrix copied three times.
13. **Low-medium. Two wire error envelopes, parsed ad hoc everywhere.** Unifying the wire is not
    worth a protocol event; one reader per SDK is.
14. **Low. No language linters or duplicate detection.** Python's type claims are unchecked; dead
    exports are invisible.
15. **Low. Samples are scattered and partly untested.** No Swift or React sample; Godot's and
    Kotlin's live inside their SDK trees; docs quickstarts are not compiled.
16. **Low. Dogfood channel and feed hygiene.** `main` instead of the canonical `dev`; `-main.N`
    prereleases never pruned.
17. **Low. Build tool split.** `shared-*` build with tsup and hand-list their entry points in the
    build script (duplicating `package.json` `exports`); the rest build with `tsc`.

---

## Owner brief: item-by-item stance

| #   | Brief item (paraphrased)                                                                                  | Stance           | Rationale and what it means in this domain                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Consolidate similar features and services                                                                 | adopt            | Node/React duplicates into `client-core`; one copy pipeline; one SDK setup renderer; one config API (Cloud Sync as a backend of `config.local`); one Electron package; one Tauri plugin; one headless layer per language.                                                                                                                                          |
| 2   | Flexibility in configuration, within limits                                                               | adopt            | Every SDK keeps its escape hatches (`fetchImpl`, stores, directories, update overrides), but the five options a developer must set get one name everywhere and come generated.                                                                                                                                                                                     |
| 3   | Reduce configuration surface area                                                                         | adopt            | Init options normalised and generated; Action inputs 36 to about 7; `--product` and `--base-url` from `.pkey/product`; one `pnpm gen` instead of eleven root scripts; one auth path for the CLI.                                                                                                                                                                   |
| 4   | Excellent onboarding: wizards, example code, auto-configuration                                           | adopt            | `renderSdkSetup` (UX-60) into the program as CQS-07; `pkey sdk` detects the language and writes config plus typed catalog accessors in one file; a runnable, CI-tested quickstart per SDK (CQS-08); docs quickstarts embed the renderer's goldens.                                                                                                                 |
| 5   | Automate whatever can be automated                                                                        | adopt            | Generator registry with `--changed`; CI scope map; `pkey validate --fix` for deprecated manifest spellings; automatic feed pruning; the Godot dock and a Gradle plugin call the one renderer.                                                                                                                                                                      |
| 6   | Degrade gracefully when a service is off                                                                  | adapt            | Already true in the SDKs (typed `service-unavailable`, `supports()` with reason `product`, D-21 fail-closed). Add: persist the last verified discovery service map so `expectedServices` stops being something a developer maintains; keep it only as a generated offline hint.                                                                                    |
| 7   | Products: an Integration section with per-service code samples, dismissable after an end-to-end handshake | adapt            | The content comes from CQS-07 plus per-service snippets generated from the API registry (CQS-05). The handshake is SETUP.md's SDK sighting (W15), which needs **no SDK change**: every SDK already sends `X-PKey-SDK` and `X-PKey-SDK-Version` (pinned by `headers.json`). `pkey doctor` becomes the CLI half of the same check.                                   |
| 8   | Licences: entitlements per licence and user, sub-licences, quantities and redemption (IAP)                | adapt            | SDK side belongs in LX-19, named through the registry: `entitlements()` returning `{id, quantity, redeemed, expiresAt, source}` and a `redeem(id, n)` call. Quantity and redemption are new wire members, so they must ride LX-18's amendment (plan mode) rather than a second one.                                                                                |
| 9   | Tiers: config flow user > licence > profile > defaults                                                    | adapt            | Resolution order is pinned by `config-matrix.json` in every SDK; any reorder is a corpus change and an all-SDK event. Recommend the config domain either confirm today's order maps onto the brief (U-01 keeps it) or batch the change with LX-18.                                                                                                                 |
| 10  | Subscriptions, perpetual fallback (JetBrains model)                                                       | adapt            | Server-side policy; the SDKs need only `licenseExpiresAt()` and status reasons (LX-18/LX-19) and the existing `version-too-new` / `allowedRange` handling. No new SDK logic.                                                                                                                                                                                       |
| 11  | Config types (regular, secret, edge-minted) and visibility (changeable, read-only, invisible)             | adopt (naming)   | The verbs exist (`get`, `getSecret`, `mintToken`, `listUserConfig`, `isLocked`). Express visibility in one `setting(key)` state (`editable`, `readonly`, `hidden`) through the registry instead of new verbs. Any new management state is a catalog or document change for the config domain.                                                                      |
| 12  | Cloud Sync through managed config conventions, no duplicated logic                                        | adopt (strongly) | Edit U-06, U-07, U-20, U-21: sync is a persistence backend of `config.local`; `set`, `clear`, `setting`, `onConfigChange` gain an `origin` and sync state; no `setConfig` or `clearConfig`. Saves and collections keep their own verbs.                                                                                                                            |
| 13  | Release content types and OS/arch gating in UI                                                            | defer            | Release and distribution domains. SDK impact is limited to `release.distribution`, which already reads the model.                                                                                                                                                                                                                                                  |
| 14  | Feeds behind licensed tokens; SDKs visible only to developers                                             | adapt            | Our install snippets (console quick start, docs, `pkey feeds setup`) then need a developer token. Make `pkey login` (CQS-11) mint it and `pkey sdk` write the registry config with it; `publish-sdks.yml`'s drift job and `sdk-node/test/examples.test.ts` need a read token. Cross-domain with Feeds and Identity.                                                |
| 15  | Clean `-main.N` builds from feeds at the next full version                                                | adopt            | Run `pkey feeds prune --apply` for the system product in `publish-sdks.yml` after a stable tag. Quick win.                                                                                                                                                                                                                                                         |
| 16  | Update channels: stable, beta, dev pre-configured                                                         | adopt            | Already canonical (`CHANNEL_DEV`). Dogfood it: publish our prereleases on `dev`, keep the npm `main` dist-tag as an alias for one release.                                                                                                                                                                                                                         |
| 17  | Sign-in across CLI apps and TUIs                                                                          | adopt            | UK-13 and UK-14 deliver the terminal kits; fold their headless models into ui-core (UK-03 edit, UK-12 edit).                                                                                                                                                                                                                                                       |
| 18  | Access tokens per user for feeds                                                                          | adopt            | The CLI should use the same token family: `pkey login` replaces `PKEY_ADMIN_COOKIE` (CQS-11).                                                                                                                                                                                                                                                                      |
| 19  | Code quality: no duplicated code, smells, consistency, style, modularity                                  | adopt            | This audit: CQS-01 to CQS-13, plus language linters with debt ledgers (CQS-13) so it stays true.                                                                                                                                                                                                                                                                   |
| 20  | "Lots of layers and abstractions that might not be needed"                                                | adapt            | For the SDKs the per-language ports are **not** removable: the wire must be verified natively in six runtimes (Godot web export, pure Python wheels, CryptoKit). Push back on a single shared native core (Rust/WASM) now: months of work, breaks pure-GDScript and pure-wheel delivery. Reduce duplication _within_ a language and generate the surfaces instead. |
| 21  | Go through the in-flight and todo work and consolidate                                                    | adopt            | See "Backlog changes": 5 packages merged or dropped, 10 deferred to on-demand, 22 edited.                                                                                                                                                                                                                                                                          |

---

## Target design

### 1. Layers, and what lives where

```text
conformance/parity/  (registries: features, errors, enums, copy*, api ← new)
        │ generators (one registry, `pnpm gen`)
        ▼
shared-protocol, shared-jws            wire types and JWS: plan mode
client-core                            the TS reference
  ├─ wire modules   (verify, trust, bundle, claims, clock, headers, gate, config resolution,
  │                  feed, record, check, decide, outlet, packs claims/marker/revocations,
  │                  stages, cloud-sync reducer)                          plan mode
  └─ neutral modules (constants + capability engine, copy runtime, discovery parse,
                      service map, activation outcome, wire error reader, boot loop,
                      QR, device label, release-fetch range logic, presentation) normal mode
@polaris-key/node, @polaris-key/react  thin hosts: transport, storage, platform glue
@polaris-key/ui-core                   one TS headless layer: web kits AND the Node terminal kit
python / swift / kotlin / godot        native ports, each with one ui-core equivalent
```

`client-core` keeps its 22 subpath exports; the neutral modules arrive as new subpaths
(`/copy`, `/discovery`, `/activation`, `/boot`, `/qr`, `/errors` extended). Node and React re-export
the old names for one minor. The plan-mode trigger is narrowed to the wire modules (a policy edit to
CLAUDE.md, AGENTS.md and the porter role); a neutral-module change proves itself by replaying the
transcripts and the corpus unchanged.

### 2. The API registry

`conformance/parity/api.json` (schema `api.schema.json`) lists, per feature id, the canonical
symbols: `{feature, symbol: "config.get", kind: "method"|"property"|"event"|"option", args, async,
result}`. Each SDK's `parity.json` gains an optional `symbols` map for **accepted idiomatic
exceptions** (Swift `activate(key:)`, Swift typed getters, Kotlin `StateFlow` settings, Godot
signals, React hooks), each with a reason, exactly like today's accepted shapes in PARITY §2.1. A
generator emits one API-surface test per SDK (a TypeScript type test, a pytest of names and
signatures, a compile-only Swift and Kotlin file, a GDScript `has_method` suite);
`parity:check` refuses an implemented feature whose symbols the SDK lacks. The same file generates
`reference/sdk-api.mdx` (one cross-language table per service) and feeds the console's per-service
Integration snippets.

### 3. One SDK configuration shape

Five product facts, one name each, flat, in every SDK: `productSlug`, `baseUrl`, `pinnedKeys`,
`pinnedReleaseKeys`, `expectedServices` (plus the host's own `version` and optional `channel`). One
construction call per SDK (`create`; Godot `configure`; React the provider), taking the generated
object unchanged. `pkey sdk` writes it; Swift and Kotlin may also read the same facts from a bundled
JSON resource (`fromBundle`, already planned as `PolarisKeyClient.fromBundle()`). Old names stay as
deprecated aliases for one minor (0.9 adds, 0.10 removes).

### 4. One config API, with Cloud Sync behind it

`config.get(key, fallback)`, `config.getSecret(key)`, `config.source(key)`, `config.set(key,
value)`, `config.clear(key)`, `config.clearAll()`, `config.setting(key)` (value, source,
`visibility: editable | readonly | hidden`, `sync: synced | pending | local | conflict`) and
`config.onChange(listener)` with `{keys, origin: local | remote | merge | migration | admin}`. A key
whose catalog entry declares `user.sync` persists through the U-01 journal; others persist locally
as today. Saves and collections keep their own verbs (`saves.*`, `collection(...)`), named in the
registry before U-13 and U-22 start. The desktop bridge v4 carries these verbs, not new ones.

### 5. One SDK setup renderer

`renderSdkSetup(lang, facts, {catalog?, services})` in `@polaris-key/manifest` (where
`renderFeedSetup` already lives) returns install steps, the config module, typed catalog accessors
(today's `pkey mirror`, folded in when the catalog has entries) and a first-run snippet. Consumers:
`pkey sdk` (language detected from `package.json`, `pyproject.toml`, `Package.swift`,
`build.gradle.kts`, `project.godot`), the console (replacing `sdkQuickStart.ts`), the Godot dock, a
Gradle plugin (SP-K10) and the docs quickstarts (embedded goldens). One Godot form: the generated
script, since the dock and CLI already use it. Goldens per language plus a parse check per language
(`tsc`, `python -m py_compile`, `swiftc -parse`, `kotlinc` in the Kotlin job, Godot's `--check-only`).

### 6. Generators: one registry

`tools/generators.ts` declares each family: `{id, run, inputs (globs), outputs (globs), after,
check}`. `pnpm gen` writes all in dependency order (services → constants → corpus → transcripts →
brand → settings → inventory → storefront-ci → docs reference → samples → action bundle);
`pnpm gen --check` checks all; `pnpm gen --changed` checks only families whose inputs changed since
the merge base (the lead gate and pre-commit use it); `pnpm gen <id>…` runs some. CI, `gate.sh`, the
pre-commit hook and the AGENTS.md rule-3 table all read the registry (the table is generated into
`reference/generators.mdx`). One freshness mechanism per family: the registry's `--check`; vitest
keeps only semantic checks (the platform inventory's Env ↔ `wrangler.toml` agreement, for example).
`gen:mirrors` goes (`pkey mirror` stays). Core copy is generated once, into the kit copy tables.

### 7. The corpus generator as family modules

`tools/corpus/<family>.ts` (jws, claims, trust, clock, bundle, gate, stage, fingerprint, headers,
device-label, config, versions, feed, record, update, outlet, packs, content, delegation, revocation,
feed-url, sync, presentation), each exporting `build()` and `selfCheck()`, with the independent
reference implementations in `tools/corpus/reference/`. `sign-corpus.ts` becomes the driver.
Output byte-identical, enforced by `gen:corpus -- --check` against `main`. The Swift tests read the
checkout through one `CorpusLocator` (`#filePath`), and the Swift corpus and transcript mirrors go;
the Godot mirror stays (exported-template runs read `res://`).

### 8. The CLI and the Action

A declarative command registry, grown from UK-14's `help.ts`, declares each command's flags with
types, defaults and environment fallbacks, and drives parsing, help, completion,
`reference/cli.mdx` and the Action. Context resolves once: `--product` ← `.pkey/product` slug,
`--base-url` ← `.pkey/product` base URL ← `PKEY_BASE_URL` ← `https://key.plrs.im`. Auth: `pkey
login` (device code against the console identity, a scoped personal access token in the OS keyring)
for developer commands; CI keeps OIDC. `pkey doctor` verifies an integration: manifests valid,
generated config pins equal discovery's, release keys match `releaseKeyFingerprints`, the trusted
publisher exists, and (once W15 lands) an SDK has been sighted. `pkey validate --fix` rewrites
ST-19's deprecated spellings. The Action takes `command` (default `release publish`), `args`
(multiline flags), the secrets (`release-key`, `content-key`), `base-url`, `working-directory` and
`dry-run`; the 36 old inputs are accepted for one minor through the same registry, with a
deprecation annotation.

### 9. CI

A composite action `.github/actions/setup-js` (checkout, pnpm, Node 22, install, optional build).
One scope map, `tools/ci-scope.json`, read by both a `changes` job and `gate.sh`: SDK and kit jobs
run when their paths or the shared inputs (`conformance/`, `packages/shared-*`,
`packages/client-core`, `packages/brand`, `tools/`) change. A final `ci-ok` job aggregates and is the
one required check. Pull requests run the floor and latest of each matrix (Python 3.9 and 3.14,
Godot floor and latest, Kotlin desktop on Linux); `main` runs the full matrix, as today's lead rules
already require. `swift` and `apple` merge into one macOS job. The generator step is one line:
`pnpm gen --check`.

### 10. Lint baselines

knip (unused files, exports and dependencies) and jscpd (duplicate blocks) for TypeScript; ruff and
mypy for Python; ktlint and detekt for Kotlin; swift-format lint for Swift; gdlint for Godot. Each
starts as a report with a committed debt ledger (the `kit-debt.json` pattern from UK-15) and then
blocks new debt only.

---

## Surface-area reduction

| Before                                                                                                          | After                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 2,264 byte-identical generated lines in Node and React (constants, copy)                                        | one module in `client-core`; per-SDK capability tables stay                                                                                   |
| about 2,000 hand-written duplicate TS lines (service map, discovery, activation, boot, copy runtime, QR)        | one copy each in `client-core`                                                                                                                |
| core copy emitted by two generators into 7 `copy.generated.*` files and the kit tables                          | kit copy tables only                                                                                                                          |
| 4 SDK setup renderers (`sdkConfig.ts`, `sdkQuickStart.ts` 312 lines, `sdkSnippet`, docs)                        | `renderSdkSetup`                                                                                                                              |
| 2 Godot config forms (`polaris_key.tres`, `polaris_key_config.gd`)                                              | 1                                                                                                                                             |
| 6 SDK init option shapes                                                                                        | 1 key set                                                                                                                                     |
| 2 planned config write APIs (`config.local` and `setConfig`)                                                    | 1                                                                                                                                             |
| 3 Electron integration paths (sdk-node v3 host, react desktop bridge, planned `@polaris-key/electron`)          | 1 package                                                                                                                                     |
| 2 Tauri packages (UK-21, X-02)                                                                                  | 1                                                                                                                                             |
| 2 headless layers per language for web and terminal kits (UK-14 models, UK-03 ui-core; UK-13 and UK-12 ui.core) | 1                                                                                                                                             |
| 11 root generator scripts and 4 hand-kept gate lists                                                            | `pnpm gen` (with `--check` or `--changed`) and 1 registry                                                                                     |
| 5 freshness mechanisms                                                                                          | 1 (`--check` through the registry)                                                                                                            |
| 36 Action inputs                                                                                                | about 7                                                                                                                                       |
| 3 CLI credentials (session cookie, CI token, registry token)                                                    | 2 (personal access token, CI OIDC token)                                                                                                      |
| `--product` and `--base-url` on every command                                                                   | read from `.pkey/product`                                                                                                                     |
| 7 MB Swift corpus and transcript mirror                                                                         | none                                                                                                                                          |
| 24 CI job instances on every pull request                                                                       | only the affected jobs, plus `js` and `ci-ok`                                                                                                 |
| Work packages                                                                                                   | 5 merged or dropped (UK-44, X-02, UK-32, UK-38, UK-39); 10 deferred to on-demand; SP-31, I-24b and PX-W9b re-scoped so no SDK is walked twice |

---

## Automation and onboarding

- **One command to integrate.** `pkey sdk` (or `pkey sdk add`, SETUP.md D15) detects the SDK from
  the repository, signs the developer in if needed (`pkey login`), writes the registry config with a
  developer feed token, installs the package, writes the generated config and typed catalog
  accessors, and runs `pkey doctor`. The console's Connect your app shows the same steps from the
  same renderer.
- **Integration done is detected, not declared.** The Worker records SDK sightings from headers the
  SDKs already send; `pkey doctor` reports the same verdict locally. No SDK change.
- **Samples that cannot rot.** One quickstart per SDK under `examples/<sdk>-quickstart/`, generated
  from the renderer's goldens and run in each SDK's CI job against a transcript replay server, so a
  renamed method fails CI rather than a developer's first hour.
- **Generated reference.** `reference/sdk-api.mdx` (from `api.json`), `reference/cli.mdx` (from the
  command registry) and `reference/generators.mdx` (from the generator registry) join the eight
  generated pages; console help links point at them.
- **Self-healing manifests.** `pkey validate --fix` rewrites deprecated spellings, which also unblocks
  ST-19's later refusal step.
- **Fewer things to remember in the gate.** `pnpm gen --changed` replaces ten gate steps; the CI
  scope map replaces the lead's private scoping; a rerun of a single failed family is `pnpm gen
<id> --check`.
- **Feed hygiene.** Prune prereleases automatically after every stable tag.
- **Porting kit per feature.** Every new SDK-facing feature lands as: wire and corpus (plan mode),
  the `client-core` reference, the `api.json` rows, the generated surface tests failing in each SDK,
  then one porter pass per language group. The failing generated test is the porter's checklist.

---

## Migration, data and risk

- **No wire change, no `PROTOCOL_VERSION` bump** in any CQS package. The only plan-mode items are
  CQS-04 (under today's rule that all of `client-core` is plan mode) and CQS-11 (a new credential,
  for its security review). The batching of LX-18 with I-24a is itself a plan-mode decision for the
  licensing and identity owners.
- **No D1 migrations** except the personal access token table, which the identity domain owns.
- **API renames are breaking.** Adopters today are internal (djdl, Diceroll, the system product) and
  every SDK ships in lockstep at 0.8.x. Mitigation: deprecated aliases in 0.9 with a runtime warning
  in debug builds, removal in 0.10, regenerated `pkey sdk` modules, a migration table generated from
  `api.json`, and doing it **before** LX-19, U-06 and CM-15 so new symbols are born with final names.
- **`client-core` extraction.** Behaviour risk is covered by replaying every transcript and the
  corpus unchanged and by the existing Node and React suites; Node and React keep re-exports. The
  activation kinds settle on one spelling (the registry's), with the other accepted as an alias for
  one minor.
- **Parity references.** Merging or deferring a package named by a `planned` entry (PX-W9b, I-10a,
  I-10b, SP-28, SP-29, SP-30) must update every affected `parity.json` in the same change or
  `parity:check` fails.
- **Corpus split.** Must be byte-identical; schedule it right after HA-12 merges and before LX-18,
  I-24a and CM-14 start, with a short freeze on `tools/sign-corpus.ts`.
- **Swift mirror removal.** Verify no test that runs on an iOS device (not the simulator) reads the
  corpus; the `apple` job builds for iOS but runs `swift test` on macOS, so the risk is low.
- **Generator registry.** Keep the old root scripts as aliases for one release; run old and new
  checks side by side for a week; the registry must list every output glob or `--changed` will miss
  a stale file (a test asserts every `GENERATED` banner in the tree belongs to a registered output).
- **CI scoping.** A path-filtered pull request can miss a cross-cutting break; mitigated by the shared
  inputs rule, by the full matrix on `main`, and by the existing rule that a deploy waits for `main`.
- **Action inputs.** Diceroll's D-03 workflow and our own `publish-package.yml` use the current
  inputs; both keep working for one minor and get regenerated by UX-62's `renderCiWorkflow`.
- **`PKEY_ADMIN_COOKIE`.** Keep reading it for one minor with a warning that names `pkey login`.
- **Dogfood channel.** Consumers following the `main` channel (feed URLs, the npm `main` dist-tag)
  must move to `dev`; keep `main` as an alias for one release.
- **In-flight branches.** UK-14 (fix round) and UK-13 should merge as they are; their headless models
  become UK-03's and UK-12's starting point rather than being rewritten. HA-12 already puts the
  presentation parser in `client-core` and the matrix in a family module: no change. LX-08 is
  Worker-only and unaffected.

---

## Backlog changes

| id     | action  | target         | note                                                                                                                                                                                                                           |
| ------ | ------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UK-44  | merge   | I-10a, I-10b   | Sign-in hints in six SDKs already depend on I-10a and I-10b; doing them in the same pass removes one walk through every SDK's sign-in code. PX-W18 becomes a dependency of I-10a and I-10b.                                    |
| PX-W9b | edit    | CQS-04         | Keep (its dependencies are done, it can ship before I-08 and I-09), but land the key-entry outcome in `client-core`'s new activation module once, so Node and React share it; names from CQS-05.                               |
| I-10a  | edit    | CQS-04, CQS-06 | Absorbs UK-44's Node, React and Python half; symbols from `api.json`; built on `client-core`'s activation and discovery modules.                                                                                               |
| I-10b  | edit    | CQS-06         | Absorbs UK-44's Swift, Kotlin and Godot half; symbols from `api.json`.                                                                                                                                                         |
| I-15   | edit    | CQS-05         | `signIn({redirect})` named in the registry before six ports start.                                                                                                                                                             |
| LX-18  | edit    | I-24a          | Batch with I-24a into one licensing wire amendment and one corpus regeneration (plan mode); include entitlement quantity and redemption if the licensing domain adopts them.                                                   |
| LX-19  | edit    | CQS-06         | Schedule after the API normalisation; `entitlements()`, `grants()`, `licenseExpiresAt()`, `redeem()` in `api.json` first.                                                                                                      |
| I-24b  | edit    | LX-19          | Run as the same SDK train as LX-19 (same porter, same window); merge outright if I-24a rides LX-18's amendment.                                                                                                                |
| U-06   | edit    | config.local   | Settings sync is a persistence backend of `config.local`: existing `set`, `clear`, `setting`, `onConfigChange` gain `origin` and sync state; no `setConfig`/`clearConfig`. Amend `plans/U-01.md` §2.9 and §5 to match.         |
| U-07   | edit    | config.local   | Same; `@PolarisSetting` and `rememberSetting` wrap `config.setting`.                                                                                                                                                           |
| U-20   | edit    | config.local   | Same; bridge v4 carries the existing verbs.                                                                                                                                                                                    |
| U-21   | edit    | config.local   | Same; Godot keeps `set_value` only if the registry records it as an accepted exception.                                                                                                                                        |
| U-13   | edit    | CQS-05         | `saves.*` and conflict objects named in the registry before the first port.                                                                                                                                                    |
| U-22   | edit    | CQS-05         | `collection`, `put`, `update` named in the registry before the first port.                                                                                                                                                     |
| CM-15  | edit    | LX-20          | One commerce client API in the registry covering both store parity (LX-20) and Polaris Key checkout (CM-15); run as one SDK train if the timing allows.                                                                        |
| LX-20  | edit    | CQS-05         | Names from the registry.                                                                                                                                                                                                       |
| UK-03  | edit    | UK-14          | ui-core absorbs UK-14's `sdk-node/src/cli/models.ts` and serves the Node terminal kit as well as the web kits; it also takes the boot and activation view logic from `client-core` rather than from `@polaris-key/react/core`. |
| UK-12  | edit    | UK-13          | `polaris_key.ui.core` already exists from UK-13; UK-12 shrinks to the Qt kit and the UI-thread hook (re-estimate down).                                                                                                        |
| SP-31  | edit    | UK-06          | Land the bridge v4 host as the first slice of `@polaris-key/electron` (`registerPolarisKey`, `exposePolarisKey`), with `exposePolarisBridge` as a deprecated alias, so there is never a second host API.                       |
| UK-06  | edit    | SP-31          | Builds on SP-31's package: menus, notifications, update progress, platform variants.                                                                                                                                           |
| X-02   | merge   | UK-21          | One Tauri package. UK-21's sidecar first; X-02's native keyring and fingerprint only if the sidecar proves insufficient.                                                                                                       |
| UK-21  | reorder | on demand      | "should" tier: start when a Tauri adopter exists.                                                                                                                                                                              |
| UK-32  | drop    |                | Ink components duplicate UK-14's terminal kit.                                                                                                                                                                                 |
| UK-38  | drop    |                | wxPython and Kivy adapters: no adopter; ui-core already lets a host draw its own.                                                                                                                                              |
| UK-39  | drop    |                | NiceGUI, Gradio, Flet: same; the elements cover web UIs.                                                                                                                                                                       |
| UK-17  | reorder | on demand      | Vue kit after UK-41, when an adopter asks; the elements already work in Vue.                                                                                                                                                   |
| UK-18  | reorder | on demand      | Svelte kit, same.                                                                                                                                                                                                              |
| UK-19  | reorder | on demand      | Angular kit, same.                                                                                                                                                                                                             |
| UK-20  | reorder | on demand      | React Native kit (4 to 6 weeks), same.                                                                                                                                                                                         |
| X-01   | reorder | on demand      | C# SDK (10 to 14 weeks): a seventh port multiplies every future feature again; only with a committed adopter.                                                                                                                  |
| F-32   | reorder | on demand      | NuGet feed only if X-01 goes ahead.                                                                                                                                                                                            |
| SP-28  | reorder | on demand      | Steam depot transport for non-Godot SDKs: no adopter; Godot already has it. `parity.json` planned entries keep pointing at the open package.                                                                                   |
| SP-29  | reorder | on demand      | MSIX and Flatpak transports for Node and Python: same.                                                                                                                                                                         |
| SP-30  | reorder | on demand      | Godot MSIX and Flatpak transports: until a Windows Store or Flathub game needs extension packs.                                                                                                                                |
| ST-18  | edit    | CQS-09, CQS-11 | `pkey settings diff/export` and `validate --against` on the command registry and personal tokens.                                                                                                                              |
| UK-41  | edit    | CQS-05         | The close-out also proves the `ui.*` symbols in `api.json`.                                                                                                                                                                    |
| UK-14  | keep    |                | Merge after its fix round; its `help.ts` becomes CQS-09's registry seed.                                                                                                                                                       |
| UK-13  | keep    |                | Merge as is; its ui.core becomes UK-12's base.                                                                                                                                                                                 |
| HA-13  | keep    |                | HA-12 already places the presentation parser in `client-core`; Node and React consume it.                                                                                                                                      |
| F-10   | keep    |                | Follow with the `dev` channel and automatic pruning (quick wins).                                                                                                                                                              |
| SP-00  | keep    |                | In review; `api.json` extends its registry rather than replacing it.                                                                                                                                                           |
| UK-02b | keep    |                | Its fixtures are what ui-core and both terminal kits run.                                                                                                                                                                      |
| UX-60  | edit    | CQS-07         | Not in `workpackages.json`; adopt as CQS-07. UX-61 and UX-62 belong to the products/onboarding and release domains and depend on it.                                                                                           |

---

## New work packages

| Id     | Title                                                     | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                             | Deps                   | Plan mode | Size    |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------- | ------- |
| CQS-01 | Generator registry and `pnpm gen`                         | `tools/generators.ts` declaring the 13 families (inputs, outputs, order, check); `pnpm gen`, `--check`, `--changed`, named runs; CI, `gate.sh` and pre-commit read it; generated `reference/generators.mdx` and AGENTS.md rule-3 table; a test that every `GENERATED` banner maps to a registered output; drop root `gen:mirrors`; old scripts as aliases.                                                                                        | none                   | no        | 1–1.5 w |
| CQS-02 | CI consolidation                                          | Composite `setup-js` action; `tools/ci-scope.json` shared with `gate.sh`; `changes` job and `ci-ok` aggregator; PR versus `main` matrices; merge `swift` and `apple`; one `pnpm gen --check` step; remove duplicated named test steps.                                                                                                                                                                                                            | CQS-01                 | no        | 1–1.5 w |
| CQS-03 | Corpus generator as family modules; drop the Swift mirror | Split `tools/sign-corpus.ts` into `tools/corpus/<family>.ts` plus `reference/`, byte-identical output; Swift `CorpusLocator` over `#filePath`; remove `Resources/v2` and `Resources/transcripts` and their generator targets; AGENTS.md rule 1 updated.                                                                                                                                                                                           | HA-12 merged           | no        | 1.5–2 w |
| CQS-04 | `client-core` takes the neutral TypeScript helpers        | Constants and copy emitted once into `client-core`; copy runtime; discovery parser and service map; activation outcome (one kind spelling); wire error reader; boot loop over a `BootDriver`; QR encoder (Worker, Node, React); release-fetch range logic. Node and React re-export for one minor. Proof: all transcripts and corpus replayed unchanged. Policy edit narrowing plan mode to the wire modules.                                     | none                   | yes       | 1.5–2 w |
| CQS-05 | SDK API registry and generated surface tests              | `conformance/parity/api.json` and schema; `parity.json` `symbols` exceptions; generated surface tests in six SDKs; `parity:check` extension; `reference/sdk-api.mdx`; per-service snippet data for the console's Integration section.                                                                                                                                                                                                             | CQS-01                 | no        | 1–1.5 w |
| CQS-06 | SDK API normalisation (0.9)                               | One option key set and construction call; config verbs (`get`, `getSecret`, `source`, `set`, `clear`, `clearAll`, `setting`, `onChange`); licence getters and `activate`; React `expectedServices`; Godot `product_slug`; Python `pinned_keys`; Kotlin options flattened; deprecated aliases; regenerated samples, docs and console snippets; migration table generated from `api.json`. Two slices: TS and Python, then Swift, Kotlin and Godot. | CQS-04, CQS-05         | no        | 2–3 w   |
| CQS-07 | `renderSdkSetup`: one SDK setup renderer (adopts UX-60)   | In `@polaris-key/manifest`; consumed by `pkey sdk` (language detection, typed catalog accessors folded in), the console (replaces `sdkQuickStart.ts`), the Godot dock, the Gradle plugin and the docs quickstarts; one Godot form; goldens and per-language parse checks; removes `sdkSnippet` and the legacy `pkey sdk` mode.                                                                                                                    | CQS-06, F-10           | no        | 1–1.5 w |
| CQS-08 | Runnable, CI-tested quickstart per SDK                    | `examples/{node,react,python,swift,kotlin,godot}-quickstart` from CQS-07's goldens; a small transcript replay server; each SDK's CI job runs its sample; scattered samples moved under `examples/` with one index.                                                                                                                                                                                                                                | CQS-07, CQS-02         | no        | 1.5 w   |
| CQS-09 | `pkey` command registry, context and doctor               | Typed command registry grown from UK-14's `help.ts` driving parse, help, completion, `reference/cli.mdx` and Action mapping; `--product`/`--base-url` from `.pkey/product` and `PKEY_BASE_URL`; `pkey doctor` as the integration verifier; `pkey validate --fix`.                                                                                                                                                                                 | UK-14                  | no        | 1.5–2 w |
| CQS-10 | Thin Action inputs                                        | `command`, `args`, secret inputs, `base-url`, `working-directory`, `dry-run`; product from `.pkey/`; old inputs accepted for one minor with a deprecation annotation; `publish-package.yml` and UX-62's workflow template moved over.                                                                                                                                                                                                             | CQS-09                 | no        | 0.5 w   |
| CQS-11 | `pkey login` and personal access tokens for the CLI       | Device-code sign-in against the console identity; scoped personal token in the OS keyring; replaces `PKEY_ADMIN_COOKIE` for `pkey bundle` and `pkey listing import`; feeds the developer feed token for `pkey sdk`; serves ST-18.                                                                                                                                                                                                                 | identity access tokens | yes       | 1 w     |
| CQS-12 | One copy pipeline                                         | `gen:constants` stops emitting `copy.generated.*`; each SDK's `core.copy` reads the `core.*` keys from its kit copy table; React and Node share one runtime from `client-core`; Node's kit table split per locale or loaded lazily.                                                                                                                                                                                                               | CQS-04, CQS-01         | no        | 1 w     |
| CQS-13 | Lint baselines with debt ledgers                          | knip and jscpd (TS), ruff and mypy (Python), ktlint and detekt (Kotlin), swift-format lint (Swift), gdlint (Godot); committed ledgers; report-only first, then blocking on new code.                                                                                                                                                                                                                                                              | CQS-02                 | no        | 1–1.5 w |

Order: CQS-01 and CQS-04 first (independent), then CQS-05, CQS-03 (right after HA-12), CQS-02,
CQS-06, CQS-12, CQS-07, CQS-09, CQS-10, CQS-08, CQS-13; CQS-11 when the identity domain's
access-token package lands. Total about 15 to 20 engineer-weeks, against 30 to 45 weeks removed or
deferred from the SDK lanes and a smaller cost for every future six-SDK feature.

---

## Quick wins

1. Delete the legacy `pkey sdk` mode without `--lang` (`packages/cli/src/index.ts:846-858`), which
   prints a Node snippet against `https://key.example.com`; until CQS-07, make it print usage.
2. Add `pnpm gen:settings -- --check` to `gate.sh` and `pnpm gen:storefront-ci -- --check` to
   `ci.yml`, so the lists agree until CQS-01 replaces them.
3. Remove the root `gen:mirrors` script and the commented-out block at `ci.yml:71-81`; `pkey mirror`
   is the supported tool.
4. One `resolveProductContext(parsed, cwd)` in the CLI: `--product` and `--base-url` default from
   `.pkey/product` for every command.
5. Accept `expectedServices` on `PolarisKeyProvider` (keep `expectServices` as a deprecated alias).
6. One `readWireError(body)` per SDK (Python's twelve sites first), returning `{code, message,
extra}` for both envelopes.
7. Fix the stale Worker path in `packages/sdk-node/src/qr/encoder.ts:6`.
8. Composite `setup-js` action for the 17 repeated setup blocks.
9. Drop the duplicate named steps in `ci.yml`'s `js` job that re-run what `pnpm test` ran.
10. Run `pkey feeds prune --apply` for the system product after each stable tag in
    `publish-sdks.yml`.
11. Publish our SDK prereleases on `dev` instead of `main`, keeping the npm `main` dist-tag one
    release.
12. Make the console's Godot quick start write `polaris_key_config.gd`, the form `pkey sdk` and the
    dock write.
13. Narrow the plan-mode trigger for `client-core` to its wire modules in CLAUDE.md, AGENTS.md and
    `.claude/agents/pkey-sdk-porter.md`, and update the rationale at
    `tools/gen-sdk-constants.ts:55-58`.
14. List `Swift: init(options:)` versus `create(options:)` once in the Swift quickstart and the
    generated sample (pick `create`).

---

## Cross-domain dependencies

- **Licensing.** Entitlement quantities, redemption and sub-licence grants shape LX-18's wire
  amendment and LX-19's SDK surface; batching LX-18 with I-24a is a licensing and identity decision
  (plan mode). Subscriptions need only `licenseExpiresAt()` and status reasons in the SDKs.
- **Config and Cloud Sync.** The single config API (target design §4) needs the config domain to name
  the visibility states and the Cloud Sync domain to accept `config.local` as its client API
  (U-06, U-07, U-20, U-21 and `plans/U-01.md`). Any change to the resolution order is a
  `config-matrix.json` change in all six SDKs.
- **Identity, access tokens and RBAC.** CQS-11 needs the per-user access-token model and its scopes;
  the CLI's session-cookie path retires with it. RBAC decides which developer roles may mint
  offline bundles.
- **Feeds.** Authenticated feeds change every SDK install snippet, `pkey feeds setup`, CQS-07's
  renderer, `publish-sdks.yml`'s drift job and `sdk-node/test/examples.test.ts`. Feed pruning and
  the `dev` channel come from the same work.
- **Products and onboarding.** The Integration section and its dismissal use CQS-07's renderer,
  CQS-05's per-service snippets and W15's SDK sightings; `pkey doctor` mirrors the console's verdict.
  UX-61 (Connect your app) and UX-62 (Publish from CI) depend on CQS-07 and CQS-10.
- **Release and distribution.** The Action and CLI consolidation (CQS-09, CQS-10) covers the
  transport and storefront steps (`ciPlane.generated.ts`, A-18h, A-18i, P5-08).
- **Worker code quality.** The two error envelopes (recommend: new device-facing routes use
  `wireError` only, enforced by a Worker test); the Worker's and admin's version comparators onto
  `client-core/version`; the Worker's QR encoder onto `client-core/qr`; the Worker's three
  generators join CQS-01's registry; the admin CSP is hand-maintained and parity-tested while the
  docs CSP is generated (one pattern).
- **Console.** `sdkQuickStart.ts` is replaced by CQS-07; `settings.generated.ts` is a registered
  output; generated reference pages need help-link entries in `nav.ts` and `docsLinks.ts`.
- **UI kits.** Tiering (should and could kits to on-demand), ui-core absorbing the terminal kits'
  headless models, and the Electron and Tauri merges.
- **Docs.** Three new generated reference pages; quickstarts embed CQS-07 goldens; the README-rendered
  SDK pages shrink once the reference is generated.
- **Program process.** The plan-mode boundary for `client-core`, the porter role's naming rule
  becoming a generated test, and the "porting kit" sequence for every new SDK-facing feature.
