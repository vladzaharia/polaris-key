# A-23 Channel setup: wizards and the setup runner

| Field       | Value                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce)                                                                             |
| Size        | 1.4–2 engineer-weeks                                                                                                                                                                              |
| Depends on  | [A-22](A-22-channel-page-status-releases-listing.md), [ST-39](ST-39-wizard-kit.md), [A-28](A-28-one-store-app-binding-derived-identity.md), [P0-27](P0-27-one-adapter-store-delivery-commerce.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [A-33](A-33-channels-enable-in-one-confirmation.md)                                                                                                       |
| Role        | `pkey-implementer`                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                |
| Gates       | none beyond the green gate                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-06** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-55, UX-68.

## Goal

Channel setup: wizards and the setup runner, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-06** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **DC-06**.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- Human-step wizards per facet (UX-55) on ui/wizard's drawer host; the setup runner (UX-68) over each store adapter's requirements() (P0-27) performs every automatable action after one Set up consent (a core.setup choice) and re-runs on fact changes (a new build platform, a new credential); team-key app matching to build identities; testing tracks receive every release by the channel's track map (P2-08), and mapping no track means no automatic sends (no per-channel switch). Non-store channels (Homebrew, winget, Scoop, package feeds, Polaris Key) automate now; each store's rows stay human steps until A-18k verifies that store.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-06**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Homebrew's setup runs end to end from the wizard with the GitHub App's write access
- [ ] Store rows are human steps until A-18k's verified answer for that store (test fixture)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-23 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-23 done`.
