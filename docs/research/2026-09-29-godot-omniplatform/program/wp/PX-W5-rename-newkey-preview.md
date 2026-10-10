# PX-W5 Device rename, new key, activate preview (G6, G7, G22 with typed refusals and masked email)

| Field       | Value                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                                                    |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                     |
| Depends on  | [PX-W1](PX-W1-library-api-media.md)                                                                                                                                                        |
| Unblocks    | [PX-17](PX-17-activate-confirm.md)                                                                                                                                                         |
| Role        | `pkey-implementer`                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                         |
| Gates       | the PORTAL.md §11 green gate; rule 10 (OpenAPI + `routeCoverage`); D1 migration (next free number at the final gate); `TABLE_OWNERS`; THREAT-MODEL; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                  |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W13.md`](../plans/PX-W13.md):** a portal rename always wins over the label PX-W13 seeds into `devices.label`; PX-W13 writes the label only while it is `NULL`.

## Goal

The portal can rename a device (`PATCH /api/licenses/:p/:id/devices/:deviceId {label}`), issue a new key once with step-up and a notice where the product opts in (`POST /api/licenses/:p/:id/keys`), and preview a key before adding it (`POST /api/activate/preview`) with typed refusals (`unknown`, `owned_elsewhere`, `email_mismatch` with masked email, `already_yours`, `portal_off`) and `entriesLeft`, never revealing ownership details.

## Why

Rename and new-key are missing ([PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G6, G7) and the Activate modal needs a confirm step with the product's art before adding (G22). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close), [PORTAL.md §4.17](../../../../design/PORTAL.md#417-activate-license-the-modal), [PORTAL.md §4.19](../../../../design/PORTAL.md#419-activate-license-errors)
- `packages/worker/src/services/identity/portal/api.ts`, `packages/worker/src/services/identity/portal/repo.ts`
- `packages/worker/migrations/` and `TABLE_OWNERS`

## Scope

**In:**

- Device rename route with label sanitising and length limit.
- New-key route: shown once, step-up, notice email, per-product opt-in; D1 migration and `TABLE_OWNERS` entry for what it stores.
- Activate preview route sharing the add rate bucket (one bucket per account for preview, add and Discover claim).

**Out** (and where it belongs instead):

- UI (→ PX-04 rename, PX-17 confirm step)
- `entriesLeft` counting itself (→ PX-W9)

## Design notes

- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- **THREAT-MODEL (enumeration):** preview answers only for well-formed keys, shares the add bucket, masks emails, and never returns owner details.
- Migration numbers take the next free number after main's highest at the moment of the final gate.
- **Overlap with the re-cut S-16/S-17 graph:** I-11 also names the Activate License modal's server side. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W5:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W5 in-review`.

## Acceptance criteria

- [ ] Each typed refusal has a test; `email_mismatch` returns only a masked address.
- [ ] Preview and add share one rate bucket per account (test).
- [ ] The migration and its `TABLE_OWNERS` entry land together; OpenAPI and `routeCoverage` cover every new route.
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen transcripts --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-17 builds the confirm step on preview; PX-04 or PX-09 adds rename and new key to the license card.

The role agent sets `--set PX-W5 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W5 done`.
