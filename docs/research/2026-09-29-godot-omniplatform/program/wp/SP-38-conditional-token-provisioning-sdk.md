# SP-38 Conditional: token provisioning for SDK installs

| Field       | Value                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation J: SDK and UI-kit consolidation)              |
| Size        | 0.8–1.2 engineer-weeks                                                                                         |
| Depends on  | [SP-33b](SP-33b-integration-content-on-polaris-key-json.md), [F-37](F-37-pkey-feeds-setup-write-cli-naming.md) |
| Unblocks    | none                                                                                                           |
| Role        | `pkey-implementer`                                                                                             |
| Plan mode   | no                                                                                                             |
| Gates       | none beyond the green gate                                                                                     |
| Human input | owner decision 3 (answered 2026-10-07, open to veto)                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                      |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-07** in [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation).

## Goal

Conditional: token provisioning for SDK installs, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **SDX-07** in [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/sdk-uikits-dx.md`](../../../2026-10-07-dx-consolidation/audits/sdk-uikits-dx.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §6, for **SDX-07**.
- [`audits/sdk-uikits-dx.md`](../../../2026-10-07-dx-consolidation/audits/sdk-uikits-dx.md), for file and line evidence.

## Scope

**In:**

- Only if owner decision 3 gates the SDK feeds: pkey sdk add and the Integration page mint a read-only developer token and write it to user-level config (~/.npmrc, pip keyring, swift package-registry login, ~/.gradle/gradle.properties), never the project; CI guidance with pkeyci\_; the Godot dock downloads the addon itself; install-from-feeds page rewritten. Must ship in the same release as gating.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track J (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **SDX-07**; DX consolidation J: SDK and UI-kit consolidation.
- Gated on owner decision 3 ([README §8](../../../2026-10-07-dx-consolidation/README.md#8-owner-decisions)), answered on 2026-10-07 under delegated authority with the recommendation and open to the owner's veto; a veto takes that row's "If the answer is no" column.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Gated installs work end to end in every SDK lane
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-38 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-38 done`.
