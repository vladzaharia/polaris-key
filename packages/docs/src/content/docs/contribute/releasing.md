---
title: "Releasing"
description: "How every SDK publishes itself to its feed on pkg.plrs.im, in lockstep with the server, on each push to main and each v* tag, and how the worker deploys — gated, D1-migrated, smoke-checked, and registering its own packages."
sidebar:
  order: 6
---

One version for everything. Every SDK this repository ships is versioned in **lockstep with the
server** and published **automatically** to Polaris Key's own feeds on `pkg.plrs.im` (owner decision
2026-10-04):

| Trigger          | What every SDK publishes                                                                                                                                                            | Channel                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| a push to `main` | a prerelease of the next version: semver `<next>-main.<N>` (npm, Swift, Maven, Godot, the `pkey` image) and PEP 440 `<next>.dev<N>` (PyPI)                                          | `main` (npm dist-tag `main`)                     |
| a `v*` tag       | exactly the tag's version (`v0.9.0` → `0.9.0` everywhere; `v1.0.0-rc.1` → `1.0.0-rc.1`, PyPI `1.0.0rc1`), after the worker that tag deploys is live and its packages are registered | `stable` (`latest`), `beta` for a prerelease tag |

`<next>` is the patch after the newest `v*` tag reachable from the commit (`v0.8.12` → `0.8.13`;
after a prerelease tag, the version it heads for), and `<N>` is the number of commits since that tag,
so every push to `main` publishes a version none before it took, and it always sorts after the last
release and before the next one. Nobody chooses or edits a version: there are no Changesets, no
version PRs and no per-SDK tags. A prerelease tag must be one PyPI can spell too: `-alpha.N`,
`-beta.N` or `-rc.N` (`deploy.yml` refuses any other tag before it deploys). In SemVer order a
`<next>-main.<N>` build sorts above `<next>-beta.<N>` and below `<next>-rc.<N>`; that is harmless,
because `main` and `beta` are separate channels and the drift check compares a build only with
builds of its own kind.

The SDKs go to Polaris Key's own feeds and **nowhere else**: no npmjs, GitHub Packages, PyPI,
Maven Central, Swift Package Index, Docker Hub, GHCR, Godot store or GitHub Release. The operator
steps (the `package-registry` environment, Swift signing, what to do when a publish or the drift
check fails) are in `docs/RUNBOOK.md`, "Releasing our SDKs to the feeds", mirrored on
[Operating](/docs/admin/kek/); how adopters install each SDK is
[Installing the SDKs from the feeds](/docs/build/install-from-feeds/).

## The version: derived from git, stamped by CI

`tools/sdk-version.mjs derive` computes the version from the ref being built (and, for `main`, from
`git describe` and `git rev-list --count`; the job checks out the whole history). `tools/sdk-version.mjs
stamp` then writes it into every SDK's version file, after that SDK's tests have run on the
committed tree: every public `packages/*/package.json` (and `pnpm pack` rewrites each `workspace:*`
range to it, so the packages depend on each other at exactly this version),
`sdks/python/pyproject.toml` (in its PEP 440 spelling), `POLARIS_SDK_VERSION` in Swift and Kotlin,
`version` in `sdks/kotlin/build.gradle.kts` (the Godot Android binding shares it), and the Godot
addon's `plugin.cfg` and `SDK_VERSION`, and `SDK_VERSION` in `packages/sdk-react/src/version.ts`
(the browser bundle cannot read its `package.json`, so the npm job rebuilds after stamping). Each
of those lines must exist exactly once, so a moved
version line fails the publish instead of shipping a wrong version. The stamp is never committed:
the versions in the tree are placeholders.

## Publishing: `publish-sdks.yml`, then one trusted publisher

`.github/workflows/publish-sdks.yml` runs on every push to `main`, and `deploy.yml` calls it on
every `v*` tag once the worker is deployed. One job derives the version; then, per SDK, a job tests,
stamps, builds and packs it, and uploads its files as a workflow artifact:

- **npm** — every public `@polaris-key/*` package, `pnpm pack`ed into its own directory;
- **PyPI** — `polaris-key`'s wheel and sdist (`python -m build`);
- **Swift** — `polaris-key.PolarisKey`, signed on macOS in the `package-registry` environment by
  `sdks/swift/tools/sign-registry-release.sh` (`swift package-registry publish --dry-run` with the
  signing flags, so no registry is contacted). It refuses to run without the three
  `SWIFT_REGISTRY_*` secrets and never falls back to unsigned; an `always()` step deletes the key
  files;
- **Maven** — every publication of the Kotlin SDK and the Godot Android binding
  (`./gradlew publishAllPublicationsToLocalRepository`, group `im.plrs.key`), checked against the
  twelve artifacts `.pkey/release` declares;
- **Godot** — the addon's reproducible zip (`sdks/godot/tools/package.py`), after the test runner
  on the 4.7.2 editor and release template and a clean install on 4.4.1 and 4.7.2;
- **OCI** — the `pkey` image (`packages/cli/image/Dockerfile`, the committed CLI bundle on
  `node:22-slim`) for `linux/amd64` and `linux/arm64`, as an OCI image layout.

Each package is then published by `.github/workflows/publish-package.yml`, the system product
`polaris-key`'s one trusted publisher: it runs in the `package-registry` environment, refuses a ref
other than `main` or a `v*` tag, a commit that is not on `main`, or a channel that does not fit the
version, exchanges the job's OIDC token for a short-lived CI token and runs `pkey release publish`
(the committed `polaris-key/publish` Action) for one deliverable of the root `.pkey/release`. The
repository stores no publishing secret. A version is unique forever: a failed publish that never
landed can be re-run, a landed one cannot be replaced (yank it; the next push or tag publishes the
next version).

Last, the **drift check** (`tools/feed-drift.mjs`) reads every package's version listing back from
its feed, as a client would, and fails the run unless each one's newest version of this build's kind
is this build's version (and npm's dist-tag and the image's tag for the channel name it), retrying
for up to ten minutes while the feeds' render queue catches up.

## npm: dependency order and closure

The npm packages depend on each other at exactly the build's version, so a version whose sibling
never reached the feed cannot install. GitHub occasionally leaves one deployment to
`package-registry` in `waiting` for good, and when all ten legs ran in one matrix the others
published anyway: `jws@0.8.28` and `protocol@0.8.29` never landed, and nine versions pin them. Three
things keep that from happening again:

- **Tiers.** `publish-sdks.yml` publishes the npm packages in six jobs, each needing the one
  below: `brand`, `protocol`, `zstd-wasm`; then `catalog`, `jws`; then `client-core`, `manifest`;
  then `ui-core`; then `node`, `react`; then `cli`. A leg that fails, is cancelled or stays in `waiting` stops every
  tier above it. `releaseWorkflows.test.ts` derives the order from each package's dependencies and
  simulates a stuck leg in every tier, so a new dependency that breaks the order fails CI.
- **The gate.** Before any npm publish, `publish-package.yml` reads the packed tarball's
  `package.json` and waits until the feed lists every `@polaris-key` version it pins
  (`tools/feed-closure.mjs requires`). A re-run of one leg cannot skip a missing dependency.
- **The closure check.** `tools/feed-closure.mjs` reads every packument and fails on a pin to a
  version the feed does not list. The drift job runs it for the version just published, the
  `npm-install` job then installs from the feed in empty directories (pnpm 11 with its one-day age
  gate, npm with React's peers, and this build's exact set), and `feed-closure.yml` checks every
  version on the npm and PyPI feeds daily.

`.github/workflows/npm-repair.yml` backfills a version a tag's own run never published. It is
dispatched by hand on `main` with a release tag and the package names. It builds those packages at
the tag, refuses a version the feed already has or a pin the feed lacks, and publishes through
`publish-package.yml` on the tag's channel. The steps are in `docs/RUNBOOK.md`, "Releasing our SDKs
to the feeds".

## Proving it locally

`pnpm --filter @polaris-key/worker registry:self-publish` runs the whole pipeline against a local
worker (`wrangler dev --env test`), for a `main` round and a `v*` round: the version derivation, the
stamp, every SDK built as CI builds it (Swift signed by a throwaway CA), the deploy hook through the
script `deploy.yml` runs, every package published with the CLI's own `publishPackage` through the
real trusted-publishing exchange, the drift check, and each SDK installed back with its real client
(npm, uv, SwiftPM with signature verification, Gradle, the Godot feed plus a real Godot clean install,
crane and `docker run`). Only GitHub's OIDC issuer and R2's S3 endpoint are stand-ins.

## The worker: `v*` tags

`.github/workflows/deploy.yml` triggers on a `v*` tag push and only ever runs against the
canonical repo (`github.repository == 'vladzaharia/polaris-key'`), with a `concurrency` group
that serializes deploys so two tags can never race.

1. **Validate the tag and its ancestry.** The tag must be semver, and — the load-bearing check
   — the tagged commit must be an ancestor of `origin/main`
   (`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`). A tag name alone was once the
   only gate, which meant a tag pointing at any commit, reviewed or not, would deploy to
   production; this closes that hole.
2. **Apply D1 migrations** (`wrangler d1 migrations apply --remote`), then re-run the newest
   `migrations/*_index_assertion.sql` (`0018_index_assertion.sql`, succeeded by
   `0027_i_index_assertion.sql`) unconditionally on every deploy. Each successor carries the
   full required-index list, so re-running an older one would stop checking the indexes added
   since. Migration bookkeeping
   means a migration's SQL runs exactly once per database, which is the wrong cadence for an
   invariant a route silently depends on — re-asserting it on every deploy turns "a required
   index vanished" into a failed deploy instead of a latent correctness bug.
3. **Assemble static assets** — `pnpm --filter @polaris-key/worker assemble` builds the admin
   SPA and this docs site into the worker's one `[assets]` root (see
   [Monorepo layout](/docs/contribute/layout/)) — then `wrangler deploy`.
4. **Smoke-check on content, not just status code:**
   - The data plane: `https://key.plrs.im/djdl/.well-known/jwks.json` must return a non-empty
     `keys` array. This deliberately isn't the admin SPA — a static asset returns `200` even
     with D1, KV, and the whole licensing path down — so the probe exercises the router, D1,
     product load, and opening the signing key under the platform KEK.
   - **The `/docs` gate probe:** an unauthenticated `GET /docs/` must be a `302` into
     `/manage/login`. A `200` would mean the platform-admin gate is off; a `5xx` would mean the
     assembled assets are broken. Either fails the deploy.
