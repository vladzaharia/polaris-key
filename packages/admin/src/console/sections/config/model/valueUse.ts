/**
 * Allowed values removed in a draft, and who still holds one (docs/design/mockups
 * config.entry-setting-remove-value). The catalog usage read names who sets a key, never the value,
 * so holders are found by reading each one's own value.
 */

import type { ConfigEntry } from "../../../../api.js";
import { same } from "./mergeDraft.js";

const enumOf = (e: ConfigEntry | undefined): unknown[] | null => {
  const v = (e?.schema as Record<string, unknown> | undefined)?.enum;
  return Array.isArray(v) ? v : null;
};

/** The allowed values the published entry had and the draft's no longer lists. */
export function removedValues(
  base: ConfigEntry | undefined,
  entry: ConfigEntry,
): unknown[] {
  const before = enumOf(base);
  if (!before) return [];
  const after = enumOf(entry);
  // Dropping the list altogether allows everything: nothing is left on a disallowed value.
  if (!after) return [];
  return before.filter((v) => !after.some((a) => same(a, v)));
}

export interface ValueHolder {
  kind: "profile" | "license" | "account";
  id: string;
  /** What it is called. */
  label: string;
  value: unknown;
}

/** Whether `value` is one of `removed`. */
export const holdsRemoved = (value: unknown, removed: unknown[]): boolean =>
  removed.some((r) => same(r, value));

export const valueText = (v: unknown): string =>
  typeof v === "string" ? v : (JSON.stringify(v) ?? "");
