/**
 * Cloud Sync's settings slice (ST-03; plans/U-01b.md §3.3, D5, D6), contributed through the
 * descriptor (`syncService.settings`), never imported by Core (rule 6).
 *
 * The model (plans/U-01b.md D5, D6): a person's quota is the `pkey.cloudSync.bytes` entitlement,
 * which a tier, a licence override or an add-on sets and which Cloud Sync reads from the device's
 * anchor licence. No product setting or manifest member carries a quota. The operator has three
 * controls: one product ceiling (`cloudSync.ceiling.bytes`, below), and at platform scope the
 * default quota (`cloudSync.quota.defaultBytes`) and the kill switch (`cloudSync.writesPaused`).
 * The platform two live in Core's platform slice (`core/settings/platform.ts`), because a service
 * slice contributes product-scope entries only.
 *
 * Every Cloud Sync entry is `pending` on U-05, which adds the readers (the Durable Object, the
 * directory totals and the `syncAccess` quota they enforce).
 */

import { CLOUD_SYNC_CEILINGS } from "@polaris-key/catalog";
import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";

const VISIBLE = { service: "sync", offBehaviour: "hide" } as const;
const DOCS = "/docs/features/cloud-sync/";
const PENDING = { wp: "U-05" } as const;

/** The largest product ceiling the registry accepts (1 PiB); the bound only keeps it an integer. */
const CEILING_MAX_BYTES = 1024 ** 5;

export const SYNC_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["cloudSync"],
  entries: [
    // The operator's cost control: all Cloud Sync data of every person on the product together.
    // Raising it costs the platform more, so it is confirmed more strictly than lowering it.
    // Lowering it below the stored total deletes nothing: writes that grow usage are refused.
    setting({
      key: "cloudSync.ceiling.bytes",
      scope: "product",
      service: "sync",
      area: "cloudSync.limits",
      label: "Product storage ceiling",
      description:
        "The most Cloud Sync data all people on the product may keep together: settings, records and files. Past it, a write that grows usage is refused; reads, clears and deletes keep working, and nothing is deleted.",
      keywords: ["quota", "storage", "ceiling", "cost"],
      docs: DOCS,
      value: {
        kind: "integer",
        unit: "bytes",
        min: 0,
        max: CEILING_MAX_BYTES,
      },
      defaultValue: CLOUD_SYNC_CEILINGS.perProduct.bytes,
      merge: "cascade",
      ownership: "operator",
      critical: true,
      confirm: { up: "L2", down: "L1" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      since: "U-01b",
      pending: PENDING,
    }),
  ],
};
