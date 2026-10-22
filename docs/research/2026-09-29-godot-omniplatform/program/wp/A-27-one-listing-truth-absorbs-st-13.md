# A-27 One listing truth (absorbs ST-13)

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce) |
| Size        | 0.8–1.2 engineer-weeks                                                                                                |
| Depends on  | [A-19](A-19-one-channel-catalogue-tools-channels.md), [HA-12](HA-12-presentation-discovery.md)                        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [A-27b](A-27b-drop-dist-listing-table-release-n-1.md)                         |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | `migration`, `table-owners`, `rule-9`                                                                                 |
| Human input | none                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-10** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- Absorbs ST-13: Listing has one home (Core -> Presentation plus per-channel Listing tab); a hub copy would be a third.

## Goal

One listing truth (absorbs ST-13), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-10** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.4, for **DC-10**.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- Portal, download page and Discover read the A-18b listing model with a dual-read fallback; backfill from the manifest dist_listing blob through a P0-49 job; Listing inherits its base fields from core.presentation; Core -> Presentation plus a per-channel Listing tab; release N stops every dist_listing read and write; A-27b drops the table a release later; ST-13's hub copy not built.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-10**; DX consolidation H: Distribution channels, storefronts and commerce.
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One listing store
- [ ] Presentation edits show on every channel's listing
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/channels/*`, rewritten in place (one page per channel; the matrix section at A-21); `reference/channels`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-27 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-27 done`.

## Corrections (2026-10-22)

The code is the fact; the plan is `_lead/plans/A-27-slices.md`. Phase 1 (A-27.1 to .13) is the expand, phase 2 (A-27.14) the contract, and A-27b drops `dist_listing` at least 14 days after phase 2 is live.

- **C1. Four listing stores, not two.**
  - `dist_listing` (0063): the manifest root listing as a blob. Only `outlets.ts` writes it (ingest). It is read through `delivery().listing()` by portal `library.ts` (`productListing`, `presentationFor`), `media.ts` (the proxy's art source), `store/obtain.ts`, `store/panelStatus.ts`, `productOidc/pages.ts` and `core/presentation.ts` (discovery's `core.presentation`, HA-12).
  - `dist_listings*` (A-18b, 0065, 0069 provenance): the console editor, imports, store pushes, the AltStore and Obtainium feeds (`listing/feed.ts`), the CI projection and `legalUrls` (I-33).
  - `dist_outlets.listing_json`: each outlet's merged copy (the feeds' fallback, the download page, the import's `manifest` source).
  - `hosted_assets` plus `products.presentation_json`: art and accents.
- **C2.** The download page reads `dist_outlets.listing_json`, not `dist_listing`. `/<p>/distribution/download.json` is transcript-recorded (`distribution-download-model.json`) and stays byte-identical.
- **C3.** Discovery's `core.presentation` takes `name` and `developerName` from `delivery().listing()`. Changing the hook's source changes SDK-visible display data for a product whose model differs from the blob. The shape is unchanged (unsigned display data, no `PROTOCOL_VERSION` change); `discovery-presentation.json` has no Distribution, so it does not move.
- **C4.** The model stores blobs, not art URLs (A-18d, HA-07). The media proxy's hosting-off rollback takes its source URL from the blob; `hosted_assets.source_ref` (0078) holds the same source.
- **C5.** The model's limits are tighter than the manifest's (name and subtitle 30 against 200, developerName 100, category 64). An import refuses an over-limit value and never cuts it.
- **C6.** A-18b says no ingest writes the model. integration.md section 5.7 supersedes this (decision D4).
- **C7.** Per-field provenance exists already (0069 `provenance_json`; the admin view returns it). ST-13's provenance needs only the UI.
- **C8.** Core's manifest snapshot (`core/manifestSnapshot.ts`, ST-01a) holds the root listing. Revert reads it.
- **C9.** The accent is manifest-only: `core.presentation` is decode-only. "Presentation edits" means `.pkey/product presentation` (name, accent, accentDark, icon) and HA-06 icon uploads.
- **C10.** ST-13 still owns 7 entries in `packages/worker/scripts/settings-coverage.ts` `PENDING` (ceiling 13). A-27 takes them as `NOT_A_SETTING`.
- **C11.** The console has no `LEGACY_REDIRECTS`. A moved page is a `routeLedger.ts` row (`moved`, `to`, `by`) plus `pnpm gen route-ledger`; it shows a "Page moved" page and does not redirect.
- **C12.** The import's `manifestSource` (`listing/sources.ts`) reads an outlet's merged copy, not the root listing, and drops `supportUrl` and `supportEmail`.
- **C13.** `test/fixtures/ingest/golden.json` is never regenerated by a script. A re-capture is a sanctioned edit listed in `test/ingest/golden.test.ts`'s header, and D1 round trips may not grow.
- **C14.** `services/distribution/index.ts` gets `contributes.migrations` only in F-34.4 (held). A-27's job appends to it.

A-27.1 built the dual read: `listing/resolved.ts` `resolvedListing(db, product)` backs `delivery().listing()`; the model's default locale wins per field and the blob fills the rest (art refs come from the blob only). `listing/feed.ts` shares its row mapping.
