/**
 * The Integration read model (ST-40, OB-04): for one product, per ENABLED feature, the console
 * prerequisites, the domain facts and where the feature is Verified.
 *
 * - Prerequisites and facts come from the services' integration contributors
 *   (`integrationContributions`, P0-19); a service that is off is absent.
 * - **Verified** is the feature's `services_ok` bit on an SDK sighting (`sightings.ts`), listed per
 *   SDK and platform, and shown only once the feature's prerequisites are met: an SDK that
 *   answered before the operator finished setting up does not count as setup complete.
 * - A server core's Verified is its `*-server` sighting's trust-manifest bit.
 * - The only facts that stand for a missing SDK request are domain facts a service reports (a
 *   package published from CI, in Release's contribution); the updater's first feed check
 *   waits on P2-11.
 * - `snippet` is the context the console feeds `renderSdkSetup` (`@polaris-key/manifest/integration`):
 *   the slug, the enabled services and the keys an app pins.
 *
 * Read-only; nothing here hides, skips or completes a step (`core.setup` is the operator's).
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { integrationContributions } from "../contributions.js";
import type {
  IntegrationContribution,
  IntegrationFact,
  IntegrationPrerequisite,
} from "../contributions.js";
import type { ServiceHooks } from "../hooks.js";
import type { ProductPublic } from "../products.js";
import { listVerificationProductKeys } from "../products/store.js";
import type { ServiceRegistry } from "../registry.js";
import { SERVICE_SLUGS, type ServiceSlug } from "../services.js";
import {
  SIGHTING_BITS,
  listSightings,
  type SightingNamespace,
  type SightingRow,
} from "./sightings.js";

/** The console's feature ids (`@polaris-key/manifest/integration` `INTEGRATION_FEATURES`). */
export const INTEGRATION_FEATURE_ROUTES = {
  licensing: { service: "license", namespace: "license" },
  config: { service: "config", namespace: "config" },
  identity: { service: "identity", namespace: "identity" },
  update: { service: "update", namespace: "update" },
  packs: { service: "distribution", namespace: "packs" },
  sync: { service: "sync", namespace: "sync" },
  commerce: { service: "distribution", namespace: "commerce" },
} as const satisfies Record<
  string,
  { service: ServiceSlug; namespace: SightingNamespace }
>;
export type IntegrationFeatureId = keyof typeof INTEGRATION_FEATURE_ROUTES;

export interface VerifiedOn {
  sdk: string;
  platform: string;
  arch: string;
  sdkVersion: string | null;
  lastOkAt: number | null;
}

export interface IntegrationFeatureView {
  id: IntegrationFeatureId;
  service: ServiceSlug;
  prerequisites: IntegrationPrerequisite[];
  /** The service's contributor failed; prerequisites are empty and do not block. */
  unavailable: boolean;
  facts: Record<string, IntegrationFact>;
  /** "verified" has at least one `verifiedOn`; "blocked" waits on a prerequisite. */
  status: "verified" | "not_seen" | "blocked";
  verifiedOn: VerifiedOn[];
}

export interface IntegrationView {
  product: string;
  now: number;
  snippet: {
    slug: string;
    services: ServiceSlug[];
    pins: Array<{ kid: string; publicKey: string }>;
  };
  features: IntegrationFeatureView[];
  /** The server lane: `*-server` sightings that fetched the trust manifest. */
  server: VerifiedOn[];
  /** Every SDK seen, newest first. */
  sightings: Array<{
    sdk: string;
    platform: string;
    arch: string;
    sdkVersion: string | null;
    firstSeenAt: number;
    lastSeenAt: number;
  }>;
  /** Any feature is Verified: the page may offer to hide itself. */
  verified: boolean;
}

const verifiedOn = (r: SightingRow): VerifiedOn => ({
  sdk: r.sdk,
  platform: r.platform,
  arch: r.arch,
  sdkVersion: r.sdkVersion,
  lastOkAt: r.lastOkAt,
});

const isServerSdk = (sdk: string): boolean => sdk.endsWith("-server");

export async function buildIntegrationView(o: {
  env: Env;
  db: Db;
  registry: ServiceRegistry;
  product: ProductPublic;
  hooks: ServiceHooks;
  now: number;
}): Promise<IntegrationView> {
  const { db, product, now } = o;
  const [contributions, sightings, keys] = await Promise.all([
    integrationContributions(
      o.registry,
      product.services,
      { env: o.env, db, product, now },
      o.hooks,
    ),
    listSightings(db, product.slug),
    listVerificationProductKeys(db, product.slug),
  ]);

  const features: IntegrationFeatureView[] = [];
  for (const [id, route] of Object.entries(INTEGRATION_FEATURE_ROUTES) as Array<
    [
      IntegrationFeatureId,
      (typeof INTEGRATION_FEATURE_ROUTES)[IntegrationFeatureId],
    ]
  >) {
    if (!product.services[route.service]?.enabled) continue;
    const c: IntegrationContribution | null | undefined =
      contributions[route.service];
    const prerequisites = c?.prerequisites ?? [];
    const met = prerequisites.every((p) => p.met);
    const bit = SIGHTING_BITS[route.namespace];
    const seen =
      met && c !== undefined
        ? sightings
            .filter((s) => !isServerSdk(s.sdk) && (s.servicesOk & bit) !== 0)
            .map(verifiedOn)
        : [];
    features.push({
      id,
      service: route.service,
      prerequisites,
      unavailable: c === null,
      facts: c?.facts ?? {},
      status: !met ? "blocked" : seen.length > 0 ? "verified" : "not_seen",
      verifiedOn: seen,
    });
  }

  return {
    product: product.slug,
    now,
    snippet: {
      slug: product.slug,
      services: SERVICE_SLUGS.filter((s) => product.services[s]?.enabled),
      pins: keys
        .filter((k) => k.status === "active" || k.status === "staged")
        .map((k) => ({ kid: k.kid, publicKey: k.public_b64url })),
    },
    features,
    server: sightings
      .filter(
        (s) => isServerSdk(s.sdk) && (s.servicesOk & SIGHTING_BITS.trust) !== 0,
      )
      .map(verifiedOn),
    sightings: sightings.map((s) => ({
      sdk: s.sdk,
      platform: s.platform,
      arch: s.arch,
      sdkVersion: s.sdkVersion,
      firstSeenAt: s.firstSeenAt,
      lastSeenAt: s.lastSeenAt,
    })),
    verified: features.some((f) => f.status === "verified"),
  };
}
