/**
 * The Google Play connector's operator-owned settings (P5-03), stored through
 * `connectors/settings.ts` (`dist_connector_settings`, connector `play`):
 *
 *   - `priority.default` — the `inAppUpdatePriority` (0–5) a release gets when its rollout starts
 *     and neither the `critical` nor the floor rule applies (`map.ts` `policyPriority`). 0 unless
 *     set.
 *   - `vitals` — the opt-in auto-halt from the Play Developer Reporting API (`vitals.ts`). OFF by
 *     default. `metric` picks the user-perceived rates (`userPerceivedCrashRate`,
 *     `userPerceivedAnrRate`, Play's own bad-behaviour basis) or all crashes and ANRs
 *     (`crashRate`, `anrRate`); `windowHours` is the HOURLY window read back from the freshest
 *     hour Google has; `minDistinctUsers` the smallest sample that may trip; the thresholds are
 *     compared with the decimal Google returns (a fraction of distinct users: 0.02 = 2 %).
 *
 * Reading never fails: a missing row, unparsable JSON or a field out of range falls back to that
 * field's default, and the defaults are the safe ones (auto-halt off, priority 0). Writing
 * validates every field and refuses the whole update on the first bad one.
 */

import type { Db } from "../../../../db/types.js";
import { readConnectorSettings, writeConnectorSettings } from "../settings.js";
import { isPriority } from "./map.js";
import { PLAY_CONNECTOR } from "./setup.js";

export type VitalsMetric = "user-perceived" | "all";

export interface PlayVitalsSettings {
  enabled: boolean;
  metric: VitalsMetric;
  windowHours: number;
  minDistinctUsers: number;
  crashRateThreshold: number;
  anrRateThreshold: number;
}

export interface PlaySettings {
  priority: { default: number };
  vitals: PlayVitalsSettings;
}

export const MAX_WINDOW_HOURS = 168;

export const DEFAULT_PLAY_SETTINGS: PlaySettings = {
  priority: { default: 0 },
  vitals: {
    enabled: false,
    metric: "user-perceived",
    windowHours: 24,
    minDistinctUsers: 1000,
    crashRateThreshold: 0.02,
    anrRateThreshold: 0.01,
  },
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isRate = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1;
const isWindow = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isInteger(v) &&
  v >= 1 &&
  v <= MAX_WINDOW_HOURS;
const isSample = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isMetric = (v: unknown): v is VitalsMetric =>
  v === "user-perceived" || v === "all";

/** Normalise a stored object: every field present and in range, defaults elsewhere. */
export function normalizePlaySettings(raw: unknown): PlaySettings {
  const d = DEFAULT_PLAY_SETTINGS;
  const o = isObj(raw) ? raw : {};
  const p = isObj(o.priority) ? o.priority : {};
  const v = isObj(o.vitals) ? o.vitals : {};
  return {
    priority: {
      default: isPriority(p.default) ? p.default : d.priority.default,
    },
    vitals: {
      enabled: v.enabled === true,
      metric: isMetric(v.metric) ? v.metric : d.vitals.metric,
      windowHours: isWindow(v.windowHours)
        ? v.windowHours
        : d.vitals.windowHours,
      minDistinctUsers: isSample(v.minDistinctUsers)
        ? v.minDistinctUsers
        : d.vitals.minDistinctUsers,
      crashRateThreshold: isRate(v.crashRateThreshold)
        ? v.crashRateThreshold
        : d.vitals.crashRateThreshold,
      anrRateThreshold: isRate(v.anrRateThreshold)
        ? v.anrRateThreshold
        : d.vitals.anrRateThreshold,
    },
  };
}

export async function readPlaySettings(
  db: Db,
  product: string,
): Promise<
  PlaySettings & { updatedAt: number | null; updatedBy: string | null }
> {
  const row = await readConnectorSettings(db, product, PLAY_CONNECTOR);
  return {
    ...normalizePlaySettings(row?.value),
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

export type SettingsPatchResult =
  | { ok: true; settings: PlaySettings }
  | { ok: false; field: string; message: string };

/**
 * Apply a partial update (`{priority?: {default?}, vitals?: {…}}`) to `current`. Every given field
 * must be valid; unknown fields are refused, so a typo never reads as "saved".
 */
export function patchPlaySettings(
  current: PlaySettings,
  body: Record<string, unknown>,
): SettingsPatchResult {
  const bad = (field: string, message: string): SettingsPatchResult => ({
    ok: false,
    field,
    message,
  });
  for (const k of Object.keys(body))
    if (k !== "priority" && k !== "vitals")
      return bad(k, `unknown setting ${k}`);
  const next: PlaySettings = structuredClone(current);
  if (body.priority !== undefined) {
    if (!isObj(body.priority))
      return bad("priority", "priority must be an object");
    for (const [k, v] of Object.entries(body.priority)) {
      if (k !== "default")
        return bad(`priority.${k}`, `unknown setting priority.${k}`);
      if (!isPriority(v))
        return bad("priority.default", "priority.default must be 0 to 5");
      next.priority.default = v;
    }
  }
  if (body.vitals !== undefined) {
    if (!isObj(body.vitals)) return bad("vitals", "vitals must be an object");
    const checks: Record<
      keyof PlayVitalsSettings,
      [(v: unknown) => boolean, string]
    > = {
      enabled: [(v) => typeof v === "boolean", "must be a boolean"],
      metric: [isMetric, 'must be "user-perceived" or "all"'],
      windowHours: [
        isWindow,
        `must be an integer from 1 to ${MAX_WINDOW_HOURS}`,
      ],
      minDistinctUsers: [isSample, "must be a positive integer"],
      crashRateThreshold: [isRate, "must be a number strictly between 0 and 1"],
      anrRateThreshold: [isRate, "must be a number strictly between 0 and 1"],
    };
    for (const [k, v] of Object.entries(body.vitals)) {
      const check = checks[k as keyof PlayVitalsSettings];
      if (!check) return bad(`vitals.${k}`, `unknown setting vitals.${k}`);
      if (!check[0](v)) return bad(`vitals.${k}`, `vitals.${k} ${check[1]}`);
      (next.vitals as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return { ok: true, settings: next };
}

export async function writePlaySettings(
  db: Db,
  product: string,
  settings: PlaySettings,
  by: string,
  now: number,
): Promise<void> {
  await writeConnectorSettings(
    db,
    product,
    PLAY_CONNECTOR,
    settings as unknown as Record<string, unknown>,
    by,
    now,
  );
}
