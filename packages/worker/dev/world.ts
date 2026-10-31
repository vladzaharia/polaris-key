/**
 * The world `pkey dev` serves: the real Worker router over an in-memory database, KV and Durable
 * Object mocks, one registered product, throwaway signing and release keys, and a test key per
 * state. Nothing here is a Polaris Key route; the HTTP shell (`server.ts`) answers `/__dev/*` and
 * the fake IdP, and hands every other request to `dispatchWith`, the router production runs.
 */
import { createHash, randomBytes } from "node:crypto";
import { signJws } from "@polaris-key/jws";
import {
  descriptorToRecord,
  parseManifest,
  type ManifestDocumentName,
  type ReleaseDescriptor,
} from "@polaris-key/manifest";
import { dispatchWith } from "../src/dispatch.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { generateEd25519 } from "../src/platform/keyvault.js";
import { hashKey, mintLicenseKey } from "../src/platform/crypto.js";
import { insertKey, insertLicense } from "../src/core/licensing/store.js";
import { ingestFor } from "../src/core/ingest/pipeline.js";
import { SERVICES } from "../src/mount.js";
import { registerFromManifest } from "../src/services/release/linkRepo.js";
import { KvMock, asKv } from "../test/kvMock.js";
import { makeRlNamespace } from "../test/rlMock.js";
import { makeSingleUseNamespace } from "../test/singleUseMock.js";
import { NodeSqliteDb, openMemoryDb } from "./nodeSqlite.js";
import { MIGRATIONS } from "pkey-dev:migrations";
import {
  DEV_WEB_ORIGINS,
  tidewaterFiles,
  TIDEWATER_SLUG,
} from "./tidewater.js";

export const KEY_STATES = [
  "ok",
  "expired",
  "disabled",
  "revoked",
  "device-limit-full",
  "key-entry-limit",
  "floating",
] as const;
export type KeyState = (typeof KEY_STATES)[number];

const DAY = 86_400;
const now = (): number => Math.floor(Date.now() / 1000);
const b64 = (n: number): string => randomBytes(n).toString("base64");
const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

/** The key-entry limit the product runs with, and so how many entries `key-entry-limit` holds. */
const ENTRY_LIMIT = 3;
const FAKE_DEVICE_PREFIX = "DEVSEAT";

export interface WorldOptions {
  /** The origin the server answers on. */
  baseUrl: string;
  /** A unique public-looking fake IdP origin for this server. */
  idpOrigin: string;
  /** `.pkey/` documents from the working directory; absent: the built-in Tidewater product. */
  manifest?: Partial<Record<ManifestDocumentName, string>>;
}

export interface Pins {
  kid: string;
  publicKey: string;
}

export interface World {
  readonly product: string;
  readonly name: string;
  readonly services: string[];
  readonly baseUrl: string;
  readonly trust: Record<string, string>;
  readonly releaseKeys: Record<string, string>;
  readonly keys: Record<KeyState, string>;
  readonly webOrigins: string[];
  readonly idp: IdpFacts;
  readonly notes: string[];
  releases(): Array<{ version: string; channel: string }>;
  /** The router: one request, the clock read now. */
  handle(req: Request): Promise<Response>;
  /** Control commands. Each answers one line. */
  expire(target: string): Promise<string>;
  disable(target: string): Promise<string>;
  revoke(target: string): Promise<string>;
  restore(target: string): Promise<string>;
  fillSeats(target: string): Promise<string>;
  setConfig(key: string, value: unknown, target?: string): Promise<string>;
  publishRelease(version: string, channel: string): Promise<string>;
  db: Db;
}

export interface IdpFacts {
  /** Null when the product runs no Identity service: there is nothing to sign in to. */
  issuer: string | null;
  clientId: string;
  person: { sub: string; email: string; name: string; groups: string[] };
  /** Signs the fake IdP's ID tokens. */
  pem: string;
  kid: string;
  jwk: Record<string, unknown>;
}

async function ed25519Jwk(
  pem: string,
  kid: string,
): Promise<Record<string, unknown>> {
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  return {
    ...(createPublicKey(createPrivateKey(pem)).export({
      format: "jwk",
    }) as object),
    kid,
    alg: "EdDSA",
    use: "sig",
  };
}

export async function createWorld(opts: WorldOptions): Promise<World> {
  const sqlite = await openMemoryDb();
  for (const sql of MIGRATIONS) sqlite.exec(sql);
  const db: Db = new NodeSqliteDb(sqlite);
  const notes: string[] = [];

  const idpHost = new URL(opts.idpOrigin).hostname;
  const kv = new KvMock();
  const env = {
    HOT: asKv(kv),
    DB: undefined,
    RL: makeRlNamespace(),
    SINGLE_USE: makeSingleUseNamespace(),
    PLATFORM_KEK: b64(32),
    KEY_HASH_PEPPER: b64(24),
    PORTAL_SESSION_SECRET: b64(24),
    // The fake IdP is served from this process; the allowlist names its unique host.
    OIDC_ISSUER_ALLOWLIST: idpHost,
    KEYENTRY_REFUSALS: "on",
    // LG-1: the local world runs every launch gate on.
    LAUNCH_IDENTITY_EXCHANGE: "on",
    LAUNCH_CONNECT: "on",
    LAUNCH_SYNC_E2E: "on",
    LAUNCH_SYNC_FILES: "on",
    LAUNCH_RELAY: "on",
  } as unknown as Env;

  const releasePair = await generateEd25519();
  const releaseKid = "dev-release-1";
  const releaseKey = {
    kid: releaseKid,
    publicKey: releasePair.publicRawB64url,
  };

  // ── The product: the repo's .pkey/, or Tidewater ─────────────────────────────────────────
  const files: Partial<Record<ManifestDocumentName, string>> = opts.manifest
    ? { ...opts.manifest }
    : tidewaterFiles(releaseKey, DEV_WEB_ORIGINS);
  if (opts.manifest) addReleaseKey(files, releaseKey, notes);
  const parsed = parseManifest(files as Record<string, string>, {});
  if (!parsed.ok)
    throw new Error(
      `The manifest is not valid:\n${parsed.errors.map((e) => `  ${e}`).join("\n")}`,
    );
  const manifest = parsed.manifest;
  const slug = manifest.product.slug;
  const started = now();
  const noNetwork = async (): Promise<Response> =>
    new Response("pkey dev has no network", { status: 404 });
  const registered = await registerFromManifest(
    env,
    db,
    manifest,
    { owner: "dev", repo: slug, installId: 0, token: "dev" },
    { sha: "0".repeat(40), files: files as Record<string, string> },
    started,
    noNetwork,
    ingestFor(SERVICES),
  );
  if (!registered.ok)
    throw new Error(
      `The product could not be registered: ${registered.error}${registered.errors ? `\n${registered.errors.join("\n")}` : ""}`,
    );
  const services = Object.entries(manifest.services)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);

  // Loopback origins for browser apps, beside any the manifest declares.
  const declared = manifest.webOrigins;
  const webOrigins = [...new Set([...declared, ...DEV_WEB_ORIGINS])].slice(
    0,
    16,
  );
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    JSON.stringify(webOrigins),
    slug,
  );

  const declaredReleaseKeys = await seedReleaseKey(db, slug, releaseKey, notes);
  const release = declaredReleaseKeys !== null;

  // ── The fake IdP, as the product's OIDC provider ─────────────────────────────────────────
  const idpPair = await generateEd25519();
  const idp: IdpFacts = {
    issuer: services.includes("identity") ? opts.idpOrigin : null,
    clientId: `${slug}-dev`,
    person: {
      sub: "u-iris",
      email: "iris@example.test",
      name: "Iris Calder",
      groups: ["users"],
    },
    pem: idpPair.privatePkcs8Pem,
    kid: "dev-idp-1",
    jwk: await ed25519Jwk(idpPair.privatePkcs8Pem, "dev-idp-1"),
  };
  if (idp.issuer) {
    const tier = manifest.tiers[0]?.id;
    await db.run("DELETE FROM oidc_config WHERE product = ?", slug);
    await db.run(
      `INSERT INTO oidc_config
         (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
       VALUES (?, 'custom', ?, ?, NULL, ?, ?)`,
      slug,
      idp.issuer,
      idp.clientId,
      JSON.stringify([`${opts.baseUrl}/${slug}/identity/auth/callback`]),
      JSON.stringify({ users: { role: "user", ...(tier ? { tier } : {}) } }),
    );
  }

  // ── Test keys, one per state ─────────────────────────────────────────────────────────────
  const tiers = manifest.tiers.map((t) => t.id);
  const bigTier = tiers.includes("pro") ? "pro" : (tiers[0] ?? null);
  const smallTier = tiers.includes("solo") ? "solo" : bigTier;
  const keys = {} as Record<KeyState, string>;
  const licenseOf = {} as Record<KeyState, string>;

  async function mint(
    state: KeyState,
    over: {
      tierId?: string | null;
      expiresAt?: number | null;
      status?: string;
      deviceLimit?: number | null;
      entitlements?: Record<string, unknown>;
      config?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const id = `lic_dev_${state.replace(/-/g, "_")}`;
    const key = mintLicenseKey(slug);
    await insertLicense(db, {
      product: slug,
      id,
      status: over.status ?? "active",
      sub: null,
      name: "Iris Calder",
      email: "iris@example.test",
      groups_json: null,
      tier_id: over.tierId === undefined ? bigTier : over.tierId,
      activated_at: started,
      expires_at: over.expiresAt ?? null,
      max_offline_days: null,
      overrides_json: JSON.stringify({
        config: over.config ?? {},
        secrets: {},
        entitlements: over.entitlements ?? {},
      }),
      channels_json: null,
      min_version: null,
      max_version: null,
      modified_by: null,
      modified_at: started,
    });
    await insertKey(db, {
      product: slug,
      key_hash: await hashKey(key, env.KEY_HASH_PEPPER),
      license_id: id,
      status: "active",
      label: state,
      created_at: started,
      created_by: null,
      last_used_at: null,
    });
    keys[state] = key;
    licenseOf[state] = id;
  }

  const enforced = (value: unknown) => ({
    state: "enforced",
    value,
    updatedAt: started,
  });
  await mint("ok", { entitlements: { exportPro: enforced(true) } });
  await mint("expired", { expiresAt: started - 30 * DAY });
  await mint("disabled", { status: "disabled" });
  await mint("revoked");
  await db.run(
    "UPDATE keys_index SET status = 'revoked' WHERE product = ? AND license_id = ?",
    slug,
    licenseOf.revoked,
  );
  await mint("device-limit-full", { tierId: smallTier, deviceLimit: 1 });
  await mint("key-entry-limit");
  await mint("floating");

  // `floating` is a licence in a batch with no account: an operator's bulk key.
  await db.run(
    `INSERT INTO license_batches (product, id, label, count, tier_id, created_by, created_at)
     VALUES (?, 'batch_dev', 'Dev keys', 1, ?, 'pkey dev', ?)`,
    slug,
    bigTier,
    started,
  );
  await db.run(
    "UPDATE licenses SET batch_id = 'batch_dev' WHERE product = ? AND id = ?",
    slug,
    licenseOf.floating,
  );

  // key-entry-limit: the licence has used every entry its product allows.
  if (services.includes("identity")) {
    await db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'identity.keyEntry.limit', ?, 'console', ?, 'pkey dev')
       ON CONFLICT(product, key) DO UPDATE SET value_json = excluded.value_json`,
      slug,
      String(ENTRY_LIMIT),
      started,
    );
    await db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('KEYENTRY_REFUSALS', '"on"', 1, ?, 'pkey dev')
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      started,
    );
    for (let i = 0; i < ENTRY_LIMIT; i++)
      await db.run(
        `INSERT INTO license_key_entries (product, license_id, id, surface, device_id, created_at)
         VALUES (?, ?, ?, 'app', ?, ?)`,
        slug,
        licenseOf["key-entry-limit"],
        `ke_dev_${i}`,
        `${FAKE_DEVICE_PREFIX}ENTRY${i}`.padEnd(32, "0"),
        started,
      );
  }

  // ── The router ───────────────────────────────────────────────────────────────────────────
  const handle = (req: Request): Promise<Response> =>
    dispatchWith(req, env, db, now());

  async function activateAs(key: string, deviceId: string): Promise<Response> {
    return handle(
      new Request(`${opts.baseUrl}/${slug}/license/activate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "x-pkey-device": deviceId,
          "x-pkey-version": "1.0.0",
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceName: "Dev seat" }),
      }),
    );
  }

  // device-limit-full: another device already holds the licence's one seat.
  {
    const res = await activateAs(
      keys["device-limit-full"],
      `${FAKE_DEVICE_PREFIX}FULL`.padEnd(32, "0"),
    );
    if (res.status !== 200)
      notes.push(
        `device-limit-full: the seat was not taken (${res.status}); the key may activate.`,
      );
  }

  // ── Releases: signed, on stable and beta ─────────────────────────────────────────────────
  const published: Array<{ version: string; channel: string }> = [];
  const builds = releaseBuildsOf(manifest);

  async function publishRelease(
    version: string,
    channel: string,
  ): Promise<string> {
    if (!services.includes("release") || builds.length === 0)
      throw new Error(
        "This product has no app deliverable to publish a release for.",
      );
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
      throw new Error(`${version} is not a version (1.2.3).`);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel))
      throw new Error(`${channel} is not a channel name.`);
    const exists = await db.first(
      "SELECT 1 AS one FROM release_metadata WHERE product = ? AND version = ?",
      slug,
      version,
    );
    if (exists) throw new Error(`${version} is already published.`);
    const seqRow = await db.first<{ n: number }>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM release_metadata WHERE product = ? AND deliverable_id = 'app'",
      slug,
    );
    const seq = seqRow?.n ?? 1;
    const t = now();
    const releaseId = `v${version}`;
    const bytes = `${slug} ${version}`;
    const artifactOf = (build: ReleaseBuild) => ({
      name: `${manifest.release?.binaryName ?? slug}-${version}-${build.platform}.${build.format}`,
      role: "payload",
      sha256: sha256(bytes),
      size: bytes.length,
    });
    const descriptor = {
      descriptorVersion: 1,
      product: slug,
      deliverable: "app",
      kind: "app",
      version,
      seq,
      channel,
      builds: builds.map((build) => ({
        id: build.id,
        platform: build.platform,
        arch: build.arch,
        format: build.format,
        artifacts: [artifactOf(build)],
      })),
    };
    const record = descriptorToRecord(
      descriptor as unknown as ReleaseDescriptor,
      {
        seq,
        issuedAt: t,
      },
    );
    const jws = await signJws(
      record,
      releasePair.privatePkcs8Pem,
      releaseKid,
      "pkey-release+jws",
    );
    const stmts: Array<[string, unknown[]]> = [
      [
        `INSERT INTO release_metadata (product, release_id, version, metadata_access, artifacts_access,
            published_at, metadata_json, created_at, modified_at, deliverable_id, seq, channel)
         VALUES (?, ?, ?, 'public', 'public', ?, ?, ?, ?, 'app', ?, ?)`,
        [
          slug,
          releaseId,
          version,
          t,
          JSON.stringify({
            summary: `Release ${version}.`,
            descriptor: {
              status: "ingested",
              sha256: sha256(JSON.stringify(descriptor)),
              source: "ci",
              at: t,
            },
          }),
          t,
          t,
          seq,
          channel,
        ],
      ],
      ...builds.map((build): [string, unknown[]] => [
        `INSERT INTO release_builds (product, release_id, build_id, platform, arch, format, created_at, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          slug,
          releaseId,
          build.id,
          build.platform,
          build.arch,
          build.format,
          t,
          t,
        ],
      ]),
      [
        `INSERT INTO release_records (product, deliverable_id, release_id, seq, kind, record_sha256, kid, jws, ingested_at)
         VALUES (?, 'app', ?, ?, 'app', ?, ?, ?, ?)`,
        [slug, releaseId, seq, sha256(jws), releaseKid, jws, t],
      ],
      [
        `INSERT OR IGNORE INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
         VALUES (?, 'direct', 'direct', '{}', ?, ?)`,
        [slug, t, t],
      ],
      [
        `INSERT INTO dist_availability (product, release_id, build_id, outlet_id, transport, state, since, source, updated_at)
         VALUES (?, ?, '', 'direct', 'pkey-cdn', 'live', ?, 'ci', ?)`,
        [slug, releaseId, t, t],
      ],
    ];
    await db.batch(
      stmts.map(([sql, params]) => ({ sql, params: params as never[] })),
    );
    published.push({ version, channel });
    return `published ${version} on ${channel} (seq ${seq})`;
  }

  if (release && builds.length > 0) {
    await publishRelease("1.0.0", "stable");
    await publishRelease("1.1.0-beta.1", "beta");
  }

  // ── Control ──────────────────────────────────────────────────────────────────────────────
  function stateOf(target: string): KeyState {
    if ((KEY_STATES as readonly string[]).includes(target))
      return target as KeyState;
    throw new Error(
      `${target} is not a test key. Use one of: ${KEY_STATES.join(", ")}.`,
    );
  }
  const touch = (id: string, set: string, ...params: unknown[]) =>
    db.run(
      `UPDATE licenses SET ${set}, modified_at = ? WHERE product = ? AND id = ?`,
      ...(params as never[]),
      now(),
      slug,
      id,
    );

  const world: World = {
    product: slug,
    name: manifest.product.name,
    services,
    baseUrl: opts.baseUrl,
    trust: registered.trustKeys,
    releaseKeys: Object.fromEntries(
      (declaredReleaseKeys ?? []).map((k) => [k.kid, k.publicKey]),
    ),
    keys,
    webOrigins,
    idp,
    notes,
    db,
    releases: () => [...published],
    handle,
    async expire(target) {
      const s = stateOf(target);
      await touch(licenseOf[s], "expires_at = ?", now() - DAY);
      return `${s} expired`;
    },
    async disable(target) {
      const s = stateOf(target);
      await touch(licenseOf[s], "status = ?", "disabled");
      return `${s} disabled`;
    },
    async revoke(target) {
      const s = stateOf(target);
      await db.run(
        "UPDATE keys_index SET status = 'revoked' WHERE product = ? AND license_id = ?",
        slug,
        licenseOf[s],
      );
      return `${s} revoked`;
    },
    async restore(target) {
      const s = stateOf(target);
      const id = licenseOf[s];
      const fresh = s === "expired" ? started - 30 * DAY : null;
      const status = s === "disabled" ? "disabled" : "active";
      await touch(id, "status = ?, expires_at = ?", status, fresh);
      await db.run(
        "UPDATE keys_index SET status = ? WHERE product = ? AND license_id = ?",
        s === "revoked" ? "revoked" : "active",
        slug,
        id,
      );
      return `${s} restored`;
    },
    async fillSeats(target) {
      const s = stateOf(target);
      let taken = 0;
      for (let i = 0; i < 100; i++) {
        const res = await activateAs(
          keys[s],
          `${FAKE_DEVICE_PREFIX}FILL${i}`.padEnd(32, "0"),
        );
        if (res.status !== 200) {
          return `${s}: all seats taken (${taken} added); the next device is refused`;
        }
        taken++;
      }
      return `${s}: 100 seats added and the limit is still not reached`;
    },
    async setConfig(key, value, target) {
      const ids = target
        ? [licenseOf[stateOf(target)]]
        : Object.values(licenseOf);
      for (const id of ids) {
        const row = await db.first<{ overrides_json: string | null }>(
          "SELECT overrides_json FROM licenses WHERE product = ? AND id = ?",
          slug,
          id,
        );
        const o = JSON.parse(row?.overrides_json ?? "{}") as {
          config?: Record<string, unknown>;
        };
        o.config = {
          ...(o.config ?? {}),
          [key]: { state: "enforced", value, updatedAt: now() },
        };
        await touch(id, "overrides_json = ?", JSON.stringify(o));
      }
      return `${key} = ${JSON.stringify(value)} on ${ids.length} key${ids.length === 1 ? "" : "s"}`;
    },
    publishRelease,
  };
  return world;
}

/** Declare the dev release key in a repo's own `.pkey/release`, creating it when there is none. */
function addReleaseKey(
  files: Partial<Record<ManifestDocumentName, string>>,
  key: Pins,
  notes: string[],
): void {
  if (files.release === undefined) {
    notes.push(
      "No .pkey/release: no releases are published. Add a release deliverable to try updates.",
    );
    return;
  }
  const doc = JSON.parse(files.release) as {
    release?: { releaseKeys?: Pins[] };
    releaseKeys?: Pins[];
  };
  const holder = doc.release ?? (doc as { releaseKeys?: Pins[] });
  holder.releaseKeys = [...(holder.releaseKeys ?? []), key].slice(0, 4);
  files.release = JSON.stringify(doc);
}

async function seedReleaseKey(
  db: Db,
  slug: string,
  key: Pins,
  _notes: string[],
): Promise<Pins[] | null> {
  const row = await db.first<{ release_keys_json: string | null }>(
    "SELECT release_keys_json FROM release_config WHERE product = ?",
    slug,
  );
  if (!row) return null;
  const list = JSON.parse(row.release_keys_json ?? "[]") as Pins[];
  if (!list.some((k) => k.kid === key.kid)) {
    list.push(key);
    await db.run(
      "UPDATE release_config SET release_keys_json = ? WHERE product = ?",
      JSON.stringify(list),
      slug,
    );
  }
  return list;
}

interface ReleaseBuild {
  id: string;
  platform: string;
  arch: string;
  format: string;
}

/** Every payload build the manifest's app deliverable declares: a dev release publishes them all. */
function releaseBuildsOf(
  manifest: ReturnType<typeof parseManifest> extends infer R
    ? R extends { ok: true; manifest: infer M }
      ? M
      : never
    : never,
): ReleaseBuild[] {
  const app = manifest.release?.app;
  const artifacts =
    (app as { artifacts?: Array<Record<string, unknown>> } | undefined)
      ?.artifacts ?? [];
  return artifacts
    .filter((a) => (a.role ?? "payload") === "payload")
    .map((a) => ({
      id: String(a.id),
      platform: String(a.platform),
      arch: String(a.arch ?? "any"),
      format: String(a.format ?? "zip"),
    }));
}

export { TIDEWATER_SLUG };
