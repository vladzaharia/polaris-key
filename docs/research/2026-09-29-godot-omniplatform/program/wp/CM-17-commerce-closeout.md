# CM-17 Commerce close-out: THREAT-MODEL CM-T1–T11, PRIVACY.md, PCI SAQ A record, docs pages, glossary, runbook (key rotation, signing-secret roll, outage), sandbox end-to-end check

| Field       | Value                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                                                                                                                                                   |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                                                                           |
| Depends on  | [CM-11](CM-11-portal-billing.md), [CM-12](CM-12-console-commerce.md), [CM-13](CM-13-commerce-emails.md), [CM-15](CM-15-sdk-purchase-handoff.md), [CM-16](CM-16-storefront-integration.md)                                        |
| Unblocks    | [CM-18](CM-18-store-link-out-programmes.md), [CM-19](CM-19-own-account-mode.md)                                                                                                                                                  |
| Role        | `pkey-implementer`                                                                                                                                                                                                               |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                                                 |
| Gates       | `threat-model`, `docs:privacy`, `docs-links`, `docs-generated`                                                                                                                                                                   |
| Human input | the owner's go signal (removes `deferred`); a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise); the G1 legal review outcome |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                        |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

The threat model, privacy page, PCI record, docs (developer guide to selling, customer help for billing), glossary entries, runbook and a recorded sandbox run from listing to refund are in place, and every S-22 decision is either built or recorded as not done.

## Why

Commerce adds money, personal data and a new trust boundary ([S-22 §8](../../notes/S-22-polaris-key-commerce.md#8-threat-model-pci-scope-privacy-and-retention)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §8](../../notes/S-22-polaris-key-commerce.md#8-threat-model-pci-scope-privacy-and-retention)
- [S-22 §10](../../notes/S-22-polaris-key-commerce.md#10-decisions)
- `docs/security/THREAT-MODEL.md`
- `docs/PRIVACY.md`
- `docs/RUNBOOK.md`

## Scope

**In:**

- THREAT-MODEL, PRIVACY, RUNBOOK, docs pages, glossary (rule 4), the sandbox run record.

**Out** (and where it belongs instead):

- Live launch (the owner's call)

## Design notes

- The PCI record states why the scope is SAQ A and what would change it (Embedded Checkout, Elements).

## Steps

1. Docs and records.
2. Sandbox run.
3. Decision audit against S-22 §10.

## Acceptance criteria

- [ ] `pnpm --filter @polaris-key/docs check:links` passes.
- [ ] The sandbox run covers buy, upgrade, subscribe, cancel, refund and dispute.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- The owner decides the live launch.

The role agent sets `--set CM-17 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-17 done`.
