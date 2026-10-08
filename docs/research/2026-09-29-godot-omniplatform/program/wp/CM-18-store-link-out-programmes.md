# CM-18 Regional store link-out programmes (US App Store external purchase links, Play external offers and alternative billing), only if the owner says yes to G6

| Field       | Value                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred)                                                                                              |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                     |
| Depends on  | [CM-01](CM-01-commerce-plan.md), [CM-15](CM-15-sdk-purchase-handoff.md), [CM-17](CM-17-commerce-closeout.md)                                                             |
| Unblocks    | none                                                                                                                                                                     |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                    |
| Plan mode   | yes: executes the approved [`plans/CM-01.md`](../plans/CM-01.md) (W1–W4); nothing beyond it                                                                              |
| Gates       | `plan-mode`, `all-sdks`, `threat-model`, `human-approval`                                                                                                                |
| Human input | the owner's go signal (removes `deferred`); the owner's yes to S-22 G6; a fresh S-07-style policy re-check and a legal review; plan approval (`plans/CM-01.md` addendum) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive with a regional programme decision. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Regional store link-out programmes (owner G6). Revive with a regional programme decision.

## Goal

Only if the owner chooses to: per product and per region, a store build may show a link-out to Polaris Key checkout where the store's programme permits it, with the store's required disclosures, reporting and fees modelled as data.

## Why

Store policies on link-outs change often and carry fees and legal risk; S-22 keeps them off by default ([S-22 §10.2](../../notes/S-22-polaris-key-commerce.md#102-for-the-owner-at-go-time) G6, D26).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.12](../../notes/S-22-polaris-key-commerce.md#712-sdk-impact-and-the-store-rules)
- [S-22 §10.2](../../notes/S-22-polaris-key-commerce.md#102-for-the-owner-at-go-time)
- [S-07](../../notes/S-07-policy-recheck.md) rows 6 and 8
- [E1](../../notes/E1-apple.md), [E2](../../notes/E2-android.md)

## Scope

**In:**

- A plan addendum, the policy re-check, the per-region switch, SDK disclosure screens.

**Out** (and where it belongs instead):

- Anything a programme does not explicitly permit

## Design notes

- Default stays off for every product and region.

## Steps

1. Policy re-check.
2. Plan addendum and approval.
3. Implementation.

## Acceptance criteria

- [ ] Off unless the product and region are explicitly enabled (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- None.

The role agent sets `--set CM-18 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-18 done`.
