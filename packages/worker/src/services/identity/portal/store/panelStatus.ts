/**
 * The Polaris Key storefront as the console's panel reads it (PS-06; notes/S-21 §6.6): the
 * listing state, which obtain paths the product has configured and which of them the listing
 * offers now ("Who can see this?"), the mapped groups and their labels, and the readiness
 * checklist (PS-01's `polarisKeyReadiness`, S-21 §6.1).
 *
 * Identity's half of the first-party `status` port (`core/storefront/firstParty.ts`): the
 * listing, the policy and the engine's rules are Identity's own, and Distribution is read only
 * through its `delivery()` descriptor hook (rule 6). The one fact that hook does not carry, the
 * fit report's grade for `polaris-key`, comes from the caller, which reads it from Distribution's
 * listing model (`admin/handlers/polarisKeyStorefront.ts`).
 *
 * Operator-facing and product-scoped: nothing here reads an account. The engine's paths are
 * described from the POLICY (which groups are mapped, whether the product auto-issues, whether
 * it is open), never from who holds what.
 */

import type { Db, Env } from "../../../../core/platform.js";
import type { ProductPublic } from "../../../../core/products.js";
import type { Delivery } from "../../../../core/hooks.js";
import { getTier } from "../../../../core/data.js";
import { licenseTermsOf } from "../../../../core/entitlements.js";
import { polarisKeyStorefrontEnabled } from "../../../../core/storefrontSwitch.js";
import type { FitStatus } from "../../../../core/storefront/projection.js";
import {
  OBTAIN_PATH_KINDS,
  type GroupLabels,
  type ListingAudience,
  type ListingState,
  type ObtainPathKind,
} from "../../../../core/storefront/polarisKeyListing.js";
import {
  polarisKeyReadiness,
  type IssuedTier,
  type ReadinessCheck,
} from "../../../../core/storefront/stores/polarisKeyReadiness.js";
import { identityIssuePolicy } from "../../oidc.js";
import { presentationOf } from "../library.js";
import {
  getPortalProductSettings,
  storefrontIdentityEligible,
} from "../repo.js";
import { storefrontListing } from "../storefrontListing.js";
import { OBTAIN_PATH_ORDER, pathCounts } from "./obtain.js";

/** One group of the product's `groupRoleMap`, with the operator's label. */
export interface PolarisKeyGroupView {
  group: string;
  /** The tier a member's licence is minted on; `null` when the mapping names none. */
  tier: string | null;
  /** The operator's label (`storefront.polarisKey.groupLabels`), or `null`. */
  label: string | null;
}

/** The product's `oidcDefault` auto-issue: the tier every signed-in person may add. */
export interface PolarisKeyAutoIssue {
  tier: string;
  tierLabel: string | null;
  /** The tier's length in days, for "Free trial · 14 days"; `null` = lifetime. */
  expiryDays: number | null;
}

/** What the panel shows (`GET …/storefronts/polaris-key`). */
export interface PolarisKeyStatus {
  /** The deployment switch `storefront.polarisKey.enabled`. */
  enabled: boolean;
  /** The product's portal switch (`portal_enabled`). */
  portalEnabled: boolean;
  listing: {
    listed: ListingState;
    audience: ListingAudience;
    /** `null` = every kind (the operator never narrowed them). */
    offerPaths: ObtainPathKind[] | null;
    groupLabels: GroupLabels;
  };
  /**
   * The kinds whose policy is configured for the product, in `OBTAIN_PATH_KINDS` order: the
   * panel's "Ways to add" switches. A kind that is not configured is absent, never disabled.
   */
  available: ObtainPathKind[];
  /** The available kinds the listing offers now, in evaluation order: "Who can see this?". */
  active: ObtainPathKind[];
  /** Audience `everyone` on a `listed` product: everyone else signed in sees a link. */
  everyone: boolean;
  /** The platform issuer with auto-linking on: the identity paths can run here at all. */
  identityEligible: boolean;
  /** License runs for the product (the identity paths issue a licence). */
  licenseEnabled: boolean;
  groups: PolarisKeyGroupView[];
  autoIssue: PolarisKeyAutoIssue | null;
  readiness: readonly ReadinessCheck[];
}

export interface PolarisKeyStatusInput {
  env: Env;
  db: Db;
  product: ProductPublic;
  /** The product's Distribution hook, or `null` while Distribution is off. */
  delivery: Delivery | null;
  now: number;
  /**
   * The fit report's grade for `polaris-key` in the listing's default locale, read from
   * Distribution's listing model by the caller; `null` when the product has no listing.
   */
  listingFit: FitStatus | null;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

/** Identity's answer to the first-party `status` port (see the file comment). Reads only. */
export async function polarisKeyStatus(
  input: PolarisKeyStatusInput,
): Promise<PolarisKeyStatus> {
  const { env, db, product, delivery, now } = input;
  const settings = await getPortalProductSettings(db, product.slug);
  const listing = await storefrontListing(db, product.slug);
  const identityEligible = await storefrontIdentityEligible(db, product.slug);
  const licenseEnabled = product.services.license.enabled;
  const policy = await identityIssuePolicy(db, product);

  const identityRuns = identityEligible && licenseEnabled;
  const open =
    !licenseEnabled && delivery !== null && (await delivery.openAccess());
  const configured = new Set<ObtainPathKind>();
  if (identityRuns && policy.groups.length > 0) configured.add("group");
  if (identityRuns && policy.defaultTier !== null) configured.add("auto_issue");
  if (open) configured.add("open");
  const available = OBTAIN_PATH_KINDS.filter((k) => configured.has(k));
  const active = OBTAIN_PATH_ORDER.filter(
    (k) => configured.has(k) && pathCounts(listing, k),
  );

  const label = (group: string): string | null =>
    Object.prototype.hasOwnProperty.call(listing.groupLabels, group)
      ? (listing.groupLabels[group] ?? null)
      : null;
  const groups = policy.groups.map((g) => ({ ...g, label: label(g.group) }));

  const defaultTierRow =
    policy.defaultTier !== null
      ? await getTier(db, product.slug, policy.defaultTier)
      : null;
  const autoIssue: PolarisKeyAutoIssue | null =
    policy.defaultTier !== null
      ? {
          tier: policy.defaultTier,
          tierLabel: defaultTierRow?.label ?? null,
          expiryDays: defaultTierRow?.policy_expiry_days ?? null,
        }
      : null;

  // ── Readiness (S-21 §6.1, PS-01's checklist) ─────────────────────────────────────────────
  // Paths: what the listing offers in its mode; an unlisted product counts what it would offer
  // once listed, so the checklist says what listing it would do.
  const offered: readonly ObtainPathKind[] =
    listing.listed === "unlisted"
      ? available.filter((k) => listing.offerPaths.includes(k))
      : active;
  const manifestListing = delivery
    ? ((await delivery.listing()) as Record<string, unknown> | null)
    : null;
  const presentation = await presentationOf(
    env,
    db,
    product,
    manifestListing,
    "discover",
  );
  const downloads = await delivery?.customerDownloads?.({
    channel: "stable",
    limit: 1,
  });
  const issued: IssuedTier[] = [];
  if (offered.includes("group"))
    for (const g of policy.groups)
      if (g.tier !== null)
        issued.push(await issuedTier(db, product, "group", g.tier));
  if (offered.includes("auto_issue") && policy.defaultTier !== null)
    issued.push(
      await issuedTier(db, product, "auto_issue", policy.defaultTier),
    );
  const readiness = polarisKeyReadiness({
    portalEnabled: settings.portal_enabled === 1,
    listingFit: input.listingFit,
    hasIcon: presentation.iconUrl !== null,
    obtainPaths: [...offered],
    audience: listing.audience,
    getIt: {
      releaseDownloads:
        downloads?.releases.reduce((n, r) => n + r.files.length, 0) ?? 0,
      storeLinks: downloads?.stores.filter((s) => s.live).length ?? 0,
      website: nonEmpty(manifestListing?.website),
    },
    issuedTiers: issued,
  });

  return {
    enabled: await polarisKeyStorefrontEnabled(db),
    portalEnabled: settings.portal_enabled === 1,
    listing: {
      listed: listing.listed,
      audience: listing.audience,
      offerPaths: listing.offerPathsAll ? null : [...listing.offerPaths],
      groupLabels: listing.groupLabels,
    },
    available,
    active,
    everyone: listing.listed === "listed" && listing.audience === "everyone",
    identityEligible,
    licenseEnabled,
    groups,
    autoIssue,
    readiness,
  };
}

/** One tier a path issues: whether it exists, and the seat limit a licence on it would carry. */
async function issuedTier(
  db: Db,
  product: ProductPublic,
  path: ObtainPathKind,
  tier: string,
): Promise<IssuedTier> {
  const row = await getTier(db, product.slug, tier);
  return {
    path,
    tier,
    exists: row !== null,
    // The tier's own limit, else the product default a licence on it inherits.
    deviceLimit: row
      ? licenseTermsOf(null, row, product).deviceLimit.value
      : null,
  };
}
