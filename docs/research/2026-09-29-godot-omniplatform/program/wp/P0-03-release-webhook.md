# P0-03 Refresh the release truth store on GitHub `release` webhook events

| Field       | Value                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality                                                  |
| Size        | 0.25 engineer-weeks                                                                       |
| Depends on  | [P0-02](P0-02-release-resolution.md)                                                      |
| Unblocks    | none                                                                                      |
| Role        | `pkey-implementer`                                                                        |
| Plan mode   | no                                                                                        |
| Gates       | worker tests; the R6-07 webhook attack tests stay green                                   |
| Human input | subscribe the `polaris-key` GitHub App to **Release** events (App settings), after deploy |
| Repo        | `vladzaharia/polaris-key`                                                                 |

## Goal

Publishing, editing, prereleasing, unpublishing or deleting a GitHub release refreshes that
product's truth store within one webhook delivery, without re-reading `.pkey/` and without
touching any manifest-owned row. The console Releases view and the portal show a new build
without anyone pushing to `.pkey/` or pressing "Resync".

## Why

`handleGithubWebhook` answers every event other than `push` with `{ok: true, ignored: <event>}`
(`packages/worker/src/githubWebhook.ts:154-157`), and a `push` only resyncs when a `.pkey/` path
changed (`githubWebhook.ts:180-189`). The truth store (`release_metadata`, `release_artifacts`,
`release_channels`, `release_health`) is therefore stale between manifest pushes, so the console
and portal lag behind what the device routes (which call GitHub live) already serve. Report
[§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issue #7;
[notes/A1 §5](../../notes/A1-release-update.md#5-github-sync). The docs already claim the webhook
"keeps a linked product current" (`packages/docs/src/content/docs/services/release/github-sync.md:13,80`).

## Read first

- `AGENTS.md`.
- `packages/worker/src/githubWebhook.ts` in full: HMAC check, the delivery-GUID replay guard
  (recorded before event dispatch, `:136-152`), and the installation binding (`:206-221`). The code
  comments call these R6-06 and R6-05; the attack suite files both under R6-07
  (`test/attack/R6-release.test.ts:951`).
- `packages/worker/src/services/release/sync.ts` (`syncReleaseStore`, `releaseStoreSyncStatements`).
- The P0-02 changes to pagination, ordering and floors (this package depends on them).
- Tests: `packages/worker/test/linkRepo.test.ts:861-960` (webhook), `test/attack/R6-release.test.ts`
  (R6-07), `test/attack/R10-dos.test.ts`.
- `docs/DEPLOYMENT.md:132-151` (the GitHub App's required settings).

## Scope

**In:**

- Handle `x-github-event: release` for every action GitHub sends (`published`, `unpublished`,
  `created`, `edited`, `deleted`, `prereleased`, `released`) the same way: for each product whose
  `release_config` names the payload's `repository` and whose `gh_installation_id` equals
  `payload.installation.id`, run `syncReleaseStore`. Drafts are already ignored by the sync.
- Keep the signature check and replay guard exactly where they are; both already run before the
  event switch.
- Mark releases that are in the store but no longer upstream: when the paginated list was read
  to the end (no unread `next` page under P0-02's cap), write `release_health` for each missing
  release as `degraded` with `details_json: {"absentUpstream": true}`. A capped, incomplete list
  marks nothing. Rows are never deleted (`store.ts:23-31`: download tokens reference them).
- Response body: `{ ok, event: "release", action, results: [{ product, ok, statements }] }`.
  _Implementation note:_ the top-level `ok` is every result's `ok`, as on the `push` path, so an
  installation mismatch or a sync that could not reach GitHub (`statements: 0`, with an `error`
  string) surfaces at the top level too. Completeness of the paginated read comes from a new
  `listReleasePages` (`{ releases, complete }`) in `github.ts`; `listReleases` delegates to it.
- Docs: `docs/DEPLOYMENT.md` App settings table (Events: Push, Release);
  `services/release/github-sync.md` describes both events.
- **Wave-1 sync:** **Safe on every event (from P0-02).** The store sync now resolves through P0-02's paginated, capped, floor-aware path and is idempotent, so it is safe to run on every release event; the existing tests must keep passing with no further debouncing.

**Out** (and where it belongs instead):

- Filtering absent-upstream or non-candidate releases out of the portal (→ P2-03, P2b-06).
- Treating a delete as a yank (→ P2-03).
- Coalescing bursts of events, or moving sync to a queue (→ P2-05 if quota requires it).
- Any change to how `push` events are handled.

## Design notes

- **Do not write `product_sync_state`.** It has one row per product (`migrations/0005_product_sync_state.sql`)
  and records the **manifest** sync; a release event overwriting it would hide a failed `.pkey/`
  sync. `release_health.checked_at` is the release sync's record.
- **Installation binding is mandatory** (R6-05): one webhook secret covers every installation, so
  a delivery for repo X signed by the platform secret must still carry the installation id that
  owns X. Reuse the check at `githubWebhook.ts:206-221`, factored into a helper both paths call.
- The payload is attacker-shaped once the secret leaks. Read only `repository.owner.login`,
  `repository.name` and `installation.id` from it; never trust `release.*` fields for writes:
  the sync re-reads GitHub with the installation token.
- Each event costs one installation-token read (KV-cached) plus the list pages. That is fine at
  release cadence; note it in `github-sync.md`.
- A `deleted` event triggers the P0-02 floor logic through the ordinary sync: health will show
  `channel-regressed` if the deleted release was a channel head.

## Steps

1. Factor the per-product installation check into a helper.
2. Add the `release` branch; parse the minimal payload; loop products; call `syncReleaseStore`.
3. Add absent-upstream marking to `releaseStoreStatements` (it needs the stored release ids:
   pass them in, keep the function pure).
4. Tests, then docs.

## Acceptance criteria

- [ ] Test: a signed `release`/`published` delivery for a linked repo inserts the new release's
      `release_metadata` and `release_artifacts` rows and updates `release_channels`.
- [ ] Test: the same delivery replayed (same `X-GitHub-Delivery`) is answered `duplicate-delivery`
      and writes nothing.
- [ ] Test: a delivery whose `installation.id` differs from the product's `gh_installation_id`
      writes nothing for that product and reports `ok: false`.
- [ ] Test: a `deleted` delivery leaves the release row in place and marks its health
      `absentUpstream`.
- [ ] Test: `product_sync_state` is unchanged by a release event.
- [ ] Test: a bad signature is still refused before any JSON parse.
- [ ] `docs/DEPLOYMENT.md` lists Release events; the green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- linkRepo releaseStore R6-release R10-dos
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

Human step after merge and deploy: in the GitHub App settings, add the **Release** event
subscription (Release events are covered by the existing **Contents: read** permission, so
installations should not need to re-approve; confirm on the App's permissions page). Until then
the code is inert and harmless. P2-03 and P2-06 rely on the store being refreshed by release
events; P2-06's publish flow may call `syncReleaseStore` directly as well. When done:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-03 done`.
