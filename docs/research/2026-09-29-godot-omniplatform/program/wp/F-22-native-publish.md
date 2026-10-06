# F-22 Optional: native-client publish adapters (`npm publish`, `twine`, `swift package-registry publish`, Maven `PUT`)

| Field       | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-2)                                  |
| Size        | 2 engineer-weeks                                                         |
| Depends on  | [F-21](F-21-registry-auth.md)                                            |
| Unblocks    | none                                                                     |
| Role        | `pkey-implementer`                                                       |
| Plan mode   | no                                                                       |
| Gates       | rule 10 (the native publish routes); THREAT-MODEL (publish tokens in CI) |
| Human input | none                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                |

## Goal

Native clients publish directly: `npm publish` (`PUT` with `_attachments`), `twine` (the legacy multipart upload), `swift package-registry publish` (`PUT` multipart) and Maven `PUT`s. Each is translated into the same release descriptor and ingested by F-03's path, authorised by a `publish`-scoped `pkeyr_` token.

## Why

Some adopters will want their usual tooling. `pkey release publish` already covers CI ([S-12 §10 tier 2](../../notes/S-12-package-feeds.md#tier-2-designed-now-built-after-tier-1)).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §10](../../notes/S-12-package-feeds.md#10-proposed-work-packages).
- F-21's tokens.

## Scope

**In:**

- What the Goal names, plus its `REGISTRY_PATHS` rows, golden files and a client matrix in
  `registry-clients.yml`.

**Out:**

- Anything that changes tier-1 behaviour.

## Design notes

- This contradicts "no long-lived secrets in CI" unless tokens are short-lived and narrowly scoped. Say how in the PR.
- Request bodies are bounded by the zone's limit (100 MB on Free and Pro).

## Steps

1. Renderer or adapter, then routes, then matrix, then docs.

## Acceptance criteria

- [ ] The client matrix is green. `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

## Hand-off

- Optional: the lead takes this package only on an owner go decision.

The role agent sets `--set F-22 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-22 done`.

## Implementation notes (corrections against the code, F-22 branch)

- **The routes are Release's, on Distribution's host.** A native publish is Release's ingest
  (`ingestPackageDescriptor`), and rule 6 forbids Distribution importing Release, while
  `core/hooks.ts` keeps every hook read-only. So the four routes live in
  `services/release/packages/native/`, name `service: "release"`, carry a new
  `FEED_PUBLISH_ROUTE` mark, and read Distribution's feed settings only through the existing
  `delivery.packageFeed` hook. `mount.ts` adds them to `REGISTRY_ROUTES`; `RegistryRoute.methods`
  widens to `POST | PUT`. The credential check is Core's (`core/registryPublish.ts`), and the
  credential extractor moved from Distribution's `authorize.ts` to `core/registryCredential.ts`
  (re-exported unchanged).
- **Short-lived and narrow (the design note).** CI presents the 30-minute `pkeyci_` that
  `pkey auth github-oidc` exchanges (any `pkeyci_` with `release:publish`), so CI stores no publish
  secret. A `pkeyr_` publish token is owner-bound, header-only, names explicit publish ecosystems
  (npm, PyPI, Swift, Maven) and lasts 1 to 30 days (default 7) — stricter than F-20's 365-day cap,
  recorded in THREAT-MODEL §3 "Native-client publish (F-22)".
- **twine and Maven send a version as several requests**, and F-03 versions never gain files, so
  a new Release table, `release_native_uploads` (migration `0075`, renumbered from `0072` after main took 0072-0074, `TABLE_OWNERS.release`),
  gathers a version's files: Maven publishes on `maven-metadata.xml`, twine ten seconds after its
  last upload (`waitUntil` settle, held back by in-flight requests of the same token), and
  Release's new `scheduled` hook (the 15-minute connector cron) publishes idle sessions.
- **Swift manifests are read out of the archive** (bounded, `swiftArchive.ts`): SwiftPM needs
  `Package.swift` from the registry and a native publish sends only the archive. This is the one
  departure from "the Worker never unzips", scoped and reviewed in the threat model.
- **twine uploads carry no PEP 658 `core-metadata` file** (the Worker does not open wheels);
  PEP 658 is optional and pip/uv fall back to the wheel.
- **Request bodies are capped at 32 MiB**, below the 100 MB zone limit, because the body sits in
  the isolate's 128 MB while it is hashed and staged. Larger packages use `pkey release publish`.
- **The matrix.** `npm-publish`, `twine`, `maven-publish` and `gradle-publish` run the real
  client end to end. SwiftPM sends credentials only over HTTPS and the harness is plain HTTP, so
  `swift-publish` sends SwiftPM's own `--dry-run` output as SwiftPM's PUT with curl, then resolves
  the release with real SwiftPM (signature verified); SwiftPM's own HTTPS publish is a staging
  check for the owner.
