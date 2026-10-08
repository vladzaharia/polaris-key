# ST-29 Admin route table, can(), useCan and NoAccessPage (absorbs ST-21)

| Field       | Value                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                     |
| Size        | 1.4–2 engineer-weeks                                                                                                                                                                                                                            |
| Depends on  | [P0-16](P0-16-first-party-respond-body-module-console.md), [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md), [ST-28](ST-28-plan-console-rbac-console-identity-on.md)                                                                     |
| Unblocks    | [P0-25](P0-25-service-portal-public-route-tables.md), [P0-51](P0-51-1-0-readiness-review.md), [ST-10](ST-10-settings-search.md), [ST-30](ST-30-console-sign-in-on-polaris-key-accounts.md), [ST-45](ST-45-platform-product-sidebar-contexts.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                                                                              |
| Gates       | `threat-model`, `rule-10`                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                       |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **AC-02** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- Absorbs ST-21: can() belongs on every admin route, not only settings writes; the registry capability becomes the settings routes' capability.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: `can()` and `resolvePrincipal` live in `W/core/rbac/`, and `can()` is re-exported by `admin/authz.ts`. It uses the 13 areas of §2.1, `rbacArea` in place of `capability` with the security-widening mapping, and the `rbacRouteAreas`/`rbacAreas` drift tests with suffix-named `AREA_MOVES`. It fixes THREAT-MODEL `:5166`.
- [`plans/CM-29.md`](../plans/CM-29.md) §10: the `commerce` row names PS-06's `storefronts/*` explicitly, as a Core route; `distribution/storefronts/**` stays `ship`. CM-29's admin routes are declared `commerce` and keep that area across the move.
- [docs plan](../../../2026-10-08-docs/README.md) §10 amendment 2, as the owner's 2026-10-08 decision (D2) changes it: the docs gate is tiered. Help and the developer sections (`start/`, `build/`, `features/`, `reference/`) are public and need no session; Operate → Console admits any console member; Operate → Platform, Contribute and the runbook stay on `can('platform.docs')`. A reader without the right session reaches the public access page, never a bare console sign-in. This replaces the scope's single `platform.docs` gate on `/docs`.

## Goal

Admin route table, can(), useCan and NoAccessPage (absorbs ST-21), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **AC-02** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.1, §4.2, §4.3, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.1, §4.2, §4.3, §4.4, for **AC-02**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), for file and line evidence.
- [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md), for file and line evidence.

## Scope

**In:**

- AdminRoute declarations for every console route with a capability and an area id (ST-28); a deny-by-default dispatcher owning session, rate limit, CSRF, 405, one product load, capability check, step-up and errors; can() in admin/authz.ts replaces the three identical predicates (authz.ts:19-44) and the handler re-checks (trustPolicy.ts:62, outletCredentials.ts:80, ciPublishing.ts:122,153); docs.ts serves Help and the developer sections publicly, Operate → Console to any console session, and Operate → Platform, Contribute and the runbook through can('platform.docs') (Superadmin and Platform admin), no longer through 'a session exists' (docs.ts:7-11,160; owner, 2026-10-08); /me.permissions; useCan; nav, palette and attention filtering; NoAccessPage listing who can grant access in that scope (name and a copyable email); every write control's disabledReason names the same people. With only the root rule, behaviour is unchanged. Absorbs ST-21.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **AC-02**; DX consolidation B: Foundations (code quality the feature tracks build on).
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A route x principal matrix test covers every admin route
- [ ] sessionFromRequest() is called only by the deny-by-default dispatcher (grep test)
- [ ] docs.ts serves Help and the developer sections with no session, gates Operate → Console on a console session, and gates Operate → Platform, Contribute and the runbook on `can('platform.docs')` (owner, 2026-10-08)
- [ ] THREAT-MODEL §9 trigger reviewed; no behaviour change for platform admins
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `operate/console/members`, `reference/roles`, the runbook's lockout recovery and the rule 11 text.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-29 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-29 done`.
