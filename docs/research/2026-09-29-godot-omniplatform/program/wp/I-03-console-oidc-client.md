# I-03 Console gets its own Pocket ID client (operators only on id.plrs.im)

| Field       | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-0, MVI)                                                                                        |
| Size        | 0.2–0.3 engineer-weeks                                                                                                           |
| Depends on  | none                                                                                                                             |
| Unblocks    | [I-09](I-09-pocket-id-migration.md)                                                                                              |
| Role        | `pkey-implementer`                                                                                                               |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                         |
| Gates       | THREAT-MODEL; `check:links`                                                                                                      |
| Human input | owner creates a second OIDC client for the console in Pocket ID (id.plrs.im) and sets the `ADMIN_OIDC_*` secrets per environment |
| Repo        | `vladzaharia/polaris-key`                                                                                                        |

## Goal

The console signs operators in through its own Pocket ID OIDC client, so the console no longer shares a client (or its secret) with the portal and with `provider: platform` product end users.

## Why

One Pocket ID client serves console admin, the root portal and every `provider: platform` product (G5); a compromise of the shared secret or a group-assignment mistake crosses from customer to operator ([S-16 §3.1](../../notes/S-16-identity-service.md#31-the-platform-idp-is-pocket-id), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 1). The owner confirmed Pocket ID supports separate clients per app.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §3.1](../../notes/S-16-identity-service.md#31-the-platform-idp-is-pocket-id), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 1, [S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes) (console operator sign-in), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-03.
- `packages/worker/src/platformOidc.ts` (today `ADMIN_OIDC_*` is only a fallback behind `PLATFORM_OIDC_*`).
- `packages/worker/src/admin/auth.ts`, `admin/authz.ts`.
- `docs/DEPLOYMENT.md`, `docs/RUNBOOK.md`.

## Scope

**In:**

- Console auth reads `ADMIN_OIDC_ISSUER`, `ADMIN_OIDC_CLIENT_ID` and `ADMIN_OIDC_CLIENT_SECRET` first, falling back to `PLATFORM_OIDC_*` only when the admin trio is unset (so deploys keep working until the owner sets them).
- The portal and `provider: platform` products keep reading `PLATFORM_OIDC_*`.
- Tests for both precedence orders.
- Runbook and deployment docs: how to create the console client in Pocket ID, its redirect URI, and the secrets to set per environment.

**Out** (and where it belongs instead):

- Moving end users off Pocket ID (→ I-09).
- Any change to operator authorisation (`PLATFORM_ADMIN_GROUP` stays).

## Design notes

- **Pocket ID facts (lead, 2026-10-04).** Separate OIDC clients per app are supported [V] (pocket-id.org/docs/introduction), so the console gets its own client. `email_verified` is advertised in `claims_supported` [M]. The admin REST API needs an admin API key; nothing here uses it.
- The client is created by the owner in Pocket ID's admin UI; agents never create or read it. Until the owner sets the secrets, the fallback keeps the console working.
- Do not log or echo the secrets; follow the existing secret-handling pattern in `admin/auth.ts`.

- **Correction (implementer, 2026-10-04).** The code also read `ADMIN_OIDC_*` as a _legacy alias_
  of `PLATFORM_OIDC_*`: `platformOidcConfig` fell back to it for the portal and products, and
  Platform → Settings reported it as `legacyName` with a `legacy_oidc_names` warning. Giving the
  names to the console means the portal must stop reading them, or a deploy with only the admin
  trio would sign customers in through the operators' client. So `platformOidcConfig` now reads
  `PLATFORM_OIDC_*` only, the settings inventory lists both trios, and the warning became
  `console_oidc_shared` (shown while the console falls back).

## Steps

1. Change the precedence in a console-specific config function, with tests.
2. Update DEPLOYMENT and RUNBOOK.
3. Hand the owner the exact Pocket ID steps and secret names in the PR body.

## Acceptance criteria

- [ ] With both trios set, console sign-in uses `ADMIN_OIDC_*` and the portal uses `PLATFORM_OIDC_*` (tests).
- [ ] With only `PLATFORM_OIDC_*` set, everything still works (test).
- [ ] DEPLOYMENT and RUNBOOK describe the console client and its secrets.
- [ ] The PR body lists the owner action (create the client, set three secrets per environment).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- admin auth platformOidc
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- I-09 can move end users off Pocket ID once operators no longer depend on the shared client.

The role agent sets `--set I-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-03 done`.
