# I-15 Portal convergence: links to product users, server-side sessions with logout, `GET /api/me/export`, one Core revocation hook with F-21

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-2)                                                          |
| Size        | 0.6–0.85 engineer-weeks                                                                       |
| Depends on  | [I-06](I-06-users-and-links.md), [F-21](F-21-registry-auth.md)                                |
| Unblocks    | none                                                                                          |
| Role        | `pkey-implementer`                                                                            |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package      |
| Gates       | D1 migration; `TABLE_OWNERS`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; privacy docs |
| Human input | none                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                     |

## Goal

The portal (still global and Polaris-branded) links to product users, has server-side sessions with logout, serves `GET /api/me/export`, and routes "link removed" and "user deleted" through one Core hook that keeps the F-21 registry-token revocation.

## Why

G10 and G11: portal sessions are stateless HMAC with no server-side logout and fall back to `ADMIN_SESSION_SECRET`; GDPR export is missing; F-20/F-21 bind registry tokens to portal links ([S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps), [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps) G10 G11, [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (Portal), [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-15; [`plans/F-20.md`](../plans/F-20.md); the F-21 brief.
- `packages/worker/src/services/identity/portal/{session,repo,api,auth}.ts`.

## Scope

**In:**

- Portal account → product user links (by verified email or explicit claim).
- Server-side portal sessions with logout and "sign out everywhere"; drop the `ADMIN_SESSION_SECRET` fallback.
- `GET /api/me/export` (JSON, Art. 15/20).
- Portal-account deletion reusing I-07's pipeline (tombstones, audit scrub).
- One Core hook for "link removed" and "user deleted" that revokes F-21 licence-bound `pkeyr_` tokens.
- Portal API routes needed for "connected products" (rule 10).

**Out** (and where it belongs instead):

- Portal screens (→ portal redesign per `docs/design/PORTAL.md`).
- "Connected apps" (→ I-16).

## Design notes

- **Portal UI follows `docs/design/PORTAL.md`.** The customer portal is being redesigned in parallel and its spec will be `docs/design/PORTAL.md`. This package delivers only the API and data the portal needs; any portal screen is built to PORTAL.md once it lands (by the portal redesign work, or a follow-up here if PORTAL.md has landed first). Do not design portal UI in this package.
- If F-21 shipped its own hook, extend it rather than replace it (S-16 §9 risk 6).
- The portal stays a platform concern regardless of the Identity flag (D7).

## Steps

1. Sessions and logout.
2. Links and export API.
3. Core hook and F-21 regression tests.

## Acceptance criteria

- [ ] Logout invalidates the session server-side (test).
- [ ] `GET /api/me/export` returns the account's personal data and links (test).
- [ ] Removing a link or deleting a user revokes the bound `pkeyr_` tokens (F-21 regression test).
- [ ] No portal UI is designed here; the PR names the PORTAL.md sections the API serves, if it has landed.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal registry
```

## Hand-off

- The portal redesign builds "connected products" UI on these APIs per PORTAL.md.

The role agent sets `--set I-15 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-15 done`.
