/**
 * Outlet capabilities (P2b-02, README §3.1): what an install that arrived through one outlet may
 * do. The security-relevant bits — `codeUpdates`, `downloadedScripts`, `commerce` — decide
 * whether an installed copy may fetch and run new code or sell things itself, so they are
 * OPERATOR-owned and never manifest-writable (the `requireSparkleSignature` precedent, R6-03):
 *
 *   - the starting point is this file's default table, per outlet KIND;
 *   - an operator may only NARROW it (`PUT …/distribution/outlets/<id>/capabilities`), and the
 *     narrowing is stored in `dist_outlets.capabilities_json` with `capabilities_source = 'admin'`;
 *   - `.pkey/distribution` cannot say anything about them at all
 *     (`capabilities_not_manifest_writable`), and no ingest writes either column.
 *
 * Reading back ALSO clamps (`effectiveCapabilities`): a stored override that is somehow wider
 * than today's default — a row written before a default was tightened, the kind changed by a
 * later push, a hand edit in the D1 console — answers with the narrower of the two, so the
 * server never widens past the compiled table (the rule P3-01's client applies too).
 *
 * The table is PROPOSED (P2b-02 brief). Once P3-01's `outlet-matrix.json` is approved it is the
 * source of truth, and this table must then match it.
 */

import type { OutletCapabilities } from "../../core/hooks.js";
import type { OutletKind } from "@polaris-key/manifest";

/** One outlet's capabilities, without the outlet id the hook adds. */
export type CapabilitySet = Omit<OutletCapabilities, "outletId">;
export type CapabilityKey = keyof CapabilitySet;

/** Every capability, in the order the console and the API list them. */
export const CAPABILITY_KEYS: readonly CapabilityKey[] = [
  "binaryUpdates",
  "codeUpdates",
  "dataUpdates",
  "channelSwitch",
  "commerce",
  "downloadedScripts",
];

/** Self-hosted outlets: the product updates itself, sells directly, and may hot-load code. */
const SELF_HOSTED: CapabilitySet = {
  binaryUpdates: "self",
  codeUpdates: true,
  dataUpdates: true,
  channelSwitch: true,
  commerce: "own",
  downloadedScripts: true,
};

/** Store outlets: the store owns binary updates; data only, no code, no channel switching. */
const STORE: CapabilitySet = {
  binaryUpdates: "store",
  codeUpdates: false,
  dataUpdates: true,
  channelSwitch: false,
  commerce: "store-iap",
  downloadedScripts: false,
};

/** Store-shaped outlets that leave commerce to the product. */
const STORE_OWN_COMMERCE: CapabilitySet = { ...STORE, commerce: "own" };

/** The default capabilities per outlet kind (README §3.1; P2b-02's proposed table). */
export const DEFAULT_CAPABILITIES: Readonly<Record<OutletKind, CapabilitySet>> =
  {
    direct: SELF_HOSTED,
    web: SELF_HOSTED,
    "app-store": STORE,
    testflight: STORE,
    play: STORE,
    "play-testing": STORE,
    "ms-store": STORE,
    steam: { ...STORE, commerce: "steam" },
    altstore: STORE_OWN_COMMERCE,
    "altstore-pal": STORE_OWN_COMMERCE,
    obtainium: STORE_OWN_COMMERCE,
    "fdroid-repo": STORE_OWN_COMMERCE,
    "app-installer": STORE_OWN_COMMERCE,
    itch: STORE_OWN_COMMERCE,
    flathub: STORE_OWN_COMMERCE,
    snap: STORE_OWN_COMMERCE,
    winget: STORE_OWN_COMMERCE,
  };

/** The default for a kind, or `null` for a kind this build does not know (fail closed). */
export function defaultCapabilities(kind: string): CapabilitySet | null {
  return Object.prototype.hasOwnProperty.call(DEFAULT_CAPABILITIES, kind)
    ? { ...DEFAULT_CAPABILITIES[kind as OutletKind] }
    : null;
}

/** `binaryUpdates`, widest first: `self` > `store` > `none` (notes/S-06 rule 2). */
const BINARY_RANK: Record<CapabilitySet["binaryUpdates"], number> = {
  self: 2,
  store: 1,
  none: 0,
};
const COMMERCE_VALUES: readonly CapabilitySet["commerce"][] = [
  "own",
  "store-iap",
  "steam",
  "none",
];

/**
 * Is `value` an allowed setting of `key`, given the `base` it narrows? Equal is allowed (a no-op
 * narrowing). `binaryUpdates` may move right along `self` > `store` > `none`; a boolean may go
 * from true to false; `commerce` may only become `none` (its other values are different
 * channels, not an order).
 */
export function narrows(
  key: CapabilityKey,
  value: unknown,
  base: CapabilitySet,
): boolean {
  switch (key) {
    case "binaryUpdates":
      return (
        typeof value === "string" &&
        Object.prototype.hasOwnProperty.call(BINARY_RANK, value) &&
        BINARY_RANK[value as CapabilitySet["binaryUpdates"]] <=
          BINARY_RANK[base.binaryUpdates]
      );
    case "commerce":
      return (
        typeof value === "string" &&
        COMMERCE_VALUES.includes(value as CapabilitySet["commerce"]) &&
        (value === base.commerce || value === "none")
      );
    case "codeUpdates":
    case "dataUpdates":
    case "channelSwitch":
    case "downloadedScripts":
      return typeof value === "boolean" && (value === base[key] || !value);
  }
}

/**
 * Check an operator's override against the default it narrows. `null` = acceptable; otherwise
 * the problem and the offending fields. An override is a partial map of capability → value.
 */
export function overrideProblem(
  base: CapabilitySet,
  override: unknown,
): { message: string; fields: string[] } | null {
  if (
    typeof override !== "object" ||
    override === null ||
    Array.isArray(override)
  )
    return { message: "capabilities must be an object", fields: [] };
  const entries = Object.entries(override as Record<string, unknown>);
  if (entries.length === 0)
    return {
      message:
        "send at least one capability to narrow; revert restores the default",
      fields: [],
    };
  const unknown = entries
    .map(([k]) => k)
    .filter((k) => !(CAPABILITY_KEYS as readonly string[]).includes(k));
  if (unknown.length)
    return {
      message: `unknown capabilities: ${unknown.join(", ")}`,
      fields: unknown,
    };
  const widened = entries
    .filter(([k, v]) => !narrows(k as CapabilityKey, v, base))
    .map(([k]) => k);
  if (widened.length)
    return {
      message:
        "capabilities can only be narrowed below this outlet kind's default (binaryUpdates self > store > none; a boolean to false; commerce to none)",
      fields: widened,
    };
  return null;
}

/**
 * The capabilities in force: the kind's default, narrowed by the stored override. Every override
 * field is re-checked against the default and IGNORED unless it narrows, so a bad or stale row can
 * only ever make the answer narrower, never wider.
 */
export function effectiveCapabilities(
  base: CapabilitySet,
  override: unknown,
): CapabilitySet {
  const out: CapabilitySet = { ...base };
  if (
    typeof override !== "object" ||
    override === null ||
    Array.isArray(override)
  )
    return out;
  for (const key of CAPABILITY_KEYS) {
    const value = (override as Record<string, unknown>)[key];
    if (value !== undefined && narrows(key, value, base))
      (out as Record<CapabilityKey, unknown>)[key] = value;
  }
  return out;
}
