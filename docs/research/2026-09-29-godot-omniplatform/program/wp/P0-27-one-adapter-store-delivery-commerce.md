# P0-27 One adapter per store (delivery and commerce facets)

| Field       | Value                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation H: Distribution channels, storefronts and commerce)                                                                                                              |
| Size        | 1.2–1.8 engineer-weeks                                                                                                                                                                                                      |
| Depends on  | [A-19](A-19-one-channel-catalogue-tools-channels.md), [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md)                                                                                                               |
| Unblocks    | [P0-28](P0-28-one-sealed-credential-store-resolver.md), [P0-51](P0-51-1-0-readiness-review.md), [A-23](A-23-channel-setup-wizards-setup-runner.md), [CM-02](CM-02-provider-webhooks.md), [CM-29](CM-29-commerce-service.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                          |
| Gates       | `rule-10`                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                   |

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

- core/stores/<store>/{client,credentials,events} plus StoreAdapter facets (delivery, commerce) and requirements(); fold DistributionConnector, StorefrontRuntime and the per-store commerce modules for Apple, Play, Microsoft Store, Steam and itch.io; adapters bind to tools/channels.json entries by id under a two-way conformance test. Commerce stays a capability: device routes keep /<p>/distribution/commerce/\* (no commerce service slug, C-17).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-13**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One adapter module per store
- [ ] Two-way catalogue conformance test passes
- [ ] Commerce device transcripts byte-identical
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-27 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-27 done`.
