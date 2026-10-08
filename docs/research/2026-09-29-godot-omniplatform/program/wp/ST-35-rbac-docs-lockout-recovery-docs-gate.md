# ST-35 RBAC docs, lockout recovery, docs-gate split and adminGroup contract

| Field       | Value                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Phase       | ST: Settings, access control and console shell (DX consolidation D: Administration, access control and console identity) |
| Size        | 0.4–0.6 engineer-weeks                                                                                                   |
| Depends on  | [ST-31](ST-31-roles-bindings-invites-members-pages.md), [ST-32](ST-32-sso-rules-admingroup-conversion.md)                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                   |
| Role        | `pkey-implementer`                                                                                                       |
| Plan mode   | no                                                                                                                       |
| Gates       | `threat-model`, `docs-links`                                                                                             |
| Human input | none                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **AC-08** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity).

## Goal

RBAC docs, lockout recovery, docs-gate split and adminGroup contract, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **AC-08** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, for **AC-08**.
- [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md), for file and line evidence.

## Scope

**In:**

- 'Console access and roles' page with the generated roles matrix; THREAT-MODEL AT-2 rows (grant escalation, rule hijack, invite takeover, strong-method bypass); RUNBOOK lockout recovery; the docs gate (rule 11) widens from Platform admin (ST-29) to any console member, with operator-only sections behind Platform admin through a Pagefind index split; ADMIN, EXPERIENCE, SETUP, FLOWS and SIGN-IN amendments; the adminGroup contract drop lands with ST-25.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track D (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **AC-08**; DX consolidation D: Administration, access control and console identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Rule 11 text amended
- [ ] Lockout recovery rehearsed in a test environment
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm --filter @polaris-key/docs build
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-35 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-35 done`.
