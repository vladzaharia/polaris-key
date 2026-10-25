# P0-27 One adapter per store (delivery and commerce facets)

| Field       | Value                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation H: Distribution channels, storefronts and commerce)                                                                          |
| Size        | 0.8–1.3 engineer-weeks                                                                                                                                                                  |
| Depends on  | [A-19](A-19-one-channel-catalogue-tools-channels.md), [P0-27a](P0-27a-store-clients-core-stores.md)                                                                                     |
| Unblocks    | [P0-28](P0-28-one-sealed-credential-store-resolver.md), [P0-51](P0-51-1-0-readiness-review.md), [A-23](A-23-channel-setup-wizards-setup-runner.md), [CM-02](CM-02-provider-webhooks.md) |
| Role        | `pkey-implementer`                                                                                                                                                                      |
| Plan mode   | no                                                                                                                                                                                      |
| Gates       | `rule-10`                                                                                                                                                                               |
| Human input | none                                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                               |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-13** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

## Goal

One adapter per store (delivery and commerce facets), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-13** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.3, for **CQW-13**.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- StoreAdapter facets (delivery, commerce) and requirements() over core/stores/<store>/; fold DistributionConnector, StorefrontRuntime and the per-store commerce modules for Apple, Play, Microsoft Store, Steam and itch.io; adapters bind to tools/channels.json entries by id under a two-way conformance test.

**Out** (and where it belongs instead):

- The move of each store's client, credentials and events to core/stores/<store>/ (→ [P0-27a](P0-27a-store-clients-core-stores.md), split off by [`plans/CM-29.md`](../plans/CM-29.md) Q5); the `commerce` service and its routes (→ CM-29).
- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-13**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Corrections (2026-10-22)

The code is the fact; these replace any contrary brief text. Source: `_lead/plans/P0-27-F-34-slices.md` §0.

- **C1. itch.io has no client, credentials or events.** Its only code is the CI-plane declaration `core/storefront/stores/itch.ts`. Its adapter is a declaration with no delivery runtime and no commerce facet; CM-27 is the spike for itch commerce.
- **C2. `StorefrontRuntime` had no implementer.** A-18j replaced it with `FlowRuntime`. "Fold StorefrontRuntime" means: delete the interface (done in P0-27.1), and the flow runtime becomes a member of the delivery facet.
- **C3. `DistributionConnector` exists for three stores only** (`asc`, `play`, `ms-store`). Steam has no connector; its delivery code is `storefronts/steam/*` over `core/stores/steam/`. `core/ops/operations.ts` repeats the connector kinds as a second list.
- **C4. Commerce's per-store code** lives in `services/commerce/{apple,appleRoot,play,steam}.ts`, dispatched by `store === ...` ladders (`bridge.ts`, the two hook handlers, `recheck.ts`, `admin.ts`). Approved `plans/CM-29.md` D3 puts these files at `services/commerce/stores/<store>/`.
- **C5. The commerce store ids are wire.** A claim body's `store` is `app-store`, `play` or `steam` (`core/licensing/storeGrants.ts`); the storefront id is `google-play`. The adapter maps the two; nothing on the wire changes.
- **C6. The catalogue's two-way test already exists for `STOREFRONT_ADAPTERS`** (`tools/gen-channels.test.ts`, A-19). P0-27 adds the store-adapter and facet binding, including `verification`, `notification` and `sku`.
- **C7. Rule 6 rules out one module per store holding both facets.** The declaration lives in Core (`core/stores/`), each service registers its facet by id, and a test binds the two.
- **C8. Credential reach.** A new Core file that reads credential metadata needs a reviewed line in `test/outletCredentialReach.test.ts`.
- **C9. Stale text.** CM-29 is done. The two lines `plans/CM-29.md` section 10 tells P0-27 to delete ("no commerce service slug (C-17)", "device routes keep `/<p>/distribution/commerce/*`") are not in this brief; nothing to delete here.
- **C10. Routes.** No route changes; `routeCoverage` stays green with no spec edit.
- **C11. Size.** tracks.md says 1.2-1.8 weeks; this brief says 0.8-1.3 after the P0-27a split. The brief stands.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] One adapter module per store
- [x] Two-way catalogue conformance test passes
- [x] Commerce device transcripts byte-identical
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches. Not fully green at P0-27.7: `gen --check` constants and action-bundle fail on the held base (A-20.3 attention codes lack `errors.json` rows; `actions/publish/dist` stale), both outside this chain; the lead resolves them when the chains merge.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-27 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-27 done`.
