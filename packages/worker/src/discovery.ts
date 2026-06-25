/// <reference types="@cloudflare/workers-types" />

import type { Db } from "./db/types.js";
import type { Product } from "./product.js";
import { loadPublicSigningKey } from "./product.js";
import { methodNotAllowed } from "./http.js";
import { getProduct } from "./repo.js";
import { parseManualChannels } from "./release/channels.js";

interface OidcConfigRow {
  issuer: string | null;
  client_id: string | null;
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
    "SELECT issuer, client_id FROM oidc_config WHERE product = ?",
    product.slug,
  );
  const release = await db.first<ReleaseConfigRow>(
    `SELECT gh_owner, gh_repo, manual_channels_json, binary_name, sparkle_ed25519_pub
     FROM release_config WHERE product = ?`,
    product.slug,
  );
  const activeKey = await loadPublicSigningKey(db, product.slug);
  const signingKid = activeKey?.kid ?? product.signingKid;
  const signingPublicKey = activeKey?.publicKey ?? product.signingPub;
  const jwksUrl = `${base}/.well-known/jwks.json`;
  const endpoints = {
    enroll: `${base}/enroll`,
    token: `${base}/token`,
    config: `${base}/config`,
    report: `${base}/config/report`,
    subscribe: `${base}/config/subscribe`,
    schema: `${base}/schema`,
    jwks: jwksUrl,
    version: `${base}/version`,
    changelog: `${base}/changelog`,
    install: `${base}/install.sh`,
    appcast: `${base}/appcast.xml`,
  };
  const trustKeys = signingPublicKey ? { [signingKid]: signingPublicKey } : {};

  const body = {
    version: 1,
    schemaVersion: 1,
    product: product.slug,
    slug: product.slug,
    name: product.name,
    baseUrl: url.origin,
    endpoints,
    trust: {
      jwksUrl,
      pinnedKeys: trustKeys,
      signingKid,
      signingPub: signingPublicKey,
    },
    modules: {
      auth: {
        enrollUrl: endpoints.enroll,
        tokenUrl: endpoints.token,
        oidc:
          oidc?.issuer && oidc.client_id
            ? {
                issuer: oidc.issuer,
                clientId: oidc.client_id,
                startUrl: `${base}/auth/start`,
                callbackUrl: `${base}/auth/callback`,
                pollUrl: `${base}/auth/poll`,
              }
            : null,
      },
      config: {
        documentUrl: endpoints.config,
        reportUrl: endpoints.report,
        subscribeUrl: endpoints.subscribe,
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
        keys: signingPublicKey
          ? [
              {
                kid: signingKid,
                alg: "EdDSA",
                kty: "OKP",
                crv: "Ed25519",
                publicKey: signingPublicKey,
              },
            ]
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
