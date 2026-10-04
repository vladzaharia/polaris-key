# U-01 Plan Cloud Sync: decision record, glossary, data model, WIRE-CONTRACT-V4 Cloud Sync section with the op table and push rules, browser principal, errors, parity ids, manifest schema, scenario-corpus format, ceilings, threat rows

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U0 plan)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Depends on  | [I-04](I-04-account-contract-plan.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Unblocks    | [U-02](U-02-principal-binding.md), [U-04](U-04-catalog-and-service.md), [U-05](U-05-cloud-sync-do.md), [U-18](U-18-scenario-corpus.md), [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md), [U-08](U-08-merge-prompt.md), [U-10](U-10-saves-backend.md), [U-13](U-13-saves-sdk-node-react-python.md), [U-25](U-25-saves-sdk-swift-kotlin-godot.md), [U-09](U-09-collections-backend.md), [U-22](U-22-collections-sdk-node-react-python.md), [U-23](U-23-collections-sdk-swift-kotlin-godot.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Plan mode   | yes: planning only; writes `plans/U-01.md`, which needs human approval (merging the plan PR)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Gates       | plan mode; human approval; rule 2 argument (no `PROTOCOL_VERSION` bump); rule 4 (glossary)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Human input | owner answers S-17 §7.3 decision 20 (entitlement overrides stay on the licence) and decision 21 (30-day notice, 90-day report)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Goal

An approved plan, `plans/U-01.md`, that fixes every name and shape Cloud Sync depends on, so U-05, the SDK packages, U-08, U-09, U-10 and the saves and collections SDKs can execute it directly (`planRef`).

## Why

Cloud Sync is a new device-writable service: new routes, error codes, transcripts and all six SDKs, though no signed-document change and no `PROTOCOL_VERSION` bump ([S-17 §1](../../notes/S-17-user-data-sync.md#1-summary-and-recommendation), [S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact)). The owner made it its own service and removed the licence-level config override layer everywhere ([S-17 owner decisions](../../notes/S-17-user-data-sync.md)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/I-04.md`](../plans/I-04.md) (the device binding, `subjectFor`, the hook registries, the web redirect).
- [S-17 owner decisions](../../notes/S-17-user-data-sync.md) and this brief's "Owner decisions" section; all of [S-17](../../notes/S-17-user-data-sync.md), especially [S-17 §4](../../notes/S-17-user-data-sync.md#4-options), [S-17 §5](../../notes/S-17-user-data-sync.md#5-the-recommended-design-defined), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) and [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions).
- `packages/client-core/src/config.ts:1-52`, `packages/worker/src/services/config/routes.ts:25-50`, `packages/worker/src/core/payload.ts:137-142`, `packages/worker/src/core/cors.ts`, `tools/services.json`, `packages/shared-manifest/schemas/v1/schema.schema.json`, `conformance/corpus/v2/config-matrix.json`.

## Scope

**In:**

- Decision record: Cloud Sync as its own service (slug `sync`) on Config's catalog; one Durable Object per `(product, subject)`; account overrides are Config's layer.
- Glossary nouns (rule 4): Cloud Sync, user setting, account override, collection, save, Cloud Sync data, principal.
- Data model ([S-17 §5.2](../../notes/S-17-user-data-sync.md#52-data-model)): `account_overrides (product, subject)`, the DO tables, `sync_directory`, the R2 layout; no global account id in any S-17 row.
- WIRE-CONTRACT-V4 Cloud Sync section: pull (`/sync`) and push (`/sync/ops`) with the op table and push rules 1–8, the save routes, `403 account_required` (no principal: not signed in and licence not attached; it carries the Worker-built portal link for the attach offer, and the sign-in offer only when the product's Identity service is on), the discovery fragment (`sync: {settings, collections, saves, limits}`), the browser principal (bearer device token from I-08, CORS without credentials) and the CORS inclusion list.
- `shared-protocol` types; error codes ([S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact)); parity ids (`config.user.set`, `config.user.observe`, `sync.settings`, `sync.collection`, `sync.saves`, `sync.offline`, `sync.merge`, `sync.live`, `sync.scenarios`).
- Catalog `user` block and `cloudSync` block with validator rules 1–11; the scenario-corpus format; ceilings and defaults ([S-17 §5.7](../../notes/S-17-user-data-sync.md#57-quotas-and-limits), [S-17 §5.17](../../notes/S-17-user-data-sync.md#517-cost-and-abuse-model)); threat rows T1–T16; the catalog-parser tolerance check in each SDK.
- The account override layer's placement and the migration steps ([S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision)), with decision 20 flagged.

**Out** (and where it belongs instead):

- Code (planning only); live pokes (→ U-14's plan), the developer-backend credential (→ U-16), receipts and end-to-end encryption (→ U-17).

## Owner decisions (2026-10-04, binding)

- **Cloud Sync is its own service** named "Cloud Sync" (slug `sync`), with its own toggle; it depends on Config and on the Polaris Key account (layer 1). The account is platform-level (Core and the portal, always present), not a per-product toggle, so the descriptor is `requires: [config]`; Cloud Sync does **not** require the product's Identity service (owner clarification, 2026-10-04).
- **The principal is the account × product**, seen by the product only as its pairwise subject. Core resolves it as `resolveSyncPrincipal(device) = devices.subject ?? subjectFor(license.account_id, product)`, the same rule as Config's account-override line: on a product without Identity a device gets Cloud Sync once its licence is attached to an account (portal Activate License, Library, Discover); on a product with Identity a sign-in through the product also binds it.
- **The licence-level config override layer is removed everywhere**, replaced by user-level managed config attached to the account per product (the account override). No "products without Identity keep licence overrides" exception.
- **Floating licences have no such layer** and are offered an account (never forced on a product without Identity, where the key is the only activation path).
- **Overrides on licences with no owner are dropped at migration**, with an operator-visible report; no grace period.
- **No Cloud Sync without a Polaris Key account, ever** (the owner's "no Cloud Sync without signing in": the person signed in at least to attach the licence). Floating licences and unbound devices get none; before the device binds, settings persist locally only and upload at the first bind; U-26 (the licence-owned backup, which needed no account) stays retired. On a product without Identity the UI kits never show app sign-in; they offer "Add this licence to your Polaris Key account to sync" with a portal deep link.
- **Defaults confirmed:** the MVP (about 64, now 67, agent-days) first, then the anonymous-to-signed-in merge and saves, before collections; per-product ceilings of 50 GiB, 100k users holding data and 2,000 pushes per second; 1 MiB with saves off for signed-in users with no licence for the product; the platform pays Cloudflare until per-product billing; web apps use a device token issued to an origin on the product's `web.origins` allowlist through I-08.

## Design notes

- **Pending the owner** ([S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions)): decision 20 (entitlement overrides stay on the licence; only `config` and `secrets` move), decision 21 (30-day notice counted from I-07 and I-11 live; 90-day report), decision 23 (web Cloud Sync without Identity: no new route; a key-activated browser device follows its licence owner), decision 24 (the developer-backend credential without Identity: product-scoped admin credentials), and decision 22, the proposed default for the licence-owner line on products without Identity: with no `license_owned` refusal there, anyone holding an owned licence's key can enrol a device and reach the owner's Cloud Sync data, so the owner is emailed on each new device on an owned licence and can remove it in the portal. The plan carries the defaults and marks them.
- **Principal change.** A licence detach or relink moves a licence-owner-line device to no principal or another subject; the SDK treats it exactly like sign-out (flush is impossible, so discard the cloud cache and keep local values as the unbound partition).
- **Settled S-16 decisions** (owner, 2026-10-04): D17–D23 accepted; D21 means an account merge keeps the survivor's pairwise subject per product, the other becomes an alias that `resolveSyncPrincipal` resolves, and the developer receives `subject.merged`.
- **Carried defaults** 5–16 of [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) (locked keys, precedence in the existing `local` slot, conflict policies, `ui.scopes` stays a hint, data follows the account not the licence, and so on) are encoded as stated.
- **Device binding (correction, 2026-10-04).** The binding is created by I-05 under the name I-04 fixes (default `devices.subject`, the pairwise subject); S-17's U-02 row said "`devices.subject` migration", but S-16 §8.1 assigns the column to I-05, so U-02 adds no migration. The code-exchange route name follows I-04 (default `POST /<p>/identity/redirect/token`, where S-17 wrote `/identity/web/token`).
- `config-matrix.json` and the signed corpus are untouched; the precedence order is unchanged.
- The SDK namespace is `cloudSync` (`cloud_sync` in Python and GDScript), never `sync`.

## Steps

1. Draft `plans/U-01.md` against the code and `plans/I-04.md`.
2. List decisions 20 to 24 for the owner in the plan PR.
3. Set status `awaiting-approval` and stop.

## Acceptance criteria

- [ ] `plans/U-01.md` covers every item in Scope → In and names every SDK that follows.
- [ ] It argues rule 2 (no bump, no signed-corpus change) and lists the transcripts of [S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact).
- [ ] It encodes the owner decisions above verbatim and marks decisions 20 to 24 pending (22: the Identity-off licence-owner line; 23: web without Identity; 24: the backend credential without Identity).
- [ ] Status is `awaiting-approval`; nothing is implemented.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

- U-02, U-03, U-04 and U-18 build to it; U-05, U-06, U-07, U-20, U-21, U-08, U-09, U-10, U-13, U-25, U-22 and U-23 execute it.

The role agent sets `--set U-01 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-01 done`.
