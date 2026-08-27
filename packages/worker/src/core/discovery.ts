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
 * ── THE THREE FRAGMENTS CORE STILL BUILDS ───────────────────────────────────────────────────
 *
 * Release, Update and Identity have no descriptors yet — they are carved in P2/P3. Their
 * fragments are therefore still built HERE, from the same rows the v2 document read, but they
 * are already nested under their service keys and already carry an honest `enabled`. The SHAPE
 * lands now so clients can be written against it; the producers move later, and when they do
 * this file loses three functions and gains nothing.
 *
 * Their `enabled` sources differ on purpose, and the difference is temporary:
 *
 *   release/update — `services_json`, the real authority. A product whose manifest does not
 *                    declare them reads `false` even if a `release_config` row exists, which is
 *                    the point: the row is configuration, not consent.
 *   identity       — the `oidc_config` row. Identity's routes are NOT yet gated by
 *                    `services_json` (P3 does that), so reporting `services.identity.enabled`
 *                    would tell every existing OIDC product that its working login is off. The
 *                    document must describe what answers, so until P3 it describes the row.
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
import { parseManualChannels } from "../release/channels.js";

interface OidcConfigRow {
  product: string;
}

interface ReleaseConfigRow {
  gh_owner: string | null;
  gh_repo: string | null;
  manual_channels_json: string | null;
  binary_name: string | null;
  sparkle_ed25519_pub: string | null;
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
  const release = await db.first<ReleaseConfigRow>(
    `SELECT gh_owner, gh_repo, manual_channels_json, binary_name, sparkle_ed25519_pub
     FROM release_config WHERE product = ?`,
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
    services[slug] = await fragmentFor(slug, ctx, registry, {
      row,
      oidc,
      release,
    });
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
  release: ReleaseConfigRow | null;
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
  switch (slug) {
    case "release":
      return ctx.product.services.release.enabled
        ? releaseFragment(ctx, rows)
        : DISABLED;
    case "update":
      return ctx.product.services.update.enabled
        ? updateFragment(ctx, rows)
        : DISABLED;
    case "identity":
      return rows.oidc ? identityFragment(ctx) : DISABLED;
    default:
      return DISABLED;
  }
}

/** The channels a client may ask for: the two built-ins plus whatever the product declared. */
function channelsOf(rows: LegacyRows): string[] {
  if (!rows.release) return [];
  return [
    "stable",
    "beta",
    ...parseManualChannels(rows.release.manual_channels_json).map(
      (c) => c.name,
    ),
  ];
}

/**
 * Release: the truth store's public face — where the software comes from and what it is called.
 *
 * Paths are the ones that answer TODAY, not the §R1 canonical ones: P2 moves `/changelog` under
 * `/release/` and `/install.sh` keeps a permanent alias. A discovery document that advertised
 * routes the running worker does not serve would be worse than one that is a phase behind.
 */
function releaseFragment(
  ctx: DiscoveryContext,
  rows: LegacyRows,
): Record<string, unknown> {
  const { base, product } = ctx;
  return {
    enabled: true,
    source: rows.row?.release_source ?? "manual",
    /** True once the product has GitHub coordinates; `enabled` without this is spec §2.2's
     *  "not-configured" state — consented to, nothing to serve yet. */
    configured: Boolean(rows.release),
    binaryName: rows.release?.binary_name ?? product.slug,
    channels: channelsOf(rows),
    repository:
      rows.release?.gh_owner && rows.release.gh_repo
        ? { owner: rows.release.gh_owner, name: rows.release.gh_repo }
        : null,
    endpoints: {
      changelog: `${base}/changelog`,
      install: `${base}/install.sh`,
    },
  };
}

/** Update: the FEED over Release's store (D-05) — appcast, version check, Sparkle key. */
function updateFragment(
  ctx: DiscoveryContext,
  rows: LegacyRows,
): Record<string, unknown> {
  const { base } = ctx;
  return {
    enabled: true,
    configured: Boolean(rows.release),
    channels: channelsOf(rows),
    sparkleEd25519PublicKey: rows.release?.sparkle_ed25519_pub ?? null,
    endpoints: {
      version: `${base}/version`,
      appcast: `${base}/appcast.xml`,
    },
  };
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
