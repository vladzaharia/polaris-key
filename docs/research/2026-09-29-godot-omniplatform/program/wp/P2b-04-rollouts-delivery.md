# P2b-04 Outlet-scoped rollouts and halts; delivery access and byte serving move to distribution

| Field       | Value                                                                                                                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2b: Distribution core                                                                                                                                                                                                                                                                                                                        |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                                                                                                                          |
| Depends on  | [P2b-02](P2b-02-distribution-manifest.md), [P2-05](P2-05-release-routes.md)                                                                                                                                                                                                                                                                   |
| Unblocks    | [P2b-05](P2b-05-storefront-feeds.md), [P2b-06](P2b-06-download-page-matrix.md), [P3-03](P3-03-feed-composition.md), [P4-05](P4-05-pack-transports-cdn.md), [P4-14](P4-14-readiness-gc-rollouts.md), [P5-02](P5-02-asc-connector.md), [P5-03](P5-03-play-connector.md), [P6-03](P6-03-update-funnel-autohalt.md), [P6-04](P6-04-hosted-web.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                            |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                            |
| Gates       | rule 10 (canonical routes move; permanent aliases added to `ALIAS_PATHS`); D1 migration + `TABLE_OWNERS`; `test/attack/R6-release.test.ts` and the portal R6-12 tests; threat model (access moves services)                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                     |

## Goal

Distribution owns rollout percentage, pause, resume, halt and completion **per outlet and
channel** for every deliverable, controlled by operators and CI and exposed through the `delivery`
hook. Distribution also owns **all byte delivery**: `/release/dl`, `install.sh` and P2-05's
builds, files and blob routes have canonical paths under `/{product}/distribution/…`, and every old
spelling keeps working as a permanent alias. **Delivery access** (`public`, `authenticated`,
`licensed`, `entitled`) moves from `release_config.artifacts_access` to `dist_access` per
deliverable, and the appcast, the portal and the byte routes all read the same answer.

## Why

Rollout and halt are outlet-scoped: Apple's phased release, Play's `userFraction` and Polaris
Key's own client-evaluated buckets are per outlet, while pointer, floor and yank stay release's
([README §3.9](../../README.md#39-rollouts-halts-and-telemetry)). "Release writes records;
distribution serves bytes", and today's access modes "move here as distribution's delivery
access" ([§3.5](../../README.md#35-storage-and-byte-delivery),
[§3.2](../../README.md#32-service-model-release-distribution-and-update-across-everything-delivered)).
Today the feed can offer what the download refuses, because the two read access separately
([notes/A1 §1.6–§1.7](../../notes/A1-release-update.md#17-the-entitled-eligibility-check)).

## Read first

- `AGENTS.md` (rules 6, 10, 11), `CLAUDE.md`.
- [README §3.5](../../README.md#35-storage-and-byte-delivery), [§3.8](../../README.md#38-distribution-distribution-service)
  (`dist_rollouts`, `dist_access`, routes), [§3.9](../../README.md#39-rollouts-halts-and-telemetry),
  [§3.6](../../README.md#36-update-what-an-installed-app-should-do-next) (the bucket rule).
- [notes/A1 §1.6, §2, §4](../../notes/A1-release-update.md#4-byte-hosting-model);
  [notes/E5 §5](../../notes/E5-frontier-tech.md) (rollouts and halts).
- Hand-offs: [P2-05](P2-05-release-routes.md) (routes, `resolveBuild`), [P2b-01](P2b-01-distribution-service.md)
  (hooks), [P2b-02](P2b-02-distribution-manifest.md) (outlets), [P2-01](P2-01-blob-store.md)
  (landed: `blobResponse(req, bucket, key, opts)` in `core/blobs.ts`; the `BYTE_ROUTES` allowlist in `mount.ts`, consumed by `dispatchBytesHost`; see P2-05 for the hardening it adds), P0-01 (the source column on `artifacts_access`).
- Code: `packages/worker/src/router.ts:154-183` (the alias rewrite pattern, D-07),
  `src/services/release/routes.ts`, `surfaces.ts`, `gateway.ts`, `access.ts`, `config.ts:140-172`
  (`accessModeFor`, `setReleaseAccess`), `install.ts`; `src/services/update/feed.ts`,
  `update/admin.ts` (the settings PATCH); `src/core/entitledAccess.ts:62,145`;
  `src/services/identity/portal/api.ts:296-311,713,835` (mint check and redirect);
  `src/http.ts:54-70`; `packages/admin/src/views/UpdateSettings.tsx`;
  `test/routeCoverage.test.ts:63-100`.

## Scope

**In:**

- **Tables** (migration; `TABLE_OWNERS` under `distribution`):
  - `dist_rollouts(product, deliverable_id, outlet_id, channel, release_id, rollout_bp, rollout_salt, state, mirrored, source, started_at, updated_at, updated_by)`,
    PK `(product, deliverable_id, outlet_id, channel)`, `state` `active|paused|halted|complete`;
  - `dist_access(product, deliverable_id, mode, entitlement, source, modified_at)`, PK
    `(product, deliverable_id)`, backfilled for `app` from `release_config.artifacts_access` and
    P0-01's `release_config.access_source` (an `entitled` value survives, unlike the truth store's
    `access` CHECK).
- **Rollout controls**, one implementation in `services/distribution/rollouts.ts`:
  - CI routes (rule 10), `pkeyci_` token with the new opt-in scope `distribution:rollout`:
    `POST /{product}/distribution/rollouts/{outlet}/{channel}` (`{deliverable?, releaseId, bp}`)
    and `…/pause`, `…/resume`, `…/halt`, `…/complete`;
  - admin routes (narrative-only) with the same verbs and `GET …/distribution/rollouts`;
  - the CLI's `pkey distribution rollout|halt|resume` on P2-06's plumbing.
- **Byte serving moves.** Canonical routes (rule 10): `GET /{product}/distribution/dl/{version}/{asset}`,
  `/distribution/install.sh`, `/distribution/builds/{selector}/{buildId}`,
  `/distribution/files/{releaseId}/{name}`, `/distribution/blobs/sha256/{hash}`. Permanent
  aliases by router rewrite: `/{product}/release/dl/…`, `/{product}/release/install.sh`,
  `/{product}/install.sh`, `/{product}/release/builds/…`, `/{product}/release/files/…`,
  `/{product}/release/blobs/…`. Move them to `ALIAS_PATHS` and generalise the "four aliases" test.
- **`releaseCatalog` gains** `resolve(q)` (P2-05's `resolveBuild`), `openSource(ref, req)` (release
  streams GitHub-located bytes with its own token and SSRF guard) and `metadataAccess()`.
- **`delivery` gains** `rollout({deliverable, outlet, channel})`, `accessMode(deliverable)` and
  `deliveryUrl({releaseId, buildId | name, outlet?})` (bytes-host URLs when `BLOB_ORIGIN` is set).
- **One access answer.** Byte routes enforce `dist_access` with Core's `usableLicensedDevice` and
  `entitledAccessCheck`; update's appcast reads `delivery.accessMode()` instead of
  `release_config.artifacts_access`; the portal's download mint (`portal/api.ts:713`) does too, and
  its redirect may target the bytes origin (extend `isAllowedStorageHost` deliberately: R6-12).
  `update/settings` keeps the metadata mode and the compat window; the artifacts mode moves to
  `GET`/`PUT …/distribution/access`, and `views/UpdateSettings.tsx` calls it.
- Discovery: distribution's fragment advertises `download`, `install`, `builds` and `blobs`.
- Docs: `services/distribution/delivery.md` and `rollouts.md`; `services/release/artifacts.md`
  and `services/update/eligibility.md` updated; threat model.
- **Wave-1 sync:** **Register on both hosts.** The distribution byte routes and the `/release/…` aliases are added to `mount.ts` `BYTE_ROUTES` with the distribution slug (moving them out of release's list that P2-05 registers), and the docs wording for the disabled case distinguishes the two not-found bodies.

**Out** (and where it belongs instead):

- Halts and rollouts changing what devices are offered: the signed feed carries them
  (→ [P3-03](P3-03-feed-composition.md)); Sparkle's `phasedRolloutInterval` (→ P3-09).
- Store-mirrored rollouts and their controls (→ P5-02, P5-03); auto-halt (→ P6-03, which uses
  the halt path here with `source: "auto-halt"`); pack rollouts and readiness (→ P4-14).
- Gated pack objects and the `gated/` prefix on reads (→ P4-05).
- The portal's other issues (sidecars listed, a licence required for public artifacts:
  README §9.1 #22) (→ [P2b-06](P2b-06-download-page-matrix.md) or a follow-up).

## Design notes

- **Rollout semantics.** `rollout_bp` is 0–10000 basis points; a new `release_id` gets a fresh
  random `rollout_salt` (16 bytes, hex) so the same devices are not always first. The bucket is
  evaluated on the device, `u32(sha256(salt ‖ installId)[0..4]) mod 10000` (README §3.6), so the
  feed stays identical for everyone; the Worker never evaluates it. Transitions: `active` ↔
  `paused`; `active`/`paused` → `halted`; `halted` → `active` only by an explicit resume;
  `active` → `complete` sets 10000. Anything else is refused.
- **`source`** is `admin`, `ci`, a connector kind (`asc`, `play`, `ms-store`) or `auto-halt`;
  `mirrored = 1` rows belong to a connector and refuse direct edits (P5-02/P5-03 name these values).
- **Say what a halt does today.** Until P3-03 composes the signed feed, a halt is recorded,
  audited and shown, but legacy feeds keep serving; the docs and the console must say so, and
  point to a yank or a pin (P2-05) as today's emergency stop.
- **Alias rewrite, not a second handler** (`router.ts` D-07 comment): an alias yields the same
  `{kind: "service"}` route as the canonical path, so the two cannot drift. The rewrite runs before
  the namespace check, because `release` is itself a namespace.
- **Behaviour change for Release-only products.** Byte routes now need distribution enabled. P2b-01
  backfilled distribution for every product with Release on; a manifest that later enables Release
  without distribution loses downloads by choice. State it in the docs.
- **No GitHub token in distribution.** GitHub-located bytes come through `releaseCatalog.openSource`;
  R2 bytes through Core's `blobResponse(req, bucket, key, opts)`; byte routes are registered as `ByteRoute`s in `mount.ts` `BYTE_ROUTES`, each with `service` set to the distribution slug, because the bytes host bypasses `dispatchService` and that field is the only enablement check there. Distribution never imports `github.ts` or `githubApp.ts`.
- **Edge caching of byte routes** ([notes/S-02](../../notes/S-02.md) §6.1–§6.2). Byte routes stay
  uncached unless this package turns caching on. If it does, use Workers Caching on one named
  entrypoint that serves only ungated bytes-host reads, never a top-level `cache` block: the
  cache key has no hostname and no `Origin`, so CORS headers and the host-dependent
  `Content-Type`/`Content-Disposition` must stay outside it, and every response from it needs an
  explicit `Cache-Control` (a 404 from `notFound()` has none and would be cached for 3 minutes).
  The default entrypoint must strip `Authorization` and `Cookie` before calling the cached one,
  and must never route a gated request to it. Cloudflare's pages disagree on what an
  `Authorization` request does: the configuration page says a `public` response to it is stored,
  the examples page says it forces `BYPASS`. S-02 hand-off row H10 measures it; until then the
  threat model records the conflict and relies on routing plus stripping, never on an automatic
  bypass (S-02 §6.1 rule 1). The
  `ctx.exports` call is billed as a second Workers request once caching is on; the gain that pays
  for it is the tiered cache, request collapsing, no `miss-fill` second R2 read and no R2
  Class B reads on hits (S-02 §5.2).
  Gated responses should read `private, no-store, no-transform`; `blobResponse` sends
  `private, no-store` today, so a compressible gated type could get a weak ETag.
- **Access CHECKs.** `dist_access.mode` includes `entitled`. Stop reading
  `release_config.artifacts_access` (leave the column; dropping it needs a rebuild) and say so in a
  comment next to `setReleaseAccess`.
- **CORS** on byte routes comes from P0-05's central step in `dispatch` (`core/cors.ts`), which
  already exposes `ETag`, `Content-Range` and `Repr-Digest` (README §3.11). Check that the
  canonical `/distribution/…` paths and the aliases fall inside its covered-path list, on both
  hosts.

## Steps

1. Migration with both tables and the `dist_access` backfill; `TABLE_OWNERS`; `docs gen`.
2. `rollouts.ts` with a transition-table test; admin and CI routes; CLI subcommands.
3. Hook additions (`resolve`, `openSource`, `metadataAccess`; `rollout`, `accessMode`, `deliveryUrl`).
4. Move the byte routes into `services/distribution/` over the hooks and Core; router rewrites;
   OpenAPI canonical paths and aliases; `routeCoverage` tables; `docs gen`.
5. Switch the appcast, portal and update settings to `delivery.accessMode()`; console change.
6. Run the release, update, portal and R6 suites unchanged against the aliases; docs; threat model.

## Acceptance criteria

- [ ] Every existing download, `install.sh` and appcast test passes through the alias paths with
      byte-identical responses; the canonical `/distribution/…` paths answer the same.
- [ ] With distribution disabled, every byte route and alias is not served: on the console host it returns the registry not-found body; on the bytes host (`dl.plrs.im`) it returns that host's flat `{"error":"not_found"}`, indistinguishable from an absent route (P2-01 test pattern).
- [ ] An operator set to `entitled` in `dist_access` makes the appcast, the download and the
      portal mint all refuse a caller without the channel entitlement (one test each).
- [ ] Rollout transitions are enforced; CI needs `distribution:rollout`; mirrored rows refuse
      direct edits; every change is audited.
- [ ] `boundaries.test.ts` passes: distribution imports no release module.
- [ ] `routeCoverage` passes; `docs gen:check` is clean; the green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- distribution release updateFeed portal routeCoverage boundaries R6-release
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- updateSettings
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Corrections from implementation

Recorded where the code (or a dependency's state) disagreed with the text above.

- **CLI subcommands deferred.** `pkey distribution rollout|halt|resume` were to sit "on P2-06's
  plumbing", but P2-06 is not done and `packages/cli` has no HTTP client or CI-token handling
  yet. Inventing that plumbing here would pre-empt P2-06's `ciClient`. The CI routes are live and
  documented. **Owner: [P2b-03](P2b-03-availability-keys.md)**, which already depends on P2-06
  and creates the `pkey distribution` command group (`report`) on its token plumbing; its brief
  now lists the three subcommands in Scope → In and in its acceptance criteria. P2-06's brief
  still points `rollout|halt` at P2b-04; that pointer now resolves through this correction to
  P2b-03.
- **`releaseCatalog` gained two more readers** than the three named: `accessSelector(selector)`
  (channel classification for the `entitled` check is Release's model, and Distribution must
  enforce it before resolving) and `installScript(origin)` (the template and binary name are
  Release's data). `metadataAccess()` doubles as the "release configuration exists" check.
- **Discovery is wire.** Removing the byte endpoints from Release's fragment would change the
  discovery document (`test/discoveryGolden.test.ts`: plan mode). Release's fragment keeps its
  keys, which now name the permanent aliases; Distribution's fragment, which P2b-01 added,
  carries the canonical `download`, `install`, `builds` and `blobs` URLs.
- **Bytes host.** Only `builds`, `files` and `blobs` (both spellings) are registered in
  `BYTE_ROUTES`. The installer is a `text/x-shellscript` body and `?checksum=sha256` on `dl`
  answers `text/plain`, both of which the bytes host refuses by type, so `install.sh` and `dl`
  stay console-host routes, as they were.
- **The installer and the appcast keep the `/release/dl` spelling** (a permanent alias), so the
  script and every feed are byte-identical to what installed copies and published curl lines
  already hold.
- **The portal's `entitled` check** uses the release's stored channel (stable when
  GitHub-derived) plus its version, through a new Core helper `licenseEntitled` (the device
  decision without the device layer). With Distribution off the portal offers and mints no
  download, since its access answer is Distribution's.
- **No new error codes.** Rollout refusals use the existing flat `not_found` / `bad_request`
  codes with a machine-readable `reason`, like P2-05's CI routes, so `errors.json` is unchanged.
- **`dist_access.entitlement`** is stored and shown but not enforced; its meaning (a named
  entitlement for gated packs) belongs to P4-05 / commerce.

## Hand-off

- `dist_rollouts`, its states and `source` values, `delivery.rollout()` and the halt path are
  what P3-03 composes into the feed, P4-14 extends to packs, P5-02/P5-03 mirror into, and P6-03
  halts through.
- The canonical byte routes and `deliveryUrl` are what P2b-05's feeds, P2b-06's page, P3-09's
  updater feeds and P4-05's pack transports link to.
- The CLI subcommands `pkey distribution rollout|halt|resume` are owned by
  [P2b-03](P2b-03-availability-keys.md): it adds them on P2-06's `packages/cli` CI plumbing next
  to `pkey distribution report`, over the CI routes this package shipped
  (`POST /{product}/distribution/rollouts/{outlet}/{channel}[/pause|resume|halt|complete]`,
  scope `distribution:rollout`).
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2b-04 done`.
