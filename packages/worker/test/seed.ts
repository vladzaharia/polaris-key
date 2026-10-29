/// <reference types="@cloudflare/workers-types" />
import { insertSchema } from "../src/services/config/schemaStore.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { insertKey, insertLicense } from "../src/core/licensing/store.js";
import {
  insertProduct,
  insertProductKey,
  upsertProductSecret,
} from "../src/core/products/store.js";
import { hashKey, mintLicenseKey } from "../src/platform/crypto.js";
import { seal } from "../src/platform/keyvault.js";
import { parseServices } from "../src/core/services.js";
import { readIdentityIssuance } from "../src/core/accounts/identityTrust.js";
import { asR2, R2Mock } from "./r2Mock.js";
import { KvMock, asKv } from "./kvMock.js";
import { makeRlNamespace } from "./rlMock.js";
import { makeSingleUseNamespace } from "./singleUseMock.js";
import {
  CloudSyncNamespaceMock,
  asCloudSyncNamespace,
} from "./cloudSyncDoMock.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// The committed Polaris Key test signing key (pkey-test-prod-2026) from the conformance corpus.
export const TEST_KID = "pkey-test-prod-2026";
export const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
export const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

// The test platform KEK: base64 of 32 zero bytes. Imports as a raw AES-256-GCM key; used to
// seal TEST_PEM into the product_keys row that Product.signingKey() opens.
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
 *  signing keys are sealed in D1 under the test KEK. `BLOBS` is an empty bucket: the erasure
 *  fence (`core/accounts/erasureFence.ts`) reads the ledger on every request that acts as an
 *  account and fails closed with no bucket, so an env that omits it models a deploy that refuses
 *  those requests. A test that needs another bucket (or none) sets or deletes `env.BLOBS`. */
export function makeEnv(kv: KvMock, _slugs?: string[]): Env {
  const env: Record<string, unknown> = {
    HOT: asKv(kv),
    DB: undefined,
    RL: makeRlNamespace(),
    SINGLE_USE: makeSingleUseNamespace(),
    // The store hooks (merge, delete, export, size) reach the person's object (U-05.7).
    CLOUD_SYNC: asCloudSyncNamespace(new CloudSyncNamespaceMock()),
    PLATFORM_KEK: TEST_KEK,
    BLOBS: asR2(new R2Mock()),
    // LG-1: the launch gates are on here, so the v0.10.0 routes keep their tests; the gate tests
    // (test/core/settings/launchGates.test.ts) switch one off.
    LAUNCH_IDENTITY_EXCHANGE: "on",
    LAUNCH_CONNECT: "on",
    LAUNCH_SYNC_E2E: "on",
    LAUNCH_RELAY: "on",
    LAUNCH_IDENTITY_NEARBY: "on",
  };
  return env as Env;
}

export async function seedProduct(
  db: Db,
  slug: string,
  opts: { catalog?: unknown; beforeMigration0106?: boolean } = {},
): Promise<void> {
  const row = {
    slug,
    name: slug,
    signing_kid: TEST_KID,
    signing_pub: TEST_PUB,
    compat_min: "0.0.0",
    compat_max: "99.0.0",
    default_max_offline_days: 30,
    default_device_limit: 5,
    admin_group: null,
    release_source: null,
    created_at: NOW,
    modified_at: NOW,
  };
  if (opts.beforeMigration0106) {
    // A database cut before 0106 has no `presentation_json` column (the migration tests that seed
    // an older schema): insertProduct always names it.
    await db.run(
      `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
         default_max_offline_days, default_device_limit, admin_group, release_source,
         created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.slug,
      row.name,
      row.signing_kid,
      row.signing_pub,
      row.compat_min,
      row.compat_max,
      row.default_max_offline_days,
      row.default_device_limit,
      row.admin_group,
      row.release_source,
      row.created_at,
      row.modified_at,
    );
  } else {
    await insertProduct(db, row);
  }
  // KEK-custody: seal TEST_PEM under the constant TEST_KEK and insert the active product key
  // that `Product.signingKey()` opens on demand.
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
    revoked_at: null,
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
 *  edge-mint tests: the recipe's `signing_key_secret` is now a product_secrets NAME. `usage`
 *  is written as given (`"edge-mint"` for key material a recipe may sign with, P0-12); omitted,
 *  a new secret is general. */
export async function seedProductSecret(
  db: Db,
  slug: string,
  name: string,
  value: string,
  usage?: "edge-mint" | null,
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
    ...(usage !== undefined ? { usage } : {}),
    created_at: NOW,
    modified_at: NOW,
  });
}

/**
 * Approve an edge-mint recipe exactly as it is currently stored — what an operator's
 * `POST …/config/mint/<id>/approve` records (P0-12), including the product's sign-in trust as it
 * stands now. Tests that exercise SIGNING call this after seeding the recipe; tests of the
 * approval gate itself go through the admin API instead.
 */
export async function approveEdgeMintRecipe(
  db: Db,
  slug: string,
  id: string,
  opts: { acknowledgeOpenRegistration?: boolean } = {},
): Promise<void> {
  const row = await db.first<{ services_json: string | null }>(
    "SELECT services_json FROM products WHERE slug = ?",
    slug,
  );
  const services = parseServices(row?.services_json ?? null).services;
  const identity = await readIdentityIssuance(db, { slug, services });
  await db.run(
    `INSERT OR REPLACE INTO edge_mint_approvals
       (product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience,
        requires, required_entitlement,
        open_registration_acknowledged, license_enabled, identity_enabled, oidc_provider,
        oidc_issuer, oidc_client_id, oidc_group_role_map_json, approved_at, approved_by)
     SELECT product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds,
            audience, requires, required_entitlement, ?, ?, ?, ?, ?, ?, ?, ?, 'test'
       FROM edge_mint_config WHERE product = ? AND id = ?`,
    opts.acknowledgeOpenRegistration ? 1 : 0,
    services.license.enabled ? 1 : 0,
    identity.enabled ? 1 : 0,
    identity.provider,
    identity.issuer,
    identity.clientId,
    identity.groupRoleMapJson,
    NOW,
    slug,
    id,
  );
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

/**
 * One deliverable's `dist_access` row, as an operator sets it under Distribution → Access
 * (P4-05). Shared by the pack-transport suite and the `packs-chunk-range` transcript (P4-32).
 */
export async function setDeliverableAccess(
  db: Db,
  product: string,
  deliverable: string,
  mode: string,
  entitlement: string | null = null,
  now: number = NOW,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
     VALUES (?, ?, ?, ?, 'admin', ?)
     ON CONFLICT (product, deliverable_id) DO UPDATE SET
       mode = excluded.mode, entitlement = excluded.entitlement`,
    product,
    deliverable,
    mode,
    entitlement,
    now,
  );
}

/** What `stagePackObjects` seeds: anything with an R2Mock-style `seed`. */
export interface StagingBucket {
  seed(
    key: string,
    bytes: Uint8Array,
    opts?: { withSha256?: boolean },
  ): unknown;
}

/**
 * Stage `objects` for pack `deliverable` the way CI does (P4-02): an upload ticket from
 * `POST /<p>/release/publish/uploads`, the bytes put under the ticket's staging prefix, then a
 * `POST /<p>/release/publish/stage` round, which promotes them and earns `pack-upload` refs.
 * `post(path, body)` sends one authenticated CI call to `/release/publish/<path>`. Shared by
 * the pack-transport suite and the `packs-chunk-range` transcript (P4-32).
 */
export async function stagePackObjects(
  post: (path: string, body: unknown) => Promise<Response>,
  bucket: StagingBucket,
  deliverable: string,
  objects: readonly { bytes: Uint8Array; sha256: string }[],
  gated = false,
): Promise<void> {
  const unique = [...new Map(objects.map((o) => [o.sha256, o])).values()];
  const up = await post("uploads", {
    objects: unique.map((o) => ({
      sha256: o.sha256,
      size: o.bytes.length,
      gated,
    })),
  });
  if (up.status !== 200)
    throw new Error(`stage: uploads ${up.status} ${await up.text()}`);
  const body = (await up.json()) as { ticket: string; prefix: string };
  for (const o of unique)
    bucket.seed(`${body.prefix}${o.sha256}`, o.bytes, { withSha256: true });
  const res = await post("stage", { ticket: body.ticket, deliverable });
  if (res.status !== 200)
    throw new Error(`stage: stage ${res.status} ${await res.text()}`);
}

/**
 * ST-14: set a product's Polaris Locker switches (`portal.enabled`, `portal.keyReissue`,
 * `identity.keyEntry.claimByKey`) as the `product_settings` rows `writeSetting()` leaves for a
 * console write, without the audit around them. A switch left out is untouched.
 */
export async function setPortalToggles(
  db: Db,
  product: string,
  toggles: {
    portalEnabled?: boolean;
    keyReissueEnabled?: boolean;
    claimByKey?: boolean;
  },
  at: number = NOW,
): Promise<void> {
  const rows: [string, boolean | undefined][] = [
    ["portal.enabled", toggles.portalEnabled],
    ["portal.keyReissue", toggles.keyReissueEnabled],
    ["identity.keyEntry.claimByKey", toggles.claimByKey],
  ];
  for (const [key, value] of rows) {
    if (value === undefined) continue;
    await db.run(
      `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
       VALUES (?, ?, ?, 'console', 1, ?, 'test')
       ON CONFLICT(product, key) DO UPDATE SET value_json = excluded.value_json,
         source = 'console', updated_at = excluded.updated_at`,
      product,
      key,
      JSON.stringify(value),
      at,
    );
  }
}

/** I-09: set a product's `identity.keyEntry.claimByKey` (a settings row since ST-14). */
export async function setClaimByKey(
  db: Db,
  product: string,
  on: boolean,
  at: number = NOW,
): Promise<void> {
  await setPortalToggles(db, product, { claimByKey: on }, at);
}

/**
 * ST-11: a product's operator-only artifact policy is its `update.operatorPolicy`
 * `product_settings` row (the old `release_config.operator_policy_json` column is not read).
 */
export async function seedOperatorPolicy(
  db: Db,
  product: string,
  json: string | null | undefined,
): Promise<void> {
  if (!json) return;
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
     VALUES (?, 'update.operatorPolicy', ?, 'console', 1, 0, 'test')
     ON CONFLICT(product, key) DO UPDATE SET value_json = excluded.value_json`,
    product,
    json,
  );
}
