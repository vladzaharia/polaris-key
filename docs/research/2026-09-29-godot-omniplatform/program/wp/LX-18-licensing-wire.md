# LX-18 Licensing wire amendment: per-entry `expiresAt`, `licenseExpiresAt`, `grants`, 401 `reason` and `not_entitled` reasons in `shared-protocol`, client-core, parity and the corpus

| Field       | Value                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase C: the wire)                                |
| Size        | 0.6–0.85 engineer-weeks                                                                                       |
| Depends on  | [LX-01](LX-01-licensing-plan.md), [LX-09](LX-09-entitlement-resolver.md), [LX-12](LX-12-licence-lifecycle.md) |
| Unblocks    | [LX-19](LX-19-sdks-licensing.md)                                                                              |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                         |
| Plan mode   | yes: the plan [`plans/LX-18.md`](../plans/LX-18.md) needs human approval before code                          |
| Gates       | plan mode; conformance corpus (`gen:corpus --check`); drift gate (`--check`); `PROTOCOL_VERSION`              |
| Human input | plan approval (`plans/LX-18.md`)                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                     |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** Q6: add `reason: "no_license"` to the licence-less 401, so new SDKs show `needs-activation` instead of `revoked`.
- **[`plans/PX-W8.md`](../plans/PX-W8.md):** Q5: `not_entitled` with `reason: device_limit` on the sign-in path carries `manageUrl` from PX-W8's `core/manageUrl.ts` builder.

## Goal

The device wire carries the model: per-entry `expiresAt`, `licenseExpiresAt`, `grants`, a 401 `reason`, and `not_entitled` reasons, in `shared-protocol`, client-core, parity and appended corpus cases.

## Why

SDKs cannot tell expired from revoked or refunded, and `isEntitled` ignores status (G10, G11, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)). Decision 9 ships Phase C right after Phase B under `PROTOCOL_VERSION` 4 precedent ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 9).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.10](../../notes/S-19-licensing-model.md#710-wire-impact-plan-mode), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-18.
- P4-13, P4-19 and P4-29 plans (precedent).

## Scope

**In:**

- The plan, naming corpus regeneration and every SDK that follows; contract, catalog, corpus, client-core.

**Out** (and where it belongs instead):

- SDKs (→ LX-19).

## Design notes

- An all-languages event: contract → catalog → corpus → SDKs.
- Old SDKs ignore entry expiry (risk 7).

## Steps

1. Plan and approval.
2. Contract and corpus.
3. client-core and parity.

## Acceptance criteria

- [ ] `gen:corpus`, `gen:constants` and `gen:transcripts` `--check` pass.
- [ ] Browser runners pass.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- LX-19 executes the same plan in every SDK.

The role agent sets `--set LX-18 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-18 done`.
