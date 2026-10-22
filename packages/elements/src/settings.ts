// The Settings pane's typed controls (UI-KITS.md §4.1: a switch for booleans, a slider for bounded
// numbers, a select for enums, text otherwise), decided once for both web renderers. No Lit, no DOM.

import type { ConfigRowInput } from "@polaris-key/ui-core";

/** A config row as the kit takes it: ui-core's row, which carries the catalog entry's `label`,
 *  `display`, `options`, `step` and `maxLength` when the adapter passes them. */
export type SettingsRow = ConfigRowInput;

/** Words a key spells in capitals when it is read as a label (ui.compact reads "UI compact"). */
const ACRONYMS: ReadonlySet<string> = new Set([
  "ui",
  "url",
  "uri",
  "id",
  "api",
  "cpu",
  "gpu",
  "fps",
  "hdr",
  "vr",
  "ar",
  "ip",
  "dns",
  "vpn",
  "usb",
  "tls",
  "ssl",
  "sdk",
  "os",
  "pc",
  "tv",
  "hdmi",
  "pin",
  "qr",
]);

/** A setting's name: the catalog entry's label, else its key read as words (`audio.volume` →
 *  "Audio volume"), never the raw key (DL8). */
export function settingLabel<T extends { key: string; label?: string }>(
  row: T,
): string {
  if (row.label?.trim()) return row.label.trim();
  const phrase = row.key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[._\-\s/:]+/)
    .filter(Boolean)
    .map((w) =>
      ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLocaleLowerCase(),
    )
    .join(" ");
  return phrase ? phrase[0]!.toLocaleUpperCase() + phrase.slice(1) : row.key;
}

export type SettingKind = "switch" | "slider" | "number" | "select" | "text";

/** The control a row is edited with (a locked row is read-only text, whatever its kind). */
export function settingKind(r: SettingsRow): SettingKind {
  if (typeof r.value === "boolean" || r.type === "boolean") return "switch";
  if (r.options && r.options.length > 0) return "select";
  if (r.type === "select") return "select";
  if (r.type === "number" || typeof r.value === "number")
    return typeof r.min === "number" && typeof r.max === "number"
      ? "slider"
      : "number";
  return "text";
}

/** A slider's step: the catalog's, else one for whole bounds, else a hundredth of the span. */
export function sliderStep(r: SettingsRow): number {
  if (typeof r.step === "number" && r.step > 0) return r.step;
  const { min, max } = r;
  if (typeof min !== "number" || typeof max !== "number") return 1;
  return Number.isInteger(min) && Number.isInteger(max) ? 1 : (max - min) / 100;
}

/** The value a row shows as text: the catalog's `display`, else the value as it is. */
export function settingText(r: SettingsRow): string {
  if (r.display !== undefined) return r.display;
  return r.value === undefined || r.value === null ? "" : String(r.value);
}

/** A number setting whose value is outside its range: Save waits until it is fixed. */
export function outOfRange(r: {
  type?: string;
  value?: unknown;
  min?: number;
  max?: number;
}): boolean {
  if (r.type !== "number" || typeof r.value !== "number") return false;
  return (
    Number.isNaN(r.value) ||
    (typeof r.min === "number" && r.value < r.min) ||
    (typeof r.max === "number" && r.value > r.max)
  );
}
