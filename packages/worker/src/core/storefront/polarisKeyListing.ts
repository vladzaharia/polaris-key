/**
 * The Polaris Key storefront's listing state (PS-02, notes/S-21 §6.2 and owner decisions 2, 3, 5,
 * 10): the values of `storefront.polarisKey.{listed,audience,offerPaths,groupLabels}`, their
 * validation, and how one `portal_product_settings` row resolves to them.
 *
 * Pure and Core-owned so the settings registry (`core/settings/core.ts`) can name the same value
 * sets without importing a service (AGENTS.md rule 6). The database read is Identity's
 * (`services/identity/portal/storefrontListing.ts`), because `portal_product_settings` is
 * Identity's table.
 *
 *   - `listed`: `auto` (the default) reproduces today's Discover exactly; `listed` lets every
 *     obtain path list the product (PS-03); `unlisted` hides it everywhere in the portal while
 *     every policy keeps working.
 *   - `audience`: `eligible` shows the product only to a person who can obtain it now; `everyone`
 *     (level-2 confirmation) is the one deliberate exception to "no enumeration".
 *   - `offerPaths`: the obtain-path kinds the product offers; `null` (the default) means all of
 *     them, including kinds added later.
 *   - `groupLabels`: presentation only, `{<group>: <label ≤ 40>}`.
 *
 * Dual-read until PS-11: `discover_enabled = 0` (migration 0071) forces `unlisted`, whatever
 * `store_listed` says, so a Worker from before 0085 that turns Discover off is still obeyed.
 */

export const LISTING_STATES = ["auto", "listed", "unlisted"] as const;
export type ListingState = (typeof LISTING_STATES)[number];

export const LISTING_AUDIENCES = ["eligible", "everyone"] as const;
export type ListingAudience = (typeof LISTING_AUDIENCES)[number];

/**
 * Every obtain-path kind (S-21 §6.3, owner decision 4), in the order the packages build them,
 * which is also the order a stored `offerPaths` list is normalised to. PS-03 builds `group`,
 * `auto_issue` and `open`; `store_owned` (PS-07), `product_idp` (PS-08) and `email_domain` (PS-09)
 * follow their dependencies. The engine EVALUATES in a different order, ownership first and `open`
 * last: `OBTAIN_PATH_ORDER` in `services/identity/portal/store/obtain.ts`.
 */
export const OBTAIN_PATH_KINDS = [
  "group",
  "auto_issue",
  "open",
  "store_owned",
  "product_idp",
  "email_domain",
] as const;
export type ObtainPathKind = (typeof OBTAIN_PATH_KINDS)[number];

/** A group label's longest form ("Included with Aperture Seven"). */
export const GROUP_LABEL_MAX = 40;
/** A group name's longest form (the `groups` claim value it labels). */
export const GROUP_NAME_MAX = 200;
/** At most this many labelled groups per product. */
export const GROUP_LABELS_MAX = 100;

export type GroupLabels = Readonly<Record<string, string>>;

/** The resolved listing state of one product. */
export interface StorefrontListing {
  /** The effective state: `discover_enabled = 0` forces `unlisted` (dual-read until PS-11). */
  listed: ListingState;
  audience: ListingAudience;
  /** The kinds offered; every kind when `offerPathsAll`. */
  offerPaths: readonly ObtainPathKind[];
  /** True when the operator never narrowed the kinds (`store_offer_paths_json` is NULL). */
  offerPathsAll: boolean;
  groupLabels: GroupLabels;
}

/** The columns a listing resolves from (a `portal_product_settings` row, or its defaults). */
export interface ListingColumns {
  discover_enabled: number;
  store_listed: string | null | undefined;
  store_audience: string | null | undefined;
  store_offer_paths_json: string | null | undefined;
  store_group_labels_json: string | null | undefined;
}

export const DEFAULT_LISTING: StorefrontListing = {
  listed: "auto",
  audience: "eligible",
  offerPaths: OBTAIN_PATH_KINDS,
  offerPathsAll: true,
  groupLabels: {},
};

export function isListingState(v: unknown): v is ListingState {
  return (
    typeof v === "string" && (LISTING_STATES as readonly string[]).includes(v)
  );
}

export function isListingAudience(v: unknown): v is ListingAudience {
  return (
    typeof v === "string" &&
    (LISTING_AUDIENCES as readonly string[]).includes(v)
  );
}

export function isObtainPathKind(v: unknown): v is ObtainPathKind {
  return (
    typeof v === "string" &&
    (OBTAIN_PATH_KINDS as readonly string[]).includes(v)
  );
}

/**
 * A submitted offer-path list, normalised to `OBTAIN_PATH_KINDS` order without duplicates, or
 * `undefined` when it is not a list of known kinds. `null` is "all kinds" and passes through.
 */
export function parseOfferPaths(
  v: unknown,
): readonly ObtainPathKind[] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v) || !v.every(isObtainPathKind)) return undefined;
  const set = new Set<string>(v);
  return OBTAIN_PATH_KINDS.filter((k) => set.has(k));
}

/**
 * A submitted group-label map, with every label trimmed, or `undefined` when it is not an object
 * of non-empty group names (≤ 200) to non-empty labels (≤ 40), at most 100 of them.
 */
export function parseGroupLabels(v: unknown): GroupLabels | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > GROUP_LABELS_MAX) return undefined;
  const out: Record<string, string> = {};
  for (const [group, label] of entries) {
    if (group.length === 0 || group.length > GROUP_NAME_MAX) return undefined;
    // A label map is a plain object: an assignment to `__proto__` would be dropped, not stored.
    if (group === "__proto__") return undefined;
    if (typeof label !== "string") return undefined;
    const t = label.trim();
    if (t.length === 0 || t.length > GROUP_LABEL_MAX) return undefined;
    out[group] = t;
  }
  return out;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Resolve one row. A stored value that no longer parses (a hand edit) fails closed: `unlisted`,
 * no offer paths and no labels, never "all kinds".
 */
export function resolveListing(row: ListingColumns): StorefrontListing {
  // A missing column (a row read before migration 0085 ran) is the default; a value the CHECK
  // constraint would refuse fails closed to `unlisted`.
  const stored: ListingState =
    row.store_listed == null
      ? "auto"
      : isListingState(row.store_listed)
        ? row.store_listed
        : "unlisted";
  const listed: ListingState = row.discover_enabled === 0 ? "unlisted" : stored;
  const audience = isListingAudience(row.store_audience)
    ? row.store_audience
    : "eligible";

  let offerPaths: readonly ObtainPathKind[] = OBTAIN_PATH_KINDS;
  let offerPathsAll = true;
  if (row.store_offer_paths_json != null) {
    offerPathsAll = false;
    const parsed = parseJson(row.store_offer_paths_json);
    // Kinds this Worker does not know (written by a newer one) are dropped, not refused.
    offerPaths = Array.isArray(parsed)
      ? OBTAIN_PATH_KINDS.filter((k) => parsed.includes(k))
      : [];
  }

  let groupLabels: GroupLabels = {};
  if (row.store_group_labels_json != null)
    groupLabels =
      parseGroupLabels(parseJson(row.store_group_labels_json)) ?? {};

  return { listed, audience, offerPaths, offerPathsAll, groupLabels };
}
