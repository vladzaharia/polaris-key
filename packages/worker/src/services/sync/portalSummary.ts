/**
 * Cloud Sync's `cloudSyncSummary` descriptor hook (U-12.5, `core/hooks.ts`): one person's usage,
 * state and device activity for the Polaris Locker portal, read through Core so Identity never
 * imports this service (rule 6).
 *
 * It asks the person's object for `inspect` and keeps only sizes and times: no setting key, no
 * collection name, no record id, no file name, whichever encryption mode the product serves
 * (`test/services/sync/portalSummary.test.ts`). Devices are mapped from the object's device ids
 * to the labels Core holds, and the ids are dropped. It creates nothing: a person with no object
 * yet reads as empty.
 *
 *   state   `paused` while the operator's `cloudSync.writesPaused` is on; else `full` when the
 *           person's bytes have reached the limit in force; else `active`.
 */

import type {
  CloudSyncDeviceActivity,
  CloudSyncState,
  CloudSyncSummary,
  HookContext,
} from "../../core/hooks.js";
import { syncPauseNotice } from "../../core/accounts/syncPause.js";
import { syncTierLimits } from "../../core/accounts/syncTierLimits.js";
import { getActiveSchema } from "../../core/products/store.js";
import { callCloudSync } from "./do/client.js";
import { syncMode } from "./handlers/common.js";

/** At most this many devices are listed (the object keeps far fewer bindings). */
const MAX_DEVICES = 50;

/** What an account with no subject here reads as. */
const NOTHING = { empty: true, usage: { bytes: 0 }, devices: [] };

export function cloudSyncSummary(ctx: HookContext) {
  const { env, db, now } = ctx;
  const product = ctx.product.slug;
  return {
    async summary(subject: string | null): Promise<CloudSyncSummary> {
      const [inspected, schemaRow, limits, pause, dir] = await Promise.all([
        subject === null
          ? Promise.resolve(NOTHING)
          : callCloudSync<"inspect">(
              env,
              { product, subject },
              { op: "inspect" },
            ),
        getActiveSchema(db, product),
        syncTierLimits(env, db, product, now),
        syncPauseNotice(env, db, false),
        subject === null
          ? Promise.resolve(null)
          : db.first<{ quota_bytes: number; tier_id: string | null }>(
              "SELECT quota_bytes, tier_id FROM sync_directory WHERE product = ? AND subject = ?",
              product,
              subject,
            ),
      ]);
      const mode = await syncMode(env, db, product, schemaRow);
      const quota = dir ? dir.quota_bytes : limits.defaultBytes;
      const bytes = inspected.usage.bytes;
      const state: CloudSyncState = pause
        ? "paused"
        : quota > 0 && bytes >= quota
          ? "full"
          : "active";
      const listed = inspected.devices.slice(0, MAX_DEVICES);
      // One read for every label. A binding outlives a device that moved to another person, so a
      // label is shown only while the device is still bound to this subject.
      const labels = new Map<string, string>();
      if (listed.length > 0 && subject !== null) {
        const rows = await db.all<{ device_id: string; label: string | null }>(
          `SELECT device_id, label FROM devices
            WHERE product = ? AND subject = ?
              AND device_id IN (${listed.map(() => "?").join(", ")})`,
          product,
          subject,
          ...listed.map((d) => d.deviceId),
        );
        for (const r of rows) labels.set(r.device_id, r.label?.trim() ?? "");
      }
      const devices: CloudSyncDeviceActivity[] = listed.map((d) => ({
        label: labels.get(d.deviceId) || "Unnamed device",
        lastSyncAt: d.lastSeen,
      }));
      return {
        encryption: mode.serve,
        empty: inspected.empty,
        state,
        pausedSince: pause ? pause.since : null,
        usage: { bytes },
        quota: {
          bytes: quota,
          tierLabel:
            limits.tiers.find((t) => t.id === (dir?.tier_id ?? null))?.label ??
            null,
        },
        devices,
      };
    },
  };
}
