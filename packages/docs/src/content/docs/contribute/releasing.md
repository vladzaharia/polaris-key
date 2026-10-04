---
title: "Releasing"
description: "How the SDKs release from tags to their feeds on pkg.plrs.im (merging never publishes), and how the worker deploys — gated, D1-migrated, and smoke-checked."
sidebar:
  order: 6
---

Two kinds of release, independent of each other: the SDKs, each released by a tag to its package
feed on `pkg.plrs.im`, and the worker itself (a `v*` tag). Merging to `main` never publishes
anything — not even merging the Changesets "Version Packages" PR. Every release is a tag on a
commit that is already on `main`, and each SDK has its own tag namespace and workflow.

The SDKs go to Polaris Key's own feeds and **nowhere else**: no npmjs, GitHub Packages, PyPI,
Maven Central, Swift Package Index, Docker Hub or Godot store. The operator steps (the tag table,
dry runs, Swift signing, the first release in an environment) are in `docs/RUNBOOK.md`,
"Releasing our SDKs to the feeds", mirrored on [Operating](/docs/admin/kek/); how adopters
install each SDK is [Installing the SDKs from the feeds](/docs/build/install-from-feeds/).

## Publishing: one workflow for every feed

Every SDK workflow builds, tests and packs its files, uploads them as a workflow artifact, and
calls `.github/workflows/publish-package.yml`. That workflow is the system product
`polaris-key`'s one trusted publisher: it runs in the `package-registry` environment, whose
deployment policy admits tags only, refuses a ref that is not a tag or a commit that is not on
`main`, exchanges the job's OIDC token for a short-lived CI token, and runs
`pkey release publish` for one deliverable of the root `.pkey/release`. The repository stores no
publishing secret. A version with a pre-release part goes to the `beta` channel. A version is
unique forever: a failed publish that never landed can be re-run, a landed one cannot be
replaced (yank it and release the next version).

## JS SDKs: Changesets, then tags

1. Add a changeset describing the user-facing change: `pnpm changeset` picks the affected
   `@polaris-key/*` packages and a semver bump, and writes a markdown file under `.changeset/`.
   Write it for consumers — the "why", not a diff summary.
2. On every push to `main`, `.github/workflows/release.yml` first repeats the green gate
   (`build`, `typecheck`, `test`, `lint`) and then runs `changesets/action`, which opens or
   updates a **"Version Packages"** PR (`pnpm version-packages`, i.e. `changeset version` —
   bumps versions and writes changelogs from the pending changesets). That is all it does: the
   action has no `publish` input, so merging the PR bumps versions and publishes nothing.
3. To release, run `pnpm changeset tag` on the versioned commit on `main`. It writes one tag per
   package version, `@polaris-key/<name>@<version>`. Push the tags **one at a time**
   (`git push origin '@polaris-key/node@1.2.0'`) — GitHub starts no workflow for a push of more
   than three tags at once — and push a package's `@polaris-key` dependencies before it.
4. Each tag runs `release.yml` for that package: it checks the tag matches a public package's
   `package.json` version, builds and tests it, `pnpm pack`s it (which rewrites `workspace:*` to
   real versions), and publishes the tarball to the npm feed through `publish-package.yml`.
   `.changeset/config.json` sets `baseBranch: "main"`; internal `@polaris-key/*`
   cross-dependencies bump by `patch` automatically.

Keep changesets focused — one logical change each. As of this writing there are sixteen pending:
`boot-stage-machine`, `canonical-headers-config-matrix`, `channel-vocabulary`, `ci-publishing`, `core-caps`, `device-code-edge-mint`,
`distribution-service`, `edge-mint-hardening`, `fingerprint-storage-fixes`,
`free-tier-and-relicensing`, `hardware-fingerprinting`, `initial-release`,
`p1b07-license-config-release-gaps`, `pkey-init-validate`, `sdk-constants` and `service-table`,
together covering `@polaris-key/protocol`, `@polaris-key/jws`, `@polaris-key/catalog`,
`@polaris-key/manifest`, `@polaris-key/client-core`, `@polaris-key/cli`, `@polaris-key/node`,
`@polaris-key/react`, and the private `@polaris-key/worker` and `@polaris-key/admin`.

`release.yml` also checks the `polaris-key/publish` Action bundle is fresh
(`pnpm --filter @polaris-key/cli bundle:action -- --check`) and, on an `@polaris-key/cli` tag,
attaches the standalone `pkey.mjs` to that tag's GitHub release.

## The `pkey` image: with `@polaris-key/cli`

`.github/workflows/release-image.yml` runs on the same `@polaris-key/cli@<version>` tag. It
builds `packages/cli/image/Dockerfile` (the committed CLI bundle on `node:22-slim`) for
`linux/amd64` and `linux/arm64` into an OCI image layout and publishes it to the OCI feed through
`publish-package.yml`, as `pkg.plrs.im/polaris-key/pkey:<version>`.

## Python SDK: `python-v*` tags

`.github/workflows/release-python.yml` triggers on a `python-v*` tag push. It refuses to
publish if the tag doesn't match `sdks/python/pyproject.toml`'s version (`python-v$VERSION`),
then runs the full pytest suite from a clean venv, builds the sdist and wheel, and publishes them
to the PyPI-compatible feed on `pkg.plrs.im` through `publish-package.yml`. Nothing goes to PyPI:
releases already there stay, new versions are on the feed only.

## Swift SDK: `swift-v*` tags

`.github/workflows/release-swift.yml` triggers on a `swift-v*` tag push, validates the tag is
semver and its commit is on `main`, and runs `swift test`. A macOS job in the
`package-registry` environment then signs the release with
`sdks/swift/tools/sign-registry-release.sh` (`swift package-registry publish --dry-run` with the
signing flags, so no registry is contacted); it refuses to run without the three
`SWIFT_REGISTRY_*` secrets and never falls back to unsigned. `publish-package.yml` sends the
signed archive to the Swift registry feed, and a GitHub release of the tag follows, so the git-URL
path keeps working.

## Kotlin SDK: `kotlin-v*` tags

`.github/workflows/release-kotlin.yml` triggers on a `kotlin-v*` tag push (the version is
`version` in `sdks/kotlin/build.gradle.kts`). It builds and tests the Kotlin SDK and the Godot
Android binding, writes every Maven publication to a local repository
(`./gradlew publishAllPublicationsToLocalRepository`), and publishes each artifact to the Maven
feed through `publish-package.yml` (group `im.plrs.key`). Run by hand (`workflow_dispatch`) it is a
dry run: everything but the publish.

## Godot addon: `godot-v*` tags

`.github/workflows/release-godot.yml` triggers on a `godot-v*` tag push. The tag, `plugin.cfg`'s
version and `PolarisKey.SDK_VERSION` must agree; the zips are built reproducibly, the test runner
and the clean-install smoke test must pass, and then the canonical zip is published to the Godot
feed through `publish-package.yml` and a GitHub release follows. Run by hand
(`workflow_dispatch`) it is a dry run. Nothing goes to the Godot Asset Store or the Asset Library.

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
