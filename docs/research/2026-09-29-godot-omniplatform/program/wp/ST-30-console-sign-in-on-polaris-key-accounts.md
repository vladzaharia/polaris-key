# ST-30 Console sign-in on Polaris Key accounts

| Field       | Value                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation D: Administration, access control and console identity)                                 |
| Size        | 1.2–1.8 engineer-weeks                                                                                                                                   |
| Depends on  | [ST-29](ST-29-admin-route-table-can-usecan.md), [P0-38](P0-38-authcard-in-ui-auth-ux-40.md)                                                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-31](ST-31-roles-bindings-invites-members-pages.md), [ST-34](ST-34-admin-scope-personal-tokens-pkey-login.md) |
| Role        | `pkey-implementer`                                                                                                                                       |
| Plan mode   | no                                                                                                                                                       |
| Gates       | `threat-model`                                                                                                                                           |
| Human input | none                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **AC-03** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-02, UX-42.

## Goal

Console sign-in on Polaris Key accounts, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **AC-03** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.3, for **AC-03**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.
- [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md), for file and line evidence.

## Scope

**In:**

- Absorbs RB-07, IX-06, UX-42 and UX-02: /manage/callback goes through I-05 signIn; console membership is having a binding (ST-31); the admin cookie carries account and session ids (no groups), checked per request with a 30-second cache; the login card in console context for the seeded env Pocket ID console IdP and passkeys (identifier-first routing to an operator's own SSO connection is ST-32's, after I-30); ST-28's strong-method rule; the computed root rule PLATFORM*ADMIN_GROUP -> Superadmin; ADMIN_OIDC*\* as break-glass for at least 30 days, removed only after 14 days with no break-glass sign-in and at least two Superadmins on passkeys (P0-24 ledger); deletes the 'a session carries full platform authority' invariant comment in admin/session.ts and merges only after ST-29 put docs.ts on can(); audit actor becomes the account id with a sub mapping; signed-out and session-ended states; 'My library' and 'Open console' cross-links; account merge, deletion and disable end membership.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track D (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **AC-03**; DX consolidation D: Administration, access control and console identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Every current PLATFORM_ADMIN_GROUP member signs in as Superadmin with no setup
- [ ] An email-code-only session is refused console access
- [ ] No route treats a non-null session as authorisation (ST-29's grep test still passes)
- [ ] Break-glass documented in the RUNBOOK with its exit facts; security review signed
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-30 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-30 done`.
