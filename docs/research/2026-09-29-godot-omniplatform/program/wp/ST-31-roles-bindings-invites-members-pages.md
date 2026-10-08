# ST-31 Roles, bindings, invites and the Members pages (absorbs ST-22)

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation D: Administration, access control and console identity)                          |
| Size        | 1.4–2 engineer-weeks                                                                                                                              |
| Depends on  | [ST-30](ST-30-console-sign-in-on-polaris-key-accounts.md)                                                                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-32](ST-32-sso-rules-admingroup-conversion.md), [ST-35](ST-35-rbac-docs-lockout-recovery-docs-gate.md) |
| Role        | `pkey-implementer`                                                                                                                                |
| Plan mode   | no                                                                                                                                                |
| Gates       | `migration`, `table-owners`, `threat-model`, `console-csp-parity`                                                                                 |
| Human input | none                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **AC-04** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity).

- Absorbs ST-22: No longer optional: the owner asks for full RBAC (ST-28 plan, ST-29 gate, ST-30 sign-in, ST-31 roles). Security review carried over.

## Goal

Roles, bindings, invites and the Members pages (absorbs ST-22), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **AC-04** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.4, for **AC-04**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md), for file and line evidence.

## Scope

**In:**

- One table, console_role_bindings (subject = account_id or email_norm, role, scope, areas, source, by, at): a member is anyone with at least one binding; an invite is a binding on an email, converted at the first strong sign-in the way a waiting licence is; the four built-in roles with platform, product and All-products scopes; area narrowing on Product admin; the product creator becomes Product admin; Platform -> Members (Members, Invite, Roles matrix generated with a drift gate) and Product -> Settings -> Members (standalone until ST-08's hub); step-up, notify and audit on every grant.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track D (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **AC-04**; DX consolidation D: Administration, access control and console identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Console access alone shows NoAccessPage with the scope's admins to contact
- [ ] A product admin sees only their products; an area-narrowed one sees only those areas
- [ ] Roles matrix is generated and drift-gated; security review before merge
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-31 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-31 done`.
