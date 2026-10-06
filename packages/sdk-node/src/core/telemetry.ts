// Device telemetry — `POST /<p>/devices/report` (wire contract v3 §6).
//
// It moved out of the config service in v3 (`POST /<p>/config/report` is gone) because it was
// never config: it is the device's software facts plus a snapshot of what it BELIEVES it was
// granted, which is licence anti-fraud data. It is a Core surface now, available under every
// registration policy, and a config-only product reports on it too.
//
// ── THE SNAPSHOT IS BUILT FROM RE-VERIFIED DOCUMENTS ────────────────────────────────────────
//
// R4-05: v1 echoed the on-disk cache back to the control plane verbatim, so a forged local file
// authored the one signal that would have revealed the forgery. Everything below is read from
// the documents `CacheManager` re-verified microseconds ago; if nothing verified, the maps are
// empty, and an empty report is a truthful one.
//
// Best-effort throughout: facts collection is wrapped, the POST is wrapped, and a failure at
// either end is invisible to the caller. Telemetry must never be able to fail a sync.

import type { DeviceFacts, JSONValue } from "@polaris-key/protocol/core";
import type { PackInstallReport } from "@polaris-key/client-core/packs";
import { collectFacts, type ProbeDeclaration } from "../devices/facts.js";
import type { UpdateEventEntry } from "../update/journal.js";
import type { CacheManager } from "./cache.js";
import type { CoreContext } from "./context.js";

export type ReportSnapshot = {
  config: Record<string, JSONValue>;
  entitlements: Record<string, JSONValue>;
  /** The feature ids `supports()` answers Supported for (P1b-10). Sent with every report: the
   *  Worker overwrites the stored report each time, so a list sent only on change would vanish
   *  from it at the next report. */
  caps?: string[];
  /** The active pack set (plans/P4-01.md §2.11): its `packSetId`, when the host has packs. */
  content?: { packSetId: string };
  /** Recent pack installs (P4-17): the pairs a lazy delta could serve. Bounded by the engine
   *  (8) and again by the Worker. */
  packInstalls?: PackInstallReport[];
  /** The gate's status (SDK parity pass §3.13), as Godot reports it. */
  gate?: { status: string };
  /** The outlet id this install reports under (allowlisted, ≤ 64 chars). */
  outlet?: string;
  /** P6-03 update-health events, at most 16, oldest first. */
  updates?: UpdateEventEntry[];
} & Partial<DeviceFacts>;

/** What the facade knows beyond the cache: the gate, the outlet and the pending events. */
export interface SnapshotExtras {
  gate?: string | null;
  outlet?: string | null;
  updates?: UpdateEventEntry[];
}

/** Assemble the report body from re-verified content plus this host's software facts. */
export function buildSnapshot(
  cache: CacheManager,
  probes: ProbeDeclaration[],
  caps?: string[],
  packSetId: string | null = null,
  packInstalls: PackInstallReport[] = [],
  extras: SnapshotExtras = {},
): ReportSnapshot {
  const config: Record<string, JSONValue> = {};
  const entitlements: Record<string, JSONValue> = {};
  for (const [k, v] of Object.entries(cache.state.config?.doc.config ?? {}))
    config[k] = v.value;
  for (const [k, v] of Object.entries(
    cache.state.license?.doc.entitlements ?? {},
  ))
    entitlements[k] = v.value;

  // Software facts ride alongside the snapshot on the SAME call — no extra round trip, and the
  // Worker's allowlist keeps the payload bounded.
  let facts: DeviceFacts | Record<string, never> = {};
  try {
    facts = collectFacts({ probes });
  } catch {
    // Facts are diagnostic; failing to gather them must never break a sync.
  }
  return {
    ...facts,
    config,
    entitlements,
    ...(caps ? { caps } : {}),
    ...(packSetId !== null ? { content: { packSetId } } : {}),
    ...(packInstalls.length > 0 ? { packInstalls } : {}),
    ...(extras.gate ? { gate: { status: extras.gate } } : {}),
    ...(extras.outlet ? { outlet: extras.outlet.slice(0, 64) } : {}),
    ...(extras.updates && extras.updates.length > 0
      ? { updates: extras.updates }
      : {}),
  };
}

/** POST the snapshot. Returns whether the server accepted it; callers ignore that. */
export async function reportSnapshot(
  ctx: CoreContext,
  token: string,
  snapshot: unknown,
): Promise<boolean> {
  try {
    const f = ctx.fetcher();
    const res = await f(ctx.url("devices/report"), {
      method: "POST",
      headers: ctx.headers({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify(snapshot),
      signal: ctx.deadline(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
