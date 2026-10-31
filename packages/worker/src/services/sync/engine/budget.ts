/**
 * Admission: whether a write may grow the person's store (§13.1).
 *
 *   - A write that shrinks (`clear`, `removeMember`) always passes.
 *   - The product ceiling: past it, a write that grows usage is `quota_exceeded`, scope `product`.
 *   - The quota is the requesting device's: a write that does not shrink is refused when usage plus
 *     its growth is over the quota, so a device whose quota is below usage can read, clear and
 *     remove, but not write (`0`: reads only).
 *   - The budget (256 keys, 64 KiB over declared and open settings) refuses only growth. A store
 *     already over it (a merge keeps everything: L8) still accepts a write that does not grow.
 *
 * A refusal is `quota_exceeded` with the scope; the budget answers as scope `user`, being inside
 * the quota. Nothing here deletes anything: quota never deletes.
 */

import {
  SYNC_MAX_SETTINGS,
  SYNC_MAX_SETTINGS_BYTES,
} from "@polaris-key/protocol/sync";
import { fileUsage, rowCost } from "./usage.js";
import type { PushLimits, StoredSetting, StoreUsage } from "./types.js";

export type QuotaScope = "user" | "product";

export function admission(
  usage: StoreUsage,
  prev: StoredSetting | undefined,
  next: StoredSetting,
  shrinking: boolean,
  limits: PushLimits | undefined,
): QuotaScope | null {
  if (shrinking) return null;
  const before = rowCost(prev);
  const after = rowCost(next);
  const dBytes = after.bytes - before.bytes;
  const dBudget = after.budget - before.budget;
  const dCount = after.settings - before.settings;
  if (limits?.productOverCeiling && dBytes > 0) return "product";
  if (
    limits &&
    (limits.quotaBytes <= 0 ||
      usage.bytes + fileUsage(usage).reservedBytes + Math.max(dBytes, 0) >
        limits.quotaBytes)
  )
    return "user";
  if (dCount > 0 && usage.settings + dCount > SYNC_MAX_SETTINGS) return "user";
  if (dBudget > 0 && usage.settingsBytes + dBudget > SYNC_MAX_SETTINGS_BYTES)
    return "user";
  return null;
}
