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
- Not done here: the fresh-reader run (§6.2) on Node and Swift and the pkey-ux-reviewer built-mode pass (both themes, phone) need the lead to schedule them. The first-product page is written on today's console and CLI.

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

- The fresh-reader run (§6.2) on Node and Swift: needs the lead or a human to schedule it. The measured time appears on the landing card and quickstart only after it.
- The `pkey-ux-reviewer` pass of the rendered pages in built mode, both themes and phone (§6.3): needs the lead to schedule it.
- The age-gate settings for Yarn, npm and Bun are not repo-verifiable; confirm against those clients' documentation before the PR merges.
- ST-38 owns the services prose in `how-it-works` and the concepts coherence section: `registration` wording there may change when ST-38 lands.
