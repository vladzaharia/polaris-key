/**
 * S-19's per-product licensing-model settings (`licensing.*`, S-19 §7.13), seeded in the
 * registry as claimable entries (ST-03 design note) and implemented by LX-06, which adds their
 * manifest keys (rule 9), storage rows and console section, and removes `pending`.
 *
 * S-19 is still under review. Every assumption about how licences, grants and entitlements
 * relate (one licence carrying many entitlements, the anchor licence, the holder) is confined to
 * THIS module: nothing else in the registry encodes a licence ↔ entitlement cardinality, and the
 * account is not a settings scope (S-18 owner decision 5), so `accountMerge` is never declared.
 * If S-19's outcome changes, this file is the one to rewrite.
 *
 * Bounds marked "LX-06 confirms" are placeholders S-19 does not fix; LX-06 owns them.
 */

import { setting } from "../../core/settings/define.js";
import type { SettingDef } from "../../core/settings/types.js";

const VISIBLE = { service: "license", offBehaviour: "hide" } as const;
const DOCS = "/docs/services/license/model/";
const AREA = "license.licensing";

export const LICENSING_SETTINGS: readonly SettingDef[] = [
  setting({
    key: "licensing.entitlementModel",
    scope: "product",
    service: "license",
    area: AREA,
    label: "Entitlement model",
    description:
      "Whether devices see the combined entitlements of every grant their holder has, or only their own licence's (the legacy model). New products start combined.",
    docs: DOCS,
    value: { kind: "enum", values: ["legacy", "combined"] },
    defaultValue: "combined",
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.entitlementModel" },
    confirm: { change: "L2" },
    visibleWhen: VISIBLE,
    wire: ["document"],
    storage: { kind: "scalar" },
    pending: { wp: "LX-06" },
  }),
  setting({
    key: "licensing.entitlementHolder",
    scope: "product",
    service: "license",
    area: AREA,
    label: "Entitlement holder",
    description:
      "Whose entitlements a device sees: the licence's own (device) or its owner account's whole set (owner). Owner lets a shared key reach everything the owner holds.",
    docs: DOCS,
    value: { kind: "enum", values: ["device", "owner"] },
    defaultValue: "device",
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.entitlementHolder" },
    critical: true,
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    wire: ["document"],
    storage: { kind: "scalar" },
    pending: { wp: "LX-06" },
  }),
  setting({
    key: "licensing.clampGraceToExpiry",
    scope: "product",
    service: "license",
    area: AREA,
    label: "Clamp offline grace to expiry",
    description:
      "Ends a device's offline grace no later than its licence's expiry, so an expired licence cannot keep running offline.",
    docs: DOCS,
    value: { kind: "boolean" },
    defaultValue: true,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.clampGraceToExpiry" },
    confirm: { on: "L0", off: "L1" },
    visibleWhen: VISIBLE,
    wire: ["document"],
    storage: { kind: "scalar" },
    pending: { wp: "LX-06" },
  }),
  setting({
    key: "licensing.anchorPolicy",
    scope: "product",
    service: "license",
    area: AREA,
    label: "Anchor licence choice",
    description:
      "Which of a holder's licences a device runs on: the highest-ranked tier, the one with most free seats, or the oldest.",
    docs: DOCS,
    value: {
      kind: "enum",
      values: ["rank-first", "most-free-seats", "oldest"],
    },
    defaultValue: "rank-first",
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.anchorPolicy" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    storage: { kind: "scalar" },
    pending: { wp: "LX-06" },
  }),
  setting({
    key: "licensing.reanchor",
    scope: "product",
    service: "license",
    area: AREA,
    label: "Re-anchor",
    description:
      "When a device may move to a better anchor licence: never, on activation, or on every refresh.",
    docs: DOCS,
    value: { kind: "enum", values: ["never", "onActivation", "onRefresh"] },
    defaultValue: "onActivation",
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.reanchor" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    storage: { kind: "scalar" },
    pending: { wp: "LX-06" },
  }),
  setting({
    key: "licensing.refundGraceHours",
    scope: "product",
    service: "license",
    area: AREA,
    label: "Refund grace",
    description:
      "Hours a refunded or charged-back grant keeps working before it is revoked. Zero revokes at once.",
    docs: DOCS,
    // Upper bound: LX-06 confirms.
    value: { kind: "integer", unit: "hours", min: 0, max: 720 },
    defaultValue: 0,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.refundGraceHours" },
    confirm: { up: "L1", down: "L0" },
    visibleWhen: VISIBLE,
    storage: { kind: "scalar" },
    pending: { wp: "LX-06" },
  }),
  setting({
    key: "licensing.dunningGraceDays",
    scope: "product",
    service: "license",
    area: AREA,
    label: "Billing-retry grace",
    description:
      "Days a subscription grant keeps working while the store retries a failed renewal. Zero follows the store's own billing grace only.",
    docs: DOCS,
    // Upper bound: LX-06 confirms.
    value: { kind: "integer", unit: "days", min: 0, max: 60 },
    defaultValue: 0,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.dunningGraceDays" },
    confirm: { up: "L1", down: "L0" },
    visibleWhen: VISIBLE,
    storage: { kind: "scalar" },
    pending: { wp: "LX-06" },
  }),
];
