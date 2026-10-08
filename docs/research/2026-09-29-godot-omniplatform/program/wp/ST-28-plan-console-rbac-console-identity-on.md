# ST-28 Plan: console RBAC and console identity on accounts

| Field       | Value                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Phase       | ST: Settings, access control and console shell (DX consolidation D: Administration, access control and console identity) |
| Size        | 0.6–0.8 engineer-weeks                                                                                                   |
| Depends on  | none                                                                                                                     |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-29](ST-29-admin-route-table-can-usecan.md)                                   |
| Role        | `pkey-wire-planner` (planning only)                                                                                      |
| Plan mode   | yes: [`plans/ST-28.md`](../plans/ST-28.md), approved 2026-10-08; ST-29 to ST-35, ST-25 and ST-25b build it               |
| Gates       | `plan-mode`, `threat-model`, `rule-10`                                                                                   |
| Human input | none                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **AC-01** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity).

- Owner 2026-10-07: the plan keeps only the break-glass window; `PKEY_ADMIN_COOKIE` goes with ST-34's tokens and no other compatibility window is planned (`tracks.md` rule 6).

## Goal

Plan: console RBAC and console identity on accounts, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **AC-01** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.1, §4.2, §4.3, for **AC-01**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md), for file and line evidence.

## Scope

**In:**

- Decision record amending S-16 decision 3, S-18 D10, S-13 §8.2 and AGENTS.md rule 11's docs gate (console on accounts is decided under the brief, owner-brief 'Console/Management accounts'): the owner's four built-in roles (Superadmin, Platform admin, Product admin, Console access) summed, no deny rules; a Product admin binding can be narrowed to areas (a storefront manager is a Product admin narrowed to Ship builds and Commerce); Product editor and Product viewer deferred until a product asks; scopes (platform, product, all products); areas are stable ids declared on every ST-29 route entry (license, config, ship, signin, sync, commerce, core, keys, settings, members), independent of sidebar placement, with a drift gate that fails when a route's area changes without a binding migration; grant rules (no escalation, step-up, notify, audit); the root rule PLATFORM_ADMIN_GROUP -> Superadmin (computed, non-removable); the strong-method rule (a passkey, or a connection whose audience includes operators and whose issuer is on OIDC_ISSUER_ALLOWLIST; a passkey or link added during a session that was not strong counts only after step-up through an existing strong method; an email code alone never opens the console); DDL for one table, console_role_bindings (subject = account_id or email_norm, role, scope, areas, source, by, at); SSO rules as the platform setting console.access in license.access's rule JSON; the route-permission table design; session binding; break-glass and cookie windows in days; THREAT-MODEL AT-2 amendment and new rows.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track D (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **AC-01**; DX consolidation D: Administration, access control and console identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Write `plans/ST-28.md` and stop for human approval; name the corpus regeneration and every SDK that follows where the wire is touched.
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Roles x areas table and DDL approved
- [ ] The strong-method rule is defined, with the step-up rule for methods added mid-session
- [ ] Security review checklist written
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-28 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-28 done`.
