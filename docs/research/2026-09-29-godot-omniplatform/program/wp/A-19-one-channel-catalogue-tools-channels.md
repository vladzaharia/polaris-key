# A-19 One channel catalogue (tools/channels.json)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce)                                                                                                                                                                                                                                                                                                                                 |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on  | [ST-37](ST-37-vocabulary-one-word-concept-rule-4.md)                                                                                                                                                                                                                                                                                                                                                                                                  |
| Unblocks    | [P0-27](P0-27-one-adapter-store-delivery-commerce.md), [P0-51](P0-51-1-0-readiness-review.md), [A-20](A-20-product-facts-channel-read-model.md), [A-25](A-25-action-v2-channels-auto-thin-inputs.md), [A-26](A-26-customer-channel-actions.md), [A-27](A-27-one-listing-truth-absorbs-st-13.md), [A-28](A-28-one-store-app-binding-derived-identity.md), [A-29](A-29-homebrew-formula-cli-archives.md), [A-31](A-31-derived-identities-short-pkey.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Gates       | none beyond the green gate                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-02** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-52.

## Goal

One channel catalogue (tools/channels.json), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-02** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.3, for **DC-02**.
- [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), for file and line evidence.

## Scope

**In:**

- tools/channels.json holds ids, aliases, labels, family, plane, platforms, formats, deliverable kinds, customer action, verbs, auto and human steps and an optional storefront facet (verification credential slot, notification kind, SKU kind), generated into the worker, console, portal and CLI (registered in P0-42); about 18 entries; the about nine label/kind tables migrate (P0-35's stores half; absorbs UX-52); adapters bind by id under a two-way conformance test; platforms are a subset of OUTLET_PLATFORMS; play/google-play and ms-store/microsoft-store spellings reconciled; no new outlet kinds.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-02**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 1 mockup item(s):** `distribution.channels`.

## Acceptance criteria

- [ ] One store label table (lint refuses literals elsewhere)
- [ ] Two-way conformance test passes
- [ ] gen --check covers the generated copies
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/channels/*`, rewritten in place (one page per channel; the matrix section at A-21); `reference/channels`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-19 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-19 done`.
