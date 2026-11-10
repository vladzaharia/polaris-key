/**
 * What the updaters of a product have reported (P2-11): the console's Updates page reads
 * Verified from here. An updater is Verified once a device has reported an update outcome on its
 * outlet (`core/updateHealth.ts`), the Ship builds domain fact: Sparkle, WinSparkle and the
 * other feed readers send no `X-PKey-SDK`, so no sighting exists for them.
 *
 * Counts are distinct devices per declared outlet, over the counters' whole retention, on the
 * newest `RELEASES_READ` releases of the app. An event carries an outlet and a channel but no
 * platform, so a fact is per outlet. Never throws; no binding reads as "not counting".
 */

import type { ServiceHooks } from "../../core/hooks.js";
import {
  countsFor,
  readUpdateHealth,
  type UpdateEvent,
} from "../../core/updateHealth.js";
import { RETENTION_SECONDS } from "../../core/updateHealthDo.js";
import type { Env } from "../../platform/env.js";

/** The newest releases of the app whose counters are read (one object call each). */
export const RELEASES_READ = 6;

export interface OutletChecks {
  outlet: string;
  kind: string;
  /** Devices that reported an offer, download, apply or confirmation. */
  checks: number;
  /** Devices that reverted an update or rolled a boot back. */
  failures: number;
}

export interface UpdateChecks {
  /** False when the counters are not bound or none could be read: "no data", never zero. */
  counting: boolean;
  outlets: OutletChecks[];
}

const CHECKED: readonly UpdateEvent[] = [
  "update_offered",
  "update_downloaded",
  "update_applied",
  "update_confirmed",
];

export async function updateChecks(
  env: Env,
  product: string,
  hooks: ServiceHooks,
  now: number,
): Promise<UpdateChecks> {
  const outlets =
    (await hooks
      .delivery()
      ?.outlets()
      .catch(() => [])) ?? [];
  const sums = new Map<string, OutletChecks>(
    outlets.map((o) => [
      o.outletId,
      { outlet: o.outletId, kind: o.kind, checks: 0, failures: 0 },
    ]),
  );
  if (!env.UPDATE_HEALTH)
    return { counting: false, outlets: [...sums.values()] };
  const catalog = hooks.releaseCatalog();
  if (!catalog) return { counting: false, outlets: [...sums.values()] };

  let readAny = false;
  let tried = 0;
  const apps = (await catalog.deliverables()).filter((d) => d.kind === "app");
  for (const d of apps) {
    const newest = (await catalog.releases(d.id))
      .slice()
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
      .slice(0, RELEASES_READ);
    for (const rel of newest) {
      tried += 1;
      const read = await readUpdateHealth(env, {
        product,
        deliverable: d.id,
        release: rel.releaseId,
        windowHours: RETENTION_SECONDS / 3600,
        now,
      });
      if (!read) continue;
      readAny = true;
      for (const row of sums.values()) {
        const per: Record<UpdateEvent, number> = {
          update_offered: 0,
          update_downloaded: 0,
          update_applied: 0,
          update_confirmed: 0,
          update_reverted: 0,
          pack_failed: 0,
          boot_rolled_back: 0,
        };
        const channels = new Set(
          read.counts
            .filter((c) => c.outlet === row.outlet)
            .map((c) => c.channel),
        );
        for (const ch of channels)
          for (const [k, v] of Object.entries(
            countsFor(read.counts, row.outlet, ch),
          ))
            per[k as UpdateEvent] += v;
        row.checks += Math.max(...CHECKED.map((e) => per[e]));
        row.failures += per.update_reverted + per.boot_rolled_back;
      }
    }
  }
  return { counting: tried === 0 || readAny, outlets: [...sums.values()] };
}
