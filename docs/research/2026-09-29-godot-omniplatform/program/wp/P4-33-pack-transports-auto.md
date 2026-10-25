# P4-33 Pack transports auto

| Field       | Value                                                                     |
| ----------- | ------------------------------------------------------------------------- |
| Phase       | P4: Packs (DX consolidation I: Packages, updates and packs)               |
| Size        | 0.6–0.9 engineer-weeks                                                    |
| Depends on  | [A-25](A-25-action-v2-channels-auto-thin-inputs.md)                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [D-05](D-05-diceroll-after-p6.md) |
| Role        | `pkey-implementer`                                                        |
| Plan mode   | no                                                                        |
| Gates       | `rule-9`                                                                  |
| Human input | none                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                 |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CP-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

## Goal

Pack transports auto, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CP-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.3, for **CP-01**.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.

## Scope

**In:**

- transports.packs: auto in shared-manifest (Background Assets on Apple channels, Steam depots on Steam, Play Asset Delivery only when chosen, the CDN elsewhere); pkey storefronts sync runs the transport package and upload steps on A-25's Action; fallback to pkey-cdn without store credentials with a readiness note; the ASC connector adds asset-pack versions to submissions where the API allows.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CP-01**; DX consolidation I: Packages, updates and packs.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Corrections (2026-10-24)

Verified against the code; the code is the fact. Slices: `P4-33.1` manifest, `.2` Worker readiness, `.3` CLI sync, `.4` Action, `.5` docs (plan: `_lead/plans/P4-33-A-32-slices.md`).

- **T1.** The command is `pkey channel sync`, not `pkey storefronts sync` (A-25 D-A1; `channelSync.ts` reserves the `transport` step kind for this package).
- **T2.** `transports.packs` is a per-outlet map today (`checkMap`, the schema's `transportMap`); order is deliverable map, packs map, default. `auto` is a new accepted value, so rule 9 applies. Decision D-P1: `transports.packs: auto` is the whole map as one word; `transports.deliverables` still overrides.
- **T3.** Sync never sees Steam or the App Store: its plan takes `pr`/`ci` plane channels plus F-Droid, and `steam`, `app-store`, `testflight`, `google-play` are `worker` plane. Transport rows come from the pack routes (`normalizeDistribution(...).routes`), not from planes.
- **T4.** Sync runs only after an app publish; transports need the pack publish's cache (`release publish --deliverable <packId> --out <dir>`).
- **T5.** Each transport needs an input the manifest lacked or a runner it may not have: Steam's depot was a flag only (now `depots`, D-P3); Apple's archive needs macOS and the ASC key; Play's modules patch the Gradle build before the AAB exists, so they never run after publish (D-P5: `auto` never picks `play-pad`).
- **T6.** "Fallback to the CDN" is a readiness rule, not a delivery change: the CDN serves pack objects whatever the transport. `apple-ba` readiness fails closed without an `approved`/`live` availability record, so an `auto` route to Background Assets with no ASC key must not hold the release (D-P2: route `origin`, P4-33.2).
- **T7.** No wire change. Only `play-pad` narrows a pack to `pinned` in the signed feed, and `auto` never picks it; the corpus reads no `.pkey/distribution`.
- **T8.** The ASC part is done (A-17e): `distribute/submission-items` lists every COMPLETE asset-pack version in a submittable state and the console's submit step checks each by default. Nothing to build.
- **T9.** Two docs targets do not exist: `releases/release-tracks` and `help/beta`. This package's part is `packs/*` (`features/ship-builds/packs/transports.mdx`, `ship-a-pack.mdx`) and `ci.md`'s pack job.
- **T10.** Verify runs more than the CLI suite: shared-manifest, the Worker and the docs build are touched too.

Settled in P4-33.1 (route shape, for .2 and .3): `ManifestTransportRoute` is `{ deliverableId, outletId, transport, origin }` with `origin: "declared" | "auto" | "default"` (`declared` = a `deliverables` override or an entry of the `packs` map; `auto` = derived by `packs: auto`, including its CDN results; `default` = fell through to `transports.default`). `ManifestTransports.packs` is `Record<string, Transport> | "auto"`. The rule is the exported `autoPackTransport(kind, hasDepot)`. A steam outlet's `depots` is `{ <packId>: "<digits>" }`, keys refused unless they name a declared pack (`unknown_deliverable_ref`).

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 1 mockup item(s):** `packages.packs`.

## Acceptance criteria

- [ ] A pack ships on every channel with no per-transport CI step
- [ ] Missing credentials degrade to the CDN with a note
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `releases/release-tracks`, `updates/*`, `packs/*`; `help/beta`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P4-33 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-33 done`.
