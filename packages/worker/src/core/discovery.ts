/// <reference types="@cloudflare/workers-types" />

import type { Db } from "../db/types.js";
import type { Product } from "./products.js";
import { loadPublicSigningKey, loadPublicSigningKeys } from "./products.js";
import { methodNotAllowed } from "./errors.js";
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

function baseUrl(req: Request, product: string): string {
  const url = new URL(req.url);
  return `${url.origin}/${product}`;
}

/** GET /<product>/.well-known/polaris.json — SDK-oriented product discovery. */
export async function handleDiscovery(
  req: Request,
  db: Db,
  product: Product,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();

  const url = new URL(req.url);
  const base = baseUrl(req, product.slug);
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
  const endpoints = {
    activate: `${base}/activate`,
    token: `${base}/token`,
    config: `${base}/config`,
    report: `${base}/config/report`,
    session: `${base}/session`,
    sessionLicense: `${base}/session/license`,
    authLogin: `${base}/auth/login`,
    authLogout: `${base}/auth/logout`,
    authDeviceStart: `${base}/auth/device/start`,
    authDevicePoll: `${base}/auth/device/poll`,
    schema: `${base}/schema`,
    jwks: jwksUrl,
    version: `${base}/version`,
    changelog: `${base}/changelog`,
    install: `${base}/install.sh`,
    appcast: `${base}/appcast.xml`,
  };
  const trustKeys = Object.fromEntries(
    verificationKeys.map((key) => [key.kid, key.publicKey]),
  );
  if (signingPublicKey && Object.keys(trustKeys).length === 0)
    trustKeys[signingKid] = signingPublicKey;

  const body = {
    version: 1,
    schemaVersion: product.schemaVersion,
    product: product.slug,
    slug: product.slug,
    name: product.name,
    baseUrl: url.origin,
    endpoints,
    trust: {
      jwksUrl,
      trustManifestUrl,
      cacheSeconds: 300,
      pinnedKeys: trustKeys,
      signingKid,
      signingPub: signingPublicKey,
    },
    modules: {
      auth: {
        activateUrl: endpoints.activate,
        tokenUrl: endpoints.token,
        oidc: oidc
          ? {
              enabled: true,
              startUrl: `${base}/auth/start`,
              loginUrl: `${base}/auth/login`,
              callbackUrl: `${base}/auth/callback`,
              pollUrl: `${base}/auth/poll`,
              deviceStartUrl: endpoints.authDeviceStart,
              devicePollUrl: endpoints.authDevicePoll,
              logoutUrl: `${base}/auth/logout`,
            }
          : { enabled: false },
      },
      browserSession: {
        sessionUrl: endpoints.session,
        licenseUrl: endpoints.sessionLicense,
        logoutUrl: endpoints.authLogout,
      },
      config: {
        documentUrl: endpoints.config,
        reportUrl: endpoints.report,
        schemaUrl: endpoints.schema,
        schemaVersion: product.schemaVersion,
        compat: {
          min: product.compatMin,
          max: product.compatMax,
        },
      },
      release: {
        enabled: Boolean(release),
        source: row?.release_source ?? "manual",
        versionUrl: endpoints.version,
        changelogUrl: endpoints.changelog,
        installUrl: endpoints.install,
        appcastUrl: endpoints.appcast,
        binaryName: release?.binary_name ?? product.slug,
        channels: release
          ? [
              "stable",
              "beta",
              ...parseManualChannels(release.manual_channels_json).map(
                (c) => c.name,
              ),
            ]
          : [],
        sparkleEd25519PublicKey: release?.sparkle_ed25519_pub ?? null,
        repository:
          release?.gh_owner && release.gh_repo
            ? { owner: release.gh_owner, name: release.gh_repo }
            : null,
      },
      signing: {
        jwksUrl,
        trustManifestUrl,
        cacheSeconds: 300,
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
    },
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}
