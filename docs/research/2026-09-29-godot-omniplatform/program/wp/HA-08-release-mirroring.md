# HA-08 Release-file mirroring: pull GitHub and external release files into R2 on sync, webhook and descriptor ingest (verify `digest` and descriptor SHA-256), append an `r2` location, backfill existing releases, legacy aliases prefer the copy

| Field       | Value                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 3: serve)                                         |
| Size        | 1–1.5 engineer-weeks                                                                                                      |
| Depends on  | [HA-01](HA-01-hosted-asset-core.md), [HA-05](HA-05-pull-on-sync.md)                                                       |
| Unblocks    | [HA-09](HA-09-portal-mirrored-downloads.md), [HA-10](HA-10-hosting-settings.md), [HA-15](HA-15-hosted-assets-closeout.md) |
| Role        | `pkey-implementer`                                                                                                        |
| Plan mode   | no                                                                                                                        |
| Gates       | migration; THREAT-MODEL; workerd lane; wrangler config                                                                    |
| Human input | none                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                 |

## Goal

Every release file whose location is `github` or `external` gets a verified R2 copy and an `r2` location, so `serveArtifact` serves our bytes first. A backfill covers existing releases. No signed document, feed URL or client changes.

## Why

Release bytes still cross GitHub on every download, and `external` locations are a blind 302 ([S-20 §4.3](../../notes/S-20-hosted-assets.md#43-release-deliverables-and-update-feeds)). The signed documents pin hashes only, so mirroring is invisible to clients except as availability (decision 6).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §4.3, §5 (DJDL sizes), §6.8.
- `src/services/release/store.ts`, `source.ts`, `descriptor.ts`, `githubWebhook.ts`, `src/services/distribution/bytes.ts` (`serveArtifact`, `LOCATION_RANK`), `shared-manifest/src/descriptor.ts` (locations).

## Scope

**In:**

- Enqueue a mirror job per asset from `syncReleaseStoreReport`, the webhook path and descriptor ingest.
- Consumer: GitHub assets through `GET /repos/{o}/{r}/releases/assets/{id}` with `Accept: application/octet-stream` and the installation token. External URLs through `safeFetch` (file kind, 4.995 GiB cap). Verify against GitHub `digest` and the descriptor's `sha256`. `putVerified`, then a `release-artifact` ref, then append `{provider:"r2", key}` to `locations_json`.
- Backfill: a one-shot cron batch plus an operator action (`POST /admin/products/:p/assets/mirror`), bounded per run.
- The legacy `/release/dl/...` and `/dl/<selector>/<binary>-<arch>` aliases serve the R2 copy when the matched asset's digest has one.
- Respects `assets.releases.mirror` once HA-10 lands (code default on).

**Out** (and where it belongs instead):

- Portal ticketed downloads (→ HA-09). Quotas as settings (→ HA-10). Files over 4.995 GiB (multipart, later).

## Design notes

- A digest mismatch never promotes. It marks the job failed and keeps GitHub serving.
- `locations` are not in the signed record, so appending is safe (`shared-protocol/src/release.ts`).

## Corrections from the code (HA-08 builder, 2026-10-06)

The code is the fact; these replace the Scope wording where they differ.

- **The copy has two holders.** The bytes go through HA-01's `ingest` into the slot
  `release-file:<sha256>` (HA-01 built that slot class, the `release-mirror` origin and the
  `github-asset` source kind for this package), which writes the `hosted_assets` row and its
  `hosted-asset` ref. The `release-artifact` ref named in Scope (`<release_id>/<artifact_id>`) then
  holds the appended `r2` location, so the location stays an app artifact's on the blob route
  after HA-07 makes `hosted-asset` refs non-app-side. Neither kind is dropped by the collector.
- **The job state is a new Release table, `release_mirrors`** (migration `00XX_release_mirrors.sql`,
  the lead numbers it; `TABLE_OWNERS.release`). A synced file with no artifact map has no recorded
  `sha256`, so per-file back-off cannot live on the per-content `hosted_assets` row. Whether a file
  is owed is read from `release_artifacts.locations_json`, never from the table.
- **A synced file's `sha256` is filled** from the verified hash when the copy is appended:
  `serveArtifact` serves an `r2` location only for an artifact with a `sha256`, and a sniffed row
  (no artifact map) never recorded one.
- **Release files get a longer fetch budget.** `safeFetch`'s 30 s cannot move a large file;
  a release file's pull gets 30 s plus a second per 10 MiB, at most 10 minutes
  (`SAFE_FETCH_FILE_TIMEOUT_MS`, `releaseFileTimeoutMs`). `ingest` also takes the expected size
  and a redirect host rule (a GitHub asset reaches only the API and GitHub's storage hosts).
- **The operator action is `POST /manage/api/products/<slug>/assets/mirror`** (the console API's
  spelling of `/admin/products/:p/assets/mirror`), with an OpenAPI entry and a `routeCoverage`
  row. The "one-shot cron batch" is the nightly sweep's `releaseMirrors` step: it backfills every
  existing release on first deploy (at most 100 files a night) and then only retries failures.
- **`assets.releases.mirror`** is read in one place, `services/release/mirrorSwitch.ts`; until
  HA-10 it answers the code default (on) for every product that runs Release.
- **Only app releases are mirrored.** A pack's objects are authorised by its gate on the blob
  route, and a package release is r2-located already.

## Steps

1. Producer hooks.
2. Consumer.
3. Backfill.
4. Legacy aliases.

## Acceptance criteria

- [ ] After a sync, a fixture release's files serve from R2 with an unchanged ETag/sha256 (test).
- [ ] Corrupted bytes are refused and GitHub keeps serving (test).
- [ ] `pnpm gen:corpus -- --check` and `pnpm gen:transcripts -- --check` stay green (no wire change).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

HA-09 prefers the R2 copy in the portal. HA-15 runs the production backfill.

The role agent sets `--set HA-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-08 done`.
