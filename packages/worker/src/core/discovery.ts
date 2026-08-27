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
 * So `modules` is replaced by `services`, keyed by the five service slugs, and every entry is a
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
 * ── THE ONE FRAGMENT CORE STILL BUILDS ──────────────────────────────────────────────────────
 *
 * Identity has no descriptor yet — it is carved in P3 — so its fragment is still built HERE,
 * from the same `oidc_config` row the v2 document read, already nested under its service key.
 * The SHAPE lands now so clients can be written against it; the producer moves later, and when
 * it does this file loses a function and gains nothing.
 *
 * Its `enabled` source differs from the other four on purpose, and the difference is temporary:
 * Identity's routes are NOT yet gated by `services_json` (P3 does that), so reporting
 * `services.identity.enabled` would tell every existing OIDC product that its working login is
 * off. The document must describe what answers, so until P3 it describes the row.
 */

import { PROTOCOL_VERSION } from "@plrs/protocol";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { Product } from "./products.js";
import { loadPublicSigningKey, loadPublicSigningKeys } from "./products.js";
import { methodNotAllowed } from "./errors.js";
import type { DiscoveryContext, ServiceRegistry } from "./registry.js";
import { SERVICE_SLUGS, type ServiceSlug } from "./services.js";
import { getProduct } from "../repo.js";

interface OidcConfigRow {
  product: string;
}

/** The one fragment shape a disabled service gets, everywhere. */
const DISABLED = { enabled: false } as const;

export async function handleDiscovery(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  registry: ServiceRegistry,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();

  const url = new URL(req.url);
  const base = `${url.origin}/${product.slug}`;
  const row = await getProduct(db, product.slug);
  const oidc = await db.first<OidcConfigRow>(
    "SELECT product FROM oidc_config WHERE product = ?",
    product.slug,
  );
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

  const ctx: DiscoveryContext = { product, env, db, base };
  const services: Record<ServiceSlug, Record<string, unknown>> = {
    license: DISABLED,
    config: DISABLED,
    release: DISABLED,
    update: DISABLED,
    identity: DISABLED,
  };
  for (const slug of SERVICE_SLUGS) {
    services[slug] = await fragmentFor(slug, ctx, registry, { row, oidc });
  }

  const body = {
    version: 2,
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

interface LegacyRows {
  row: { release_source?: string | null } | null;
  oidc: OidcConfigRow | null;
}

/**
 * One service's fragment: the descriptor's if it has one, Core's stand-in if it does not, and
 * `{enabled:false}` if the product has not enabled it.
 *
 * A slug with no descriptor AND no stand-in cannot happen today, but if it ever does the answer
 * is `{enabled:false}` — a service Core cannot describe is a service a client must not try.
 */
async function fragmentFor(
  slug: ServiceSlug,
  ctx: DiscoveryContext,
  registry: ServiceRegistry,
  rows: LegacyRows,
): Promise<Record<string, unknown>> {
  const descriptor = registry.get(slug);
  if (descriptor) {
    return ctx.product.services[slug].enabled
      ? await descriptor.discoveryFragment(ctx)
      : DISABLED;
  }
  return slug === "identity" && rows.oidc ? identityFragment(ctx) : DISABLED;
}

/**
 * Identity: product OIDC plus the browser session it establishes.
 *
 * `/auth/login` is gone from the document even though the route still answers — §R1 removes it
 * as a redundant alias of `/auth/start`, and discovery is where a permanent alias stops being
 * advertised first.
 */
function identityFragment(ctx: DiscoveryContext): Record<string, unknown> {
  const { base } = ctx;
  return {
    enabled: true,
    endpoints: {
      session: `${base}/session`,
      sessionLicense: `${base}/session/license`,
      authStart: `${base}/auth/start`,
      authCallback: `${base}/auth/callback`,
      authPoll: `${base}/auth/poll`,
      authLogout: `${base}/auth/logout`,
      authDeviceStart: `${base}/auth/device/start`,
      authDeviceVerify: `${base}/auth/device/verify`,
      authDevicePoll: `${base}/auth/device/poll`,
    },
  };
}
