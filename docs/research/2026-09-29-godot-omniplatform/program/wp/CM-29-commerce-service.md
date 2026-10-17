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

**In:** what the approved plan names: the `tools/services.json` row and `gen services` output in all six SDKs;
discovery and the corpus mirror; the device routes to `/<p>/commerce/*` together with the SDK path strings (no
aliases); the store hook URLs kept as Commerce's canonical routes; the code move to `services/commerce/`; the
console's sixth feature row; the RBAC `commerce` area; the automatic catch-up when Commerce is turned back on.

**Out:** Polaris Key's own checkout (behind the owner's "commerce: go"); the brand accent ([CM-29b](CM-29b-commerce-accent.md), on this branch); the store-client move ([P0-27a](P0-27a-store-clients-core-stores.md)).

## Acceptance

- [ ] Every acceptance item in the approved `plans/CM-29.md`.
- [x] No store notification route changes URL; a notification sent while the deploy rolls out is processed.
- [x] Turning License off turns Commerce off in the same audited change, and the confirmation names it (`packages/worker/test/admin.test.ts`).
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/commerce/*` (with `features/ship-builds/commerce` and `channels/storefronts` moved in); `help/restore-purchase`, `help/refunds`.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- In `tools/services.json` the commerce console icon is `ShoppingBag` and its accent is the Distribution green family (B1; CM-29b). The slug and routes stay; the platform contract wins over the guide's 'no new service slug'. No wire change. (brand-36)

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 13 mockup item(s):** `products.features`, `products.turn-off-licensing`, `commerce.connect-app-store-error`, `commerce.connect-app-store`, `commerce.features-blocked`, `commerce.features-save-failed`, `commerce.features`, `commerce.first-run-connected`, `commerce.first-run`, `commerce.offers-empty`, `commerce.purchases-empty`, `commerce.storefronts`, `commerce.turn-off-licensing`.

## Verify

The plan's §Verify, then the lead gate.

## Hand-off

`check.mjs --set CM-29 done` in the PR's last commit.

## Progress and continuation (2026-10-17)

Slice done on `wp/CM-29-commerce` (plan §2-§4, §5, §6 and the CM-29b token alias): the `commerce` row, `gen services` in every language, `commerce_requires_license` (worker `REQUIREMENT_CODES`, manifest validator, schema, mutation entry, console message), the `commerceService` descriptor under `services/commerce/`, mount, discovery, the device routes at `/<p>/commerce/{binding,claim}`, the store hooks kept at `/<p>/distribution/hooks/{app-store,play-rtdn}` (router `storeHook`, `storeHookPath`), `TABLE_OWNERS`, boundaries, OpenAPI and `routeCoverage`, the SDK gate and path strings in all six SDKs, eight transcripts re-recorded, WIRE-CONTRACT-V4 §5.6, THREAT-MODEL and PRIVACY.

**Corrections to the plan, found against today's code (the code is the fact):**

- `commerce_requires_license` is a manifest validation code and an admin `reason`, not a wire error: `conformance/parity/errors.json` holds no `<slug>_requires_<req>` code (none of the other four), so nothing was registered there.
- P0-27a had left more coupling than the plan states. Commerce imported `../access.js` (`entitlementOf`) and Distribution's `connectors/asc/{controls,flow}` (the Apple IAP catalog); Distribution imported Commerce's `apple.ts`, `steam.ts`, `http.ts` and `APP_STORE_EVENTS`. Resolved without a cross-service edge: `core/stores/http.ts`, `core/stores/apple/server.ts` (credential choice, bearer token, test notification), `core/stores/steam/publisher.ts` (publisher-key custody, platform apps listing, live check), `APP_STORE_EVENTS` in `core/stores/events.ts`; the IAP catalog flows stay in Distribution (`connectors/asc/iapCatalog.ts`) and read Commerce's map through a new read-only Core hook, `storeProducts` (`core/hooks.ts`, empty map while Commerce is off); Commerce reads the delivery gate through `hooks.delivery().entitlement`. The P0-27a boundaries test's two seam rows are gone (it now asserts none).
- `TABLE_OWNERS` lives in `packages/worker/src/db/owners.ts`, not `gen-reference.mjs`. Two SEAMS rows changed: `commerce -> license_store_grants` (was distribution) and a new `distribution -> dist_store_products` (the Play one-time-product upsert, `connectors/play/storefront.ts`), both removed by P0-27.
- The signed corpus is unchanged, but `ui-matrix.json` (and its Godot mirror) is regenerated: its service lists follow the table. Kits gained the slug: Swift `KitService`, Kotlin `ALL_SERVICES`/`SERVICE_REQUIRES`, Godot and ui-core `SERVICES`.
- Eight transcripts changed: the plan lists `discovery-failure`; the code changed `discovery-identity` too. `commerce-claim`'s world is `servicesOn(license, config, release, distribution, commerce)` with no Steam channel (CM-21 owns the Ready gate).
- The admin SPA never called the commerce admin API (the Commerce page is the ASC in-app purchases page), so moving the admin API to `…/products/<p>/commerce` needed no client change. `LEGACY_REDIRECTS` does not exist in `nav.ts`; the page id `commerce` moved to a new Commerce section at `commerce/in-app-purchases`.
- CM-29b is partly done here because `brand/test/services.test.ts` pins `SERVICE_IDS` to the table: `SERVICE_ALIAS = { commerce: "distribution" }` (green, B1); the CSS emits `[data-service="commerce"]` as Distribution's declarations and no `--pk-service-commerce` variables. `DE00_FLOORS` are unchanged. Not done: BRAND.md §5.2 wording, the `brand proofs` re-render of `accents-{dark,light}.png`, the "links use strong text" kit rule.
- Admin routes of the `commerce` area are `…/commerce/**` for all methods (`SERVICE_AREA`); `rbac-route-areas.json` lost the three `distribution/commerce/**` rows and gained five. The PS-06 `storefronts/*` rows stay `commerce` (Core routes).

**Remaining (propose as follow-ups, owner in brackets):**

- Plan §3.4 console: the Commerce row's Attention state ("Store refunds are not landing while Commerce is off"; License on, Commerce off, an active `grants` row from app-store|play|steam), the "N storefronts ready" status, the Commerce overview page and `SERVICE_HOME` target beyond the in-app purchases page, and the Commerce off-confirmation warning about Play's 7-day and 31-day limits [CM-29 continuation or CM-23].
- Plan §3.5 pre-deploy production check (lead, with P0-24's ledger) and the manifest-sourced `modules.commerce` owner step.
- Plan §3.3 readiness (`services/commerce/readiness.ts`, "Ready" needs the channel) [CM-21].
- UK-02b §8: the Paywall x commerce and EntitlementGate x commerce rows and their `SERVICE_DEPENDENCIES` entries [UK-02b].
- Docs: only the `features/commerce/index` page moved and gained the "Turn it on" section; `help/restore-purchase`, `help/refunds`, `channels/storefronts` moved in, `services/commerce/index` rename [DOC lane].
- Android Kotlin modules (`:billing`, `:android`) were edited for the path and gate but not built (no Android SDK here).
- `supports("commerce.receipt")` is product-N/A while Commerce is off in every SDK (via `features.json` `service: commerce`).
