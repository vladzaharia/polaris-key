# CM-01 Plan Polaris Key commerce: decision record, exact DDL, routes, wire changes W1–W4, settings, threat model

| Field       | Value                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Polaris Key commerce (S-22): deferred until the owner's go                                                                                |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                        |
| Depends on  | [LX-01](LX-01-licensing-plan.md), [ST-03](ST-03-settings-registry.md)                                                                         |
| Unblocks    | [CM-02](CM-02-provider-webhooks.md), [CM-14](CM-14-device-checkout-wire.md), [CM-18](CM-18-store-link-out-programmes.md)                      |
| Role        | `pkey-wire-planner` (planning only)                                                                                                           |
| Plan mode   | yes: this package writes [`plans/CM-01.md`](../plans/CM-01.md) (planning only); it needs human approval                                       |
| Gates       | `plan-mode`, `protocol-version`, `threat-model`, `human-approval`                                                                             |
| Human input | the owner's go signal (removes `deferred`); the owner's answers to S-22 G1–G6 (§10.2), restated in the plan; plan approval (`plans/CM-01.md`) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                     |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Goal

`plans/CM-01.md` exists and is approved: it fixes the exact DDL, every portal, admin, platform and device route, the four device-visible wire changes (W1–W4) with their corpus, transcript and constants consequences, the `commerce.*` registry rows, the provider interface and the threat-model rows, and it re-reads every Stripe fact S-22 marks [U].

## Why

S-22 is a design note; the CM packages execute a plan, as the LX packages execute LX-01. The wire changes (a device route, an additive response member, an error code, an enum value) are an all-languages event under AGENTS.md rule 2 and must be approved before code ([S-22 §9](../../notes/S-22-polaris-key-commerce.md#9-wire-changes-plan-mode-cm-01-then-cm-14-and-cm-15)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §2](../../notes/S-22-polaris-key-commerce.md#2-short-answer)
- [S-22 §6](../../notes/S-22-polaris-key-commerce.md#6-the-provider-abstraction)
- [S-22 §7.1](../../notes/S-22-polaris-key-commerce.md#71-data-model-sketch-cm-01-fixes-ddl-one-bare-add-column-per-file-r11-04)
- [S-22 §9](../../notes/S-22-polaris-key-commerce.md#9-wire-changes-plan-mode-cm-01-then-cm-14-and-cm-15)
- [S-22 §10](../../notes/S-22-polaris-key-commerce.md#10-decisions)
- [`plans/LX-01.md`](../plans/LX-01.md) §2.5, §3.1, §6.1
- `docs/security/WIRE-CONTRACT-V4.md` §2.4
- `packages/worker/src/services/distribution/commerce/`

## Scope

**In:**

- Exact DDL and migration order for the Core and Distribution tables of S-22 §7.1, and whether the `polaris-key` grant source lands in LX-08 or in a CM migration.
- Every route with method, auth, request and response shape, error codes; the OpenAPI and `routeCoverage` rows.
- W1–W4 in contract → catalog → corpus/transcripts → SDK order; the `PROTOCOL_VERSION` 4 confirmation.
- The registry slice for `commerce.*` and the reused `licensing.*` keys; deploy secrets and the `COMMERCE_EVENTS` queue.
- THREAT-MODEL rows CM-T1–CM-T11 and PRIVACY.md text.
- A fresh read of every [U] Stripe fact in S-22 §13, with dates.
- The owner's G1–G6 answers, quoted.

**Out** (and where it belongs instead):

- Code (→ CM-02 onward)
- Store link-out programmes (→ CM-18)
- Own-account mode (→ CM-19)

## Design notes

- Planning only: the wire planner writes the plan and stops at `awaiting-approval`.
- If S-21 has landed, the plan replaces S-22 §3's assumed seam names with S-21's.
- Store mappings and offers stay operator-only (LX-01 §3.1 precedent).

## Steps

1. Re-read S-22, LX-01 and S-21 (if landed).
2. Re-verify the [U] Stripe facts.
3. Write `plans/CM-01.md`; set `awaiting-approval`.

## Acceptance criteria

- [ ] `plans/CM-01.md` names every route, table, setting, wire change and gate the CM packages touch.
- [ ] The plan lists, per CM package, the sections it executes.
- [ ] Every [U] fact in S-22 §13 is re-read or explicitly left open.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

- CM-02 onward execute the approved plan's sections; CM-14 and CM-18 carry `planRef: CM-01`.

The role agent sets `--set CM-01 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-01 done`.
