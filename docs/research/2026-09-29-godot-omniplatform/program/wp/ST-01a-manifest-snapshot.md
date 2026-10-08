# ST-01a Manifest snapshot and pinned-commit fetch: `product_manifest_snapshot` written in every apply batch (resync, link, the system product's deploy hook), `applied_sha`, "Triggered by push" relabel of `commit_sha`

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 0: stop the bleeding)       |
| Size        | 0.6–0.85 engineer-weeks                                                           |
| Depends on  | none                                                                              |
| Unblocks    | [ST-01b](ST-01b-resync-claims.md)                                                 |
| Role        | `pkey-implementer`                                                                |
| Plan mode   | no                                                                                |
| Gates       | D1 migration (replayable, scratch-SQLite rehearsal); `TABLE_OWNERS`; THREAT-MODEL |
| Human input | none                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                         |

## Goal

Every apply of a linked product's manifest (webhook or manual resync, `linkRepo`, the system product's deploy hook) fetches all `.pkey/` documents at one pinned commit and writes a `product_manifest_snapshot` row in the same batch, so Revert, drift and the ST-01c backfill have the last applied manifest to read.

## Why

Nothing stores the applied manifest today: `product_sync_state` holds only the triggering push's `commit_sha`, which may be a feature-branch push that was never applied ([S-18 §2.1](../../notes/S-18-settings-architecture.md#21-the-resync-overwrite-a-correctness-bug)). Fetching each document separately also opens a mixed-commit window.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §2.1](../../notes/S-18-settings-architecture.md#21-the-resync-overwrite-a-correctness-bug) (the resync overwrite), [S-18 §4.3](../../notes/S-18-settings-architecture.md#43-storage) (the snapshot DDL and the pinned fetch), [S-18 §4.14](../../notes/S-18-settings-architecture.md#414-migration), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-01a.
- `packages/worker/src/services/release/github.ts` (`MAX_REPO_FILE_BYTES`), `packages/worker/src/services/release/admin.ts` (`resyncRepo`, `linkRepo`), `packages/worker/src/admin/systemProduct.ts` (`linkSystemProduct`), `packages/worker/src/env.ts` (`PKEY_GIT_SHA`).

## Scope

**In:**

- Migration creating `product_manifest_snapshot` exactly as §4.3 sketches (`applied_sha`, `applied_at`, `origin` in `resync|link|deploy-hook|backfill`, `files_sha256`, `manifest_json`); `TABLE_OWNERS` entry (Core).
- Pinned fetch: resolve the default-branch head once from the DB-configured repo, then fetch every document `?ref=<sha>`; the deploy hook records `PKEY_GIT_SHA` as `applied_sha`.
- The snapshot row written inside the apply's `db.batch` by all three apply paths; latest row only.
- Console relabel of `product_sync_state.commit_sha` as "Triggered by push <sha>".

**Out** (and where it belongs instead):

- Claims, `product_settings` and per-field audit (→ ST-01b).
- The backfill that writes the first snapshot for products not resynced since (→ ST-01c).
- The dry-run plan and drift view (→ ST-17).

## Design notes

- R6-05 must keep holding: nothing caller-supplied chooses the fetched content. Re-read and amend that THREAT-MODEL row.
- `manifest_json` is the normalised `ParsedManifest`; manifests carry secret names only, never values.
- D1's value-size limit is unverified [U]: assert in a test that four maximum-size documents fit.
- No observable behaviour change: resync still overwrites as today until ST-01b.

**Corrections from the code (recorded by the implementer, 2026-10-04):**

- `linkRepo` lives in `packages/worker/src/services/release/linkRepo.ts`, not `admin.ts`
  (`admin.ts` holds the manual-resync route that calls `resyncRepo`).
- `docs/security/THREAT-MODEL.md` has no row labelled R6-05. The control it names is the
  `.pkey/` manifest row of §5 ("Semi-trusted inputs"); that row was amended, and a bullet on the
  pinned fetch and the snapshot was added under "Boundaries that are weaker than they look".
- The head is resolved with ONE call, `GET /repos/{o}/{r}/commits/HEAD` with
  `Accept: application/vnd.github.sha` (bare sha body; checked against api.github.com), instead of
  S-18 §4.3's two calls (`GET /repos/{o}/{r}`, then `/commits/{branch}`). The property is the same:
  GitHub resolves the default branch from the repo coordinates alone. It is one fewer round trip,
  and it avoids reading a full commit JSON, whose file list could exceed the read cap.
- The table's `product` column references `products(slug)` without S-18 §4.3's `ON DELETE
CASCADE`: `test/attack/R11-data.test.ts` (R11-01) pins that only the account and portal tables
  cascade, and no product-scoped table declares `ON DELETE` (products are never deleted).

## Steps

1. Migration and `TABLE_OWNERS`; scratch-SQLite rehearsal against the full migration chain.
2. Pinned fetch helper shared by resync and link; deploy-hook path.
3. Snapshot write in each apply batch; console relabel.
4. Tests, THREAT-MODEL row.

## Acceptance criteria

- [ ] Each of the three apply paths writes exactly one snapshot row in the same batch as the apply (test per path).
- [ ] All documents of one apply come from one commit, and `applied_sha` equals it (test with a branch that moves between calls).
- [ ] A snapshot built from four maximum-size documents is stored and read back (test).
- [ ] THREAT-MODEL R6-05 re-read and amended for the pinned fetch.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- ST-01b reads the snapshot for Revert; ST-01c writes `origin = 'backfill'` rows; ST-17 diffs against it.

The role agent sets `--set ST-01a in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-01a done`.
