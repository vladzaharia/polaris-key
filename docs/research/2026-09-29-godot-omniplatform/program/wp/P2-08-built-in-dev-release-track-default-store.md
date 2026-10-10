# P2-08 Built-in dev release track and default store track maps

| Field       | Value                                                                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth, publishing and release tracks (DX consolidation I: Packages, updates and packs)                                                                                                                                                                                                                                                  |
| Size        | 0.7–1.1 engineer-weeks                                                                                                                                                                                                                                                                                                                              |
| Depends on  | none                                                                                                                                                                                                                                                                                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-09](P2-09-demote-release-down-release-track.md), [P2-11](P2-11-updates-page-updaters-shipped-platforms.md), [P2-13](P2-13-portal-channel-picker-sha-256.md), [P2-14](P2-14-optional-split-dev-channel-from-dev.md), [D-03](D-03-diceroll-after-p3.md), [F-36](F-36-feed-cleanup-on-default-dev-main.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                               |
| Plan mode   | yes: executes the approved [`plans/P2-08.md`](../plans/P2-08.md) (2026-10-09)                                                                                                                                                                                                                                                                       |
| Gates       | `plan-mode`, `rule-9`                                                                                                                                                                                                                                                                                                                               |
| Human input | none (the plan was approved on 2026-10-09)                                                                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                           |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **UC-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/P2-12.md`](../plans/P2-12.md) §7: legacy surfaces get `dev` only after P2-12's switch, and only if P2-08 teaches `classifyChannel` (`channels.ts:58-84`) and `policyChannelOf` the `dev` selector.

## Approved plan (2026-10-09)

[`plans/P2-08.md`](../plans/P2-08.md) is approved (2026-10-09, recommendation on all five decisions). Where it differs from the text below, it wins. Contract-adjacent, not wire-changing: no signed document, claim, corpus file or `PROTOCOL_VERSION` change.

- **Include chain.** `dev` is built in with `dev` ⊇ `beta` ⊇ `stable`; a declared `dev` keeps priority, as `staging` does. A product that already publishes to an undeclared `dev` starts to include beta and stable builds unless it declares `includes: []`: say so in the changelog.
- **Worker.** `release/channels.ts`: `ChannelKind` gains `"dev"` and `classifyChannel("dev")` returns it after the manual lookup (today `/update/dev/feed.jws` and every other `{channel}` route 404 for an undeclared dev, `channels.ts:58-84`). `resolve.ts:212` `defaultIncludes` becomes dev to beta, beta to stable. `compose.ts`, `access.ts` (`entitledSelectorFor`) and `admin.ts:540` map dev. Discovery `update.channels` is the known channels minus `pr-<n>`.
- **Shared manifest.** `BUILT_IN_CHANNELS = ["stable","beta","dev"]` at `shared-manifest/src/index.ts:1155`; the hand copy in `release/store.ts:1264` is replaced by it. New `DEFAULT_OUTLET_TRACKS` and `effectiveTrackMap(kind, declared)` in `distribution.ts` (declared entries win per channel, never written back): Play production / open beta / internal, TestFlight none / external / internal, Steam default / beta / dev, Microsoft Store non-flighted / flight beta / none, Snap stable / beta / edge. Setup, provision, `cli/src/transportSteam.ts` and `storefronts/snap.ts` call it.
- **Write path.** One helper `withIncludedChannels(["dev"])` in the tier and licence write routes; the console pickers offer dev with the R3-01 hint (a dev grant still bypasses the version window for 0.0.0-dev builds until P2-14), in console copy (ST-37 ledger, `copy.debt.json`).
- **Stale tracks.** `trackFallbackState(newest, fallbackNewest)` in the Worker release read model, pure, no route: `behind` only when a track's newest build is older than the track it falls back to; "N builds ahead" counts builds newer than the source track's current. P2-09 and P2-11 consume it (`packages.release-tracks-stale`).
- **Action bundle.** `actions/publish/dist` bundles `BUILT_IN_CHANNELS`: rebuild it for its dist drift check.
- **P2-12.** The condition in `plans/P2-12.md` §7 (legacy surfaces get `dev` only if P2-08 teaches `classifyChannel` and `policyChannelOf` the `dev` selector) is met by this package; legacy surfaces answer 404 for dev until P2-12's switch and serve it after.
- **No new rule, route or migration.** The existing `channelMap` validator rules already admit a `dev` key (rule 9: no new rule; the mutation table and schema change only if `pnpm gen` shows the channel enum text drifted). No route (rule 10 does not apply), no migration, no `TABLE_OWNERS` change.
- **Docs.** `services/release/channels.md` (hand-written), plus this package's part of `releases/release-tracks`, `updates/*`, `packs/*` and `help/beta`.

## Goal

Built-in dev release track and default store track maps, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **UC-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §3.1, §3.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §3.1, §3.2, for **UC-01**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.

## Scope

**In:**

- BUILT_IN_CHANNELS gains dev (packages/shared-manifest/src/index.ts:1149); discovery update.channels from known channels minus pr-<n> (services/update/index.ts:56-63); default track maps for Play, TestFlight, Steam, Microsoft Store and Snap; the tier and licence pickers offer dev, and choosing it stores ['beta','dev'] (the 'dev includes beta' rule is applied at write time; the wire predicate is unchanged, WIRE-CONTRACT-V4 §5.1 rule 4) with the R3-01 hint (a dev grant still bypasses the window for 0.0.0-dev builds until P2-14); docs services/release/channels.md; our SDK prereleases publish on dev. Contract change: a documentation row listing dev as built in, no predicate change.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **UC-01**; DX consolidation I: Packages, updates and packs.
- Plan mode (contract row): the plan is approved before any code.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. The approved `plans/P2-08.md` is merged; follow it.
3. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 7 mockup item(s):** `distribution.channel-app-store`, `distribution.publish-result`, `distribution.publish`, `packages.promote`, `packages.release-tracks-stale`, `packages.release-tracks`, `packages.updates`.

## Code check (2026-10-09)

The brief and plan were checked against the code while building. Corrections: `BUILT_IN_CHANNELS` is at `shared-manifest/src/index.ts:1155`, not 1149. The Steam/Snap storefront steps in the CLI read the outlet identity twice (the step builder and the allow-list through `loadStepProduct`), so the default lanes are applied in both. The channels table of `release/store.ts` (`channelNames`) now yields a `dev` row for every product, so a `dev` channel row and health entry (status `unknown`) exist with nothing published. Choosing `dev` stores `beta` with it in the tier, licence and licence-batch write paths. The copy-debt entries and the Release tracks page itself belong to the packages that rebuild that page (P2-09, P2-11); only the tier and licence pickers changed here.

## Acceptance criteria

- [x] No corpus change; signed documents byte-identical (`pnpm gen corpus --check` and `pnpm gen transcripts --check` report zero diff)
- [x] `classifyChannel("dev")` returns `{kind:"dev"}` after the manual lookup and `/update/dev/feed.jws` signs `channel: "dev"`; `defaultIncludes` is dev -> beta -> stable with a declared dev winning
- [x] `effectiveTrackMap` per outlet; the tier and licence write routes store `["beta","dev"]` for dev (server side); `trackFallbackState` is a pure function with the mockup's stale cases
- [x] `actions/publish/dist` is rebuilt and has no drift (`pnpm --filter ./actions/publish build && git diff --exit-code actions/publish/dist`)
- [x] stable, beta and dev exist for every product with no declaration
- [x] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `releases/release-tracks`, `updates/*`, `packs/*`; `help/beta`.
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P2-08 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-08 done`.
