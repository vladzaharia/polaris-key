/**
 * Platform → Activity: an event's before and after, in words (ST-51-fix B2). The Worker stores a
 * setting change as a snapshot (`core/settings/write.ts` `snapshot()`): `{stored, version,
 * effective, source}`, with a secret's value as `{set: boolean}`. The drawer and the CSV show
 * `effective` the way the Settings row does; a bare status object reads as its word; a shape this
 * does not know stays compact JSON.
 */

import type { PlatformActivityItem, PlatformSetting } from "../../../../api.js";
import { SETTINGS_INDEX } from "../../../settings.generated.js";
import { namesOf } from "../../../useSettingTarget.js";
import { formatPlatformValue } from "./platformSettingRow.js";

export interface ValueText {
  text: string;
  /** Unknown shape: shown as code. */
  json: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function plain(v: unknown): ValueText {
  if (v === null || v === undefined) return { text: "Not set", json: false };
  if (isRecord(v) && typeof v.set === "boolean" && Object.keys(v).length === 1)
    return { text: v.set ? "Set" : "Not set", json: false };
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return { text: String(v), json: false };
  if (Array.isArray(v) && v.every((x) => typeof x === "string"))
    return { text: v.join(", "), json: false };
  return { text: JSON.stringify(v), json: true };
}

/** One side of an event, or `null` when the event records nothing there. */
export function valueText(
  raw: unknown,
  setting?: PlatformSetting,
): ValueText | null {
  if (raw === null || raw === undefined) return null;
  if (isRecord(raw) && "effective" in raw) {
    const v = raw.effective;
    if (setting && v !== null && v !== undefined && !isRecord(v))
      return { text: formatPlatformValue(setting, v), json: false };
    return plain(v);
  }
  if (
    isRecord(raw) &&
    typeof raw.status === "string" &&
    Object.keys(raw).length === 1
  )
    return { text: raw.status, json: false };
  return plain(raw);
}

/**
 * The platform setting an event changed. The audit names it by registry key; the settings read
 * keys a row by its A-13 alias (`BLOB_GC_GRACE_DAYS`) where it has one, so both are tried.
 */
export function settingOf(
  item: PlatformActivityItem,
  settings: Map<string, PlatformSetting>,
): PlatformSetting | undefined {
  if (item.target?.kind !== "setting") return undefined;
  for (const name of namesOf(item.target.id)) {
    const found = settings.get(name);
    if (found) return found;
  }
  return undefined;
}

/** The registry entry of the platform setting an event changed (client-side; no API). */
export function indexOf(item: PlatformActivityItem) {
  if (item.target?.kind !== "setting") return undefined;
  const key = item.target.id;
  return SETTINGS_INDEX.find(
    (e) => e.scope === "platform" && (e.key === key || e.aliases.includes(key)),
  );
}

/**
 * "Blob collector grace period changed": the setting's label and what was done to it, from the
 * loaded setting or the registry index. Other events keep the Worker's summary.
 */
export function titleOf(
  item: PlatformActivityItem,
  setting?: PlatformSetting,
): string | null {
  const label = setting?.label ?? indexOf(item)?.label;
  if (!label) return null;
  if (item.action === "platform.setting.set") return `${label} changed`;
  if (item.action === "platform.setting.revert") return `${label} reverted`;
  return null;
}

/** The Settings section an event's setting lives in, for "Where". */
export function areaOf(
  item: PlatformActivityItem,
  setting?: PlatformSetting,
): string | undefined {
  return setting?.area ?? indexOf(item)?.area;
}
