# CM-29 Commerce service: the `commerce` slug, requires License

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CM: Commerce (DX consolidation H: Channels, storefronts and commerce)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Size        | 1.5–2.5 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Depends on  | [ST-38](ST-38-service-table-five-features-one-service.md), [CM-20](CM-20-commerce-consolidation-plan-lx-11-plan.md), [P0-27a](P0-27a-store-clients-core-stores.md)                                                                                                                                                                                                                                                                                                                                                                                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-11](LX-11-commerce-rework.md), [LX-18](LX-18-licensing-wire.md), [LX-20](LX-20-commerce-clients.md), [LX-23](LX-23-subscriptions.md), [CM-21](CM-21-storefront-connection-notifications.md), [CM-23](CM-23-console-commerce-offers-purchases-sales.md), [CM-24](CM-24-one-steam-ownership-engine-absorbs-ps-07.md), [CM-25](CM-25-app-purchase-as-licence-source.md), [CM-26](CM-26-portal-account-purchases-across.md), [CM-28](CM-28-consumables-quantity-grants-from-store.md), [CM-29b](CM-29b-commerce-accent.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Plan mode   | yes: executes the approved [`plans/CM-29.md`](../plans/CM-29.md) (2026-10-08); CM-29b runs on the same branch                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Gates       | `plan-mode`, `corpus`, `drift-gate`, `docs-generated`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Consolidation 2026-10-07

Registered by the lead (owner-approved, 2026-10-08) after the owner reversed conflict resolution C-17: Commerce
is a service. The design is the approved [`plans/CM-29.md`](../plans/CM-29.md).

- Owner 2026-10-07/08: **Commerce is a service** (`commerce`, `requires: ["license"]`, CM-29), the sixth feature. The generic requirement rule, derived from `requires` in `tools/services.json`, applies to every service: a service can be enabled only while all its requirements are on (stable code `<slug>_requires_<req>`); disabling a requirement disables its dependents transitively in the same audited batch, with a confirmation naming every dependent; re-enabling a requirement does not re-enable dependents; a manifest that declares a dependent on with a requirement off is a validator error. This replaces the hand-written coherence edges in `core/services.ts` (Cloud Sync's refusal becomes a cascade).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: appends the Paywall × `commerce` and EntitlementGate × `commerce` rows and their `SERVICE_DEPENDENCIES` entries, in this PR (§4.8).

## Goal

Add the `commerce` service (requires `license`, off by default) and move Commerce's code and device routes
into it, without losing a single store notification. Done when every acceptance criterion holds and the green
gate passes.

## Why

The owner decided Commerce is a service with its own switch that follows the requirement rule. See C-17 in
[`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) and the plan.

## Read first

- `AGENTS.md`, and [`plans/CM-29.md`](../plans/CM-29.md): the approved plan is the scope.
- [`plans/CM-20.md`](../plans/CM-20.md): the commerce model that builds on it.

## Scope

**In:** what the approved plan names: the `tools/services.json` row and `gen:services` output in all six SDKs;
discovery and the corpus mirror; the device routes to `/<p>/commerce/*` together with the SDK path strings (no
aliases); the store hook URLs kept as Commerce's canonical routes; the code move to `services/commerce/`; the
console's sixth feature row; the RBAC `commerce` area; the automatic catch-up when Commerce is turned back on.

**Out:** Polaris Key's own checkout (behind the owner's "commerce: go"); the brand accent ([CM-29b](CM-29b-commerce-accent.md), on this branch); the store-client move ([P0-27a](P0-27a-store-clients-core-stores.md)).

## Acceptance

- [ ] Every acceptance item in the approved `plans/CM-29.md`.
- [ ] No store notification route changes URL; a notification sent while the deploy rolls out is processed.
- [ ] Turning License off turns Commerce off in the same audited change, and the confirmation names it.

## Verify

The plan's §Verify, then the lead gate.

## Hand-off

`check.mjs --set CM-29 done` in the PR's last commit.
