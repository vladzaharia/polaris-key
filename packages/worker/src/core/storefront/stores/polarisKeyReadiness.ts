/**
 * THE POLARIS KEY STOREFRONT'S READINESS CHECKLIST (PS-01; notes/S-21 §6.1, S-15 §8.1 step 2):
 * what must hold before listing a product on the portal does what the operator expects. Five
 * checks, each `pass`, `warn` (it works, with something the operator should know) or `fail` (it
 * will not show or cannot be added), with a reason in the console's voice.
 *
 * Pure: the caller (PS-06) reads the inputs — the product's portal flag, the fit report row for
 * `polaris-key`, the obtain paths PS-03 evaluates, the download page's actions and the tiers the
 * paths issue — and passes them in. Nothing here assumes how many licences or entitlements a path
 * grants (S-19 is open): a path names the tier it issues, or none.
 */

import type { FitStatus } from "../projection.js";

export type ReadinessState = "pass" | "warn" | "fail";

export type PolarisKeyCheckId =
  | "portal"
  | "listing"
  | "obtain-path"
  | "get-it"
  | "licence-tier";

export interface ReadinessCheck {
  readonly id: PolarisKeyCheckId;
  readonly state: ReadinessState;
  readonly reason: string;
}

/** A tier an obtain path issues, as the licence service reports it. */
export interface IssuedTier {
  /** The obtain path's kind (`group`, `auto_issue`, …). */
  readonly path: string;
  readonly tier: string;
  /** The tier is defined on the product. */
  readonly exists: boolean;
  /** Its device limit; null when it has none. */
  readonly deviceLimit: number | null;
}

export interface PolarisKeyReadinessInput {
  /** `portal_enabled` for the product. */
  readonly portalEnabled: boolean;
  /** The fit report's grade for `polaris-key` in the default locale; null when no listing exists. */
  readonly listingFit: FitStatus | null;
  /** The listing has its icon (the `presentation.icon` slot). */
  readonly hasIcon: boolean;
  /** The kinds of obtain path configured for the product (PS-03). */
  readonly obtainPaths: readonly string[];
  /** The operator's audience: only people who can add it, or everyone signed in (D5). */
  readonly audience: "eligible" | "everyone";
  /** What **Get it** can do on at least one platform. */
  readonly getIt: {
    readonly releaseDownloads: number;
    readonly storeLinks: number;
    readonly website: boolean;
  };
  /** The tiers the configured paths issue; empty when no path issues a licence. */
  readonly issuedTiers: readonly IssuedTier[];
}

function portal(i: PolarisKeyReadinessInput): ReadinessCheck {
  return i.portalEnabled
    ? {
        id: "portal",
        state: "pass",
        reason: "The portal is on for this product",
      }
    : {
        id: "portal",
        state: "fail",
        reason: "Turn the portal on for this product to show it on Polaris Key",
      };
}

function listing(i: PolarisKeyReadinessInput): ReadinessCheck {
  const id = "listing";
  if (i.listingFit === null)
    return {
      id,
      state: "fail",
      reason: "Add a name, an icon and a short description to the listing",
    };
  if (i.listingFit === "red")
    return {
      id,
      state: "fail",
      reason:
        "The listing needs a name and a short description that fit Polaris Key's limits",
    };
  if (!i.hasIcon)
    return { id, state: "fail", reason: "Add an icon to the listing" };
  if (i.listingFit === "amber")
    return {
      id,
      state: "warn",
      reason: "The listing fits, with warnings in the fit report",
    };
  return {
    id,
    state: "pass",
    reason: "The listing has a name, an icon and a short description",
  };
}

function obtainPath(i: PolarisKeyReadinessInput): ReadinessCheck {
  const id = "obtain-path";
  if (i.audience === "everyone")
    return {
      id,
      state: "warn",
      reason:
        "Everyone signed in sees this product, whether or not they can add it",
    };
  if (i.obtainPaths.length === 0)
    return {
      id,
      state: "fail",
      reason: "No one can add this product: configure an obtain path",
    };
  return {
    id,
    state: "pass",
    reason: `People can add it through ${i.obtainPaths.length === 1 ? "one obtain path" : `${i.obtainPaths.length} obtain paths`}`,
  };
}

function getIt(i: PolarisKeyReadinessInput): ReadinessCheck {
  const id = "get-it";
  const { releaseDownloads, storeLinks, website } = i.getIt;
  if (releaseDownloads > 0 || storeLinks > 0)
    return {
      id,
      state: "pass",
      reason: "Get it offers a download or a store link",
    };
  if (website)
    return {
      id,
      state: "warn",
      reason:
        "Get it opens the developer's website: there is no download or store link",
    };
  return {
    id,
    state: "fail",
    reason:
      "Get it has nothing to offer: publish a release, add a store link or a website",
  };
}

function licenceTier(i: PolarisKeyReadinessInput): ReadinessCheck {
  const id = "licence-tier";
  if (i.issuedTiers.length === 0)
    return { id, state: "pass", reason: "No obtain path issues a licence" };
  const missing = i.issuedTiers.find((t) => !t.exists);
  if (missing)
    return {
      id,
      state: "fail",
      reason: `The ${missing.path} path issues tier ${missing.tier}, which does not exist`,
    };
  const unlimited = i.issuedTiers.find(
    (t) => t.deviceLimit === null || t.deviceLimit < 1,
  );
  if (unlimited)
    return {
      id,
      state: "fail",
      reason: `Tier ${unlimited.tier}, issued by the ${unlimited.path} path, has no device limit`,
    };
  return {
    id,
    state: "pass",
    reason: "Every tier a path issues exists and has a device limit",
  };
}

/** The five checks, in the order the console shows them. */
export function polarisKeyReadiness(
  input: PolarisKeyReadinessInput,
): readonly ReadinessCheck[] {
  return [
    portal(input),
    listing(input),
    obtainPath(input),
    getIt(input),
    licenceTier(input),
  ];
}
