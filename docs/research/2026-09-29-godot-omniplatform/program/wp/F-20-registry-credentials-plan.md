# F-20 Plan registry credentials: `pkeyr_` tokens, licence binding, per-client challenges and the OCI token service

| Field       | Value                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-2)                                                     |
| Size        | 1 engineer-weeks                                                                            |
| Depends on  | [F-02](F-02-registry-host.md)                                                               |
| Unblocks    | [F-21](F-21-registry-auth.md)                                                               |
| Role        | `pkey-wire-planner` (planning only)                                                         |
| Plan mode   | yes: this package **is** the plan. It writes `plans/F-20.md`, then stops for human approval |
| Gates       | plan mode; human approval                                                                   |
| Human input | approval of `plans/F-20.md` and answers to its questions                                    |
| Repo        | `vladzaharia/polaris-key`                                                                   |

## Goal

`plans/F-20.md` fixes registry credentials so that F-21 can implement them:

- the `pkeyr_` token prefix, which touches AGENTS.md rule 8's naming list;
- hashing at rest;
- scopes (`read`, `publish`), ecosystem narrowing and expiry;
- minting in the console (platform admin) and the customer portal (licence-bound read tokens);
- how each client presents a token, mapped onto F-02's `feedPrincipal`;
- the OCI token service (`/v2/token`, anonymous pull tokens);
- Swift `POST /login`;
- Cargo `auth-required`;
- tokenised Godot listing URLs;
- the caching consequences.

## Why

The owner chose public read now and auth later, as a configuration change. F-02's seam makes
that possible. This plan decides what fills it ([S-12 §7.2](../../notes/S-12-package-feeds.md#72-what-auth-adds-later-tier-2-f-20f-21)).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.6; F-02's `authorize.ts` as landed; `AGENTS.md` rule 8;
  `services/distribution/blobAccess.ts`; the portal's session model.

## Scope

**In:**

- The plan, with every item in the Goal answered or raised as a question.

**Out:**

- Code (→ [F-21](F-21-registry-auth.md)).

## Design notes

- `pkeyci_` tokens are also accepted for reads by the same product's CI.
- Credentials travel only in `Authorization`, never in cookies.
- A token never widens past the feed's mode.

## Steps

1. Read the landed F-02 code.
2. Write the plan.
3. `--set F-20 awaiting-approval`.

## Acceptance criteria

- [ ] Nine required sections.
- [ ] Rule 8's naming change is spelled out.
- [ ] Every client's challenge and credential form is listed.
- [ ] `node check.mjs` passes.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

- F-21 executes the plan.

The role agent sets `--set F-20 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-20 done`.
