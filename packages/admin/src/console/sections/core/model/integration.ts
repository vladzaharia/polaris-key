/**
 * The Integration page's model (ST-41): the words, links and next step for ST-40's read model.
 * Pure. `sdk_version` in a sighting is client-supplied (unauthenticated), so nothing here turns it
 * into anything but text, and nothing treats it as more than "seen".
 */

import {
  SDK_IDS,
  sdkFit,
  type FitPlatform,
  type SdkId,
  type UsageContext,
} from "@polaris-key/manifest/integration";
import type { ProductCatalog } from "@polaris-key/catalog";
import type {
  IntegrationFeature,
  IntegrationFeatureId,
  IntegrationVerifiedOn,
  IntegrationView,
} from "../../../../api.js";
import type { DocsLinkKey } from "../../../../lib/docsLinks.js";
import { platformName } from "../../../../lib/vocab/platforms.js";
import { r } from "../../../routes.js";
import { reviewHref } from "../../config/model/pending.js";

export const FEATURE_LABEL: Record<IntegrationFeatureId, string> = {
  licensing: "Licensing",
  config: "Managed config",
  identity: "Sign-in",
  update: "Updates",
  packs: "Content packs",
  sync: "Cloud Sync",
  commerce: "Commerce",
};

/** The console page that fixes a prerequisite, by the ids the services' contributors report. */
const PREREQ: Record<
  string,
  { label: string; href: (slug: string) => string; action: string }
> = {
  tiers: { label: "A tier", href: r.tiers, action: "Add a tier" },
  catalog: {
    label: "A published catalog",
    href: r.catalog,
    action: "Publish a catalog",
  },
  oidc: {
    label: "A sign-in provider",
    href: r.signIn,
    action: "Connect a provider",
  },
  release: { label: "A release", href: r.releases, action: "Add a release" },
  distribution: {
    label: "Distribution turned on",
    href: r.services,
    action: "Turn on Distribution",
  },
  outlets: { label: "A channel", href: r.outlets, action: "Add a channel" },
  repository: {
    label: "A linked repository",
    href: r.releases,
    action: "Link a repository",
  },
};

export function prerequisiteInfo(
  id: string,
  slug: string,
): { label: string; href: string; action: string } {
  const p = PREREQ[id];
  return p
    ? { label: p.label, href: p.href(slug), action: p.action }
    : { label: id, href: r.services(slug), action: "Open" };
}

/** The docs page for each SDK's kit and own-UI lanes (docsLinks.ts is the one table of links). */
export const SDK_DOC_KEYS: Record<
  SdkId,
  { customise: DocsLinkKey; ownUi: DocsLinkKey }
> = {
  node: { customise: "nodeCustomiseCli", ownUi: "nodeOwnUiCli" },
  react: { customise: "reactCustomise", ownUi: "reactOwnUi" },
  python: { customise: "pythonCustomise", ownUi: "pythonOwnUi" },
  swift: { customise: "swiftCustomise", ownUi: "swiftOwnUi" },
  kotlin: { customise: "kotlinCustomise", ownUi: "kotlinOwnUi" },
  godot: { customise: "godotCustomise", ownUi: "godotOwnUi" },
};

export const isSdkId = (v: string | null | undefined): v is SdkId =>
  (SDK_IDS as readonly string[]).includes(v ?? "");

const FIT_PLATFORMS: readonly string[] = [
  "web",
  "windows",
  "macos",
  "linux",
  "ios",
  "android",
  "godot",
  "server",
];

/** The platforms this product is known to run on: every one an SDK was seen or Verified on. */
export function knownPlatforms(view: IntegrationView | undefined): string[] {
  const set = new Set<string>();
  for (const s of view?.sightings ?? []) set.add(s.platform);
  for (const f of view?.features ?? [])
    for (const v of f.verifiedOn) set.add(v.platform);
  return [...set];
}

/**
 * The SDK to lead with, from `sdkFit` over the platforms the product was seen on, else the SDK
 * most recently seen, else none (the developer picks).
 */
export function fitSdk(view: IntegrationView | undefined): SdkId | null {
  const platforms = knownPlatforms(view).filter((p): p is FitPlatform =>
    FIT_PLATFORMS.includes(p),
  );
  for (const s of view?.sightings ?? []) {
    const id = s.sdk.replace(/-server$/, "");
    if (isSdkId(id)) return id;
  }
  return sdkFit(platforms).sdk;
}

export const defaultSdk = (view: IntegrationView | undefined): SdkId =>
  fitSdk(view) ?? "node";

/** The SDK tabs in order: the fit first, then the rest as the registry lists them. */
export function sdkOrder(view: IntegrationView | undefined): SdkId[] {
  const first = fitSdk(view);
  return first ? [first, ...SDK_IDS.filter((s) => s !== first)] : [...SDK_IDS];
}

/** What the catalog and release say about this product, for the snippets. */
export interface ProductNames {
  catalog: ProductCatalog | undefined;
  packIds: readonly string[];
}

/**
 * The snippets' names, from this product: its first flag, setting, secret, minted token and pack.
 * A name the product does not have yet is a visible placeholder, never another product's.
 */
export function usageContext(slug: string, n: ProductNames): UsageContext {
  const entries = n.catalog?.entries ?? [];
  const first = (pred: (e: (typeof entries)[number]) => boolean) =>
    entries.find(pred);
  const flags = entries.filter((e) => e.kind === "flag");
  const config = first((e) => e.kind === "config");
  const secret = first((e) => e.kind === "secret" && e.delivery !== "edgeMint");
  const mint = first((e) => e.kind === "secret" && e.delivery === "edgeMint");
  const d = config?.default;
  return {
    entitlement: flags[0]?.key ?? "<your-entitlement>",
    configKey: config?.key ?? "<your-setting>",
    configFallback:
      typeof d === "string" || typeof d === "number" || typeof d === "boolean"
        ? d
        : "<fallback>",
    secretKey: secret?.key ?? "<your-secret>",
    mintRecipe: mint?.key ?? "<your-recipe>",
    packId: n.packIds[0] ?? "<your-pack>",
    commerceFlag: flags[1]?.key ?? flags[0]?.key ?? "<your-flag>",
    appName: slug,
    appVersion: "<your-app-version>",
  };
}

export const platformLabel = (p: string): string => platformName(p);

/** One row per platform: the SDKs it ran, newest success first. */
export interface PlatformRow {
  platform: string;
  label: string;
  seen: IntegrationVerifiedOn[];
}

export function byPlatform(
  seen: readonly IntegrationVerifiedOn[],
): PlatformRow[] {
  const rows = new Map<string, IntegrationVerifiedOn[]>();
  for (const s of seen)
    rows.set(s.platform, [...(rows.get(s.platform) ?? []), s]);
  return [...rows.entries()]
    .map(([platform, list]) => ({
      platform,
      label: platformLabel(platform),
      seen: [...list].sort((a, b) => (b.lastOkAt ?? 0) - (a.lastOkAt ?? 0)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Platforms the product has been seen on or Verified on, by name. */
export function seenPlatforms(view: IntegrationView): string[] {
  return knownPlatforms(view).sort((a, b) =>
    platformLabel(a).localeCompare(platformLabel(b)),
  );
}

export interface Progress {
  total: number;
  verified: number;
}

export function progress(view: IntegrationView): Progress {
  return {
    total: view.features.length,
    verified: view.features.filter((f) => f.status === "verified").length,
  };
}

/** Per platform: how many of the features were Verified there. */
export function platformProgress(
  view: IntegrationView,
): Array<{ platform: string; label: string; verified: number; total: number }> {
  return seenPlatforms(view).map((platform) => ({
    platform,
    label: platformLabel(platform),
    total: view.features.length,
    verified: view.features.filter((f) =>
      f.verifiedOn.some((v) => v.platform === platform),
    ).length,
  }));
}

export interface NextStep {
  text: string;
  /** Why this is next, in a sentence. */
  reason: string;
  to: string;
}

/**
 * The one next step, computed from facts: a missing signing key, else the first feature waiting on
 * a prerequisite, else the first feature no app has called yet. None once all are Verified.
 */
export function nextStep(
  slug: string,
  view: IntegrationView,
  hasSigningKey: boolean,
  pending: readonly string[] = [],
): NextStep | null {
  if (!hasSigningKey)
    return {
      text: "Activate a signing key",
      reason: "No signing key is active, so nothing can be signed.",
      to: r.keys(slug),
    };
  if (pending.length > 0)
    return {
      text: pending.length === 1 ? "Review the recipe" : "Review the recipes",
      reason:
        "A minted token mints nothing until its recipe is approved as it stands.",
      to: reviewHref(slug, [...pending]),
    };
  const blocked = view.features.find((f) => f.status === "blocked");
  if (blocked) {
    const missing = blocked.prerequisites.find((p) => !p.met);
    const info = prerequisiteInfo(missing?.id ?? "", slug);
    return {
      text: info.action,
      reason: `${FEATURE_LABEL[blocked.id]} needs ${info.label.toLowerCase()} before an app can use it.`,
      to: info.href,
    };
  }
  const waiting = view.features.find((f) => f.status === "not_seen");
  if (waiting)
    return {
      text: `Add ${FEATURE_LABEL[waiting.id]} to your app`,
      reason: `No app has called ${FEATURE_LABEL[waiting.id]} yet.`,
      to: r.integration(slug, { feature: waiting.id }),
    };
  return null;
}

export const featureOf = (
  view: IntegrationView,
  id: IntegrationFeatureId,
): IntegrationFeature | undefined => view.features.find((f) => f.id === id);
