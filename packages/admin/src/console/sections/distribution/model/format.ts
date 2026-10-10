/**
 * Distribution vocabulary shared by the chunk 9 pages: labels for raw enums (ADMIN.md §5.8: every
 * raw value gets a label), the rollout summary, and the storefront feed URLs.
 */

import type { Rollout, RolloutVerb } from "../../../../api.js";
import { formatBasisPoints } from "../../../../lib/format.js";
import { label, outletLabel } from "../../../../lib/labels.js";
import { humanize, statusOf } from "../../../../lib/status.js";

/**
 * An outlet kind's name ("App Store", "Polaris Key" for `direct`), the raw kind humanised when
 * unknown; with a subkind, "Polaris Key · via Homebrew".
 */
export function outletKindLabel(kind: string, subkind?: string | null): string {
  return outletLabel(kind, subkind);
}

/** "Rolling out · 25 %", "Paused at 25 %", "Halted at 25 %", "Complete". */
export function rolloutSummary(
  r: Pick<Rollout, "state" | "rolloutBp">,
): string {
  const pct = formatBasisPoints(r.rolloutBp);
  switch (r.state) {
    case "active":
      return `Rolling out · ${pct}`;
    case "paused":
      return `Paused at ${pct}`;
    case "halted":
      return `Halted at ${pct}`;
    case "complete":
      return "Complete";
    default:
      return `${statusOf("rollout", r.state).label} · ${pct}`;
  }
}

/** Halted first, then paused, active, complete (the Rollouts page's default order). */
export const ROLLOUT_STATE_ORDER: Record<string, number> = {
  halted: 0,
  paused: 1,
  active: 2,
  complete: 3,
};

export const VERB_LABEL: Record<RolloutVerb, string> = {
  pause: "Pause",
  resume: "Resume",
  halt: "Halt",
  complete: "Complete",
};

export const VERB_DONE: Record<RolloutVerb, string> = {
  pause: "Paused",
  resume: "Resumed",
  halt: "Halted",
  complete: "Completed",
};

/** Who changed a rollout or a setting, in words (`admin:u1` → "admin u1", `ci:…` → "CI"). */
export function actorLabel(by: string | null | undefined): string {
  if (!by) return "—";
  if (by.startsWith("admin:")) return by.slice("admin:".length);
  if (
    by.startsWith("ci:") ||
    by.startsWith("static:") ||
    by.startsWith("repo:")
  )
    return "CI";
  if (by === "system" || by.startsWith("system:"))
    return "Polaris Key (auto-halt)";
  return by;
}

/** Where a rollout's state comes from (`admin`, `ci`, a connector kind). */
export const SOURCE_NAMES: Record<string, string> = {
  admin: "Console",
  ci: "CI",
  asc: "App Store Connect",
  play: "Google Play",
  "ms-store": "Microsoft Store",
  system: "Automatic",
  "auto-halt": "Auto-halt",
};

export function sourceLabel(source: string): string {
  return SOURCE_NAMES[source] ?? humanize(source);
}

/** Readiness states (P4-14) as the Matrix's Readiness view reads them. */
export const READINESS_LABEL: Record<string, string> = {
  ready: "Ready",
  blocked: "Not ready",
  pending: "Pending",
  overridden: "Ready (overridden)",
};

/**
 * The storefront feeds an outlet kind publishes (`docs/services/distribution/feeds.md`), each a
 * path under `/<product>/distribution/` per channel.
 */
export const FEED_KINDS: Record<
  string,
  { label: string; path: (channel: string) => string }
> = {
  altstore: {
    label: "AltStore source",
    path: (c) => `altstore/${c}/source.json`,
  },
  "altstore-pal": {
    label: "AltStore PAL source",
    path: (c) => `altstore-pal/${c}/source.json`,
  },
  obtainium: { label: "Obtainium config", path: (c) => `obtainium/${c}.json` },
  "fdroid-repo": {
    label: "F-Droid repository",
    path: (c) => `fdroid/${c}/repo`,
  },
  direct: { label: "Scoop manifest", path: (c) => `scoop/${c}.json` },
  flathub: { label: "Flathub checker", path: (c) => `flathub/${c}.json` },
};

/** The public URL of a product path on this deployment (`/<product>/…`). */
export function publicUrl(slug: string, path: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://";
  return `${origin}/${encodeURIComponent(slug)}/${path}`;
}

/** Capability values in words. */
export const CAPABILITY_LABEL: Record<string, string> = {
  binaryUpdates: "Binary updates",
  codeUpdates: "Code updates",
  dataUpdates: "Data updates",
  channelSwitch: "Channel switch",
  commerce: "Commerce",
  downloadedScripts: "Downloaded scripts",
};

export const CAPABILITY_HELP: Record<string, string> = {
  binaryUpdates:
    "Who installs a new build: the app itself, the store, or nobody.",
  codeUpdates: "The app may load new code (scripts, bytecode) at runtime.",
  dataUpdates: "The app may download content packs and data.",
  channelSwitch: "A user may move between channels (stable, beta).",
  commerce:
    "Who sells: your own checkout, the store's in-app purchase, or nobody.",
  downloadedScripts: "The app may run scripts it downloaded.",
};

export const BINARY_UPDATE_LABEL: Record<string, string> = {
  self: "The app updates itself",
  store: "The store updates it",
  none: "No updates",
};

export const COMMERCE_LABEL: Record<string, string> = {
  own: "Own checkout",
  "store-iap": "Store in-app purchase",
  none: "None",
};

/** The narrowing order: a value may only move right (WIRE-CONTRACT-V4 §8). */
export const BINARY_ORDER = ["self", "store", "none"] as const;

/** A capability value in words. */
export function capabilityValue(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "Allowed" : "Not allowed";
  if (key === "binaryUpdates") return label(BINARY_UPDATE_LABEL, String(value));
  if (key === "commerce") return label(COMMERCE_LABEL, String(value));
  return value === null || value === undefined ? "—" : String(value);
}
