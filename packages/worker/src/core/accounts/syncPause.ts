/// <reference types="@cloudflare/workers-types" />

/**
 * The Cloud Sync pause as the console shows it to a member who cannot read the platform
 * settings (U-05.21 M5/M6): is `cloudSync.writesPaused` on, since when, by whom and, for a
 * caller who may read it, why. Read for a service that may not read Core's tables itself.
 *
 * `by` is a display name from the audit row of the write that turned it on, never a subject or
 * member id: a row with no name answers `by: null`. `reason` is the operator's own text and is
 * returned only when `withReason` (the caller holds the Platform area).
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { platformSettingResolved } from "../settings/platformRead.js";

export interface SyncPauseNotice {
  /** Epoch seconds the switch was turned on. */
  since: number | null;
  by: string | null;
  reason: string | null;
}

const KEY = "cloudSync.writesPaused";

export async function syncPauseNotice(
  env: Env,
  db: Db,
  withReason: boolean,
): Promise<SyncPauseNotice | null> {
  const r = await platformSettingResolved(env, db, KEY);
  if (r.value !== "on") return null;
  const step = r.chain.find((s) => s.source === "platform");
  const audit = await db.first<{
    at: number;
    actor_name: string | null;
    reason: string | null;
  }>(
    `SELECT at, actor_name, reason FROM platform_audit
      WHERE setting_key = ? AND after_json LIKE '%"on"%'
      ORDER BY at DESC, id DESC LIMIT 1`,
    KEY,
  );
  return {
    since: audit?.at ?? step?.at ?? null,
    by: audit?.actor_name?.trim() ? audit.actor_name : null,
    reason: withReason && audit?.reason?.trim() ? audit.reason : null,
  };
}
