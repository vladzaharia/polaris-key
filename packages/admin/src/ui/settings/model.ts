/**
 * The settings engine's vocabulary (ST-07): what a registry setting is, what a change to it
 * needs, and how a value is worded. App-neutral (`ui/` imports no app module): the console's
 * product and platform settings are adapted to these shapes at their pages.
 *
 * One implementation of the two rules both settings scopes used to carry their own copy of:
 * the confirm level a change needs (the registry's `confirm`, per direction), and a value in words.
 */

import { formatCount, formatNumber } from "../../lib/format.js";

export type SettingLevel = "L0" | "L1" | "L2" | "L3";

/** A registry value spec, as the engine renders it. */
export type SettingSpec =
  | { kind: "switch" }
  | { kind: "boolean" }
  | { kind: "integer"; unit: string; min: number; max: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string"; pattern?: string; maxLength: number }
  | { kind: "list"; of: SettingSpec; max: number }
  | { kind: "json"; schema: string };

/** The confirm level per direction of change; `byValue` is the level for changing TO a value. */
export type SettingConfirm =
  | { up: SettingLevel; down: SettingLevel }
  | { on: SettingLevel; off: SettingLevel }
  | { change: SettingLevel }
  | { byValue: Record<string, SettingLevel> };

/** Display labels for enum values (the raw value is shown when absent). */
export type ValueLabels = Record<string, string>;

const MIB = 1_048_576;

/**
 * The confirm level for changing `from` to `to`. An unchanged value is `L0`. An ordered enum ranks
 * by its position in `values`; a value missing from `byValue` asks at `L1`.
 */
export function confirmLevel(
  spec: SettingSpec,
  confirm: SettingConfirm,
  from: unknown,
  to: unknown,
): SettingLevel {
  if (from === to) return "L0";
  if ("change" in confirm) return confirm.change;
  if ("byValue" in confirm) return confirm.byValue[String(to)] ?? "L1";
  if ("on" in confirm)
    return to === true || to === "on" ? confirm.on : confirm.off;
  const rank = (v: unknown): number =>
    spec.kind === "enum" ? spec.values.indexOf(String(v)) : Number(v);
  return rank(to) > rank(from) ? confirm.up : confirm.down;
}

/** A level's rank, for "at least this much". */
export const LEVEL_RANK: Record<SettingLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
};

/** The dialog intent a level asks for: L1 is a caution, L2 and L3 a danger. */
export function intentOf(
  level: SettingLevel,
): "neutral" | "caution" | "danger" {
  if (LEVEL_RANK[level] >= 2) return "danger";
  return level === "L1" ? "caution" : "neutral";
}

/** A value as the console shows it: "On", "30 days", "32 MiB", an enum's label. */
export function formatSettingValue(
  spec: SettingSpec,
  value: unknown,
  labels?: ValueLabels | { values?: ValueLabels },
): string {
  const map: ValueLabels | undefined =
    labels && "values" in labels
      ? (labels as { values?: ValueLabels }).values
      : (labels as ValueLabels | undefined);
  if (spec.kind === "boolean") return value === true ? "On" : "Off";
  if (spec.kind === "switch")
    return value === "on" ? "On" : value === "off" ? "Off" : String(value);
  if (spec.kind === "integer") {
    const n = Number(value);
    if (spec.unit === "bytes") return `${formatNumber(n / MIB, 2)} MiB`;
    if (spec.unit === "count") return formatCount(n);
    const unit =
      n === 1 && /^(days|hours|minutes|seconds)$/.test(spec.unit)
        ? spec.unit.slice(0, -1)
        : spec.unit;
    return `${formatCount(n)} ${unit}`;
  }
  if (spec.kind === "enum") return map?.[String(value)] ?? String(value);
  return JSON.stringify(value);
}

/** The number a field shows for a stored value: MiB for a byte size, the value otherwise. */
export function toField(spec: SettingSpec, value: number): number {
  return spec.kind === "integer" && spec.unit === "bytes"
    ? Math.round((value / MIB) * 10_000) / 10_000
    : value;
}

/** The stored value for what a field shows (the inverse of `toField`). */
export function fromField(spec: SettingSpec, value: number): number {
  return spec.kind === "integer" && spec.unit === "bytes"
    ? Math.round(value * MIB)
    : value;
}

/** The unit word on a field: "MiB" for bytes, the spec's unit otherwise, none for a count. */
export function fieldUnit(spec: SettingSpec): string | undefined {
  if (spec.kind !== "integer") return undefined;
  if (spec.unit === "bytes") return "MiB";
  return spec.unit === "count" ? undefined : spec.unit;
}

/** The message a draft fails with, or `null` when it can be saved. */
export function draftError(spec: SettingSpec, draft: unknown): string | null {
  if (spec.kind !== "integer") return null;
  if (typeof draft !== "number" || Number.isNaN(draft)) return "Enter a value.";
  const min = toField(spec, spec.min);
  const max = toField(spec, spec.max);
  const shown = toField(spec, draft);
  if (shown < min) return `Use ${formatNumber(min, 4)} or more.`;
  if (shown > max) return `Use ${formatNumber(max, 4)} or less.`;
  return null;
}

/** Equal by content: how a draft is told from the value in force. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The words a save asks with, by the kind of value it changes. */
export function saveCopy(
  label: string,
  spec: SettingSpec,
  to: unknown,
  labels?: ValueLabels,
): { title: string; confirmLabel: string } {
  const name = label.toLowerCase();
  const next = formatSettingValue(spec, to, labels);
  if (spec.kind === "switch" || spec.kind === "boolean") {
    const on = to === true || to === "on";
    const verb = on ? "Turn on" : "Turn off";
    return { title: `${verb} ${name}?`, confirmLabel: `${verb} ${name}` };
  }
  if (spec.kind === "enum")
    return {
      title: `Set ${name} to ${next.toLowerCase()}?`,
      confirmLabel: `Set to ${next.toLowerCase()}`,
    };
  return { title: `Change ${name} to ${next}?`, confirmLabel: `Save ${next}` };
}
