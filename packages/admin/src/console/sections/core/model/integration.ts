/**
 * The Integration page's model (ST-41): the words, links and next step for ST-40's read model.
 * Pure. `sdk_version` in a sighting is client-supplied (unauthenticated), so nothing here turns it
 * into anything but text, and nothing treats it as more than "seen".
 */

import { SDK_IDS, type SdkId } from "@polaris-key/manifest/integration";
import type {
  IntegrationFeature,
  IntegrationFeatureId,
  IntegrationVerifiedOn,
  IntegrationView,
} from "../../../../api.js";
import type { DocsLinkKey } from "../../../../lib/docsLinks.js";
import { platformName } from "../../../../lib/vocab/platforms.js";
import { r } from "../../../routes.js";

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

/** The SDK to open on: the `sdk=` query, else the one seen most recently, else Node. */
export function defaultSdk(view: IntegrationView | undefined): SdkId {
  for (const s of view?.sightings ?? []) {
    const id = s.sdk.replace(/-server$/, "");
    if (isSdkId(id)) return id;
  }
  return "node";
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

/** Platforms the product has been seen on (any feature), for per-platform progress. */
export function seenPlatforms(view: IntegrationView): string[] {
  const set = new Set<string>();
  for (const s of view.sightings) set.add(s.platform);
  return [...set].sort((a, b) =>
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
): NextStep | null {
  if (!hasSigningKey)
    return { text: "Activate a signing key", to: r.keys(slug) };
  const blocked = view.features.find((f) => f.status === "blocked");
  if (blocked) {
    const missing = blocked.prerequisites.find((p) => !p.met);
    const info = prerequisiteInfo(missing?.id ?? "", slug);
    return { text: info.action, to: info.href };
  }
  const waiting = view.features.find((f) => f.status === "not_seen");
  if (waiting)
    return {
      text: `Add ${FEATURE_LABEL[waiting.id]} to your app`,
      to: r.integration(slug, { feature: waiting.id }),
    };
  return null;
}

export const featureOf = (
  view: IntegrationView,
  id: IntegrationFeatureId,
): IntegrationFeature | undefined => view.features.find((f) => f.id === id);
