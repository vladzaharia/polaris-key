# LX-20 Store commerce client parity (one wave with LX-19)

| Field       | Value                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase C: the wire)                                                                                                                                                                                     |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                               |
| Depends on  | [LX-11](LX-11-commerce-rework.md), [LX-18](LX-18-licensing-wire.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md), [CM-25](CM-25-app-purchase-as-licence-source.md), [CM-29](CM-29-commerce-service.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-14](CM-14-device-checkout-wire.md)                                                                                                                                                                                     |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                                                                                 |
| Gates       | all six SDKs (`parity:check`); macOS CI; Android CI                                                                                                                                                                                                                |
| Human input | none                                                                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                          |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`notes/SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) owner decisions (2026-10-05):** `commerce.receipt` is **required** on Node and Python. This reverses the planned Python `allowedNa`; SP-00 changes the registry.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Same SDK wave as LX-19: holder bindings, transferred, automatic commerce.sync() on sign-in and launch, offers()/purchase(offerId) for stores. Fix the stale 'Why' (all six SDKs implement commerce.receipt).

- Title: was "Commerce client parity: Swift (StoreKit 2), Kotlin (Play), Node (Steam and Electron), React through client-core, Python `allowedNa`; restore `transferred` result".
- Depends on: added LX-18 and SP-35.

- Owner 2026-10-07/08: Commerce is a service (CM-29, `plans/CM-29.md`). Its code lives in `services/commerce/`, device routes move to `/<p>/commerce/*` in CM-29's release with the SDK path strings (no aliases), and the store hook URLs stay as Commerce's canonical routes. Reconcile this package with CM-29's approved plan before building.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-20.md`](../plans/CM-20.md) §14: all six SDKs, Godot included; the §5.2 surface, with the "holder bindings" item dropped (D5) and the binding re-read after a licence change added. Removed with no alias, each with its `api.json` `removed` row: the SDK helpers that read `products[]`. The Worker half drops `products[]` from the binding answer and re-records the three commerce transcripts without it (Q4). No route move, no gate move and no Worker path change: CM-29's release moved them. The `allowedNa` web row for `commerce.appPurchase`, with its `why`.
- [`plans/SP-35.md`](../plans/SP-35.md) §12: the `entitlements.*` names, `license.term()` and the `entitlement` kind.

## Goal

Commerce clients reach parity: Swift (StoreKit 2), Kotlin (Play), Node (Steam and Electron) implement bind and claim; React goes through client-core; Python is `allowedNa`; restore returns a `transferred` result.

## Why

Only Godot can bind and claim today (G17, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)); decision 13 sets the scope.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.7](../../notes/S-19-licensing-model.md#77-store-purchases-under-oc), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-20.

## Scope

**In:**

- Client implementations; parity rows; platform suites.

**Out** (and where it belongs instead):

- Server changes (→ LX-11).
- React's `commerce.receipt` row (→ SP-16, 2026-10-05): the bearer engine and the desktop bridge
  already speak binding and claim, so what remains is the Worker CORS entry and React's replay.

## Design notes

- Rename clashes from G18 (StoreKit's "entitlements").

## Steps

1. Swift.
2. Kotlin.
3. Node; React via client-core.
4. Parity.

## Acceptance criteria

- [ ] `commerce.receipt` parity row is implemented or `allowedNa` per SDK.
- [ ] macOS and Android CI pass.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- None.

The role agent sets `--set LX-20 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-20 done`.
