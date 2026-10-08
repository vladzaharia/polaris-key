# P2-07 Console: builds and channels view in the Release section

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth, publishing and release tracks                                              |
| Size        | 0.5–1 engineer-weeks                                                                          |
| Depends on  | [P2-05](P2-05-release-routes.md)                                                              |
| Unblocks    | [P4-09](P4-09-console-pack-views.md)                                                          |
| Role        | `pkey-implementer`                                                                            |
| Plan mode   | no                                                                                            |
| Gates       | admin tests; `pnpm --filter @polaris-key/admin build`; the help-link drift gate (`docsLinks`) |
| Human input | none                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                     |

Milestone: **every Diceroll artifact indexed and published without long-lived secrets.**

## Goal

The Release section of the console shows, per release, its builds (platform, arch, format, build
number, minimum OS) with their artifacts (role, size, SHA-256, where the bytes live), and per
deliverable its channels (pointer, pinned, `includes`, floor, critical, who owns the row). An
operator can promote, pin, unpin, yank and unyank a release and set a floor or the critical flag,
each behind a confirmation, and can hand a channel back to the manifest. Every control is
operator-owned and survives a resync.

## Why

The Releases view shows an artifact **count** and read-only channel badges; channels cannot be
changed at all ([notes/A3 §2.1–§2.2](../../notes/A3-admin-dx.md#2-the-admin-console)). The
research ranks "Builds and channels" second among new console surfaces, after the distribution
matrix: the artifact data already arrives on `…/release/releases` but is not shown
([README §6.2](../../README.md#62-administrator-operator) item 2). P2-05 adds the data and the
operations; this package puts them in front of the operator.

## Read first

- `AGENTS.md` (the green gate, the docs conventions: help links live in exactly two tables) and
  `CLAUDE.md`.
- [README §6.2](../../README.md#62-administrator-operator) items 2 and 7 and the
  operator-ownership model; [notes/A3 §2.4](../../notes/A3-admin-dx.md#24-what-an-omni-platform-game-needs-in-the-console)
  items 1, 2, 5, 6.
- [P2-05](P2-05-release-routes.md) hand-off: the admin read model (`GET …/release/releases`,
  `GET …/release/channels`) and the admin operations.
- Code: `packages/admin/src/views/Releases.tsx` (the artifact-count column at `:185-191`, the doc
  comment at `:37-48` that says live feeds never consult the store: stale after P2-05),
  `src/views/releases/ResyncButton.tsx` (the confirm-dialog pattern), `src/api.ts:409-412` and
  `:796` (`ReleaseStoreResponse`, `api.releases`), `src/route.ts:164-176` (the Release section),
  `src/lib/docsLinks.ts`, `src/components/ui/`, `test/releases.test.tsx`.

## Scope

**In:**

- `api.ts`: DTOs for builds, artifact roles and locations, yanks and channel policy; client calls
  for the P2-05 admin operations.
- `Releases.tsx`: an expandable row per release with a builds table; artifacts grouped under
  their build; sidecars (`signature`, `checksum`) collapsed behind a toggle; SHA-256 shortened
  with copy; the location shown as R2, GitHub, store or external; a "Yanked" badge with reason.
- A channels panel per deliverable (the `app` deliverable only until packs exist): current
  resolved release per platform (from the admin model), pointer, pinned, `includes`, floor,
  critical, `source` (`manifest` or `admin`) and last change (`modified_by`, time).
- Actions: promote, pin, unpin, yank (reason required), unyank, set floor, toggle critical,
  revert to manifest; each opens a confirmation stating the effect ("stable will serve 0.4.2 on
  every platform that has a build; newer releases are ignored until you unpin").
- Update the view's doc comment, and add a help link to the channels docs page P2-05 wrote
  (`/docs/services/release/channels/`) through `docsLinks.ts`.
- Tests in `test/releases.test.tsx` (and a new `test/releaseChannels.test.tsx` if clearer).
- **Wave-1 sync:** **Channel-floor console (from P0-02).** A button for the channel-floor endpoint (`/manage/api` route that lowers or clears a floor; it refuses to raise), and show the new `channel-floor-unverified-<channel>` warning (and the `channel-regressed` check) in the health view.

**Out** (and where it belongs instead):

- Rollout percentage, pause and halt per outlet, and the release × outlet matrix
  (→ [P2b-06](P2b-06-download-page-matrix.md)); pack deliverables, the compatibility matrix and the
  device simulator (→ P4-09, P4-15).
- A trusted-publishing card (policy to paste, static `pkeyci_` tokens). README §6.1 step 4 needs it
  and no work package owns it; see the report.
- Making the setup checklist and release health platform-neutral (→ P0-11, README §9.1 #21).

## Design notes

- **Operator-owned means visible.** Show `source` on every channel row. When it is `admin`, show
  "Revert to manifest" and explain that the manifest re-applies on the next resync, not at once
  (the `services_source` precedent in `views/services/ServicesCard.tsx`).
- **Yank semantics** in the dialog: a yanked release is never offered on a moving selector and
  resolves only through an explicit pin; installs already on it are not told to move until the
  signed feed exists (P3). Do not promise more than P2-05 implements.
- **Per-platform truth.** "Stable" is not one release: a release missing the iOS build falls back
  per platform (README §3.4). Render the resolved release per platform, not one badge.
- **No new copy of the rules.** The console displays what the admin API returns; it never
  recomputes resolution.
- Keep the confirm, toast and error handling identical to `ResyncButton`; map API `reason`s to
  messages in one table, as `SERVICE_ERROR_MESSAGES` does in `api.ts:349`.

## Steps

1. DTOs and API client calls with unit tests in `test/api.test.ts`.
2. The builds table and artifact grouping; tests with a Diceroll-shaped fixture (six builds).
3. The channels panel and actions with confirmation dialogs; tests for each action's request.
4. Docs link, doc comment; `pnpm --filter @polaris-key/admin build`, the docs link gate.

## Acceptance criteria

- [x] With a fixture of six builds, the view shows each build's platform, arch, format, build
      number and payload SHA-256, and hides sidecars until toggled.
- [x] Each action sends the right request to P2-05's admin route and refreshes; yank refuses an
      empty reason; revert is offered only when `source` is `admin`.
- [x] The channels panel shows a per-platform resolved release that differs by platform when the
      fixture lacks one platform's build in the newest release.
- [x] `test/docsLinks.test.ts` (admin) and the worker's docs-link drift test pass.
- [x] The green gate passes (`AGENTS.md`), including `pnpm --filter @polaris-key/admin build`.
- [x] The console can lower or clear a channel floor and renders the `channel-floor-unverified-<channel>` warning.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- releases api docsLinks
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- docsLinks
mise exec node@22 -- pnpm typecheck
```

## Corrections from implementation

Where this brief and the code disagreed when P2-07 was built, the code won:

- **Per-platform resolution was not in the admin model.** `GET …/release/channels` returned one
  `resolved` release per channel, with no platform filter, so the console could not render
  per-platform truth without recomputing resolution. P2-07 extended the read model (narrative-only
  admin route, no OpenAPI or `routeCoverage` change): each deliverable now carries `platforms` and
  each channel `byPlatform`, resolved server-side through `loadDeliverableState` and
  `resolveInState`. The worker test is in `test/releasePolicy.test.ts`.
- **There are no admin promote, pin or unpin routes.** Those are CI routes. The console reaches the
  same operations through the operator `PUT …/release/channels/<channel>`: promote sends
  `pointer`, pin sends `pointer` and `pinned: true`, unpin sends `pinned: false`. That PUT does
  not refuse a yanked pointer the way the CI promote does, so the console offers only unyanked
  releases for promotion. A yanked release can still be pinned.
- **"Set floor" means two floors.** The device floor (`minSupported`, P2-03) is set through the
  PUT. The anti-rollback floor (P0-02) is lowered or cleared through `POST …/channels/<channel>/floor`.
  The console offers both, under different names ("minimum supported" and "rollback floor").
- **The signed feed has landed (P3-03).** It carries `minSupported` as the floor and `critical` for
  the channel's pointer release. The confirmation copy says so, and does not claim that P3 is still
  ahead.
- **Line references.** `Releases.tsx` no longer has an artifact count at :185-191 (P2-05 changed
  the view), and `api.ts:409-412` and `:796` had moved. The doc comment that said live feeds never
  consult the store has been rewritten.
- **The health view already rendered every check generically**, including
  `channel-floor-unverified-<channel>` and `channel-regressed`. P2-07 adds a pointer from those
  checks to the floor action, plus a test.

## Hand-off

- The builds and channels components are reused by P2b-06's matrix (artifact and SHA-256 cells)
  and by P4-09 for pack deliverables.
- With this merged the P2 milestone is demonstrable: a Diceroll-shaped release published through
  the Action (P2-06's end-to-end fixture, or a staging run) appears here build by build. Diceroll
  itself switches over in [D-03](D-03-diceroll-after-p3.md).
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-07 done`.
