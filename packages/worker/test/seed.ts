/// <reference types="@cloudflare/workers-types" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import {
  insertKey,
  insertLicense,
  insertProduct,
  insertProductKey,
  insertSchema,
  upsertProductSecret,
} from "../src/repo.js";
import { hashKey, mintLicenseKey } from "../src/crypto.js";
import { seal } from "../src/keyvault.js";
import { KvMock, asKv } from "./kvMock.js";
import { makeRlNamespace } from "./rlMock.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// The committed Polaris Key test signing key (pkey-test-prod-2026) from the conformance corpus.
export const TEST_KID = "pkey-test-prod-2026";
export const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
export const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

// The test platform KEK: base64 of 32 zero bytes. Imports as a raw AES-256-GCM key; used to
// seal TEST_PEM into the product_keys row that loadProduct now opens.
export const TEST_KEK = btoa("\0".repeat(32));

export const NOW = 1_700_000_000;

/**
 * A WELL-FORMED device token that was never minted (wire v3 §6: `pkeyt_` + 43 base64url chars).
 *
 * Used wherever a suite means "unknown credential". It matters that it is well-formed: since
 * `validateDeviceToken` now rejects a bad PREFIX before it hashes anything, a malformed string
 * would 401 without ever reaching the lookup, and every "unknown token" test would silently
 * become a second test of the shape gate. `RETIRED_DEVICE_TOKEN` is the deliberate opposite.
 */
export const UNKNOWN_DEVICE_TOKEN = `pkeyt_${"u".repeat(43)}`;

/** A `plrst_` token — the prefix Amendment A1 withdrew — for the tests that pin its refusal
 *  (wire v3 §8: the device principal carries exactly one prefix). */
export const RETIRED_DEVICE_TOKEN = `plrst_${"r".repeat(43)}`;

/** An Env whose KV is the mock, whose PLATFORM_KEK is the test KEK, and whose per-product
 *  signing keys are sealed in D1 under the test KEK. */
export function makeEnv(kv: KvMock, _slugs: string[]): Env {
  const env: Record<string, unknown> = {
    HOT: asKv(kv),
    DB: undefined,
    RL: makeRlNamespace(),
    PLATFORM_KEK: TEST_KEK,
  };
  return env as Env;
}

export async function seedProduct(
  db: Db,
  slug: string,
  opts: { catalog?: unknown } = {},
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
  // KEK-custody: seal TEST_PEM under the constant TEST_KEK and insert the active product key
  // that loadProduct opens.
  const encPrivate = await seal({ PLATFORM_KEK: TEST_KEK } as Env, TEST_PEM, {
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
  const catalog = opts.catalog ?? { schemaVersion: 1, entries: [] };
  await insertSchema(db, {
    product: slug,
    catalog_version: 1,
    catalog_json: JSON.stringify(catalog),
    active: 1,
    created_at: NOW,
  });
}

/** Seal `value` under the test KEK and upsert it into product_secrets as `name`. Used by
 *  edge-mint tests: the recipe's `signing_key_secret` is now a product_secrets NAME. */
export async function seedProductSecret(
  db: Db,
  slug: string,
  name: string,
  value: string,
): Promise<void> {
  const enc_value_json = await seal({ PLATFORM_KEK: TEST_KEK } as Env, value, {
    product: slug,
    kind: "product-secret",
    id: name,
  });
  await upsertProductSecret(db, {
    product: slug,
    name,
    enc_value_json,
    created_at: NOW,
    modified_at: NOW,
  });
}

/** The real djdl product catalog (from products/djdl/catalog.json) — used by tests that
 *  exercise handleConfig's catalog-driven validation against actual declared keys. */
export const DJDL_CATALOG: unknown = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "..", "products", "djdl", "catalog.json"),
    "utf8",
  ),
);

/** Seed a tier row (with optional admin channel/version policy). */
export async function seedTier(
  db: Db,
  slug: string,
  id: string,
  opts: {
    channels?: string[];
    minVersion?: string | null;
    maxVersion?: string | null;
    deviceLimit?: number | null;
    fingerprint?: string | null;
    expiryDays?: number | null;
  } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit,
       channels_json, min_version, max_version, policy_fingerprint, modified_by, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    slug,
    id,
    id,
    null,
    opts.expiryDays ?? null,
    opts.deviceLimit ?? null,
    opts.channels ? JSON.stringify(opts.channels) : null,
    opts.minVersion ?? null,
    opts.maxVersion ?? null,
    opts.fingerprint ?? null,
    null,
    NOW,
  );
}

/** Overwrite a product's fingerprint policy (per-product opt-out / default mode / probes). */
export async function setProductFingerprintPolicy(
  db: Db,
  slug: string,
  policy: unknown,
): Promise<void> {
  await db.run(
    "UPDATE products SET fingerprint_policy_json = ? WHERE slug = ?",
    policy === null ? null : JSON.stringify(policy),
    slug,
  );
}

/** Mint an additional key for an EXISTING license; returns the raw key. Distinct from
 *  seedLicenseWithKey, which creates a new license row. */
export async function seedKeyForLicense(
  db: Db,
  slug: string,
  licenseId: string,
): Promise<string> {
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
  return key;
}

/** Insert an active license + a fresh key; returns the raw key to activate with. */
export async function seedLicenseWithKey(
  db: Db,
  slug: string,
  opts: {
    id?: string;
    config?: Record<string, ManagedEntry>;
    secrets?: Record<string, ManagedEntry>;
    entitlements?: Record<string, ManagedEntry>;
    expiresAt?: number | null;
    tierId?: string | null;
    channels?: string[];
    minVersion?: string | null;
    maxVersion?: string | null;
  } = {},
): Promise<{ licenseId: string; key: string }> {
  const licenseId = opts.id ?? `lic_${slug}_1`;
  const overrides = {
    config: opts.config ?? {},
    secrets: opts.secrets ?? {},
    entitlements: opts.entitlements ?? {},
  };
  await insertLicense(db, {
    product: slug,
    id: licenseId,
    status: "active",
    sub: null,
    name: "Ada Lovelace",
    email: "ada@example.com",
    groups_json: null,
    tier_id: opts.tierId ?? null,
    activated_at: NOW,
    expires_at: opts.expiresAt ?? null,
    max_offline_days: null,
    overrides_json: JSON.stringify(overrides),
    channels_json: opts.channels ? JSON.stringify(opts.channels) : null,
    min_version: opts.minVersion ?? null,
    max_version: opts.maxVersion ?? null,
    modified_by: null,
    modified_at: NOW,
  });
  const key = mintLicenseKey(slug);
  const keyHash = await hashKey(key);
  await insertKey(db, {
    product: slug,
    key_hash: keyHash,
    license_id: licenseId,
    status: "active",
    label: null,
    created_at: NOW,
    created_by: null,
    last_used_at: null,
  });
  return { licenseId, key };
}

/** Build a request the worker handlers accept (cast across the node/workers Request types). */
export function mkReq(
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Request {
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request("https://key.plrs.im/x", init) as unknown as Request;
}
