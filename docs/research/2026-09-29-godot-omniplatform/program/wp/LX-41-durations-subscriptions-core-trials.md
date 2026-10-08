# LX-41 Durations and subscriptions core: trials, onExpiry keepVersion, licenseState, Core subscriptions

| Field       | Value                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                                                                                                                         |
| Size        | 2–2.8 engineer-weeks                                                                                                                                                                                                                     |
| Depends on  | [LX-33](LX-33-licence-tier-platform-default-every.md), [LX-12](LX-12-licence-lifecycle.md)                                                                                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-15](LX-15-portal-licensing.md), [LX-18](LX-18-licensing-wire.md), [LX-23](LX-23-subscriptions.md), [CM-08](CM-08-subscriptions.md), [LX-43](LX-43-licensing-presets-1-x-helper-new-major.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                    |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/LX-41.md` first; no code before a human approves it                                                                                                                                               |
| Gates       | `plan-mode`, `migration`, `table-owners`, `threat-model`                                                                                                                                                                                 |
| Human input | plan approval (`plans/LX-41.md`)                                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-41** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

## Goal

Durations and subscriptions core: trials, onExpiry keepVersion, licenseState, Core subscriptions, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-41** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.1, §4.2, §4.3, for **LX-41**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md), for file and line evidence.

## Scope

**In:**

- tiers/licenses.on_expiry (stop | keepVersion | tier:<id>, the last for trials that convert, e.g. 14 days of Pro then Free) and licenses.fallback_version frozen at lapse through releaseCatalog (devices.app_version when Ship builds is off); a trial is a fixed duration on a tier, offered as a preset (LX-43); licenseState per gate replaces licenseUsable; a Core subscriptions table for every source (manual, external, app-store, play, polaris-key) with states trialing, active, past_due, canceled and expired, renew, cancel and dunning (unhides license.dunningGraceDays); the admin renew API (rule 10) so subscriptions work with Commerce off; console subscription panel on the licence (the one subscriptions view), Renew... and Preview at a date; lapse and trial-ending emails through core/notify; grace clamp null for keepVersion; the duration member's wire rows (including trial end and tier:<id>) go into LX-18's plan; THREAT-MODEL rows.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-41**; DX consolidation E: Licensing model.
- Security review and THREAT-MODEL rows before merge (`sec`).
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/LX-41.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] JetBrains fixture: subscribe through 1.0-1.4, lapse, keeps running 1.4 forever, refused 1.5
- [ ] '1.x forever, 2.x subscription' fixture with two licences
- [ ] Trial fixture: 14 days of Pro, then the licence runs on Free with no operator step
- [ ] Works with no storefront configured
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-41 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-41 done`.
