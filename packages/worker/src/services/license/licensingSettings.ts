/**
 * S-19's per-product licensing-model settings (`licensing.*`, S-19 §7.13, plans/LX-01.md §3.2),
 * registered by ST-03 and made live by LX-06.
 *
 * Each is a claimable, ROW-BACKED `product_settings` row (S-18 §4.3, §4.5, model C):
 *
 *   - the manifest seeds it from `.pkey/product`'s `licensing:` block (rule 9: one validator rule
 *     per field in `@polaris-key/manifest`, which also owns the vocabularies and bounds used
 *     below). License's `manifestIngestAlways` writes the declared values as `source = 'manifest'`
 *     rows on every link and resync, and clears a row the manifest no longer declares;
 *   - a console edit (`PATCH /manage/api/products/<slug>/settings/<key>`) claims it
 *     (`source = 'console'`), and every later resync leaves it alone;
 *   - Revert (`DELETE …/settings/<key>`) drops the claim and re-applies the last applied
 *     manifest's value at once.
 *
 * The storage and the write path are Core's (`core/rowSettings.ts`), shared with Identity's
 * `identity.oidc.syncTierOnSignIn`. ST-04's resolver and `writeSetting()` take both over.
 *
 * The behaviour behind each setting is NOT here. LX-07's grace clamp reads
 * `licensing.clampGraceToExpiry` through ST-04's resolver (`core/graceClamp.ts`, which the bundle
 * mint and every licence-bearing document share); LX-09 (the model and the holder), LX-10 (anchor
 * and re-anchor), LX-12 (refund grace) and LX-23 (billing-retry grace) read theirs through the
 * resolver or `readLicensingSettings` below.
 *
 * Every assumption about how licences, grants and entitlements relate (one licence carrying many
 * entitlements, the anchor licence, the holder) is confined to THIS module: nothing else in the
 * registry encodes a licence ↔ entitlement cardinality, and the account is not a settings scope
 * (S-18 owner decision 5), so `accountMerge` is never declared.
 */

import {
  LICENSING_ANCHOR_POLICIES,
  LICENSING_DUNNING_GRACE_DAYS_MAX,
  LICENSING_ENTITLEMENT_HOLDERS,
  LICENSING_ENTITLEMENT_MODELS,
  LICENSING_REANCHOR_VALUES,
  LICENSING_REFUND_GRACE_HOURS_MAX,
  type LicensingAnchorPolicy,
  type LicensingEntitlementHolder,
  type LicensingEntitlementModel,
  type LicensingReanchor,
} from "@polaris-key/manifest";
import type { Db } from "../../core/platform.js";
import {
  readRowSettings,
  type RowSettingProduct,
} from "../../core/rowSettings.js";
import { setting } from "../../core/settings/define.js";
import type { SettingDef } from "../../core/settings/types.js";

const VISIBLE = { service: "license", offBehaviour: "hide" } as const;
const DOCS = "/docs/features/licensing/model/";
/** License → Settings renders exactly this area (the console's `license/settings` page). */
export const LICENSING_AREA = "license.licensing";
/** Who reads the values until ST-04's resolver: the typed reader below and Core's row store. */
const READERS = [
  "services/license/licensingSettings.ts",
  "core/rowSettings.ts",
];

/**
 * The cut-over for the derived `entitlementModel` default (plans/LX-01.md §8 Q2): a product
 * registered before this instant (2026-10-06T00:00:00Z, the day LX-06 was committed) keeps
 * `legacy`; a newer one starts `combined`. A manifest value or a console claim overrides it.
 */
export const COMBINED_ENTITLEMENT_MODEL_SINCE = 1791244800;

export const LICENSING_SETTINGS: readonly SettingDef[] = [
  setting({
    key: "licensing.entitlementModel",
    scope: "product",
    service: "license",
    area: LICENSING_AREA,
    label: "Entitlement model",
    description:
      "Whether devices see the combined entitlements of every grant their holder has, or only their own licence's (the legacy model). Products registered before 2026-10-06 start on legacy; newer ones start combined.",
    keywords: ["combined", "legacy", "grants", "holder report"],
    docs: DOCS,
    value: { kind: "enum", values: LICENSING_ENTITLEMENT_MODELS },
    defaultValue: "combined",
    legacyDefault: {
      createdBefore: COMBINED_ENTITLEMENT_MODEL_SINCE,
      value: "legacy",
    },
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.entitlementModel" },
    // Switching to combined changes what every device of the product sees: L2, after the holder
    // report (LX-09). Back to legacy is L1.
    confirm: { up: "L2", down: "L1" },
    visibleWhen: VISIBLE,
    wire: ["document"],
    readers: READERS,
    storage: { kind: "scalar" },
    since: "LX-06",
  }),
  setting({
    key: "licensing.entitlementHolder",
    scope: "product",
    service: "license",
    area: LICENSING_AREA,
    label: "Entitlement holder",
    description:
      "Whose entitlements a device sees: the account signed in on that device (device), or the licence owner's whole set (owner). Owner lets anyone with a shared key reach everything the owner holds.",
    keywords: ["owner", "device", "shared key"],
    docs: DOCS,
    value: { kind: "enum", values: LICENSING_ENTITLEMENT_HOLDERS },
    defaultValue: "device",
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.entitlementHolder" },
    critical: true,
    confirm: { up: "L2", down: "L1" },
    visibleWhen: VISIBLE,
    wire: ["document"],
    readers: READERS,
    storage: { kind: "scalar" },
    since: "LX-06",
  }),
  setting({
    key: "licensing.clampGraceToExpiry",
    scope: "product",
    service: "license",
    area: LICENSING_AREA,
    label: "Clamp offline grace to expiry",
    description:
      "Ends a device's offline grace no later than its licence's expiry, so an expired licence cannot keep running offline.",
    keywords: ["grace", "offline", "graceUntil", "expiry"],
    docs: DOCS,
    value: { kind: "boolean" },
    defaultValue: true,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.clampGraceToExpiry" },
    critical: true,
    confirm: { on: "L0", off: "L1" },
    visibleWhen: VISIBLE,
    wire: ["document"],
    // LX-07: the clamp itself (licence, config, bundle and browser-session documents).
    readers: [...READERS, "core/graceClamp.ts"],
    storage: { kind: "scalar" },
    since: "LX-06",
  }),
  setting({
    key: "licensing.anchorPolicy",
    scope: "product",
    service: "license",
    area: LICENSING_AREA,
    label: "Anchor licence choice",
    description:
      "Which of a holder's licences a device runs on: the highest-ranked tier, the one with the most free seats, or the oldest.",
    keywords: ["anchor", "rank", "seats"],
    docs: DOCS,
    value: { kind: "enum", values: LICENSING_ANCHOR_POLICIES },
    defaultValue: "rank-first",
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.anchorPolicy" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    readers: READERS,
    storage: { kind: "scalar" },
    since: "LX-06",
  }),
  setting({
    key: "licensing.reanchor",
    scope: "product",
    service: "license",
    area: LICENSING_AREA,
    label: "Re-anchor",
    description:
      "When a device may move to a better anchor licence: never, or on activation. Moving on every refresh is not available yet.",
    keywords: ["anchor", "onActivation"],
    docs: DOCS,
    // `onRefresh` (S-19 §7.5) is refused until LX-21: it is not in the shared vocabulary yet.
    value: { kind: "enum", values: LICENSING_REANCHOR_VALUES },
    defaultValue: "onActivation",
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.reanchor" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    readers: READERS,
    storage: { kind: "scalar" },
    since: "LX-06",
  }),
  setting({
    key: "licensing.refundGraceHours",
    scope: "product",
    service: "license",
    area: LICENSING_AREA,
    label: "Refund grace",
    description:
      "Hours a refunded or charged-back grant keeps working before it is revoked. Zero revokes at once. It only delays the revocation; a refund always revokes.",
    keywords: ["refund", "chargeback", "revoke"],
    docs: DOCS,
    value: {
      kind: "integer",
      unit: "hours",
      min: 0,
      max: LICENSING_REFUND_GRACE_HOURS_MAX,
    },
    defaultValue: 0,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.refundGraceHours" },
    confirm: { up: "L1", down: "L0" },
    visibleWhen: VISIBLE,
    readers: READERS,
    storage: { kind: "scalar" },
    since: "LX-06",
  }),
  setting({
    key: "licensing.dunningGraceDays",
    scope: "product",
    service: "license",
    area: LICENSING_AREA,
    label: "Billing-retry grace",
    description:
      "Days a subscription grant keeps working while the store retries a failed renewal. Zero follows the store's own billing grace only.",
    keywords: ["dunning", "billing", "subscription"],
    docs: DOCS,
    value: {
      kind: "integer",
      unit: "days",
      min: 0,
      max: LICENSING_DUNNING_GRACE_DAYS_MAX,
    },
    defaultValue: 0,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.dunningGraceDays" },
    confirm: { up: "L1", down: "L0" },
    visibleWhen: VISIBLE,
    storage: { kind: "scalar" },
    since: "LX-06",
    // Hidden until LX-23 builds billing-retry grace (plans/LX-01.md §3.2): the manifest value is
    // stored on every resync, but the console does not offer it and the API refuses writes.
    pending: { wp: "LX-23" },
  }),
];

/** The licensing settings in force for one product, typed. */
export interface LicensingSettings {
  entitlementModel: LicensingEntitlementModel;
  entitlementHolder: LicensingEntitlementHolder;
  clampGraceToExpiry: boolean;
  anchorPolicy: LicensingAnchorPolicy;
  reanchor: LicensingReanchor;
  refundGraceHours: number;
  dunningGraceDays: number;
}

/**
 * The effective licensing settings of `product`: its console claim, else its manifest value, else
 * the (derived) default. The one read path LX-07 onward use until ST-04's resolver replaces it.
 */
export async function readLicensingSettings(
  db: Db,
  product: RowSettingProduct,
): Promise<LicensingSettings> {
  const views = await readRowSettings(db, product, LICENSING_SETTINGS);
  const v = (name: keyof LicensingSettings): unknown =>
    views.find((x) => x.def.key === `licensing.${name}`)?.value;
  return {
    entitlementModel: v("entitlementModel") as LicensingEntitlementModel,
    entitlementHolder: v("entitlementHolder") as LicensingEntitlementHolder,
    clampGraceToExpiry: v("clampGraceToExpiry") as boolean,
    anchorPolicy: v("anchorPolicy") as LicensingAnchorPolicy,
    reanchor: v("reanchor") as LicensingReanchor,
    refundGraceHours: v("refundGraceHours") as number,
    dunningGraceDays: v("dunningGraceDays") as number,
  };
}
