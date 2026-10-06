# HA-05 Pull on register and resync: queue `pkey-assets-<env>`, URL and repo-path sources (installation token at the synced commit), re-sync semantics, nightly re-check, console status

| Field       | Value                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 2: ingest)                                                                                                    |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                  |
| Depends on  | [HA-01](HA-01-hosted-asset-core.md), [HA-04](HA-04-manifest-presentation.md)                                                                                                          |
| Unblocks    | [HA-06](HA-06-upload-paths.md), [HA-07](HA-07-serve-hosted-copies.md), [HA-08](HA-08-release-mirroring.md), [HA-10](HA-10-hosting-settings.md), [HA-16](HA-16-release-note-images.md) |
| Role        | `pkey-implementer`                                                                                                                                                                    |
| Plan mode   | no                                                                                                                                                                                    |
| Gates       | migration; wrangler config; THREAT-MODEL; workerd lane; table owners                                                                                                                  |
| Human input | none                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                             |

## Goal

Registering or resyncing a product enqueues a pull for each declared asset ref that is new or changed. A consumer in the main script ingests each one. Repo paths are read through the GitHub App installation token at the commit being synced. The slot keeps serving its old copy until the new one is ready. Failures are visible and never block a register.

## Why

This is the owner's "just pull the files". It also retires DJDL's public `djdl-assets` repo workaround, because private-repo paths work ([S-20 §5](../../notes/S-20-hosted-assets.md#5-results-of-the-measurements-m)).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §6.3 (ways in), §6.4.
- The resync path (`admin/handlers/products.ts`, the GitHub sync helpers and the installation-token code), `wrangler.deltas.toml` (queue precedent).

## Scope

**In:**

- Queue `pkey-assets-<env>`: producer and consumer in `polaris-key`, with a dead-letter queue.
- Slot planning from the normalised manifest: `presentation.icon`, `listing.icon`/`header`/`screenshot:<n>`. The listing icon falls back to `presentation.icon`.
- Repo source: `GET /repos/{o}/{r}/contents/{path}?ref=<sha>` with the raw media type. The blob SHA is the change detector.
- Re-sync rules exactly as S-20 §6.4. Validation warning `asset_unreachable`. Nightly re-check of `failed`/`stale` rows in the existing cron, bounded per run.
- Admin read API `GET /admin/products/:p/assets` (rule 10), used by HA-06's page.

**Out** (and where it belongs instead):

- Console upload and CI push (→ HA-06). Release files (→ HA-08).

## Corrections from the code (HA-05, 2026-10-05)

- The admin read route is `GET /manage/api/products/:p/assets` (the console API's real prefix),
  not `/admin/products/:p/assets`. It is pinned in the OpenAPI spec and `routeCoverage`'s
  `ADMIN_KIND_PATHS` (rule 10).
- HA-01's `hosted_assets` has no place to keep what the manifest wants while the old copy keeps
  serving, nor any back-off state. The migration `00XX_hosted_asset_pulls.sql` (the lead numbers
  it) adds `wanted_ref`, `pulled_ref`, `source_blob`, `attempts` and `next_attempt_at`. There is no
  new table, so `TABLE_OWNERS` is unchanged (`hosted_assets` is already Core's).
- `asset_unreachable` is a Worker-side warning in the resync result (`warnings[]`), not a code
  from `@polaris-key/manifest`'s validator. The validator never fetches, so there is no rule-9
  entry.
- The system product's deploy-hook apply (`admin/systemProduct.ts`) is not wired. Only link and
  resync plan pulls.

## Design notes

- Exponential back-off per slot, capped at 24 h.
- A console-claimed slot (HA-06) is never overwritten by a pull.

## Steps

1. Queue.
2. Planner and consumer.
3. Repo resolver.
4. Status API.

## Acceptance criteria

- [ ] Resyncing an unchanged manifest enqueues nothing (test).
- [ ] Changing the icon URL swaps the copy only after the new ingest is `ready` (test).
- [ ] A 404 source leaves the old copy serving, with status `stale` (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

HA-07 reads `hosted_assets` by slot. HA-08 reuses the queue.

The role agent sets `--set HA-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-05 done`.
