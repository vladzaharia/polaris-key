/**
 * Cloud Sync's settings slice (ST-03; plans/U-01.md §3 "Settings registry entries"), contributed
 * through the descriptor (`syncService.settings`), never imported by Core (rule 6).
 *
 * The split (S-18, Q5): the data shape a client needs (user settings, collections, saves,
 * migrations) lives in the catalog; limits and access policy are these product settings, seeded
 * by `.pkey/product`'s `cloudSync` block and claimable from the console screen. The manifest
 * validator already refuses a declared limit above the platform ceiling (rule 10,
 * `cloud_sync_limit_over_ceiling`) and an unknown tier or flag (rules 8, 8b); the ceilings and
 * defaults below are the same constants it uses, imported from `@polaris-key/catalog` (one source
 * of truth).
 *
 * Every entry is `pending` on U-05, which adds the readers (the resolver call behind
 * `syncAccess` and the limits it enforces); persistence as `product_settings` rows waits for
 * ST-01b. The operator-only per-product ceilings (`cloudSync.ceiling.*`) and the platform
 * `cloudSync.writesPaused` lock are U-05's, registered with the code that enforces them.
 */

import { CLOUD_SYNC_CEILINGS, CLOUD_SYNC_DEFAULTS } from "@polaris-key/catalog";
import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";

const VISIBLE = { service: "sync", offBehaviour: "hide" } as const;
const DOCS = "/docs/services/sync/";
const PENDING = { wp: "U-05" } as const;
const PER_PERSON = CLOUD_SYNC_CEILINGS.perPerson;

/** How the value spec names a limits object and the ceiling it is clamped to. */
const LIMITS_SCHEMA = `cloudSyncLimits (product.schema.json), each byte limit at most CLOUD_SYNC_CEILINGS.perPerson (totalBytes ${PER_PERSON.totalBytes}, settingsBytes ${PER_PERSON.settingsBytes}, collectionBytes ${PER_PERSON.collectionBytes}, saves.maxBytes ${PER_PERSON.saveBytes})`;

export const SYNC_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["cloudSync"],
  entries: [
    setting({
      key: "cloudSync.limits",
      scope: "product",
      service: "sync",
      area: "cloudSync.limits",
      label: "Per-person limits",
      description:
        "How much Cloud Sync data one licensed person may keep on the product: total bytes, user-settings bytes, records, collection bytes and save slots. Never above the platform's per-person ceilings.",
      keywords: ["quota", "storage", "saves", "slots"],
      docs: DOCS,
      value: { kind: "json", schema: LIMITS_SCHEMA },
      defaultValue: CLOUD_SYNC_DEFAULTS.licensed,
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:cloudSync.limits" },
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      since: "U-04",
      pending: PENDING,
    }),
    setting({
      key: "cloudSync.limits.byTier",
      scope: "product",
      service: "sync",
      area: "cloudSync.limits",
      label: "Limits by tier",
      description:
        "Per-tier limits that replace the per-person limits for people whose highest-ranked contributing licence is on that tier. Each tier is held to the same ceilings.",
      keywords: ["quota", "tier", "plan"],
      docs: DOCS,
      value: { kind: "json", schema: `{ <tierId>: ${LIMITS_SCHEMA} }` },
      defaultValue: {},
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:cloudSync.limits.byTier" },
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      since: "U-04",
      pending: PENDING,
    }),
    setting({
      key: "cloudSync.limits.byEntitlement",
      scope: "product",
      service: "sync",
      area: "cloudSync.limits",
      label: "Limits by entitlement",
      description:
        "The numeric catalog flags (combined by max) that raise a person's total bytes or save slots, so a purchase can grant more storage.",
      keywords: ["quota", "entitlement", "flag", "storage"],
      docs: DOCS,
      value: {
        kind: "json",
        schema:
          "cloudSync.limits.byEntitlement (product.schema.json): { totalBytes?, saveSlots? } naming numeric flags with combine: max",
      },
      defaultValue: {},
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:cloudSync.limits.byEntitlement" },
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      since: "U-04",
      pending: PENDING,
    }),
    setting({
      key: "cloudSync.unlicensed",
      scope: "product",
      service: "sync",
      area: "cloudSync.limits",
      label: "Unlicensed people",
      description:
        "Limits for signed-in people with no usable licence, and whether they may use save slots. Never above the licensed limits.",
      keywords: ["free", "unlicensed", "quota", "saves"],
      docs: DOCS,
      value: {
        kind: "json",
        schema: `cloudSync.unlicensed (product.schema.json): { limits?: ${LIMITS_SCHEMA}, saves?: boolean }`,
      },
      defaultValue: {
        limits: CLOUD_SYNC_DEFAULTS.unlicensed,
        saves: CLOUD_SYNC_DEFAULTS.unlicensedSaves,
      },
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:cloudSync.unlicensed" },
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      since: "U-04",
      pending: PENDING,
    }),
    // Access policy: dropping `requireLicense` or lowering `minTrust` lets more devices write, so
    // it is a security-widening setting (rule 2).
    setting({
      key: "cloudSync.writes",
      scope: "product",
      service: "sync",
      area: "cloudSync.access",
      label: "Who may write",
      description:
        "Whether a write needs a usable licence on the device, and the lowest device trust level that may write. Reads of one's own data are always allowed.",
      keywords: ["requireLicense", "minTrust", "attested", "access"],
      docs: DOCS,
      value: {
        kind: "json",
        schema:
          "cloudSync.writes (product.schema.json): { requireLicense?: boolean, minTrust?: basic | attested | null }",
      },
      defaultValue: { requireLicense: false, minTrust: null },
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:cloudSync.writes" },
      securityWidening: true,
      critical: true,
      widensWhen: "any",
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      since: "U-04",
      pending: PENDING,
    }),
  ],
};
