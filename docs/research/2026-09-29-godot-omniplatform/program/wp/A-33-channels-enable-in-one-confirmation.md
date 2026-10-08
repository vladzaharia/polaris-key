# A-33 Channels enable in one confirmation; a storefront activates with its channel

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce) |
| Size        | 0.6–0.9 engineer-weeks                                                                                                |
| Depends on  | [A-23](A-23-channel-setup-wizards-setup-runner.md), [P0-28](P0-28-one-sealed-credential-store-resolver.md)            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | none beyond the green gate                                                                                            |
| Human input | none                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-06b** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

## Goal

Channels enable in one confirmation; a storefront activates with its channel, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-06b** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, for **DC-06b**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.

## Scope

**In:**

- 'One click' on a Not set up channel: credentials already held at product or platform level, read through P0-28's resolveCredential (product, then platform, then env), so one confirmation runs A-23's runner and turns the channel on; the storefront facet activates with its channel when one credential serves both; store channels qualify only after A-18k verified that store.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-06b**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Homebrew with the GitHub App's write access enables in one confirmation
- [ ] App Store channel and storefront activate together from one ASC key (after A-18k's Apple answer)
- [ ] No fifth credential reader (resolveCredential only, grep)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-33 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-33 done`.
