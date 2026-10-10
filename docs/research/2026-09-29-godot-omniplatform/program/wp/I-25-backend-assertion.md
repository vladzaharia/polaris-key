# I-25 RFC 7523 product-backend assertion (console platforms) with `jti` replay cache and console key management

| Field       | Value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (later)                                                          |
| Size        | 0.4–0.8 engineer-weeks                                                                                                              |
| Depends on  | [I-13](I-13-exchange-endpoint.md)                                                                                                   |
| Unblocks    | none                                                                                                                                |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                               |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-25.md` first; it needs human approval before code                                          |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen constants --check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL |
| Human input | none                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                           |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive when a console storefront (PSN, Xbox, Nintendo) becomes real. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Console-platform backend assertion. Revive when a console storefront (PSN, Xbox, Nintendo) becomes real.

## Goal

Console-platform games (PSN, Xbox, Nintendo) can sign in through the product's own backend with an RFC 7523 JWT assertion, verified with a `jti` replay cache, with the backend's keys managed in the console.

## Why

Console platform verification is under NDA and cannot ship in an open-source Worker or SDK; an assertion from the developer's backend covers it ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J12).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); `plans/I-25.md` once approved.
- [S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J12, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-25.

## Scope

**In:** a `backend` exchange kind on I-13's route, key registration in the console, `jti` cache, audit.

**Out** (and where it belongs instead):

- Platform-specific verification (never in this repo).

## Design notes

- Optional and deferred.
- Identity service only (owner, 2026-10-04). The assertion is minted by the developer's backend, so like D18 (decided) it is tenant-controlled: its links are tenant-scoped to that developer and are created only after the person proves their account on the login card (`interstitial_required`, with "Continue to <App>" per D22). A backend can never reach an account outside its own products.

## Steps

1. Plan, approved. 2. Kind, keys and replay cache.

## Acceptance criteria

- [ ] A replayed `jti` and an unregistered key are refused (tests).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity assertion
```

## Hand-off

- U-16 may use it as the fallback credential (S-17 decision 12).

The role agent sets `--set I-25 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-25 done`.
