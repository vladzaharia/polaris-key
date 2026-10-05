# PX-W3 Licensed R2 downloads (G3): signed short-lived bytes URL or streaming through `/download/<token>`

| Field       | Value                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                            |
| Size        | 0.4–0.8 engineer-weeks                                                                                                             |
| Depends on  | [PX-W2](PX-W2-downloads-stores.md)                                                                                                 |
| Unblocks    | [PX-09](PX-09-get-it-complete.md), [HA-09](HA-09-portal-mirrored-downloads.md)                                                     |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                              |
| Plan mode   | yes: the plan [`plans/PX-W3.md`](../plans/PX-W3.md) needs human approval before code                                               |
| Gates       | the PORTAL.md §11 green gate; plan mode; THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`); `typecheck:workerd` and `test:workerd` |
| Human input | plan approval (plans/PX-W3.md)                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                          |

## Goal

Licensed builds hosted on R2 download from the portal through either a signed short-lived bytes URL or streaming through `/download/<token>`, as chosen by an approved plan, so the Get it panel never says "Not available here yet" for a build Polaris Key hosts.

## Why

Today the portal can only hand out tokens for artifacts reachable elsewhere ([PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G3). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `/download/<token>` handler and the bytes host (`packages/worker/src/core/bytesHost.ts`)
- `docs/security/THREAT-MODEL.md`

## Scope

**In:**

- A plan (`plans/PX-W3.md`) choosing signed URL vs streaming, token lifetime, licence checks and revocation.
- The implementation of the approved plan.

**Out** (and where it belongs instead):

- UI (→ PX-09)

## Design notes

- **Plan mode:** the plan is written first and approved by the owner before code.
- **THREAT-MODEL:** token leakage, replay window, hotlinking, and licence revocation between mint and download.

- **S-19 amendments (owner, 2026-10-04).** Decision 18: the "download grant" is renamed **"download ticket"** before this ships: the query parameter is `?ticket=`, the token label `pkey-download-ticket/1`, and the token shape `v1.<kid>.<exp>.<mac>` is unchanged. "Grant" is reserved for S-19's entitlement grants (S-19 §7.1). Decision 19 (Cloud Sync quotas `byEntitlement` plus `byTier`, highest-rank contributing licence) does not touch downloads, but the re-run entitlement checks call `resolveDeviceEntitlements` once LX-09 lands ([S-19 §8](../../notes/S-19-licensing-model.md#8-interactions-with-other-plans-exactly-what-changes) PX-W3 row).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W3:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W3 in-review`.

## Acceptance criteria

- [ ] `plans/PX-W3.md` is approved and merged before implementation.
- [ ] THREAT-MODEL rows for the chosen design, with tests for expiry and revoked licences.
- [ ] OpenAPI and `routeCoverage` cover any new route.
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

PX-09 drops the "Not available here yet" fallback for R2-hosted builds.

The role agent sets `--set PX-W3 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W3 done`.
