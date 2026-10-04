# F-10 Our SDKs onto the feeds: the root `.pkey/`, release workflows, Kotlin `maven-publish`, Swift signing and the first OCI image

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Depends on  | [F-04](F-04-npm-feed.md), [F-05](F-05-pypi-feed.md), [F-06](F-06-swift-registry.md), [F-07](F-07-maven-feed.md), [F-08](F-08-oci-registry.md), [F-09](F-09-godot-feed.md)                                                                                                                                                                                                                                                                                 |
| Unblocks    | none                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Plan mode   | no: follows [`plans/F-01.md`](../plans/F-01.md) §5                                                                                                                                                                                                                                                                                                                                                                                                        |
| Gates       | Action-bundle drift (workflows use the committed Action); docs links (`build/install-from-feeds.md`); CI (new `release-kotlin.yml`, changed release workflows)                                                                                                                                                                                                                                                                                            |
| Human input | the `package-registry` GitHub environment (deployment policy: the `main` branch and `v*` tags), branch protection on `main` and a `v*` tag ruleset; the Swift signing certificate and key as the `package-registry` secrets `SWIFT_REGISTRY_SIGNING_KEY`, `SWIFT_REGISTRY_SIGNING_CERT` and `SWIFT_REGISTRY_CERT_CHAIN` (the owner provides them later; the Swift job fails clearly until then). The trusted publisher registers itself (amendment below) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Goal

Every SDK this repository ships is published to its feed on `pkg.plrs.im` by CI, through `pkey
release publish` and trusted publishing under the `polaris-key` system product:

- npm: client-core, node, react, manifest, jws, protocol, catalog and cli (plus brand and
  zstd-wasm);
- PyPI: `polaris-key`;
- Swift: `polaris-key.PolarisKey`, signed;
- Maven: `im.plrs.key:polaris-key-platform` and `im.plrs.key:polaris-key-godot`;
- Godot: `polaris_key`;
- OCI: `polaris-key/pkey`.

Publishing to GitHub Packages and to PyPI stops (owner decision: feeds only). An adopter page
shows how to install each one.

## Why

The SDKs ship four different ways today, and the Kotlin AAR not at all ([S-12 §6.4](../../notes/S-12-package-feeds.md#64-how-todays-sdks-get-onto-the-feeds)).
The feeds exist to host them.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §5, §7.2.
- `.github/workflows/{release,release-python,release-swift,release-godot}.yml`,
  `sdks/kotlin/{build.gradle.kts,settings.gradle.kts,platform/build.gradle.kts}`,
  `sdks/godot/native/android/`, `sdks/swift/Package.swift`, `actions/publish/`.

## Scope

**In:**

- **The root `.pkey/`** (`product`, `release`) declaring the system product's package deliverables
  (plan §5.1), validated by `pkey validate`.
- **`release.yml`:** `pnpm pack` into `dist-pkg/`, then publish each package. **Remove**
  `changeset publish` to GitHub Packages.
- **`release-python.yml`:** publish the wheel and sdist. **Remove** the PyPI publish step.
- **`release-swift.yml`:** a macOS job that checks the signing secrets (§5.3's error text), runs
  `swift package-registry publish --dry-run` with the signing flags, publishes, and deletes the key
  files in an `always()` step.
- **Kotlin:** `maven-publish` on `:platform` and `:godot` with sources jar, POM and `.module`; a
  `build/repo` local repository; the new `release-kotlin.yml`.
- **`release-godot.yml`:** publish the canonical zip.
- **OCI:** a `Dockerfile` for the `pkey` image, multi-arch `buildx` to an OCI layout, and publish.
- **Docs:** `build/install-from-feeds.md`; each SDK README's install section.

**Out:**

- Feeds themselves (→ F-04 to F-09).
- Publishing to any public registry (owner decision).
- Claiming public names (plan Q2, a human action).

## Design notes

- Workflows use the committed `polaris-key/publish` Action, so CLI changes reach CI only through
  the Action bundle.
- The Swift job never falls back to unsigned. Without the secrets it fails with the exact message
  in plan §5.3.
- One ecosystem may land at a time, npm first, each once its feed's matrix is green.

## Steps

1. Root `.pkey/` and the bootstrap check against staging.
2. npm, then PyPI, Godot, Kotlin, OCI and Swift workflows, each verified on staging with a
   pre-release version.
3. Remove the old publish steps; the docs page; the READMEs.

## Acceptance criteria

- [ ] A tagged pre-release of each SDK appears on its staging feed, and its client installs it
      using the page's snippet.
- [ ] No workflow publishes to GitHub Packages, PyPI, npmjs or Maven Central.
- [ ] The Swift job fails with the documented message when a secret is missing.
- [ ] `bundle:action -- --check` and `check:links` pass. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli bundle:action -- --check
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
( cd sdks/kotlin && ./gradlew publishAllPublicationsToLocalRepository )
mise exec node@22 -- node packages/cli/dist/pkey.mjs validate
```

## Hand-off

- Adopters install from the feeds.
- F-21 later adds tokens to the same snippets.

The role agent sets `--set F-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-10 done`.

## Amendment (owner decision 2026-10-04)

The Kotlin SDK ([P6-05](P6-05-kotlin-sdk.md) and its children P6-06 to P6-12) adds modules beyond
`:platform` and `:godot`: `:core`, `:license`, `:config`, `:identity`, `:release`, `:update`,
`:packs`, `:sdk`, `:android` and `:ui`. Each carries its own `maven-publish` metadata, so
`publishAllPublicationsToLocalRepository` and `release-kotlin.yml` cover whatever modules exist when
this package lands, and the rest as they land. Kotlin artifacts go **only** to Polaris Key's Maven
feed: no Maven Central, no Sonatype, no `signing` plugin.

## Corrections (F-10 implementation, 2026-10-04: the code is the fact)

- **Maven coordinates are per module and per flavour.** P6-06 to P6-10 already gave every JVM
  module (`:core`, `:license`, `:config`, `:identity`, `:release`, `:update`, `:packs`, `:sdk`) a
  `maven-publish` publication with sources and `.module`, and `:platform` and `:godot` publish one
  coordinate per flavour (`polaris-key-platform-{play,direct}`, `polaris-key-godot-{play,direct}`),
  all into `sdks/kotlin/build/repo`. So `.pkey/release` declares twelve `maven.<artifact>`
  deliverables (`im.plrs.key:polaris-key-<artifact>`), not `maven.platform` and `maven.godot`, and
  `release-kotlin.yml` fails when `build/repo` holds an artifact the release does not publish
  (the amendment's `:android` and `:ui` join both lists as they land).
- **Deliverable ids** match `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`, so the Godot addon is
  `godot.polaris-key` (its package name stays `polaris_key`).
- **`artifacts.match` is a file-name glob** (the base name under `--dir`), never a path such as
  `dist-pkg/…`. The Godot feed gets the canonical zip staged alone, because the `-assetlib` zip
  matches the same glob.
- **One trusted publisher per product.** `ci_publishers` holds one workflow and one environment,
  so every release workflow calls the reusable `.github/workflows/publish-package.yml` (GitHub
  names the called workflow in `job_workflow_ref`), in the `package-registry` environment. The
  OCI image has its own `release-image.yml` on the `@polaris-key/cli@<version>` tag; its name on
  the feed is `pkey` (`pkg.plrs.im/polaris-key/pkey`).
- **npm releases are tags, not merges.** The owner ruled that nothing publishes yet and that the
  Changesets "Version Packages" PR stays open: `release.yml` keeps the version PR (with no
  `publish` input) and publishes one package per `@polaris-key/<name>@<version>` tag
  (`pnpm changeset tag`).
- **Verify:** `packages/cli/dist/pkey.mjs` does not exist; the standalone CLI is
  `node actions/publish/dist/index.js validate` (or `packages/cli/dist/bin/pkey.js`).
- **Gap (not F-10's to fix): the system product cannot take the root `.pkey/`.** A package publish
  is checked against `release_deliverables`, which only a repository link or resync writes, and
  `linkRepo` refuses the reserved slug while `resyncRepo` needs `release_source = 'github'`, which
  the bootstrap never sets. Until a follow-up lets the bootstrap link the system product to
  `vladzaharia/polaris-key` (F-03's area), every package publish is refused as
  `invalid_descriptor`. The trusted publisher can be registered meanwhile by claiming it
  (`PUT /manage/api/products/polaris-key/ci-publisher`; DEPLOYMENT §2).
- **Acceptance criterion 1 waits on that gap and on real R2.** No tagged pre-release can land on a
  staging feed until the system product holds `release_deliverables`; the lead either accepts F-10
  without it or holds `done` until the F-03 follow-up lands and a staging run of each SDK succeeds.
- **Also removed:** the root `.npmrc`'s `@polaris-key:registry = https://npm.pkg.github.com`, the
  last of the GitHub Packages setup (`plans/F-01.md` §5), now guarded by `releaseWorkflows.test.ts`.
- **Follow-ups to file:** link the system product to the monorepo (F-03's area, above); delete
  `sdks/godot/store/CHECKLIST.md` and `LISTING.md`, which describe the store submission the owner
  ruled out; the pip dependency route for the Python SDK (F-12).

## Amendment: automation (owner decision 2026-10-04, binding)

The owner ruled the SDKs are registered on and kept updated on our feeds **automatically**, in
**lockstep with the server**, and that all legacy SDK deployment infrastructure goes. The
automation pass implements it:

- **Triggers and versions.** `.github/workflows/publish-sdks.yml` publishes every SDK on every push
  to `main` (semver `<next>-main.<N>`, PEP 440 `<next>.dev<N>`, channel `main`: npm dist-tag
  `main`, never `latest`) and, called by `deploy.yml` after the deploy and the registration, on
  every `v*` tag (exactly that version; `stable`, or `beta` for a prerelease tag).
  `tools/sdk-version.mjs` derives the version from git (`<next>` = the patch after the newest `v*`
  tag, `<N>` = commits since it) and stamps it into every SDK after its tests; nothing is
  versioned by hand or committed back. Unit-tested in `tools/sdk-version.test.ts`.
- **Removed.** `release.yml` (Changesets), `release-python.yml`, `release-swift.yml`,
  `release-godot.yml` (and its GitHub Release and asset-lib zip), `.changeset/`, the `changeset`
  and `version-packages` scripts and `@changesets/cli`, `sdks/godot/store/`. `release-kotlin.yml`
  and `release-image.yml` (this package's own, on `kotlin-v*` and `@polaris-key/cli@*` tags) are
  folded into `publish-sdks.yml`, because lockstep leaves no per-SDK tag to run them on.
  `package.py` no longer builds the asset-lib zip or requires a CHANGELOG section.
- **Registration** (the F-03 follow-up the Corrections below found). `POST /webhooks/deploy`
  (`packages/worker/src/platformDeploy.ts`), called by `deploy.yml` on every deploy through
  `scripts/register-platform.mjs` and authenticated by the deploy job's own GitHub OIDC token
  (policy: the prod vars `PLATFORM_REPOSITORY*`, `deploy.yml`, `production`, a protected `v*`
  tag), runs `ensureSystemProduct` (idempotent; an operator's switches stay off) and the new
  `linkSystemProduct`: `release_source = 'github'`, the `release_config` coordinates and
  manifest-owned columns, the package deliverables and the manifest-owned trusted publisher with
  the configured numeric ids. Narrative-only route (as `githubWebhook`), no OpenAPI path; no new
  table (the single-use `jti` reuses `idx_ci_tokens_jti`).
- **Drift.** The `drift` job runs `tools/feed-drift.mjs`: every package's newest version of the
  build's kind on its feed must be the build's (npm dist-tag and image tag included), or the run
  fails naming each package.
- **Environment.** `publish-package.yml` takes the channel from the version job and refuses any
  ref but `main` and `v*`; `package-registry`'s deployment policy is `main` plus `v*`; the Swift
  signing job runs there and is signed or nothing.

Corrections found by proving it locally (`pnpm --filter @polaris-key/worker registry:self-publish`,
the whole pipeline against a local Worker with each real client):

- A package publish's `channel` must be a declared channel: the root `.pkey/release` declares the
  manual channel `main`, and the link re-applies `manual_channels_json` on every deploy.
- The npm feed made the newest prerelease `latest` when nothing was on `stable`, so every
  `-main.N` build would have been `latest` until the first release: a prerelease another
  channel's tag names is no longer the `latest` fallback (`npm/render.ts`).

What only CI or production can prove: GitHub's real OIDC tokens and the `package-registry`
deployment policy, real R2 temporary credentials and the S3 upload, the Swift job with the real
certificate, the Linux and Android runners, and the first deploy registering against production
D1. The acceptance criterion "a tagged pre-release of each SDK appears on its staging feed" stays
open until a production deploy and a `main` push have run; the staging environment has no deploy
hook vars (DEPLOYMENT §2).
