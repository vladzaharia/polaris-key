# CM-02 Stripe as the Polaris Key storefront's commerce facet (absorbs CM-03)

| Field       | Value                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred)                                                                                                                         |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                |
| Depends on  | [CM-01](CM-01-commerce-plan.md), [LX-08](LX-08-licensing-expand.md), [P0-27](P0-27-one-adapter-store-delivery-commerce.md), [P0-28](P0-28-one-sealed-credential-store-resolver.md)                  |
| Unblocks    | [CM-04](CM-04-offers-catalogue.md)                                                                                                                                                                  |
| Role        | `pkey-implementer`                                                                                                                                                                                  |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                    |
| Gates       | `migration`, `table-owners`, `wrangler`, `drift-gate`, `rule-10`, `threat-model`, `workerd`                                                                                                         |
| Human input | the owner's go signal (removes `deferred`); a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                           |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Absorbs CM-03: Stripe is the Polaris Key storefront's commerce facet (P0-27 adapter), connected as a Store connection; secrets in P0-28's one sealed store; webhook intake on the route table.

- Title: was "Provider abstraction and Stripe client; platform secrets; webhook intake (verify, dedupe, queue, fetch-latest) and daily reconciliation".
- Depends on: added P0-27 and P0-28.
- Absorbs CM-03: Provider abstraction and merchant connection are one Store connection; commerce.enabled, commerce.mode and merchantCountries are facts, not keys.

## Goal

A `PaymentProvider` interface and its Stripe module exist; the platform webhook route accepts only correctly signed Stripe events, records each event id once, acknowledges, and processes from the `COMMERCE_EVENTS` queue by re-fetching the named object; a daily reconciliation re-reads recent objects per merchant.

## Why

Every later CM package needs one verified, idempotent path from Stripe into Polaris Key ([S-22 §6](../../notes/S-22-polaris-key-commerce.md#6-the-provider-abstraction), D2, D23, D24).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §6](../../notes/S-22-polaris-key-commerce.md#6-the-provider-abstraction)
- [S-22 §7.1](../../notes/S-22-polaris-key-commerce.md#71-data-model-sketch-cm-01-fixes-ddl-one-bare-add-column-per-file-r11-04)
- [S-22 §8](../../notes/S-22-polaris-key-commerce.md#8-threat-model-pci-scope-privacy-and-retention)
- `packages/worker/src/services/distribution/commerce/http.ts`, `connectors/state.ts` (event dedupe precedent)
- `packages/worker/src/core/hooks.ts`
- `plans/CM-01.md`

## Scope

**In:**

- `W/services/distribution/commerce/checkout/provider.ts` and `providers/stripe.ts` (fixed API host through `core/safeFetch.ts`, body cap, idempotency keys).
- `commerce_events` (Core) and its migration; `TABLE_OWNERS`.
- The platform webhook route: raw-body `v1` HMAC-SHA256, constant-time compare, 300 s tolerance, current and previous signing secret; record-then-ack; queue consumer; fetch-latest.
- Deploy secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET_PREVIOUS`, the `COMMERCE_EVENTS` queue, `gen platform-inventory`.
- Daily reconciliation cron (no-op until merchants exist).

**Out** (and where it belongs instead):

- Merchants (→ CM-03)
- Fulfilment logic (→ CM-05)

## Design notes

- Events are hints; objects are truth (Stripe does not order or deduplicate deliveries).
- Never trust event metadata alone; the event's connected account must match a known merchant.
- The store bridge keeps its inline-then-503 pattern; only Stripe uses the queue.

## Steps

1. Interface and Stripe module with recorded-response tests.
2. Webhook route and queue consumer.
3. Inventory, wrangler, OpenAPI.

## Acceptance criteria

- [ ] A bad signature, a stale timestamp and a non-`v1` scheme are refused (tests).
- [ ] A duplicate event id is processed once (test).
- [ ] `pnpm gen platform-inventory --check` passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen platform-inventory --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- CM-03 and CM-05 register event handlers on the consumer; the provider interface is the only Stripe entry point.

The role agent sets `--set CM-02 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-02 done`.
