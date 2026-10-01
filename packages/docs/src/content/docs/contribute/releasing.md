---
title: "Releasing"
description: "The Changesets flow for the JS SDKs, the Python and Swift tag releases, and how the worker deploys — gated, D1-migrated, and smoke-checked."
sidebar:
  order: 6
---

Four release surfaces, independent of each other: the JS SDKs (Changesets, on merge to `main`),
the Python SDK (a `python-v*` tag), the Swift SDK (a `swift-v*` tag), and the worker itself (a
`v*` tag). None of them is a single "cut a release" step — each has its own trigger, its own
workflow, and its own tag namespace.

All packages are currently at **`0.0.0`** — nothing has published yet.

## JS SDKs: Changesets

1. Add a changeset describing the user-facing change: `pnpm changeset` picks the affected
   `@polaris-key/*` packages and a semver bump, and writes a markdown file under `.changeset/`.
   Write it for consumers — the "why", not a diff summary.
2. On every push to `main`, `.github/workflows/release.yml` first repeats the green gate
   (`build`, `typecheck`, `test`, `lint`) and then runs `changesets/action`, which opens or
   updates a **"Version Packages"** PR (`pnpm version-packages`, i.e. `changeset version` —
   bumps versions and writes changelogs from the pending changesets).
3. Merging that PR runs `pnpm changeset publish`, authenticated to `npm.pkg.github.com` (GitHub
   Packages, not the public npm registry) via the workflow's `GITHUB_TOKEN`.
   `.changeset/config.json` sets `access: "restricted"` and `baseBranch: "main"`; internal
   `@polaris-key/*` cross-dependencies bump by `patch` automatically.

Keep changesets focused — one logical change each. As of this writing there are fifteen pending:
`boot-stage-machine`, `canonical-headers-config-matrix`, `channel-vocabulary`, `ci-publishing`, `device-code-edge-mint`,
`distribution-service`, `edge-mint-hardening`, `fingerprint-storage-fixes`,
`free-tier-and-relicensing`, `hardware-fingerprinting`, `initial-release`,
`p1b07-license-config-release-gaps`, `pkey-init-validate`, `sdk-constants` and `service-table`,
together covering `@polaris-key/protocol`, `@polaris-key/jws`, `@polaris-key/catalog`,
`@polaris-key/manifest`, `@polaris-key/client-core`, `@polaris-key/cli`, `@polaris-key/node`,
`@polaris-key/react`, and the private `@polaris-key/worker` and `@polaris-key/admin`.

`release.yml` also checks the `polaris-key/publish` Action bundle is fresh
(`pnpm --filter @polaris-key/cli bundle:action -- --check`) and, when Changesets publishes
`@polaris-key/cli`, attaches the standalone `pkey.mjs` to that GitHub release.

## Python SDK: `python-v*` tags

`.github/workflows/release-python.yml` triggers on a `python-v*` tag push. It refuses to
publish if the tag doesn't match `sdks/python/pyproject.toml`'s version (`python-v$VERSION`),
then runs the full pytest suite from a clean venv, builds the sdist/wheel, and publishes with
`pypa/gh-action-pypi-publish` over PyPI's trusted-publisher OIDC flow (`id-token: write`,
`environment: pypi` — no long-lived PyPI token stored in the repo).

## Swift SDK: `swift-v*` tags

`.github/workflows/release-swift.yml` triggers on a `swift-v*` tag push, validates the tag is
semver, runs `swift test`, and creates a GitHub release with `gh release create`. There is no
package-registry step — SwiftPM resolves dependencies straight from git tags, so the tag and
the GitHub release **are** the release.

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
