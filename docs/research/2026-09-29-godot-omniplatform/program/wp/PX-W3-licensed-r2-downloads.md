# PX-W3 Licensed R2 downloads (G3) through a download ticket: a signed, short-lived, file-bound bytes-host URL (plan approved 2026-10-05)

| Field       | Value                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                            |
| Size        | 0.4–0.8 engineer-weeks                                                                                                             |
| Depends on  | [PX-W2](PX-W2-downloads-stores.md)                                                                                                 |
| Unblocks    | [PX-09](PX-09-get-it-complete.md), [SP-09](SP-09-velopack-auth-redirect.md), [HA-09](HA-09-portal-mirrored-downloads.md)           |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                              |
| Plan mode   | yes: executes the approved [`plans/PX-W3.md`](../plans/PX-W3.md) (approved 2026-10-05)                                             |
| Gates       | the PORTAL.md §11 green gate; plan mode; THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`); `typecheck:workerd` and `test:workerd` |
| Human input | a `DOWNLOAD_TICKET_KEY` signing key pair provisioned per environment (plans/PX-W3.md Q3)                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                          |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W3.md`](../plans/PX-W3.md):** approved on 2026-10-05 with every recommendation accepted: a ticketed bytes-host URL (Q1), 120 s multi-use and bound to one file (Q2), a dedicated `DOWNLOAD_TICKET_KEY` pair (Q3, provisioned per environment by the owner), the portal's licence-only rule for `attested` products (Q4 (a), with a THREAT-MODEL row), the revocation residual accepted (Q5), no IP binding (Q6), private GitHub files left out (Q7). No migration; an OpenAPI parameter instead of a new route; a glossary entry for "download ticket". The plan supersedes the draft on branch `wp/PX-W3-licensed-downloads-plan` (`72676b8e`), which must not be merged.

## Corrections and decisions from implementation (2026-10-05)

Recorded by the implementer; the code is the fact where this brief or the plan read otherwise.

- **Key material.** The header's "signing key pair" means the secret `DOWNLOAD_TICKET_KEY` plus
  its rotation slot `DOWNLOAD_TICKET_KEY_PREVIOUS`, not an asymmetric pair. Both are already
  provisioned as base64 strings by the owner; the Worker uses the string as HMAC material, as it
  does `REGISTRY_TOKEN_KEY`, and the `kid` is the first 6 bytes of SHA-256 over that string.
- **Verify signature.** `verifyDownloadTicket(env, ticket, {host, product, releaseId, name,
sha256}, now)` as planned; the host is compared normalized (case, trailing dot).
- **Licence vocabulary.** `licenses.status` is `active | disabled`; "revoked" and "suspended" in
  the plan's acceptance list are both `disabled`. The revocation test covers disabled, expired and
  detached licences.
- **Inventory.** ST-02 has not landed (no `@inventory` annotations exist), so the two secrets are
  added to `SECRET_NAMES` and given notes on the console's Platform → Secrets list
  (`packages/admin/src/console/pages/platformSettings.tsx`), the existing pattern.
- **Redemption order.** The ticket is minted before the single-use token is spent, so a failure
  (for example the key deleted between mint and click) leaves the user's token usable.
- **`downloadTarget`** returns `{kind: "redirect", url} | {kind: "ticket", base} | null`; the
  ticket branch requires the delivery URL on the bytes host itself (not merely an allowed redirect
  host) and the file's SHA-256.
- **Q4 (a)** needs no code: neither `accountMayDownload` nor the ticketed byte route consults the
  device trust policy. A test pins it.

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

- [x] `plans/PX-W3.md` is approved and merged before implementation.
- [x] THREAT-MODEL rows for the chosen design, with tests for expiry and revoked licences.
- [x] OpenAPI and `routeCoverage` cover any new route.
- [x] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [x] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

PX-09 drops the "Not available here yet" fallback for R2-hosted builds.

The role agent sets `--set PX-W3 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W3 done`.
