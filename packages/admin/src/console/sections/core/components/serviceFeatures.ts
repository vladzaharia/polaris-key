/** Pure model for the Services page: the enabled set, the changes a switch asks for, and fact copy. */

import {
  SERVICE_ERROR_MESSAGES,
  type ServiceFeatureFacts,
  type ServiceSlug,
  type ServicesDryRun,
  type ServicesResponse,
  type UpdateServicesBody,
} from "../../../../api.js";
import {
  SERVICE_REQUIRES,
  SERVICE_SLUGS,
  type FeatureId,
  type FeatureRow,
  type FeatureSwitchRow,
} from "../../../../services.generated.js";
import { FEATURES, SERVICE_TABLE } from "../../../../services.generated.js";

export type Enabled = Record<ServiceSlug, boolean>;

export type ChangePhase = "dry-run" | "write";

export interface ServiceChange {
  feature: FeatureId;
  label: string;
  on: boolean;
  requested: readonly ServiceSlug[];
  body: UpdateServicesBody;
}

export interface PendingChange {
  change: ServiceChange;
  phase: ChangePhase;
}

export interface FailedChange {
  change: ServiceChange;
  phase: ChangePhase;
  error: unknown;
}

export interface OffConfirmation {
  change: ServiceChange;
  dryRun: ServicesDryRun;
}

/** What turning a service off does, in the docs' words (services-enablement). */
export const DISABLE_CONSEQUENCES: Record<ServiceSlug, string> = {
  license:
    "Licensing endpoints answer not-configured: no activation, license documents, or new device seats.",
  config:
    "Managed config endpoints answer not-configured: no config documents or minted tokens.",
  release: "Release’s truth store stops answering clients.",
  distribution:
    "Distribution stops serving downloads and no longer manages channels.",
  update: "The update feed answers not-configured: clients see no updates.",
  identity:
    "Sign-in through this product stops. Licenses stay attached to their owners’ accounts.",
  sync: "Cloud Sync stops: settings stay on each device and nothing syncs.",
  commerce: "Commerce’s endpoints answer not-found: no purchase claims.",
};

/** Play drops what Commerce cannot receive: the limits an operator has to beat when it is off. */
export const COMMERCE_OFF_LIMITS =
  "Store refunds do not land while it is off. Google Play retries notifications for 7 days and lists voided purchases for 31: turn it back on within them or those refunds are missed.";

/** The docs section that sets a storefront up. */
export const STOREFRONT_DOCS = "/docs/features/commerce/#setting-it-up";
export const SET_UP_STOREFRONT = "Set up a storefront";

/** The row's Attention state: store purchases are live but Commerce is off, so refunds miss. */
export function storeRefundsAttention(
  feature: FeatureRow,
  enabled: Enabled,
  facts: ServiceFeatureFacts,
): string | null {
  return feature.id === "commerce" &&
    enabled.license &&
    !enabled.commerce &&
    facts.commerce.storeGrants > 0
    ? "Store refunds are not landing while Commerce is off"
    : null;
}

export function readEnabled(data: ServicesResponse): Enabled {
  const enabled = {} as Enabled;
  for (const slug of SERVICE_SLUGS)
    enabled[slug] = data.services?.[slug]?.enabled === true;
  return enabled;
}

export function patchFor(
  slugs: readonly ServiceSlug[],
  enabled: boolean,
): UpdateServicesBody {
  const services: Partial<Record<ServiceSlug, { enabled: boolean }>> = {};
  for (const slug of slugs) services[slug] = { enabled };
  return { services };
}

export function mergeEnabled(
  enabled: Enabled,
  body: UpdateServicesBody,
): Enabled {
  if (!body.services) return enabled;
  const next = { ...enabled };
  for (const slug of SERVICE_SLUGS) {
    const patch = body.services[slug];
    if (patch) next[slug] = patch.enabled;
  }
  return next;
}

/** Requirements that an enable request would leave outside its own batch. */
export function unmetRequirements(
  slugs: readonly ServiceSlug[],
  enabled: Enabled,
): ServiceSlug[] {
  const inBatch = new Set(slugs);
  const missing = new Set<ServiceSlug>();
  for (const slug of slugs) {
    for (const requirement of SERVICE_REQUIRES[slug]) {
      if (!inBatch.has(requirement) && !enabled[requirement])
        missing.add(requirement);
    }
  }
  return SERVICE_SLUGS.filter((slug) => missing.has(slug));
}

/** The feature word an operator knows a service by: its feature's label, not its slug. */
export function featureWord(slug: ServiceSlug): string {
  if (slug === "update") return "In-app updates";
  const group = SERVICE_TABLE.find((row) => row.slug === slug)?.group;
  return FEATURES.find((f) => f.id === group)?.label ?? slug;
}

/** The id of the switch that turns the feature of `slug` on. */
export function featureSwitchId(slug: ServiceSlug): string {
  const group = SERVICE_TABLE.find((row) => row.slug === slug)?.group;
  return `feature-${group}-switch`;
}

/** "Sign-in and Cloud Sync", "A, B and C", in feature words, each once. */
export function listOf(slugs: readonly ServiceSlug[]): string {
  const names = [...new Set(slugs.map(featureWord))];
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function codeMessage(code: string): string {
  return (
    SERVICE_ERROR_MESSAGES[code] ??
    `The server refused this set (${code}). Refresh the page and try again.`
  );
}

export function signedInConsequence(signedIn: number): string | null {
  if (!signedIn) return null;
  return `${signedIn.toLocaleString("en-US")} signed-in device${signedIn === 1 ? "" : "s"} will be signed out; installs and licenses keep working.`;
}

export function factFor(
  feature: FeatureRow,
  facts: ServiceFeatureFacts,
): string | null {
  switch (feature.id) {
    case "licensing":
      return `${facts.licensing.tiers.toLocaleString("en-US")} ${facts.licensing.tiers === 1 ? "tier" : "tiers"} · ${facts.licensing.licenses.toLocaleString("en-US")} ${facts.licensing.licenses === 1 ? "license" : "licenses"}`;
    case "managed-config":
      return facts.managedConfig.catalogVersion === null
        ? "No published catalog"
        : `Catalog v${facts.managedConfig.catalogVersion} published`;
    case "ship-builds": {
      const latest = facts.shipBuilds.latest;
      return latest
        ? `${latest.version}${latest.channel ? ` on ${latest.channel}` : ""}`
        : "No app release yet";
    }
    case "commerce": {
      const n = facts.commerce.storefronts;
      return n > 0
        ? `${n} ${n === 1 ? "storefront" : "storefronts"} ready`
        : SET_UP_STOREFRONT;
    }
    default:
      return null;
  }
}

export function featureOn(feature: FeatureRow, enabled: Enabled): boolean {
  return feature.primary.every((slug) => enabled[slug]);
}

export function featureChange(feature: FeatureRow, on: boolean): ServiceChange {
  // Service switches are on by default when the feature is first enabled. Off asks the Worker to
  // turn off only the primary slugs; it returns the dependent service switches in `cascaded`.
  const requested = on ? feature.services : feature.primary;
  return {
    feature: feature.id,
    label: feature.label,
    on,
    requested,
    body: patchFor(requested, on),
  };
}

export function serviceChange(
  feature: FeatureRow,
  row: FeatureSwitchRow,
  on: boolean,
): ServiceChange {
  const service = row.service!;
  return {
    feature: feature.id,
    label: row.label,
    on,
    requested: [service],
    body: patchFor([service], on),
  };
}

/** The features a feature needs from outside itself, in service order, by their feature words. */
export function externalNeeds(feature: FeatureRow): ServiceSlug[] {
  const own = new Set(feature.services);
  const seen = new Set<string>();
  const out: ServiceSlug[] = [];
  for (const slug of feature.services)
    for (const need of SERVICE_REQUIRES[slug]) {
      const word = featureWord(need);
      if (own.has(need) || seen.has(word)) continue;
      seen.add(word);
      out.push(need);
    }
  return out;
}
