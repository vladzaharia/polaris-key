# DOC-07a Start path

| Field       | Value                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Developers: start and build) |
| Size        | 0.4–0.6 engineer-weeks                                                                                                             |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md), [ST-37](ST-37-vocabulary-one-word-concept-rule-4.md)                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                             |
| Role        | `pkey-implementer`                                                                                                                 |
| Plan mode   | no                                                                                                                                 |
| Gates       | `docs-generated`, `docs-links`                                                                                                     |
| Human input | none                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                          |

## Owner decision (2026-10-08): public developer docs

The developer sections (`start/`, `build/`, `features/`, `reference/`) are public (owner decision, 2026-10-08; [docs plan](../../../2026-10-08-docs/README.md) D2). Operate → Console stays member-only; Operate → Platform, Contribute and the runbook stay admin-only. Where the text below assumes members-only developer pages, this wins.

- The landing copy labels only the Operate card "For console members"; the start path is public.

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- The fresh-reader run may use AX-05's harness (suite `first-product`).

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-07a (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** Landing copy (`index.mdx` content); `start/index`, `first-product` (interim), `choose-your-integration`, `how-it-works` (with the coherence-rule table), `concepts`; `build/install`

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`packages/cli/src/{help,sdkConfig,feedSetup}.ts`; the console's New product, Services, Licenses and Devices pages; `shared-manifest` and `core/services.ts` (both validators, for the table); `engines` (≥ 22.13.0); `sdk.docs-first-product`; the SP-37 scope

## Design notes

- Writes the 0.9.x interim path on today's console and CLI; SP-37 writes the final path after the wizard (§3.5). `concepts` waits for ST-37's word table.
- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Screen acceptance (brand transition, 2026-10-09)

N/A: no screen or state ships in this package (selected by the overview-04 rule on its gate or mention only).

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] The **fresh-reader run** (§6.2) on Node and Swift.
- [ ] Install steps rendered from `feedsSetup()`.
- [ ] `pkey-ux-reviewer` passes the rendered pages in built mode, both themes and phone (§6.3).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs test
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

The role agent sets `--set DOC-07a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-07a done`.

## Corrections and notes (builder)

- `InstallSteps` gained `sdk="cli"` (the `pkey` CLI on the npm feed); the Kotlin and Swift package names now match the console's quick start.
- `start/choose-your-integration` is added to the Developers sidebar (`doors.ts`).
- `start/choose-your-integration` no longer says every SDK has two lanes of equal depth. Node, React and Python have an own-UI guide; for Swift, Kotlin and Godot the own-UI lane is the SDK reference page, and the page says the walk-through guide is not built yet. SP-45b writes those guides; when it lands, restore the equal-depth claim and point the three table cells at the guides.
- The `FEEDS` mapping and labels moved from `InstallSteps.astro` to `packages/docs/src/lib/feeds.ts` so `packages/docs/test/installSteps.test.ts` can run the same mapping through `feedsSetup()` (all six SDKs and `cli`).
- The generated pip block is `pip install --no-deps …` (`packages/shared-manifest/src/feedSetup.ts:335`), so the pip path installs none of the Python SDK's dependencies (`sdks/python/pyproject.toml:21-28`: `cryptography>=41`, `httpx>=0.24`, `zstandard>=0.22` below Python 3.14). `build/install.mdx` and `start/first-product.mdx` now name them in one `pip install` line, and `installSteps.test.ts` pins that line to `pyproject.toml`. uv and Poetry resolve them from the default index.
- `<SdkPicker />` is `?sdk=` links with no script yet: the behaviour in docs plan §3.7 (read `?sdk=`, `localStorage`, `replaceState`) ships with DOC-02a. Until then every `<InstallSteps>` block shows, so `first-product` no longer says the picker selects one install; it says to use the block for your SDK. The component stays on both pages and needs no consumer change when the script lands.
- The builder did not run the fresh-reader run (§6.2) or the `pkey-ux-reviewer` pass. The run was done on 2026-10-11 and is recorded below: it is not met. The UX pass is still open (Open items).

## Fresh-reader run (docs plan §6.2), 2026-10-11

**Status: not met.** In the last round, steps 1 to 4 and the console half of step 6 ran with no unmentioned step on Node and on Swift. Every step still unmentioned is in step 5 or the app half of step 6, which send the reader to pages DOC-08a owns. The criterion stays open until DOC-08a's compiled quickstart snippets land and one reader finishes with none. No duration goes on the landing card or the page: no run was clean, and the times below are an agent's.

**How it ran.** The worker at this branch's HEAD (`wrangler dev --env test`, every migration applied to local D1, KV and R2) served the built console and the built docs on one origin, laid out as `assemble-assets.mjs` does. The Platform admin session was a cookie minted by the worker's own `issueSession` and injected into headless Chrome for Testing; signing in is not part of the page. Where the page says `key.plrs.im` the reader used the local origin. Packages came from the real feed on `pkg.plrs.im`: `@polaris-key/cli` and `@polaris-key/node` 0.9.3 and `polaris-key.PolarisKey` 0.9.3. The feed has no build of this branch, so the CLI and SDKs ran one release behind the worker. Six fresh `task` subagents, two per round, followed the page from an empty directory with a private `HOME` and were told never to read the repo; their transcripts show only the local docs URLs, the console and `/tmp` paths. Each kept a log and wrote a report. The harness stayed in `/tmp/pk-docrun` and is not committed.

| Round | Route and toolchain | Elapsed, agent-measured                     | Unlocked, device under Core → Devices    |
| ----- | ------------------- | ------------------------------------------- | ---------------------------------------- |
| 1     | Node 26.7, npm      | 175 s, 45 s of it browser trouble           | yes                                      |
| 1     | Swift 6.4 on macOS  | 345 s, 60 s of it browser trouble           | yes, after three workarounds (see below) |
| 2     | Node 22.13.1, npm   | 142 s                                       | yes                                      |
| 2     | Swift 6.4 on macOS  | 190 s from first reading, 167 s from step 1 | yes                                      |
| 3     | Node 26.7, npm      | 157 s                                       | yes                                      |
| 3     | Swift 6.4 on macOS  | 180 s                                       | yes                                      |

**Gaps on the page, fixed here** (the round that found each, and the round that confirmed it):

- The console's address was never given (found by reading the page; the harness had handed it to the readers). Step 1 now names `https://key.plrs.im/manage/`.
- The slug field fills `tidewater-studio` (round 1). Step 1 says to replace it; round 2 and 3 held.
- `pkey` is not on `PATH` after a project install, and only `pnpm exec pkey` was named (round 1, Node). Four forms are named; rounds 2 and 3 ran `npx pkey help`.
- "An empty directory works" is false for SwiftPM, and a Node project needs a `package.json` (round 1). Before you start names `npm init -y` and `swift package init --type executable`.
- `from: "1.0.0"` matches no release, so Swift could not resolve (round 1, blocking). `feeds.ts` passes `0.9.0`, which resolved 0.9.3 in rounds 2 and 3; the test pins it.
- Swift needed the platform floor, the product dependency and the file in the target, and the config file landed outside the target (round 1, one blocking). The pages give the macOS floor from `Package.swift` (the install page lists all four), the `.product(…)` line and `--out Sources/<Target>/PolarisConfig.swift`; the test pins them. Round 3 found the `dependencies` array unnamed. That fix, and a trim of Before you start item 3 and the Swift paragraph to fit the quickstart's 900-word budget (`lint:docs`), came after the last round and were not re-run.
- The page said to compare a fingerprint with the console, which shows the public key (round 1). It now compares the key; rounds 2 and 3 held.
- The output sample lacked the warning every new product prints first (round 1). Added.
- "The app reports that it needs activation" is not what the CLI kit or Swift prints (rounds 1 and 2). Step 5 states the status and what a drop-in kit shows; round 3 held.
- Where `registries.json` goes, that SwiftPM fetches the SDK's `zstd` and `Sparkle` from GitHub, and the license dialog's **I've stored it** gate (round 2). Named; round 3 hit none.
- The 404 from `pkey sdk` and `pkey: command not found`, which readers hit. Two lines under If it isn't working.

**Still unmentioned, owned elsewhere** (hand-off to DOC-08a unless noted):

- `build/quickstart/node`: the snippets import `./polaris.config.js` while `pkey sdk` writes `polaris.config.ts`; nothing says how to run TypeScript (Node 22.13.1 fails with `ERR_UNKNOWN_FILE_EXTENSION`, Node 26 strips types) or to set `"type": "module"` (round 3 hit it); `commander` is imported and never installed (it resolved only as a dependency of `@polaris-key/node`, which pnpm's strict layout would not give); no file name is given; `status` and `activate` appear only in the checkpoint table, and `needs-activation` shows only in `status --json`. The CLI kit's `activate` reads the key from a prompt, never an argument; that sits on DOC-08b's kit page.
- `build/quickstart/swift`: the snippet does not compile (`Bundle.main.appVersion`, `userEnteredKey`, no `@main` entry, no way to read a key); `client.status()` is not shown; it sets the registry with `swift package-registry set` and runs `pkey sdk` without `--product`, against this page's `registries.json` and flags.
- `build/sdks/swift` renders `sdks/swift/README.md`, which still says `from: "0.9.3"` and `.macOS(.v14), .iOS(.v17)` (`README.md:49`, `:51`) beside "macOS 15+" (`:31`), and that `pkey sdk --lang swift --write` writes `PolarisKey.plist` (`:80`). The CLI writes `PolarisConfig.swift` (`sdkConfig.ts:48` to `:53`), and `Package.swift:71` to `:76` says macOS 15, iOS 18.

**Findings outside this package:**

- The CLI's trust-pin header says "compare each fingerprint with the console" (`sdkConfig.ts:269` to `:281`), but the console shows the public key and key id only (`Keys.tsx:747`). The generated Swift file's comment shows `try PolarisKeyClient(options: …)` (`sdkConfig.ts:440`); the documented path is `try await PolarisKeyClient.create(options:)`.
- After **Create** on **New product**, the form flashed "tidewater is taken. Try tidewater-app." for about a second before the Overview opened (round 2, Swift).
- `ConsoleLink` builds `/manage/<to>`, but the console routes by hash: in a browser `/manage/products` opens Home. Only `to=""` works (DOC-03a, DOC-02a).
- The Swift floor in the published 0.9.3 is macOS 14 (the round 1 build failed below it); this branch says macOS 15. The pages state 15.
- The `0.9.0` in `packages/docs/src/lib/feeds.ts` moves with the version line (the 1.0 readiness review).

**Environment artefacts, not gaps:** two readers shared one browser profile in round 1 (fixed with a private `--user-data-dir`); a private `HOME` has no login keychain (`keychain(-60006)` in round 1, a keyring warning in round 2; later rounds got a provisioned keychain); the machine's global npm folder is read-only for a private `HOME`; Node 26 runs `.ts` files that Node 22.13 cannot.

## PR note: claim → file:line evidence (docs plan §6.3 item 7)

Paths are relative to the repo root. Pages are under `packages/docs/src/content/docs/`.

### start/first-product.mdx

| Claim                                                                                                               | Evidence                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creating a product needs the Platform admin role                                                                    | `packages/worker/src/console/handlers/products.ts:27`                                                                                                                                                |
| New product has **Start from** with **Nothing**                                                                     | `packages/admin/src/console/sections/global/pages/ProductNew.tsx:445`, `:460`                                                                                                                        |
| The create button reads **Create <name>**                                                                           | `ProductNew.tsx:421`                                                                                                                                                                                 |
| **<Name> is ready** on Overview, with the signing key                                                               | `packages/admin/src/console/sections/core/pages/Welcome.tsx:115`                                                                                                                                     |
| **Core → Services** exists; the License and Config switches save on their own                                       | `packages/admin/src/console/nav.ts:240` (Core), `:257` (Services); `packages/admin/src/console/sections/core/pages/Services.tsx:230`, `:289`                                                         |
| A product starts with License and Config on, the rest off                                                           | `tools/services.json:8`, `:21`, `:34`, `:47`, `:73`; `packages/worker/src/core/services.ts:53`; `packages/shared-manifest/src/index.ts:699`                                                          |
| Node 22.13 or later                                                                                                 | `packages/sdk-node/package.json:114`, `packages/client-core/package.json:120` (the SDK engines). The CLI's own bound is the repo's `>=22` (`package.json:8`); the page states the stricter SDK bound |
| The CLI binary is `pkey`, published as `@polaris-key/cli`                                                           | `packages/cli/package.json:2`, `:7`                                                                                                                                                                  |
| Install lines (routing, then install) come from `feedsSetup()`                                                      | `packages/docs/src/components/docs/InstallSteps.astro`, `packages/docs/src/lib/feeds.ts`, `packages/cli/src/feedSetup.ts:46`, `:104`; pinned by `packages/docs/test/installSteps.test.ts`            |
| The packages exist only on `pkg.plrs.im`; a bare `npx pkey` resolves from npmjs                                     | `packages/cli/README.md:12`; `packages/shared-manifest/src/feedSetup.ts:111` (`DEFAULT_REGISTRY_ORIGIN`)                                                                                             |
| The product's Overview shows the same lines under **SDK quick start**                                               | `packages/admin/src/console/sections/core/pages/Overview.tsx:1268`; `packages/admin/src/console/sections/core/model/sdkQuickStart.ts:2`                                                              |
| `pkey help` lists the commands                                                                                      | `packages/cli/src/index.ts:582`, `:583`                                                                                                                                                              |
| `pkey sdk --lang <lang> --product <slug> --write`                                                                   | `packages/cli/src/sdkConfig.ts:39`; `packages/cli/src/help.ts:246` to `:256`                                                                                                                         |
| The file written per SDK (the table)                                                                                | `packages/cli/src/sdkConfig.ts:48` to `:53`                                                                                                                                                          |
| `--base-url` for a console not at `key.plrs.im`                                                                     | `packages/cli/src/help.ts:107` (the `--base-url` default); `packages/cli/src/sdkConfig.ts:96` to `:112`                                                                                              |
| The output block: product line, `Services:`, trust pins with `sha256:` fingerprints, `Release keys: none`           | `packages/cli/src/sdkConfig.ts:269` to `:281`                                                                                                                                                        |
| A product with one signing key prints a warning to stage a second                                                   | `packages/cli/src/index.ts:1355`                                                                                                                                                                     |
| Signing keys are under **Core → Keys & secrets → Signing keys**                                                     | `packages/admin/src/console/sections/core/pages/Keys.tsx:80`, `:177`                                                                                                                                 |
| **License → Licenses → Create license**, then **Continue to terms**, then **Create license**; the key is shown once | `nav.ts:335`; `packages/admin/src/console/sections/license/components/CreateLicenseDialog.tsx:8`, `:389`, `:614`                                                                                     |
| The activated device appears under **Core → Devices**                                                               | `nav.ts:265`                                                                                                                                                                                         |

Added after the fresh-reader run (the Swift and CLI rows hold for `build/install.mdx` too):

| Claim                                                                                   | Evidence                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The console is at `/manage/`                                                            | `packages/worker/src/router.ts:130` to `:131`; `packages/worker/src/console/index.ts:3` to `:9`. `https://key.plrs.im/manage/` answered with the console shell ("Polaris Key — Manage") when checked; pinned by `installSteps.test.ts` |
| The form fills the slug from the name until it is edited                                | `packages/admin/src/console/sections/global/pages/ProductNew.tsx:95`, `:283`, `:286` to `:287`                                                                                                                                         |
| A project install runs through `npx pkey`, `pnpm exec pkey`, `yarn pkey` or `bunx pkey` | Run against the feed's `@polaris-key/cli` 0.9.3 with npm, pnpm 11.22, Yarn 4.18.1 and Bun; both pages pinned to the four forms by `installSteps.test.ts`                                                                               |
| `pkey sdk --out <path>`; the 404 text                                                   | `packages/cli/src/sdkConfig.ts:39` to `:42`; `:159` to `:161`                                                                                                                                                                          |
| The single-key warning prints first, on stderr                                          | `packages/cli/src/index.ts:1353` to `:1356`                                                                                                                                                                                            |
| The console shows the public key, not a fingerprint; the file pins the public key       | `packages/admin/src/console/sections/core/pages/Keys.tsx:747` (`KeyDisplay label="Public key"`); the generated `polaris.config.ts` and `PolarisConfig.swift` hold the key in `pinnedKeys`                                              |
| Swift floors, the `PolarisKey` product and the two GitHub dependencies                  | `sdks/swift/Package.swift:71` to `:76`, `:80`, `:106`, `:110`; pinned by `installSteps.test.ts`                                                                                                                                        |
| Swift `from: "0.9.0"`, never the generated `1.0.0`                                      | `packages/shared-manifest/src/feedSetup.ts:401` (the generator's default); `packages/docs/src/lib/feeds.ts`; the feed lists releases 0.8.18 to 0.9.3 and `0.9.4-main.*`, none at 1.x; pinned by `installSteps.test.ts`                 |
| `registries.json` is `.swiftpm/configuration/registries.json`                           | `packages/shared-manifest/src/feedSetup.ts:363`                                                                                                                                                                                        |
| Done stays disabled until the key is copied or **I've stored it** is ticked             | `packages/admin/src/ui/OneTimeSecretPanel.tsx:13` to `:14`, `:132`, `:189` to `:190`                                                                                                                                                   |

### build/install.mdx

| Claim                                                                                                 | Evidence                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feed URLs and package names per ecosystem (the table)                                                 | Run through `feedsSetup()` in `packages/docs/test/installSteps.test.ts` (npm, pypi, swift, maven, godot); `packages/cli/src/feedSetup.ts:104`                               |
| The platform's feeds are public: no account, no token                                                 | `packages/cli/src/feedSetup.ts:98` to `:100` (a credential is added only with `--token-env`); `docs/RUNBOOK.md:893` (only a non-public feed takes a `pkeyr_` token)         |
| Godot: AssetLib, then **Project → Project Settings → Plugins**; lands in `res://addons/polaris_key/`  | `sdks/godot/README.md:20` to `:31`                                                                                                                                          |
| Kotlin coordinates: umbrella, core, one module per service, platform/android per flavour, ui, billing | `sdks/kotlin/settings.gradle.kts:50` to `:84`; `sdks/kotlin/platform/build.gradle.kts:13`; `sdks/kotlin/samples/android-consumer/app/build.gradle.kts:70`                   |
| Every SDK carries the server's version in lockstep                                                    | `.github/workflows/publish-sdks.yml:4`                                                                                                                                      |
| Pre-releases `<next>-main.<N>`, and `<next>.dev<N>` for Python; never npm `latest`                    | `.github/workflows/publish-sdks.yml:7` to `:9`                                                                                                                              |
| A stable publish prunes the main builds at or below it; stable and beta are never touched             | `docs/RUNBOOK.md:1143` to `:1147`; `.github/workflows/publish-sdks.yml:784` to `:789`                                                                                       |
| The `pkey` image, `pkg.plrs.im/polaris-key/pkey:latest`, mounted at `/work`                           | `packages/cli/image/Dockerfile:4`, `:20`; `packages/cli/README.md:29`                                                                                                       |
| `pkey feeds setup … --token-env`; the Godot editor sends no credentials                               | `packages/cli/src/help.ts:604`, `:635`; `packages/cli/src/feedSetup.ts:55`, `:59` to `:62`                                                                                  |
| pnpm one-day age gate                                                                                 | `docs/RUNBOOK.md:1095`. The Yarn, npm and Bun settings in the age-gate table have no repo source: they are those clients' documented settings and were not re-verified here |

### start/how-it-works.md

| Claim                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Features group the services (Licensing, Managed config, Ship builds, Sign-in, Cloud Sync)                      | `packages/docs/src/lib/features.ts:38` to `:72`                                                                                                                                                                                                                                                                                                |
| Distribution needs Release, Update needs Distribution, Cloud Sync needs Config and Identity                    | `tools/services.json:48`, `:61`, `:87`; `packages/worker/src/core/services.ts:286` to `:306`                                                                                                                                                                                                                                                   |
| The coherence table: five codes, ingest versus enablement API                                                  | Enablement: `packages/worker/src/core/services.ts:287`, `:294`, `:302`, `:305`, `:311`, `:323`. Ingest: `packages/shared-manifest/src/index.ts:2815`, `:2826`, `:2837`, `:2846`, `:2798` (`config_without_activation` is a warning). `registration_requires_identity` is enablement-only: `packages/worker/src/core/registry.ts:453` to `:454` |
| Config on with License and Identity off is a warning in ingest                                                 | `packages/shared-manifest/src/index.ts:2790` to `:2800`                                                                                                                                                                                                                                                                                        |
| Config on, License off, `requires-license` declared is an error in the API                                     | `packages/worker/src/core/services.ts:316` to `:324`                                                                                                                                                                                                                                                                                           |
| A disabled service, an unknown service and an unknown route all return the same `404`                          | `packages/worker/src/core/registry.ts:375`                                                                                                                                                                                                                                                                                                     |
| The three document types and their endpoints                                                                   | `packages/shared-jws/src/index.ts:43` to `:50`; `packages/worker/src/core/cors.ts:109`, `:110`; `packages/worker/src/router.ts:187`; `packages/worker/src/core/discovery.ts:81`                                                                                                                                                                |
| Registration policy table, and the derived default (`requires-license`, else `requires-identity`, else `open`) | `packages/worker/src/core/services.ts:220` to `:226`; `packages/worker/src/core/register.ts:20` to `:26`, `:102`                                                                                                                                                                                                                               |
| Every refusal is the same `403 registration_closed`                                                            | `packages/worker/src/core/register.ts:76` to `:84`                                                                                                                                                                                                                                                                                             |
| A product that enables nothing still registers devices and serves its keys                                     | `packages/worker/src/core/services.ts:50` to `:60`; `packages/worker/src/router.ts:185` (`jwks.json`)                                                                                                                                                                                                                                          |
| Console edit takes ownership from the manifest; **Revert to manifest…** hands it back                          | `packages/admin/src/console/sections/core/pages/Services.tsx:433`, `:620`                                                                                                                                                                                                                                                                      |
| A record that can't be read falls back to License and Config                                                   | `packages/shared-manifest/src/index.ts:1374`                                                                                                                                                                                                                                                                                                   |

### start/concepts.md

| Claim                                                                                                                                                    | Evidence                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| License statuses `ok`, `grace`, `expired`, `revoked`, `needs-activation`, `version-too-old`, `version-too-new`, `channel-not-entitled`, `not-applicable` | `packages/shared-protocol/src/license.ts:42` to `:54`                 |
| `not-applicable` when License isn't enabled, and it counts as usable                                                                                     | `packages/shared-protocol/src/license.ts:42` to `:44`                 |
| Document type names, including bundle, feed and release                                                                                                  | `packages/shared-jws/src/index.ts:43` to `:50`                        |
| Developers see a `ps_…` pairwise subject                                                                                                                 | `packages/worker/src/core/accounts/accountSubjects.ts:28`, `:39`      |
| Feature names in the glossary                                                                                                                            | `packages/docs/src/lib/features.ts:38` to `:72`                       |
| Cloud Sync needs Config and Identity                                                                                                                     | `tools/services.json:87`                                              |
| SDKs are packages of the platform's own product `polaris-key`                                                                                            | `packages/cli/src/feedSetup.ts:104`, `packages/docs/src/lib/feeds.ts` |

Not re-verified in this pass (code claims carried over from the earlier glossary, owned by ST-37's word table): the config merge order, client precedence, the release and distribution model definitions and the console copy rules. ST-37 is their source of truth.

### start/choose-your-integration.md

| Claim                                                                            | Evidence                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node, React and Python have an own-UI guide                                      | `build/sdks/node/your-own-ui.md`, `build/sdks/react/your-own-ui.md`, `build/sdks/python/your-own-ui.md`                                                                                                                                                          |
| Swift, Kotlin and Godot have no own-UI guide; the link goes to the SDK reference | `build/sdks/swift.mdx`, `build/sdks/kotlin.mdx`, `build/sdks/godot.mdx` (no `your-own-ui` page exists under them)                                                                                                                                                |
| A drop-in kit exists for each SDK                                                | `build/ui/frameworks/{terminal-node,react,terminal-python,swiftui,compose,godot}.mdx`                                                                                                                                                                            |
| Each SDK has a headless layer to draw over                                       | `sdks/swift/Sources/PolarisKeyUICore/KitScreen.swift`, `sdks/swift/Sources/PolarisKeyUICore/States/KitStates.swift`, `sdks/godot/addons/polaris_key/ui/model/view.gd`; Kotlin's is `sdks/kotlin/ui` over `polaris-key-sdk` (`sdks/kotlin/ui/build.gradle.kts:1`) |

### Open items

- The fresh-reader run (§6.2) on Node and Swift was done on 2026-10-11 and is not met: see the run record above. It needs DOC-08a's quickstart snippets, then a reader who finishes with no unmentioned step. The measured time appears on the landing card and the page only then.
- The `pkey-ux-reviewer` pass of the rendered pages in built mode, both themes and phone (§6.3): **not run**. No agent of that type exists in this harness (the role text is `.claude/agents/pkey-ux-reviewer.md`). Built-mode capture works: a Playwright script against the worker serving the built docs took all seven pages at 1440 and 390 px, light and dark. On that capture, before the last text edits, no page scrolled sideways, each had one `h1`, and the theme key applied. Seen without a review: the `Requires` chips are unstyled (`pk-chip` and `pk-requires` have no CSS until DOC-02a), and `first-product` is about 10,050 px tall at 1440 px because every SDK block shows until DOC-02a's picker script ships. Schedule the reviewer once DOC-02a lands.
- The age-gate settings for Yarn, npm and Bun are not repo-verifiable; confirm against those clients' documentation before the PR merges.
- ST-38 owns the services prose in `how-it-works` and the concepts coherence section: `registration` wording there may change when ST-38 lands.
