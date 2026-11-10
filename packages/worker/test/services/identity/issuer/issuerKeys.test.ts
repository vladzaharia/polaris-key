/**
 * I-21.3: the issuer key ring (V5 §12.13.5; IS-7). Generate, seal, open, sign and verify with jose;
 * the three states and their timetable; rotation keeping the retired key in the set; emergency
 * rotation dropping every other key at once; and no private material in a JWKS, a log or an audit
 * row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compactVerify,
  createLocalJWKSet,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from "jose";
import { open } from "../../../../src/platform/keyvault.js";
import {
  ISSUER_KEY_NEXT_LEAD_SECONDS,
  ISSUER_KEY_RETIRED_SECONDS,
  ISSUER_KEY_ROTATION_SECONDS,
  emergencyRotateIssuerKey,
  ensureIssuerKeys,
  issuerJwks,
  rotateIssuerKeys,
  signIssuerJwt,
} from "../../../../src/services/identity/issuer/keys.js";
import { identityProductDeletion } from "../../../../src/services/identity/productDeletion.js";
import { identityMaintenance } from "../../../../src/services/identity/maintenance.js";
import type { MaintenanceRecorder } from "../../../../src/core/contributions.js";
import { makeEnv, seedProduct, NOW } from "../../../seed.js";
import { KvMock } from "../../../kvMock.js";
import { makeTestDb } from "../../../helpers.js";

const P = "acme";
const SU = { sub: "su", name: null, email: null };
const DAY = 86_400;
let db: ReturnType<typeof makeTestDb>;
let env: ReturnType<typeof makeEnv>;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), []);
  await seedProduct(db, P);
  await seedProduct(db, "other");
});
afterEach(() => vi.restoreAllMocks());

const states = async (product = P) =>
  (
    await db.all<{ kid: string; state: string }>(
      "SELECT kid, state FROM identity_issuer_keys WHERE product = ? ORDER BY created_at, kid",
      product,
    )
  ).map((r) => r.state);
const auditActions = async () =>
  (
    await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE action LIKE 'identity.issuer.key.%' ORDER BY at, rowid",
    )
  ).map((r) => r.action);

describe("generation and custody", () => {
  it("makes an active RSA-2048 key named by its RFC 7638 thumbprint, sealed", async () => {
    const kid = await ensureIssuerKeys(env, db, P, NOW);
    const row = (await db.first<{
      state: string;
      sealed: string;
      n: string;
      e: string;
    }>(
      "SELECT state, sealed, n, e FROM identity_issuer_keys WHERE kid = ?",
      kid,
    ))!;
    expect(row.state).toBe("active");
    expect(row.e).toBe("AQAB"); // 65537
    expect(Buffer.from(row.n, "base64url").length).toBe(256);
    const { calculateJwkThumbprint } = await import("jose");
    expect(
      await calculateJwkThumbprint({ kty: "RSA", n: row.n, e: row.e }),
    ).toBe(kid);
    // Sealed, never plaintext.
    expect(row.sealed).not.toContain("PRIVATE KEY");
    expect(JSON.parse(row.sealed)).toMatchObject({ v: 2 });
  });

  it("opens only in its own product and kid slot (AAD)", async () => {
    const kid = await ensureIssuerKeys(env, db, P, NOW);
    const { sealed } = (await db.first<{ sealed: string }>(
      "SELECT sealed FROM identity_issuer_keys WHERE kid = ?",
      kid,
    ))!;
    const slot = (product: string, id: string) => ({
      product,
      kind: "issuer-signing-key" as const,
      id,
    });
    expect(await open(env, sealed, slot(P, kid))).toContain("PRIVATE KEY");
    await expect(open(env, sealed, slot("other", kid))).rejects.toThrow();
    await expect(open(env, sealed, slot(P, "x" + kid))).rejects.toThrow();
    // Another kind in the same slot does not open it either.
    await expect(
      open(env, sealed, { product: P, kind: "signing-key", id: kid }),
    ).rejects.toThrow();
  });

  it("writes nothing when the key vault is unusable", async () => {
    const broken = { ...env, PLATFORM_KEK: undefined } as unknown as typeof env;
    await expect(ensureIssuerKeys(broken, db, P, NOW)).rejects.toThrow();
    expect(await states()).toEqual([]);
  });

  it("is idempotent and a ring is per product", async () => {
    const a = await ensureIssuerKeys(env, db, P, NOW);
    expect(await ensureIssuerKeys(env, db, P, NOW + 5)).toBe(a);
    const b = await ensureIssuerKeys(env, db, "other", NOW);
    expect(b).not.toBe(a);
    expect(await states()).toEqual(["active"]);
  });

  it("two concurrent first calls leave one active key", async () => {
    const [a, b] = await Promise.all([
      ensureIssuerKeys(env, db, P, NOW),
      ensureIssuerKeys(env, db, P, NOW),
    ]);
    expect(await states()).toEqual(["active"]);
    expect(a === b || (await issuerJwks(db, P)).keys.length === 1).toBe(true);
  });
});

describe("signing", () => {
  it("signs RS256 with kid and typ, and verifies against /jwks", async () => {
    const kid = await ensureIssuerKeys(env, db, P, NOW);
    const jwt = await signIssuerJwt(
      env,
      db,
      P,
      "at+jwt",
      { iss: "https://x/acme/identity", aud: "a", sub: "ps_1", exp: NOW + 600 },
      NOW,
    );
    expect(decodeProtectedHeader(jwt)).toEqual({
      alg: "RS256",
      kid,
      typ: "at+jwt",
    });
    const set = createLocalJWKSet(await issuerJwks(db, P));
    const { payload } = await jwtVerify(jwt, set, {
      algorithms: ["RS256"],
      typ: "at+jwt",
      currentDate: new Date(NOW * 1000),
    });
    expect(payload.sub).toBe("ps_1");
    // Another product's set does not verify it.
    await seedProduct(db, "z");
    await ensureIssuerKeys(env, db, "z", NOW);
    await expect(
      jwtVerify(jwt, createLocalJWKSet(await issuerJwks(db, "z")), {
        algorithms: ["RS256"],
        currentDate: new Date(NOW * 1000),
      }),
    ).rejects.toThrow();
  });

  it("makes the first key on demand", async () => {
    await signIssuerJwt(env, db, P, "JWT", { sub: "s" }, NOW);
    expect(await states()).toEqual(["active"]);
  });
});

describe("/jwks", () => {
  it("is exactly the six public members, whatever the state", async () => {
    await ensureIssuerKeys(env, db, P, NOW);
    await rotateIssuerKeys(
      env,
      db,
      P,
      NOW + ISSUER_KEY_ROTATION_SECONDS - ISSUER_KEY_NEXT_LEAD_SECONDS,
    );
    const { keys } = await issuerJwks(db, P);
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(Object.keys(k).sort()).toEqual([
        "alg",
        "e",
        "kid",
        "kty",
        "n",
        "use",
      ]);
      expect(k).toMatchObject({ kty: "RSA", use: "sig", alg: "RS256" });
    }
    expect(JSON.stringify(keys)).not.toMatch(/PRIVATE|"d"|"p"|"q"|sealed/);
    // Each member imports as a usable verification key.
    for (const k of keys) await importJWK(k, "RS256");
  });

  it("is empty for a product with no ring", async () => {
    expect(await issuerJwks(db, P)).toEqual({ keys: [] });
  });
});

describe("rotation", () => {
  const T = ISSUER_KEY_ROTATION_SECONDS;
  const LEAD = ISSUER_KEY_NEXT_LEAD_SECONDS;

  it("does nothing for a young ring or a product with no ring", async () => {
    expect(await rotateIssuerKeys(env, db, P, NOW)).toBe(0);
    await ensureIssuerKeys(env, db, P, NOW);
    expect(await rotateIssuerKeys(env, db, P, NOW + T - LEAD - 1)).toBe(0);
    expect(await states()).toEqual(["active"]);
  });

  it("publishes a next key 7 days before 90, which does not sign", async () => {
    const active = await ensureIssuerKeys(env, db, P, NOW);
    await rotateIssuerKeys(env, db, P, NOW + T - LEAD);
    expect(await states()).toEqual(["active", "next"]);
    // Idempotent: another pass publishes no second next.
    await rotateIssuerKeys(env, db, P, NOW + T - LEAD + 60);
    expect(await states()).toEqual(["active", "next"]);
    const jwt = await signIssuerJwt(
      env,
      db,
      P,
      "JWT",
      { sub: "s" },
      NOW + T - LEAD,
    );
    expect(decodeProtectedHeader(jwt).kid).toBe(active);
  });

  it("activates it after 90 days, retires the old key, and keeps both in the set", async () => {
    const first = await ensureIssuerKeys(env, db, P, NOW);
    await rotateIssuerKeys(env, db, P, NOW + T - LEAD);
    const old = await signIssuerJwt(
      env,
      db,
      P,
      "JWT",
      { sub: "s" },
      NOW + T - LEAD,
    );
    await rotateIssuerKeys(env, db, P, NOW + T);
    expect(await states()).toEqual(["retired", "active"]);
    const kids = (await issuerJwks(db, P)).keys.map((k) => k.kid);
    expect(kids).toHaveLength(2);
    expect(kids).toContain(first);
    const fresh = await signIssuerJwt(env, db, P, "JWT", { sub: "s" }, NOW + T);
    expect(decodeProtectedHeader(fresh).kid).not.toBe(first);
    // A token the retired key signed still verifies for the overlap.
    const set = createLocalJWKSet(await issuerJwks(db, P));
    await compactVerify(old, set, { algorithms: ["RS256"] });
  });

  it("waits for both the 7-day lead and the 90 days", async () => {
    await ensureIssuerKeys(env, db, P, NOW);
    // A job that missed days publishes late: 90 days pass, the next is only 1 day old.
    await rotateIssuerKeys(env, db, P, NOW + T + 6 * DAY);
    expect(await states()).toEqual(["active", "next"]);
    await rotateIssuerKeys(env, db, P, NOW + T + 6 * DAY + LEAD - 1);
    expect(await states()).toEqual(["active", "next"]);
    await rotateIssuerKeys(env, db, P, NOW + T + 6 * DAY + LEAD);
    expect(await states()).toEqual(["retired", "active"]);
  });

  it("drops a retired key, sealed half and all, 30 days after it retired", async () => {
    const first = await ensureIssuerKeys(env, db, P, NOW);
    await rotateIssuerKeys(env, db, P, NOW + T - LEAD);
    await rotateIssuerKeys(env, db, P, NOW + T);
    await rotateIssuerKeys(
      env,
      db,
      P,
      NOW + T + ISSUER_KEY_RETIRED_SECONDS - 1,
    );
    expect(await states()).toEqual(["retired", "active"]);
    await rotateIssuerKeys(env, db, P, NOW + T + ISSUER_KEY_RETIRED_SECONDS);
    expect(await states()).toEqual(["active"]);
    expect(
      await db.first("SELECT 1 FROM identity_issuer_keys WHERE kid = ?", first),
    ).toBeNull();
    expect((await issuerJwks(db, P)).keys).toHaveLength(1);
  });

  it("audits each step without key material", async () => {
    await ensureIssuerKeys(env, db, P, NOW);
    for (const at of [T - LEAD, T, T + ISSUER_KEY_RETIRED_SECONDS])
      await rotateIssuerKeys(env, db, P, NOW + at);
    expect(await auditActions()).toEqual([
      "identity.issuer.key.created",
      "identity.issuer.key.published",
      "identity.issuer.key.rotated",
      "identity.issuer.key.dropped",
    ]);
    const rows = JSON.stringify(await db.all("SELECT * FROM audit"));
    expect(rows).not.toMatch(/PRIVATE KEY|sealed|"iv"/);
  });

  it("is a step of Identity's nightly product job", async () => {
    await ensureIssuerKeys(env, db, P, NOW);
    const seen: string[] = [];
    const rec = {
      step: async (name: string, run: () => Promise<number>) => {
        seen.push(name);
        await run();
      },
      drain: async (name: string, pass: (l: number) => Promise<number>) => {
        seen.push(name);
        await pass(500);
      },
      fail: () => undefined,
    } as MaintenanceRecorder;
    await identityMaintenance.product!(
      { db, env, product: P, now: NOW + T - LEAD, cutoff: 0 },
      rec,
    );
    expect(seen).toContain(`issuerKeys:${P}`);
    expect(await states()).toEqual(["active", "next"]);
  });
});

describe("rotation without env", () => {
  it("records a failed step instead of skipping silently", async () => {
    const failed: string[] = [];
    const rec = {
      step: async () => undefined,
      drain: async () => undefined,
      fail: (name: string) => failed.push(name),
    } as unknown as MaintenanceRecorder;
    await identityMaintenance.product!(
      { db, product: P, now: NOW, cutoff: 0 },
      rec,
    );
    expect(failed).toEqual([`issuerKeys:${P}`]);
  });
});

describe("product deletion", () => {
  it("leaves a re-created slug with no keys, clients, secrets, grants or tokens", async () => {
    await ensureIssuerKeys(env, db, P, NOW);
    for (const [t, cols, vals] of [
      [
        "identity_clients",
        "client_id, product, key, name, type, redirect_uris_json, scopes_json, created_at, updated_at",
        "'cl_a', 'acme', 'k', 'n', 'web', '[]', '[]', 1, 1",
      ],
      [
        "identity_client_secrets",
        "id, client_id, product, secret_hash, last4, created_at",
        "'cs_a', 'cl_a', 'acme', 'h', 'abcd', 1",
      ],
      [
        "identity_client_grants",
        "account_id, client_id, product, scope_hash, granted_at, changed_at",
        "'a', 'cl_a', 'acme', 'h', 1, 1",
      ],
      [
        "identity_refresh_tokens",
        "token_hash, family_id, product, client_id, account_id, scope, auth_time, family_started_at, created_at, last_used_at",
        "'t', 'f', 'acme', 'cl_a', 'a', 'openid', 1, 1, 1, 1",
      ],
    ] as const)
      await db.run(`INSERT INTO ${t} (${cols}) VALUES (${vals})`);
    await ensureIssuerKeys(env, db, "other", NOW);
    await db.batch(identityProductDeletion(P, NOW));
    for (const t of [
      "identity_clients",
      "identity_client_secrets",
      "identity_issuer_keys",
      "identity_client_grants",
      "identity_refresh_tokens",
    ])
      expect(
        await db.first(`SELECT 1 FROM ${t} WHERE product = ?`, P),
        t,
      ).toBeNull();
    // Another product's ring is untouched.
    expect((await issuerJwks(db, "other")).keys).toHaveLength(1);
  });
});

describe("emergency rotation", () => {
  it("makes a new key active and drops every other key at once", async () => {
    const T = ISSUER_KEY_ROTATION_SECONDS;
    const first = await ensureIssuerKeys(env, db, P, NOW);
    await rotateIssuerKeys(env, db, P, NOW + T - ISSUER_KEY_NEXT_LEAD_SECONDS);
    const jwt = await signIssuerJwt(env, db, P, "JWT", { sub: "s" }, NOW + T);
    const r = await emergencyRotateIssuerKey(
      env,
      db,
      P,
      { sub: "su", name: "Su", email: "su@example.com" },
      NOW + T,
      "key exposed",
    );
    expect(r.dropped).toBe(2);
    expect(r.kid).not.toBe(first);
    expect(await states()).toEqual(["active"]);
    const set = createLocalJWKSet(await issuerJwks(db, P));
    await expect(
      compactVerify(jwt, set, { algorithms: ["RS256"] }),
    ).rejects.toThrow();
    const next = await signIssuerJwt(env, db, P, "JWT", { sub: "s" }, NOW + T);
    expect(decodeProtectedHeader(next).kid).toBe(r.kid);
    await compactVerify(next, set, { algorithms: ["RS256"] });
    const a = (await db.first<Record<string, unknown>>(
      "SELECT * FROM audit WHERE action = 'identity.issuer.key.emergency_rotated'",
    ))!;
    expect(a).toMatchObject({
      product: P,
      actor_sub: "su",
      reason: "key exposed",
      target_id: r.kid,
    });
    expect(JSON.stringify(a)).not.toMatch(/PRIVATE KEY|sealed/);
  });

  it("touches no other product's ring", async () => {
    await ensureIssuerKeys(env, db, P, NOW);
    const other = await ensureIssuerKeys(env, db, "other", NOW);
    await emergencyRotateIssuerKey(env, db, P, SU, NOW);
    expect((await issuerJwks(db, "other")).keys.map((k) => k.kid)).toEqual([
      other,
    ]);
  });

  it("creates the first key for an empty ring", async () => {
    const r = await emergencyRotateIssuerKey(env, db, P, SU, NOW);
    expect(r.dropped).toBe(0);
    expect(await states()).toEqual(["active"]);
  });
});

describe("no private key in a log", () => {
  it("never writes key material to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await ensureIssuerKeys(env, db, P, NOW);
    await rotateIssuerKeys(env, db, P, NOW + ISSUER_KEY_ROTATION_SECONDS);
    await signIssuerJwt(env, db, P, "JWT", { sub: "s" }, NOW);
    await emergencyRotateIssuerKey(env, db, P, SU, NOW);
    for (const s of spies)
      expect(JSON.stringify(s.mock.calls)).not.toMatch(/PRIVATE KEY/);
  });
});
