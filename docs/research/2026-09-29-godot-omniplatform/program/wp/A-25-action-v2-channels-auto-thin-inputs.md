# A-25 Action v2: channels auto and thin inputs (absorbs CQS-10)

| Field       | Value                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce)                                                |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                 |
| Depends on  | [A-19](A-19-one-channel-catalogue-tools-channels.md), [P0-45](P0-45-pkey-command-registry-context-doctor.md)                                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P4-33](P4-33-pack-transports-auto.md), [D-03](D-03-diceroll-after-p3.md), [A-32](A-32-github-write-path-publish-from-ci.md) |
| Role        | `pkey-implementer`                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                   |
| Gates       | `rule-9`                                                                                                                                                             |
| Human input | none                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                            |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-08** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.
- Owner 2026-10-07: no compatibility window. What this package replaces (a route, mode, shape, Action input or CLI form) is removed in the same release; the one exception is a path that native app binaries already on end-user machines call (DJDL's desktop builds, the permanent alias routes), removed once DJDL has shipped a build on 0.9 (`tracks.md` rule 6).
- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-56.

## Goal

Action v2: channels auto and thin inputs (absorbs CQS-10), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-08** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.3, for **DC-08**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.

## Scope

**In:**

- pkey storefronts sync, pkey channel add and renderOutletBlock (UX-56); the Action's channels: auto covers CI and PR channels and implied transport steps; thin inputs (command, args, secrets, base-url, working-directory, dry-run; the product from .pkey/), old inputs accepted for the Action's deprecation window (at least 30 days and one minor, P0-24) with a deprecation annotation; storefront, itch-platform and storefront-outlet inputs deprecated; bundle regenerated. Absorbs UX-56.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-08**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A product's workflow needs no per-channel step
- [ ] Old inputs warn through the window
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-25 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-25 done`.
