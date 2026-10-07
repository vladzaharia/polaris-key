/// <reference types="@cloudflare/workers-types" />

/**
 * `GET /<product>/.well-known/polaris.json` — registry-assembled product discovery
 * (design spec §4.3, wire contract v3).
 *
 * ── WHAT CHANGED, AND WHY IT IS A BREAK ─────────────────────────────────────────────────────
 *
 * The v2 document had a `modules` object that each surface re-derived its own way: `release`
 * was "enabled" if a `release_config` row existed, `oidc` if an `oidc_config` row did, and
 * `license`/`config` were unconditional because every product had them. That is exactly the
 * "four surfaces each re-infer enablement from row presence" problem spec §2.2 abolishes — the
 * document could say a service was on while its routes 404ed, or off while they answered.
 *
 * So `modules` is replaced by `services`, keyed by the service slugs, and every entry is a
 * projection of ONE authority:
 *
 *   - enabled  ⇒ the service's own `discoveryFragment` (design spec §4.3). Core does not know
 *                what a service publishes; it knows who to ask.
 *   - disabled ⇒ `{"enabled": false}` and NOTHING else. Not an empty endpoint list, not a
 *                populated block with a false flag: a client must not be able to read a
 *                disabled service's configuration out of a public document, and an operator
 *                must not be able to mistake "advertised" for "reachable".
 *
 * Pre-launch, so this is a clean replacement with no `modules` compatibility alias (§9).
 *
 * ── EVERY FRAGMENT IS NOW A DESCRIPTOR'S ────────────────────────────────────────────────────
 *
 * Identity was the last service Core still described on its behalf: while its routes answered
 * for any product with an `oidc_config` row, reporting `services.identity.enabled` would have
 * told working OIDC products that their login was off, so the fragment was built here, from the
 * row. The identity carve (P3) gates those routes on `services_json` like every other service,
 * so that exception is gone with it. This file now knows the shape of NO service: it asks the
 * registry, or answers `{"enabled":false}`.
 *
 * ── PRESENTATION (HA-12) ────────────────────────────────────────────────────────────────────
 *
 * `core.presentation` (WIRE-CONTRACT-V4 §5.5) is unsigned display data, resolved by
 * `core/presentation.ts`: the product's name, developer, accents and a hash-verifiable icon. It is
 * present only when something beyond the name resolves, so a product with nothing to show keeps
 * the document it had. No ETag is added (plans/HA-12.md Q4): `max-age=300` bounds how long a new
 * icon or accent takes to reach a device.
 */

import { PROTOCOL_VERSION } from "@polaris-key/protocol";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { Product } from "./products.js";
import { loadPublicSigningKey, loadPublicSigningKeys } from "./products.js";
import { methodNotAllowed } from "./errors.js";
import type { DiscoveryContext, ServiceRegistry } from "./registry.js";
import { buildHooks } from "./hooks.js";
import { resolvePresentation } from "./presentation.js";
import { SERVICE_SLUGS, type ServiceSlug } from "./services.js";

/** The discovery document's own `version` (a public, client-read field; not PROTOCOL_VERSION).
 *  Exported so the admin version endpoint (A-11) reports the same number. */
export const DISCOVERY_VERSION = 2;

/** The one fragment shape a disabled service gets, everywhere. */
const DISABLED = { enabled: false } as const;

export async function handleDiscovery(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  registry: ServiceRegistry,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();

  const url = new URL(req.url);
  const base = `${url.origin}/${product.slug}`;
  const activeKey = await loadPublicSigningKey(db, product.slug);
  const verificationKeys = await loadPublicSigningKeys(db, product.slug);
  const signingKid = activeKey?.kid ?? product.signingKid;
  const signingPublicKey = activeKey?.publicKey ?? product.signingPub;
  const jwksUrl = `${base}/.well-known/jwks.json`;
  const trustManifestUrl = `${base}/.well-known/polaris-trust.jws`;

  const trustKeys = Object.fromEntries(
    verificationKeys.map((key) => [key.kid, key.publicKey]),
  );
  if (signingPublicKey && Object.keys(trustKeys).length === 0)
    trustKeys[signingKid] = signingPublicKey;

  const ctx: DiscoveryContext = {
    product,
    env,
    db,
    base,
    hooks: buildHooks(registry, product.services, { env, db, product, now }),
  };
  // Keys in canonical table order — the order clients read. Every slug gets a fragment.
  const services = {} as Record<ServiceSlug, Record<string, unknown>>;
  for (const slug of SERVICE_SLUGS) {
    services[slug] = await fragmentFor(slug, ctx, registry);
  }
  const presentation = await resolvePresentation(ctx);

  const body = {
    version: DISCOVERY_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: product.schemaVersion,
    product: product.slug,
    slug: product.slug,
    name: product.name,
    baseUrl: url.origin,
    /**
     * Core's own surface: the always-on device/platform block (design spec §2.1). Everything
     * here answers whatever a product has enabled, including nothing.
     */
    core: {
      registration: product.registration,
      compat: { min: product.compatMin, max: product.compatMax },
      endpoints: {
        discovery: `${base}/.well-known/polaris.json`,
        jwks: jwksUrl,
        trustManifest: trustManifestUrl,
        devices: `${base}/devices`,
        report: `${base}/devices/report`,
        // Advertised only when the policy could ever say yes. Under `requires-license` the
        // endpoint answers a flat 403 to everyone, and publishing a URL that is defined never
        // to work is how a client ends up implementing a retry loop against a wall.
        ...(product.registration === "requires-license"
          ? {}
          : { register: `${base}/devices/register` }),
      },
      ...(presentation ? { presentation } : {}),
    },
    trust: {
      jwksUrl,
      trustManifestUrl,
      cacheSeconds: 300,
      pinnedKeys: trustKeys,
      signingKid,
      signingPub: signingPublicKey,
      keys: signingPublicKey
        ? verificationKeys.map((key) => ({
            kid: key.kid,
            alg: "EdDSA",
            kty: "OKP",
            crv: "Ed25519",
            publicKey: key.publicKey,
            status: key.status,
            active: key.status === "active",
          }))
        : [],
    },
    services,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}

/**
 * One service's fragment: the descriptor's when the product has enabled it, `{enabled:false}`
 * otherwise.
 *
 * A slug with no descriptor at all answers `{enabled:false}` too — a service Core cannot
 * describe is a service a client must not try — and it answers that whether or not the flag is
 * set, so an operator who enables a service this build does not mount sees "off" rather than a
 * fragment nothing will serve.
 */
async function fragmentFor(
  slug: ServiceSlug,
  ctx: DiscoveryContext,
  registry: ServiceRegistry,
): Promise<Record<string, unknown>> {
  const descriptor = registry.get(slug);
  if (!descriptor || !ctx.product.services[slug].enabled) return DISABLED;
  return descriptor.discoveryFragment(ctx);
}
