# A-28 One store-app binding with derived identity

| Field       | Value                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce)                                                                                                                                  |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                                                                                                 |
| Depends on  | [A-19](A-19-one-channel-catalogue-tools-channels.md)                                                                                                                                                                                                   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [A-22](A-22-channel-page-status-releases-listing.md), [A-23](A-23-channel-setup-wizards-setup-runner.md), [A-31](A-31-derived-identities-short-pkey.md), [CM-21](CM-21-storefront-connection-notifications.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                                                                                     |
| Gates       | none beyond the green gate                                                                                                                                                                                                                             |
| Human input | none                                                                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                              |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-11** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-20.md`](../plans/CM-20.md) §14: the identity precedence and the optional identity fields (D12). The binding-alias line is dropped: the alias path stays the existing table (D5).

## Goal

One store-app binding with derived identity, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-11** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §4.3, for **DC-11**.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- Commerce settings and outlet identity checks derive from platform_credential_pins (appStore.bundleId/appAppleId, play.packageName and steam.appId are no longer typed); a mismatch attention item; prefilled console fields; product-key products unchanged; absorbs CM-21's identity half; dist_purchase_binding_aliases replaced by one alias path.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-11**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 4 mockup item(s):** `distribution.channel-app-store`, `distribution.channel-setup`, `distribution.channels`, `commerce.sales`.

## Acceptance criteria

- [ ] No store identity is typed twice
- [ ] A pin mismatch raises attention instead of failing silently
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/channels/*`, rewritten in place (one page per channel; the matrix section at A-21); `reference/channels`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-28 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-28 done`.

## Corrections (2026-10-22)

The code and the approved `plans/CM-20.md` (§0 D5, §2.5 D12, §14) override this brief. Recorded by A-28.1.

- **B1.** Precedence (D12): the pin of the product's own active credential, else the product's platform pin. The identity fields of `commerce.stores` become optional. A stored field that differs from the pin still wins and raises attention until the operator confirms "Use the assigned app". No alias work: the binding-alias line is dropped (D5), `dist_purchase_binding_aliases` stays the one alias path. No migration.
- **B2.** No console form types the commerce identity today. `commerce.stores` has home `api`; only `PUT …/commerce/settings` writes it. "Prefilled console fields" means derived values shown with their source.
- **B3.** Pins: `app-store.api-key` -> `appleId`, `app-store.in-app-purchase-key` -> `bundleId`, `google-play.service-account` -> `packageName`, `microsoft-store.partner-center` -> `productId`, `steam.publisher-key` -> `appId`. Own pins live in `outlet_credentials.meta_json`.
- **B4.** A pin mismatch is today only an inert ASC refusal (`connectors/asc/setup.ts`, `pin_mismatch`), with no attention item.
- **B5.** Commerce settings readers to switch in A-28.2: `bridge.ts` (binding, claim, two hooks), `recheck.ts`, `admin.ts`, `public.ts`.
- **B6.** `outletCredentialReach.test.ts` lets `services/commerce/` and `services/distribution/` import `core/platformCredentials`; the console reads pins only through a service's `public.ts`.
- **B7.** `conformance/transcripts/commerce-claim.json` stores an explicit `steam.appId`; it must stay byte-identical.
- **A-28.1** ships the read: `storeAppBinding` / `storeAppBindings` in `core/platformCredentials.ts` (D12 per field; lowest own id wins; `ambiguous` per D15).
