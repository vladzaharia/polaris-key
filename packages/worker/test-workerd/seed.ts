/// <reference types="@cloudflare/workers-types" />
// Workerd-safe seeding for the smoke lane.
//
// `test/seed.ts` cannot be reused: it reads `products/djdl/catalog.json` with `node:fs` at
// module scope, and there is no filesystem inside an isolate. Everything else here is the
// same shape (and the same committed test key) as the Node lane, so a divergence between the
// two lanes is a divergence in the runtime, not in the fixtures.

import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import {
  insertKey,
  insertLicense,
  insertProduct,
  insertProductKey,
  insertSchema,
} from "../src/repo.js";
import { hashKey, mintLicenseKey } from "../src/crypto.js";
import { seal } from "../src/keyvault.js";

/** The committed Polaris Key test signing key (pkey-test-prod-2026), as in `test/seed.ts`. */
export const TEST_KID = "pkey-test-prod-2026";
export const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
export const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

export const NOW = 1_700_000_000;

/** Seed a product, its sealed Ed25519 signing key, and an active catalog. */
export async function seedProduct(
  env: Env,
  db: Db,
  slug: string,
  catalog: unknown,
): Promise<void> {
  await insertProduct(db, {
    slug,
    name: slug,
    signing_kid: TEST_KID,
    signing_pub: TEST_PUB,
    compat_min: "0.0.0",
    compat_max: "99.0.0",
    default_max_offline_days: 30,
    default_device_limit: 5,
    admin_group: null,
    branding_json: null,
    release_source: null,
    created_at: NOW,
    modified_at: NOW,
  });
  // AES-GCM seal under PLATFORM_KEK, opened again by `loadProduct` on every request. This is
  // WebCrypto, so it is one of the paths worth proving in the real runtime.
  const encPrivate = await seal(env, TEST_PEM, {
    product: slug,
    kind: "signing-key",
    id: TEST_KID,
  });
  await insertProductKey(db, {
    product: slug,
    kid: TEST_KID,
    alg: "Ed25519",
    public_b64url: TEST_PUB,
    enc_private_json: encPrivate,
    status: "active",
    created_at: NOW,
    rotated_at: null,
  });
  await insertSchema(db, {
    product: slug,
    catalog_version: 1,
    catalog_json: JSON.stringify(catalog),
    active: 1,
    created_at: NOW,
  });
}

/** Insert an active license + a fresh key; returns the raw key to activate with. */
export async function seedLicenseWithKey(
  db: Db,
  slug: string,
): Promise<{ licenseId: string; key: string }> {
  const licenseId = `lic_${slug}_1`;
  await insertLicense(db, {
    product: slug,
    id: licenseId,
    status: "active",
    sub: null,
    name: "Ada Lovelace",
    email: "ada@example.com",
    groups_json: null,
    tier_id: null,
    activated_at: NOW,
    expires_at: null,
    max_offline_days: null,
    overrides_json: JSON.stringify({
      config: {},
      secrets: {},
      entitlements: {},
    }),
    channels_json: null,
    min_version: null,
    max_version: null,
    modified_by: null,
    modified_at: NOW,
  });
  const key = mintLicenseKey(slug);
  await insertKey(db, {
    product: slug,
    key_hash: await hashKey(key),
    license_id: licenseId,
    status: "active",
    label: null,
    created_at: NOW,
    created_by: null,
    last_used_at: null,
  });
  return { licenseId, key };
}
