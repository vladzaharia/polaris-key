# U-01 Plan Cloud Sync: decision record, glossary, data model, WIRE-CONTRACT-V4 Cloud Sync section with the op table and push rules, browser principal, errors, parity ids, manifest schema, scenario-corpus format, ceilings, threat rows

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (U0 plan)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Depends on  | [I-04](I-04-account-contract-plan.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Unblocks    | [U-02](U-02-principal-binding.md), [U-04](U-04-catalog-and-service.md), [U-05](U-05-cloud-sync-do.md), [U-18](U-18-scenario-corpus.md), [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md), [U-08](U-08-merge-prompt.md), [U-10](U-10-saves-backend.md), [U-09](U-09-collections-backend.md), [U-22](U-22-collections-sdk-node-react-python.md), [U-23](U-23-collections-sdk-swift-kotlin-godot.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Plan mode   | yes: planning only; [`plans/U-01.md`](../plans/U-01.md) was approved on 2026-10-05                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Gates       | plan mode; human approval; rule 2 argument (no `PROTOCOL_VERSION` bump); rule 4 (glossary)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Human input | none (S-17 §7.3 decisions 20–24 were decided on 2026-10-04)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/U-01.md`](../plans/U-01.md):** approved on 2026-10-05 with every recommendation accepted, so this package is done. The plan supersedes the earlier draft on branch `wp/U-01-cloud-sync-plan`, which must not be merged. LX-01 §7 and I-24 Q6 amend it; see the plan's owner-decisions header.

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
- WIRE-CONTRACT-V4 Cloud Sync section: pull (`/sync`) and push (`/sync/ops`) with the op table and push rules 1–8, the save routes, `403 account_required` (not signed in; it carries I-08's sign-in offer), the discovery fragment (`sync: {settings, collections, saves, limits}`), the browser principal (bearer device token from I-08, CORS without credentials) and the CORS inclusion list.
- `shared-protocol` types; error codes ([S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact)); parity ids (`config.user.set`, `config.user.observe`, `sync.settings`, `sync.collection`, `sync.saves`, `sync.offline`, `sync.merge`, `sync.live`, `sync.scenarios`).
- Catalog `user` block and `cloudSync` block with validator rules 1–11; the scenario-corpus format; ceilings and defaults ([S-17 §5.7](../../notes/S-17-user-data-sync.md#57-quotas-and-limits), [S-17 §5.17](../../notes/S-17-user-data-sync.md#517-cost-and-abuse-model)); threat rows T1–T16; the catalog-parser tolerance check in each SDK.
- The account override layer's placement and the migration steps ([S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision)): entitlement overrides stay on the licence; only `config` and `secrets` move (decision 20, decided).

**Out** (and where it belongs instead):

- Code (planning only); live pokes (→ U-14's plan), the developer-backend credential (→ U-16), receipts and end-to-end encryption (→ U-17).

## Owner decisions (2026-10-04, binding)

- **Cloud Sync is its own service** named "Cloud Sync" (slug `sync`), with its own toggle; it depends on Config and on the product's Identity service, because Cloud Sync needs sign-in (owner, 2026-10-04, final answers): descriptor `requires: [config, identity]`, enforced by the console Services toggle.
- **The principal is the account × product**, seen by the product only as its pairwise subject. Core resolves it as `resolveSyncPrincipal(device) = devices.subject`, set only by sign-in through the product; there is no licence-owner fallback for Cloud Sync. Config's account override layer keeps its owner fallback (`subjectFor(license.account_id, product)`), so owned licences on key-entry devices still get account overrides.
- **The licence-level config override layer is removed everywhere**, replaced by user-level managed config attached to the account per product (the account override). No "products without Identity keep licence overrides" exception.
- **Floating licences have no such layer** and are prompted to sign up.
- **Overrides on licences with no owner are dropped at migration**, with an operator-visible report; no grace period.
- **No Cloud Sync without signing in, ever** (literal sign-in; owner, 2026-10-04, final answers). Floating licences, key-activated devices and products without Identity get local persistence only; settings upload at the first sign-in; U-26 (the licence-owned backup) stays retired. The SDK and UI kits offer sign-in on `account_required`.
- **Defaults confirmed:** the MVP (about 64, now 67, agent-days) first, then the anonymous-to-signed-in merge and saves, before collections; per-product ceilings of 50 GiB, 100k users holding data and 2,000 pushes per second; 1 MiB with saves off for signed-in users with no licence for the product; the platform pays Cloudflare until per-product billing; web apps use a device token issued to an origin on the product's `web.origins` allowlist through I-08.

## S-19 amendments (owner, 2026-10-04)

- **Decision 19: Cloud Sync quotas are `byEntitlement` plus `byTier`.** Add `byEntitlement` (`sync.storageBytes` and `sync.slots`, catalog `combine: max`, read from the device's effective entitlement set, S-19 §7.3), and keep `byTier` evaluated on the **highest-rank contributing licence** (`tiers.rank`). This replaces §8 Q2's "largest limit among the account's usable licences" with "the effective set's value": the same result for numbers, one code path ([S-19 §8](../../notes/S-19-licensing-model.md#8-interactions-with-other-plans-exactly-what-changes) U-01 row, [§10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 19).
- `requiresFlag` reads the resolver (`resolveDeviceEntitlements`, LX-09), so it works on licence-less signed-in devices; `writes.requireLicense` reads the anchor's usability. U-02 builds on the resolver once LX-09 lands.
- **Decision 18** renames PX-W3's "download grant" to **"download ticket"**; where this plan refers to download grants, use the new name.
- Ceilings and quotas are `product_settings` rows (S-18 §5.4), not a `sync_product_settings` table.

## Design notes

- **S-17 decisions 20–24, decided** (owner, 2026-10-04, final answers): 20, entitlement overrides stay on the licence and only `config` and `secrets` move; 21, a 30-day notice counted from I-07 and I-11 live, and a 90-day report; 22, Cloud Sync needs sign-in (no licence-owner line, so no leaked-key residual and no new-device alert); 23, web Cloud Sync uses I-08's web redirect, which needs Identity; 24, the developer-backend credential follows Identity (I-21 client credentials with `pkey:sync`, else I-25).
- **Principal change.** Sign-out, a relink that clears the binding or a merge alias changes the device's principal; the SDK treats it exactly like sign-out (discard the cloud cache and keep local values as the unbound partition).
- **Settled S-16 decisions** (owner, 2026-10-04): D17–D23 accepted; D21 means an account merge keeps the survivor's pairwise subject per product, the other becomes an alias that `resolveSyncPrincipal` resolves, and the developer receives `subject.merged`.
- **Carried defaults** 5–16 of [S-17 §7.3](../../notes/S-17-user-data-sync.md#73-owner-decisions) (locked keys, precedence in the existing `local` slot, conflict policies, `ui.scopes` stays a hint, data follows the account not the licence, and so on) are encoded as stated.
- **Device binding (correction, 2026-10-04).** The binding is created by I-05 under the name I-04 fixes (default `devices.subject`, the pairwise subject); S-17's U-02 row said "`devices.subject` migration", but S-16 §8.1 assigns the column to I-05, so U-02 adds no migration. The code-exchange route name follows I-04 (default `POST /<p>/identity/redirect/token`, where S-17 wrote `/identity/web/token`).
- `config-matrix.json` and the signed corpus are untouched; the precedence order is unchanged.
- The SDK namespace is `cloudSync` (`cloud_sync` in Python and GDScript), never `sync`.

## Steps

1. Draft `plans/U-01.md` against the code and `plans/I-04.md`.
2. Encode decisions 20 to 24 as decided in the plan.
3. Set status `awaiting-approval` and stop.

## Acceptance criteria

- [ ] `plans/U-01.md` covers every item in Scope → In and names every SDK that follows.
- [ ] It argues rule 2 (no bump, no signed-corpus change) and lists the transcripts of [S-17 §5.13](../../notes/S-17-user-data-sync.md#513-wire-impact).
- [ ] It encodes the owner decisions above verbatim, decisions 20 to 24 included as decided.
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
