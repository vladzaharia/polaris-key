# CM-14 Device checkout hand-off: W1 and W3 (deferred)

| Field       | Value                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred)                                |
| Size        | 0.6–0.9 engineer-weeks                                                                                     |
| Depends on  | [CM-01](CM-01-commerce-plan.md), [CM-05](CM-05-checkout-fulfilment.md), [LX-20](LX-20-commerce-clients.md) |
| Unblocks    | [CM-15](CM-15-sdk-purchase-handoff.md)                                                                     |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                      |
| Plan mode   | yes: executes the approved [`plans/CM-01.md`](../plans/CM-01.md) (W1–W4); nothing beyond it                |
| Gates       | `plan-mode`, `rule-10`, `corpus`, `drift-gate`, `threat-model`, `workerd`                                  |
| Human input | the owner's go signal (removes `deferred`); plan approval (`plans/CM-01.md`)                               |
| Repo        | `vladzaharia/polaris-key`                                                                                  |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Keeps W1 and W3 only: W2 (offers[]) and W4 (the polaris-key enum) moved into LX-18. Still deferred (owner decision 5).

- Title: was "Device checkout hand-off (wire): `POST /<p>/distribution/commerce/checkout`, `offers[]` on the binding response, `store_billing_required`, grant source `polaris-key` in the enums".

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-29.md`](../plans/CM-29.md) §10: W1 becomes `POST /<p>/commerce/checkout`.

## Goal

Exactly the approved W1–W4 of `plans/CM-01.md` ship on the Worker: the device route returns a single-use checkout ticket URL for desktop and web builds and `403 store_billing_required` for store builds; the binding response carries `offers[]` for non-store builds only; `errors.json` and `enums.json` gain the code and the `polaris-key` source; transcripts and constants are regenerated.

## Why

Apps need a way into checkout, and the store rules must be enforced on the server ([S-22 §7.12](../../notes/S-22-polaris-key-commerce.md#712-sdk-impact-and-the-store-rules), [S-22 §9](../../notes/S-22-polaris-key-commerce.md#9-wire-changes-plan-mode-cm-01-then-cm-14-and-cm-15), D25, D28).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.12](../../notes/S-22-polaris-key-commerce.md#712-sdk-impact-and-the-store-rules)
- [S-22 §9](../../notes/S-22-polaris-key-commerce.md#9-wire-changes-plan-mode-cm-01-then-cm-14-and-cm-15)
- `plans/CM-01.md`
- `packages/worker/src/services/distribution/commerce/index.ts`
- AGENTS.md rules 1–3, 10

## Scope

**In:**

- W1–W4 on the Worker; OpenAPI and `routeCoverage`; `errors.json`, `enums.json`; `pnpm gen:constants`, `pnpm gen:transcripts` (and `gen:corpus` if LX-18's `grants` member has shipped).

**Out** (and where it belongs instead):

- SDK clients (→ CM-15)

## Design notes

- `PROTOCOL_VERSION` stays 4 (additive, outside the claims), as the plan confirms.
- The outlet guard uses the device's recorded outlet, not a client claim alone.

## Steps

1. Contract and catalog.
2. Route and guard.
3. Regenerate transcripts and constants.

## Acceptance criteria

- [ ] A store-build device gets `store_billing_required` (transcript).
- [ ] `pnpm gen:transcripts -- --check` and `pnpm gen:constants -- --check` pass.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- CM-15 implements the SDK half against the new transcript.

The role agent sets `--set CM-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-14 done`.
