import { afterEach, describe, expect, it, vi } from "vitest";
import { signJws, verifyJws } from "@polaris-key/jws";
import type { Env } from "../src/env.js";
import type { Db, DbParam } from "../src/db/types.js";
import {
  describeKeyring,
  generateEd25519,
  open,
  seal,
  type Sealed,
} from "../src/keyvault.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedProductSecret,
  TEST_KEK,
} from "./seed.js";
import {
  openManagedValue,
  sealManagedValue,
} from "../src/admin/lib/managedSecrets.js";
import type { ManagedPayload } from "../src/core/payload.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { loadProduct } from "../src/core/products.js";
import { getProductSecret, listAudit, listPlatformAudit } from "../src/repo.js";
import { signInSecretContext } from "../src/services/identity/providers/config.js";
import { sealSignInSecret } from "../scripts/seal-signin-secret.js";

const env = { PLATFORM_KEK: TEST_KEK } as unknown as Env;
const ctx = { product: "djdl", kind: "signing-key", id: "kid-1" } as const;

// Three distinct 32-byte KEKs. KEK_OLD is the one every seeded blob is sealed under, so a test
// that rotates to KEK_NEW is exercising the same transition production would.
const KEK_OLD = TEST_KEK;
const KEK_NEW = btoa(String.fromCharCode(1).repeat(32));
const KEK_THIRD = btoa(String.fromCharCode(2).repeat(32));

/** An env carrying an explicit keyring: `active` is sealed under, every kid can be opened. */
function ring(active: string, keys: Record<string, string>): Env {
  return {
    PLATFORM_KEK_KEYS: JSON.stringify(keys),
    PLATFORM_KEK_ACTIVE: active,
  } as unknown as Env;
}

describe("keyvault seal/open", () => {
  it("round-trips a value (open(seal(x)) === x)", async () => {
    const plaintext =
      "-----BEGIN PRIVATE KEY-----\nhello world\n-----END PRIVATE KEY-----";
    const sealed = await seal(env, plaintext, ctx);
    expect(await open(env, sealed, ctx)).toBe(plaintext);
  });

  it("produces a fresh nonce per seal (same plaintext ⇒ different ciphertext)", async () => {
    const a = JSON.parse(await seal(env, "secret", ctx)) as Sealed;
    const b = JSON.parse(await seal(env, "secret", ctx)) as Sealed;
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("THROWS on a tampered ciphertext (auth-tag failure, never a partial value)", async () => {
    const sealed = JSON.parse(await seal(env, "top-secret", ctx)) as Sealed;
    // Flip the first base64url char so the decoded ciphertext bytes definitely change.
    const first = sealed.ct[0] === "A" ? "B" : "A";
    const tampered = JSON.stringify({
      ...sealed,
      ct: first + sealed.ct.slice(1),
    });
    await expect(open(env, tampered, ctx)).rejects.toThrow();
  });

  it("THROWS when the KEK is missing", async () => {
    await expect(seal({} as Env, "x", ctx)).rejects.toThrow();
    const sealed = await seal(env, "x", ctx);
    await expect(open({} as Env, sealed, ctx)).rejects.toThrow();
  });

  it("rejects a non-32-byte KEK instead of deriving a deployment key", async () => {
    const weird = { PLATFORM_KEK: btoa("short-kek") } as unknown as Env;
    await expect(seal(weird, "value", ctx)).rejects.toThrow(
      "PLATFORM_KEK must decode to exactly 32 bytes",
    );
  });

  it("binds v2 envelopes to KEK id and associated data", async () => {
    const sealed = await seal(env, "value", ctx);
    expect(JSON.parse(sealed)).toMatchObject({ v: 2, kekId: "default" });
    await expect(
      open(env, sealed, { product: "djdl", kind: "signing-key", id: "kid-2" }),
    ).rejects.toThrow();
    expect(await open(env, sealed, ctx)).toBe("value");
  });
});

describe("keyvault KEK keyring (R2-09)", () => {
  it("treats the legacy PLATFORM_KEK as a one-entry ring, both directions", async () => {
    // The property that makes this deployable: on today's production secret set — a bare
    // PLATFORM_KEK — nothing about the bytes on disk changes.
    const legacy = await seal(env, "value", ctx);
    expect(JSON.parse(legacy)).toMatchObject({ kekId: "default" });
    const asRing = ring("default", { default: KEK_OLD });
    expect(await open(asRing, legacy, ctx)).toBe("value");
    expect(await open(env, await seal(asRing, "value", ctx), ctx)).toBe(
      "value",
    );
    expect(await describeKeyring(env)).toEqual({
      active: "default",
      kids: ["default"],
    });
  });

  it("honours PLATFORM_KEK_ID as the legacy kid", async () => {
    const named = {
      PLATFORM_KEK: KEK_OLD,
      PLATFORM_KEK_ID: "k1",
    } as unknown as Env;
    const sealed = await seal(named, "value", ctx);
    expect(JSON.parse(sealed)).toMatchObject({ kekId: "k1" });
    expect(await open(ring("k1", { k1: KEK_OLD }), sealed, ctx)).toBe("value");
    // …and that a blob written before PLATFORM_KEK_ID was set is now unopenable is exactly
    // the trap the runbook warns about.
    await expect(
      open(named, await seal(env, "value", ctx), ctx),
    ).rejects.toThrow("sealed value uses unavailable KEK default");
  });

  it("seals under the ACTIVE kid only, never a secondary", async () => {
    const rotating = ring("k2", { default: KEK_OLD, k2: KEK_NEW });
    expect(JSON.parse(await seal(rotating, "value", ctx))).toMatchObject({
      v: 2,
      kekId: "k2",
    });
    expect(await describeKeyring(rotating)).toEqual({
      active: "k2",
      kids: ["default", "k2"],
    });
  });

  it("opens a blob sealed under a SECONDARY kid — the read window", async () => {
    const legacyBlob = await seal(env, "old-secret", ctx);
    const rotating = ring("k2", { default: KEK_OLD, k2: KEK_NEW });
    expect(await open(rotating, legacyBlob, ctx)).toBe("old-secret");
    // Promoting k2 does not retroactively break anything sealed under default.
    const newBlob = await seal(rotating, "new-secret", ctx);
    expect(await open(rotating, newBlob, ctx)).toBe("new-secret");
    expect(await open(rotating, legacyBlob, ctx)).toBe("old-secret");
  });

  it("fails closed on a kid the ring does not hold", async () => {
    const newBlob = await seal(ring("k2", { k2: KEK_NEW }), "value", ctx);
    // A ring that has been rolled back past k2 must refuse, not substitute another key.
    await expect(
      open(ring("default", { default: KEK_OLD }), newBlob, ctx),
    ).rejects.toThrow("sealed value uses unavailable KEK k2");
    await expect(open(env, newBlob, ctx)).rejects.toThrow(
      "sealed value uses unavailable KEK k2",
    );
    // Right kid, wrong bytes ⇒ auth-tag failure, never a partial plaintext.
    await expect(
      open(ring("k2", { k2: KEK_THIRD }), newBlob, ctx),
    ).rejects.toThrow();
  });

  it("fails closed when no keyring is configured at all", async () => {
    const blob = await seal(env, "value", ctx);
    await expect(seal({} as Env, "value", ctx)).rejects.toThrow(
      "PLATFORM_KEK is not configured",
    );
    await expect(open({} as Env, blob, ctx)).rejects.toThrow(
      "PLATFORM_KEK is not configured",
    );
    await expect(describeKeyring({} as Env)).rejects.toThrow();
  });

  it("fails closed on every malformed ring — never falling back to PLATFORM_KEK", async () => {
    const blob = await seal(env, "value", ctx);
    const broken: [string, Record<string, unknown>][] = [
      ["not JSON", { PLATFORM_KEK_KEYS: "{k1:", PLATFORM_KEK_ACTIVE: "k1" }],
      [
        "not an object",
        { PLATFORM_KEK_KEYS: '["k1"]', PLATFORM_KEK_ACTIVE: "k1" },
      ],
      ["empty ring", { PLATFORM_KEK_KEYS: "{}", PLATFORM_KEK_ACTIVE: "k1" }],
      ["no active kid", { PLATFORM_KEK_KEYS: JSON.stringify({ k1: KEK_OLD }) }],
      [
        "active kid not in ring",
        {
          PLATFORM_KEK_KEYS: JSON.stringify({ k1: KEK_OLD }),
          PLATFORM_KEK_ACTIVE: "k2",
        },
      ],
      [
        "non-string entry",
        {
          PLATFORM_KEK_KEYS: JSON.stringify({ k1: 42 }),
          PLATFORM_KEK_ACTIVE: "k1",
        },
      ],
      [
        "short key",
        {
          PLATFORM_KEK_KEYS: JSON.stringify({ k1: btoa("short-kek") }),
          PLATFORM_KEK_ACTIVE: "k1",
        },
      ],
    ];
    for (const [label, vars] of broken) {
      // PLATFORM_KEK is present and valid in every case: a half-parsed ring must NOT quietly
      // degrade into "seal everything under the legacy key".
      const bad = { PLATFORM_KEK: KEK_OLD, ...vars } as unknown as Env;
      await expect(seal(bad, "value", ctx), label).rejects.toThrow();
      await expect(open(bad, blob, ctx), label).rejects.toThrow();
    }
  });

  it("preserves the AAD binding across a re-seal (the migration is slot-safe)", async () => {
    const rotating = ring("k2", { default: KEK_OLD, k2: KEK_NEW });
    const original = await seal(env, "signing-pem", ctx);
    const resealed = await seal(
      rotating,
      await open(rotating, original, ctx),
      ctx,
    );
    expect(JSON.parse(resealed)).toMatchObject({ v: 2, kekId: "k2" });
    expect(await open(rotating, resealed, ctx)).toBe("signing-pem");
    // Same value, different slot ⇒ still rejected after the rotation.
    for (const wrong of [
      { ...ctx, id: "kid-2" },
      { ...ctx, product: "other" },
      { ...ctx, kind: "product-secret" as const },
    ]) {
      await expect(open(rotating, resealed, wrong)).rejects.toThrow();
    }
  });
});

/** A ring that ALSO carries the legacy `PLATFORM_KEK` (the "old KEK is unknown" rotation). */
function ringWithLegacy(
  active: string,
  keys: Record<string, string>,
  legacy: string,
  legacyId?: string,
): Env {
  return {
    PLATFORM_KEK_KEYS: JSON.stringify(keys),
    PLATFORM_KEK_ACTIVE: active,
    PLATFORM_KEK: legacy,
    ...(legacyId === undefined ? {} : { PLATFORM_KEK_ID: legacyId }),
  } as unknown as Env;
}

/** Assert `p` rejects with `pattern` and that the message names no key material. */
async function rejectsWithoutKeyMaterial(
  p: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let message = "";
  try {
    await p;
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message).toMatch(pattern);
  // Compared as booleans so a failure can never print the key into the test output.
  for (const key of [KEK_OLD, KEK_NEW, KEK_THIRD])
    expect(message.includes(key)).toBe(false);
}

describe("keyvault: PLATFORM_KEK beside PLATFORM_KEK_KEYS (legacy key, open-only)", () => {
  it("opens a blob sealed under the legacy key while the ring is active", async () => {
    // Sealed exactly as today's single-key deployment seals: kid `default`, under PLATFORM_KEK.
    const legacyBlob = await seal(env, "old-secret", ctx);
    const both = ringWithLegacy("k2", { k2: KEK_NEW }, KEK_OLD);
    expect(await open(both, legacyBlob, ctx)).toBe("old-secret");
    // Without PLATFORM_KEK the same ring cannot: the legacy key is what opens it.
    await expect(
      open(ring("k2", { k2: KEK_NEW }), legacyBlob, ctx),
    ).rejects.toThrow("sealed value uses unavailable KEK default");
  });

  it("seals new values under the active kid, never the legacy key", async () => {
    const both = ringWithLegacy("k2", { k2: KEK_NEW }, KEK_OLD);
    const sealed = await seal(both, "new-secret", ctx);
    expect(JSON.parse(sealed)).toMatchObject({ v: 2, kekId: "k2" });
    // Sealed with KEK_NEW: it opens under the new key alone, with PLATFORM_KEK gone.
    expect(await open(ring("k2", { k2: KEK_NEW }), sealed, ctx)).toBe(
      "new-secret",
    );
    expect(await open(both, sealed, ctx)).toBe("new-secret");
  });

  it("refuses PLATFORM_KEK_ACTIVE naming the legacy kid: the legacy key never seals", async () => {
    const legacyActive = ringWithLegacy("default", { k2: KEK_NEW }, KEK_OLD);
    await expect(seal(legacyActive, "value", ctx)).rejects.toThrow(
      "PLATFORM_KEK_ACTIVE is not in PLATFORM_KEK_KEYS",
    );
    await expect(describeKeyring(legacyActive)).rejects.toThrow(
      "PLATFORM_KEK_ACTIVE is not in PLATFORM_KEK_KEYS",
    );
  });

  it("describes the legacy key as legacy and open-only", async () => {
    expect(
      await describeKeyring(ringWithLegacy("k2", { k2: KEK_NEW }, KEK_OLD)),
    ).toEqual({
      active: "k2",
      kids: ["k2", "default"],
      legacy: { kid: "default", openOnly: true },
    });
  });

  it("keeps the legacy kid PLATFORM_KEK_ID names", async () => {
    const named = {
      PLATFORM_KEK: KEK_OLD,
      PLATFORM_KEK_ID: "k1",
    } as unknown as Env;
    const blob = await seal(named, "value", ctx);
    const both = ringWithLegacy("k2", { k2: KEK_NEW }, KEK_OLD, "k1");
    expect(await open(both, blob, ctx)).toBe("value");
    expect(await describeKeyring(both)).toEqual({
      active: "k2",
      kids: ["k2", "k1"],
      legacy: { kid: "k1", openOnly: true },
    });
  });

  it("accepts the legacy kid in PLATFORM_KEK_KEYS when the bytes match", async () => {
    const legacyBlob = await seal(env, "value", ctx);
    // Same 32 bytes, spelled without padding: equal keys are compared as bytes, not strings.
    const same = ringWithLegacy(
      "k2",
      { default: KEK_OLD.replace(/=+$/, ""), k2: KEK_NEW },
      KEK_OLD,
    );
    expect(await describeKeyring(same)).toEqual({
      active: "k2",
      kids: ["default", "k2"],
      legacy: { kid: "default", openOnly: false },
    });
    expect(await open(same, legacyBlob, ctx)).toBe("value");
    expect(JSON.parse(await seal(same, "value", ctx))).toMatchObject({
      kekId: "k2",
    });
  });

  it("fails closed when PLATFORM_KEK_KEYS holds the legacy kid with different bytes", async () => {
    const legacyBlob = await seal(env, "value", ctx);
    const conflict =
      /both define kid default with different keys; refusing to choose/;
    for (const active of ["default", "k2"]) {
      const bad = ringWithLegacy(
        active,
        { default: KEK_NEW, k2: KEK_THIRD },
        KEK_OLD,
      );
      // Never silently one or the other: not for sealing, opening or describing.
      await rejectsWithoutKeyMaterial(seal(bad, "value", ctx), conflict);
      await rejectsWithoutKeyMaterial(open(bad, legacyBlob, ctx), conflict);
      await rejectsWithoutKeyMaterial(describeKeyring(bad), conflict);
    }
  });

  it("fails closed on a malformed PLATFORM_KEK beside a valid ring", async () => {
    const bad = ringWithLegacy("k2", { k2: KEK_NEW }, btoa("short-kek"));
    await expect(seal(bad, "value", ctx)).rejects.toThrow(
      "PLATFORM_KEK must decode to exactly 32 bytes",
    );
  });
});

describe("keyvault: the single shapes are unchanged", () => {
  // Recorded from the keyvault before the legacy key could sit beside a ring, with the IV pinned
  // to 0..11: either single shape must produce these exact bytes.
  const GOLDEN_LEGACY =
    '{"v":2,"kekId":"default","iv":"AAECAwQFBgcICQoL","ct":"76RfNmWT4efchwQX0BHmfQQKfjWJJg"}';
  const GOLDEN_RING =
    '{"v":2,"kekId":"k2","iv":"AAECAwQFBgcICQoL","ct":"3Mn5QkWQAqOtLy7I0Alf4Ujh6Hglpg"}';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function pinIv(): void {
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((
      arr: Uint8Array,
    ) => {
      for (let i = 0; i < arr.length; i++) arr[i] = i;
      return arr;
    }) as typeof crypto.getRandomValues);
  }

  it("PLATFORM_KEK alone seals, opens and describes byte-for-byte as before", async () => {
    pinIv();
    expect(await seal(env, "golden", ctx)).toBe(GOLDEN_LEGACY);
    expect(await open(env, GOLDEN_LEGACY, ctx)).toBe("golden");
    const described = await describeKeyring(env);
    expect(JSON.stringify(described)).toBe(
      '{"active":"default","kids":["default"]}',
    );
  });

  it("PLATFORM_KEK_KEYS alone seals, opens and describes byte-for-byte as before", async () => {
    pinIv();
    const only = ring("k2", { k2: KEK_NEW });
    expect(await seal(only, "golden", ctx)).toBe(GOLDEN_RING);
    expect(await open(only, GOLDEN_RING, ctx)).toBe("golden");
    expect(JSON.stringify(await describeKeyring(only))).toBe(
      '{"active":"k2","kids":["k2"]}',
    );
    // …and still never consults a kid it does not list.
    await expect(open(only, GOLDEN_LEGACY, ctx)).rejects.toThrow(
      "sealed value uses unavailable KEK default",
    );
  });
});

describe("signin:seal resolves the keyring as the Worker does", () => {
  it("seals under the active kid with both shapes set, and under the legacy kid alone", async () => {
    const both = ringWithLegacy("k2", { k2: KEK_NEW }, KEK_OLD);
    const steam = signInSecretContext("steam-web-api-key");
    const mid = await sealSignInSecret(both, "steam", "ABCDEF0123456789");
    expect(mid).toMatchObject({
      name: "SIGNIN_STEAM_WEB_API_KEY",
      kekId: "k2",
    });
    // Opens once PLATFORM_KEK is gone: the operator never needs the old key to re-seal.
    expect(await open(ring("k2", { k2: KEK_NEW }), mid.sealed, steam)).toBe(
      "ABCDEF0123456789",
    );
    const legacy = await sealSignInSecret(env, "steam", "ABCDEF0123456789");
    expect(legacy.kekId).toBe("default");
    expect(await open(both, legacy.sealed, steam)).toBe("ABCDEF0123456789");
    await rejectsWithoutKeyMaterial(
      sealSignInSecret(
        ringWithLegacy("k2", { default: KEK_NEW, k2: KEK_NEW }, KEK_OLD),
        "steam",
        "ABCDEF0123456789",
      ),
      /both define kid default with different keys/,
    );
  });
});

// ── the re-seal sweep: GET|POST /manage/api/products/kek ────────────────────────────────────

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const KEK_PATH = "/api/products/kek";

/** An admin env whose ONLY KEK configuration is `kek` (the legacy var is dropped unless the
 *  case supplies it, so a test can never accidentally pass via a fallback). */
function kekAdminEnv(kv: KvMock, kek: Record<string, string>): Env {
  const base = makeEnv(kv, []) as unknown as Record<string, unknown>;
  delete base.PLATFORM_KEK;
  return Object.assign(base, {
    ADMIN_SESSION_SECRET: ADMIN_SECRET,
    PLATFORM_ADMIN_GROUP: PLATFORM_GROUP,
    ...kek,
  }) as Env;
}

interface KekResponse {
  active?: string;
  kids?: string[];
  counts?: {
    keys: Record<string, number>;
    secrets: Record<string, number>;
    managed: Record<string, number>;
  };
  remaining?: number;
  unopenable?: number;
  resealed?: number;
  skipped?: number;
  failed?: number;
  failures?: { table: string; product: string; id: string; message: string }[];
  legacy?: {
    kid: string;
    openOnly: boolean;
    remaining: number;
    workerSecrets: string[];
    safeToDelete: boolean;
  };
  message?: string;
}

/** Call the keyring endpoint as a platform admin (CSRF included on mutations). */
async function kek(
  env: Env,
  db: Db,
  method: "GET" | "POST" | "DELETE",
  opts: { body?: unknown; csrf?: boolean; groups?: string[] } = {},
): Promise<{ status: number; body: KekResponse }> {
  const { token, session } = await issueSession(
    env,
    {
      sub: "admin-1",
      email: "admin@example.com",
      groups: opts.groups ?? [PLATFORM_GROUP],
    },
    NOW,
  );
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
  };
  if (opts.csrf !== false) headers[CSRF_HEADER] = session.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const req = new Request(
    `https://key.plrs.im/manage${KEK_PATH}`,
    init,
  ) as unknown as Request;
  const res = await handleAdmin(req, env, db, KEK_PATH, { now: NOW });
  return { status: res.status, body: (await res.json()) as KekResponse };
}

/** Two products, each with a sealed signing key and a sealed secret: four sealed rows, all
 *  written under the legacy `default` kid exactly as production's are. */
async function seedSealedRows(): Promise<{ db: Db; kv: KvMock }> {
  const db = makeTestDb();
  const kv = new KvMock();
  await seedProduct(db, "djdl");
  await seedProductSecret(db, "djdl", "OIDC_SECRET", "djdl-oidc-secret");
  await seedProduct(db, "acme");
  await seedProductSecret(db, "acme", "MINTER_KEY", "acme-minter-key");
  return { db, kv };
}

/** Open a stored product secret with whatever ring `env` carries. */
function openSecret(env: Env, db: Db, product: string, name: string) {
  return getProductSecret(db, product, name).then((row) =>
    open(env, row!.enc_value_json, {
      product,
      kind: "product-secret",
      id: name,
    }),
  );
}

describe("KEK rotation sweep (GET|POST /api/products/kek)", () => {
  it("is a no-op on a legacy single-KEK deployment", async () => {
    const { db, kv } = await seedSealedRows();
    const env = kekAdminEnv(kv, { PLATFORM_KEK: KEK_OLD });

    const status = await kek(env, db, "GET");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      active: "default",
      kids: ["default"],
      counts: { keys: { default: 2 }, secrets: { default: 2 } },
      remaining: 0,
      unopenable: 0,
    });

    const sweep = await kek(env, db, "POST");
    expect(sweep.status).toBe(200);
    expect(sweep.body).toMatchObject({ resealed: 0, failed: 0, remaining: 0 });
  });

  it("walks a full rotation with the platform serving throughout", async () => {
    const { db, kv } = await seedSealedRows();
    const both = { default: KEK_OLD, k2: KEK_NEW };

    // Step 3 — add the new key WITHOUT promoting it. Nothing moves.
    const added = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: JSON.stringify(both),
      PLATFORM_KEK_ACTIVE: "default",
    });
    expect((await kek(added, db, "GET")).body).toMatchObject({
      active: "default",
      kids: ["default", "k2"],
      remaining: 0,
    });
    expect(await loadProduct(added, db, "djdl")).not.toBeNull();

    // Step 5 — promote k2. Every stored blob is still under `default`, and every one of them
    // still opens: this is the read window that makes the rotation survivable.
    const promoted = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: JSON.stringify(both),
      PLATFORM_KEK_ACTIVE: "k2",
    });
    expect((await kek(promoted, db, "GET")).body).toMatchObject({
      active: "k2",
      counts: { keys: { default: 2 }, secrets: { default: 2 } },
      remaining: 4,
      unopenable: 0,
    });
    expect(await loadProduct(promoted, db, "djdl")).not.toBeNull();
    expect(await openSecret(promoted, db, "djdl", "OIDC_SECRET")).toBe(
      "djdl-oidc-secret",
    );

    // Step 6 — the sweep is bounded and resumable.
    const first = await kek(promoted, db, "POST", { body: { limit: 1 } });
    expect(first.body).toMatchObject({ resealed: 1, failed: 0, remaining: 3 });
    const rest = await kek(promoted, db, "POST", { body: { limit: 200 } });
    expect(rest.body).toMatchObject({
      resealed: 3,
      failed: 0,
      remaining: 0,
      counts: { keys: { k2: 2 }, secrets: { k2: 2 } },
    });
    // …and idempotent: a re-run is free.
    expect((await kek(promoted, db, "POST")).body).toMatchObject({
      resealed: 0,
      skipped: 0,
      remaining: 0,
    });

    // Every sweep is attributed, per tenant.
    const audits = await listAudit(db, "djdl", {});
    expect(audits.map((r) => r.action)).toContain("kek.reseal");
    // …and once per sweep on the platform trail (A-12), with counts only, never key material.
    const platform = await listPlatformAudit(db);
    expect(platform.length).toBeGreaterThan(0);
    for (const row of platform) {
      expect(row).toMatchObject({ action: "kek.reseal", target_kind: "kek" });
      expect(row.after_json).not.toContain(KEK_NEW);
      expect(row.after_json).not.toContain(KEK_OLD);
    }
    // Every sweep in this walk ran at the same NOW, so match rows by content, not order.
    const sweeps = platform.map((r) => ({
      before: JSON.parse(r.before_json!) as { remaining: number },
      after: JSON.parse(r.after_json!) as {
        remaining: number;
        resealed: number;
      },
    }));
    expect(
      sweeps.some((x) => x.before.remaining > 0 && x.after.resealed > 0),
    ).toBe(true);
    expect(
      sweeps.some(
        (x) =>
          x.before.remaining === 0 &&
          x.after.remaining === 0 &&
          x.after.resealed === 0,
      ),
    ).toBe(true);

    // Step 8 — retire the old KEK. The platform is unaffected because nothing references it.
    const retired = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: JSON.stringify({ k2: KEK_NEW }),
      PLATFORM_KEK_ACTIVE: "k2",
    });
    expect((await kek(retired, db, "GET")).body).toMatchObject({
      active: "k2",
      kids: ["k2"],
      remaining: 0,
      unopenable: 0,
    });
    const product = await loadProduct(retired, db, "djdl");
    expect(product).not.toBeNull();
    expect(await openSecret(retired, db, "acme", "MINTER_KEY")).toBe(
      "acme-minter-key",
    );
  });

  it("reports rows the ring cannot open instead of destroying or skipping them", async () => {
    const { db, kv } = await seedSealedRows();
    // A blob under a kid nobody holds any more, and a blob that is not JSON at all. The second
    // one is why the counting SQL is guarded by json_valid: unguarded, ONE such row makes
    // json_extract raise for the whole statement and the sweep goes blind.
    const orphan = await seal(ring("k9", { k9: KEK_THIRD }), "orphan-pem", {
      product: "djdl",
      kind: "signing-key",
      id: "djdl-orphan",
    });
    await db.run(
      `INSERT INTO product_keys (product, kid, alg, public_b64url, enc_private_json, status, created_at)
       VALUES ('djdl', 'djdl-orphan', 'Ed25519', 'pub', ?, 'retired', ?)`,
      orphan,
      NOW,
    );
    await db.run(
      `INSERT INTO product_keys (product, kid, alg, public_b64url, enc_private_json, status, created_at)
       VALUES ('djdl', 'djdl-corrupt', 'Ed25519', 'pub', 'not json at all', 'retired', ?)`,
      NOW,
    );

    const env = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: JSON.stringify({ default: KEK_OLD, k2: KEK_NEW }),
      PLATFORM_KEK_ACTIVE: "k2",
    });
    const status = await kek(env, db, "GET");
    expect(status.body.counts!.keys).toEqual({
      default: 2,
      k9: 1,
      "(unreadable)": 1,
    });
    expect(status.body).toMatchObject({ remaining: 6, unopenable: 2 });

    const sweep = await kek(env, db, "POST");
    expect(sweep.body).toMatchObject({ resealed: 4, failed: 2, remaining: 2 });
    expect(sweep.body.failures!.map((f) => f.id).sort()).toEqual([
      "djdl-corrupt",
      "djdl-orphan",
    ]);
    // Neither unopenable row was touched — a sweep never destroys what it cannot read.
    const rows = await db.all<{ kid: string; enc_private_json: string }>(
      "SELECT kid, enc_private_json FROM product_keys WHERE product = 'djdl' ORDER BY kid",
    );
    expect(rows.find((r) => r.kid === "djdl-corrupt")!.enc_private_json).toBe(
      "not json at all",
    );
    expect(rows.find((r) => r.kid === "djdl-orphan")!.enc_private_json).toBe(
      orphan,
    );
  });

  it("lets a racing admin write win the compare-and-swap", async () => {
    const { db, kv } = await seedSealedRows();
    const env = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: JSON.stringify({ default: KEK_OLD, k2: KEK_NEW }),
      PLATFORM_KEK_ACTIVE: "k2",
    });

    // Fire a competing write against the FIRST row the sweep is about to update — the shape of
    // a `secret.set` or a key rotation landing mid-sweep.
    let raced = false;
    const racing: Db = {
      all<T = Record<string, unknown>>(sql: string, ...params: DbParam[]) {
        return db.all<T>(sql, ...params);
      },
      first<T = Record<string, unknown>>(sql: string, ...params: DbParam[]) {
        return db.first<T>(sql, ...params);
      },
      run(sql: string, ...params: DbParam[]) {
        return db.run(sql, ...params);
      },
      batch(statements: Parameters<Db["batch"]>[0]) {
        return db.batch(statements);
      },
      async runChanges(sql: string, ...params: DbParam[]) {
        if (!raced && sql.includes("product_keys")) {
          raced = true;
          const [, product, kid] = params as [string, string, string];
          await db.run(
            "UPDATE product_keys SET enc_private_json = ? WHERE product = ? AND kid = ?",
            await seal(env, "rotated-by-someone-else", {
              product,
              kind: "signing-key",
              id: kid,
            }),
            product,
            kid,
          );
        }
        return db.runChanges(sql, ...params);
      },
    };

    const sweep = await kek(env, racing, "POST");
    expect(sweep.body).toMatchObject({ resealed: 3, skipped: 1, failed: 0 });
    // The competitor's value survived; the sweep did not clobber it with a stale plaintext.
    const row = await db.first<{ enc_private_json: string; kid: string }>(
      "SELECT kid, enc_private_json FROM product_keys WHERE product = 'acme'",
    );
    expect(
      await open(env, row!.enc_private_json, {
        product: "acme",
        kind: "signing-key",
        id: row!.kid,
      }),
    ).toBe("rotated-by-someone-else");
    expect(sweep.body.remaining).toBe(0);
  });

  it("re-seals managed secrets nested in profile and license payloads (R12-02)", async () => {
    const { db, kv } = await seedSealedRows();
    // Sealed exactly as `applyOverrides` writes them: an envelope string nested inside the
    // JSON payload column, AAD `…:product-secret:managed:<key>`.
    const profileSecret = await sealManagedValue(
      env,
      "djdl",
      "PROFILE_TOKEN",
      "profile-plaintext",
    );
    const licenseSecret = await sealManagedValue(
      env,
      "djdl",
      "API_TOKEN",
      "license-plaintext",
    );
    await db.run(
      `INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at)
       VALUES ('djdl', 'baseline', 'Baseline', NULL, ?, NULL, ?)`,
      JSON.stringify({
        config: {},
        secrets: {
          PROFILE_TOKEN: {
            state: "enforced",
            value: profileSecret,
            updatedAt: NOW,
          },
        },
        entitlements: {},
      }),
      NOW,
    );
    await seedLicenseWithKey(db, "djdl", {
      secrets: {
        API_TOKEN: { state: "enforced", value: licenseSecret, updatedAt: NOW },
      },
    });

    const promoted = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: JSON.stringify({ default: KEK_OLD, k2: KEK_NEW }),
      PLATFORM_KEK_ACTIVE: "k2",
    });
    const before = await kek(promoted, db, "GET");
    expect(before.body.counts!.managed).toEqual({ default: 2 });
    expect(before.body.remaining).toBe(6);

    const sweep = await kek(promoted, db, "POST");
    expect(sweep.body).toMatchObject({ resealed: 6, failed: 0, remaining: 0 });
    expect((await kek(promoted, db, "GET")).body.counts!.managed).toEqual({
      k2: 2,
    });

    // The point of the pass: after the old KEK is retired, the values still open — and they
    // open to the same plaintext, under the same AAD.
    const retired = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: JSON.stringify({ k2: KEK_NEW }),
      PLATFORM_KEK_ACTIVE: "k2",
    });
    const profileRow = await db.first<{ payload_json: string }>(
      "SELECT payload_json FROM profiles WHERE product = 'djdl' AND id = 'baseline'",
    );
    const licenseRow = await db.first<{ overrides_json: string }>(
      "SELECT overrides_json FROM licenses WHERE product = 'djdl'",
    );
    const profilePayload = JSON.parse(
      profileRow!.payload_json,
    ) as ManagedPayload;
    const licensePayload = JSON.parse(
      licenseRow!.overrides_json,
    ) as ManagedPayload;
    expect(
      await openManagedValue(
        retired,
        "djdl",
        "PROFILE_TOKEN",
        profilePayload.secrets.PROFILE_TOKEN!.value,
      ),
    ).toBe("profile-plaintext");
    expect(
      await openManagedValue(
        retired,
        "djdl",
        "API_TOKEN",
        licensePayload.secrets.API_TOKEN!.value,
      ),
    ).toBe("license-plaintext");
    // Idempotent here too: nothing left that names a non-active kid.
    expect((await kek(retired, db, "POST")).body).toMatchObject({
      resealed: 0,
      remaining: 0,
      unopenable: 0,
    });
  });

  it("rotates off an unknown PLATFORM_KEK: legacy blobs open, the sweep moves them, zero remain", async () => {
    // Every seeded row is sealed under `default` with KEK_OLD — the key nobody holds. The
    // operator adds a NEW ring and leaves PLATFORM_KEK where it is.
    const { db, kv } = await seedSealedRows();
    const steamCtx = signInSecretContext("steam-web-api-key");
    const env = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: JSON.stringify({ k2: KEK_NEW }),
      PLATFORM_KEK_ACTIVE: "k2",
      PLATFORM_KEK: KEK_OLD,
      // A sealed Worker secret under the legacy kid: the sweep cannot move it. Set as
      // `signin:seal | wrangler secret put` leaves it, with the trailing newline.
      SIGNIN_STEAM_WEB_API_KEY:
        (await seal(
          { PLATFORM_KEK: KEK_OLD } as unknown as Env,
          "ABCDEF0123456789",
          steamCtx,
        )) + "\n",
    });

    const before = await kek(env, db, "GET");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      active: "k2",
      kids: ["k2", "default"],
      counts: { keys: { default: 2 }, secrets: { default: 2 } },
      remaining: 4,
      unopenable: 0,
      legacy: {
        kid: "default",
        openOnly: true,
        remaining: 4,
        workerSecrets: ["SIGNIN_STEAM_WEB_API_KEY"],
        safeToDelete: false,
      },
    });
    // The platform serves throughout: the legacy blobs still open.
    expect(await loadProduct(env, db, "djdl")).not.toBeNull();
    expect(await openSecret(env, db, "acme", "MINTER_KEY")).toBe(
      "acme-minter-key",
    );

    // Bounded and resumable…
    const first = await kek(env, db, "POST", { body: { limit: 1 } });
    expect(first.body).toMatchObject({
      resealed: 1,
      failed: 0,
      remaining: 3,
      legacy: { remaining: 3, safeToDelete: false },
    });
    const rest = await kek(env, db, "POST", { body: { limit: 200 } });
    expect(rest.body).toMatchObject({
      resealed: 3,
      failed: 0,
      remaining: 0,
      unopenable: 0,
      counts: { keys: { k2: 2 }, secrets: { k2: 2 } },
      legacy: { kid: "default", remaining: 0 },
    });
    // …and idempotent.
    expect((await kek(env, db, "POST")).body).toMatchObject({
      resealed: 0,
      skipped: 0,
      remaining: 0,
      legacy: { remaining: 0 },
    });

    // Zero D1 values left under the legacy kid, but a Worker secret still is: not yet safe.
    expect((await kek(env, db, "GET")).body.legacy).toEqual({
      kid: "default",
      openOnly: true,
      remaining: 0,
      workerSecrets: ["SIGNIN_STEAM_WEB_API_KEY"],
      safeToDelete: false,
    });
    // Re-sealed with signin:seal under the new ring (no old key needed) and set again.
    const resealed = await sealSignInSecret(env, "steam", "ABCDEF0123456789");
    expect(resealed.kekId).toBe("k2");
    (env as Record<string, unknown>).SIGNIN_STEAM_WEB_API_KEY = resealed.sealed;
    expect((await kek(env, db, "GET")).body.legacy).toEqual({
      kid: "default",
      openOnly: true,
      remaining: 0,
      workerSecrets: [],
      safeToDelete: true,
    });

    // `wrangler secret delete PLATFORM_KEK`: nothing referenced it, so nothing breaks.
    delete (env as Record<string, unknown>).PLATFORM_KEK;
    const after = await kek(env, db, "GET");
    expect(after.body).toMatchObject({
      active: "k2",
      kids: ["k2"],
      remaining: 0,
      unopenable: 0,
    });
    expect(after.body.legacy).toBeUndefined();
    expect(await loadProduct(env, db, "djdl")).not.toBeNull();
    expect(await openSecret(env, db, "djdl", "OIDC_SECRET")).toBe(
      "djdl-oidc-secret",
    );
    expect(
      await open(env, env.SIGNIN_STEAM_WEB_API_KEY as string, steamCtx),
    ).toBe("ABCDEF0123456789");
  });

  it("reports the legacy key as safe to delete at once when PLATFORM_KEK_KEYS holds the same key", async () => {
    const { db, kv } = await seedSealedRows();
    const env = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: JSON.stringify({ default: KEK_OLD, k2: KEK_NEW }),
      PLATFORM_KEK_ACTIVE: "k2",
      PLATFORM_KEK: KEK_OLD,
    });
    expect((await kek(env, db, "GET")).body).toMatchObject({
      kids: ["default", "k2"],
      remaining: 4,
      legacy: {
        kid: "default",
        openOnly: false,
        remaining: 4,
        safeToDelete: true,
      },
    });
  });

  it("answers 503 naming the kid when PLATFORM_KEK and PLATFORM_KEK_KEYS disagree on it", async () => {
    const { db, kv } = await seedSealedRows();
    const env = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: JSON.stringify({ default: KEK_NEW }),
      PLATFORM_KEK_ACTIVE: "default",
      PLATFORM_KEK: KEK_OLD,
    });
    const res = await kek(env, db, "GET");
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(
      /both define kid default with different keys/,
    );
    for (const key of [KEK_OLD, KEK_NEW])
      expect(JSON.stringify(res.body).includes(key)).toBe(false);
    // Nothing was swept, so nothing was destroyed.
    expect((await kek(env, db, "POST")).status).toBe(503);
  });

  it("surfaces an unusable keyring as 503, not a silent platform-wide 404", async () => {
    const { db, kv } = await seedSealedRows();
    const env = kekAdminEnv(kv, {
      PLATFORM_KEK_KEYS: "{not json",
      PLATFORM_KEK_ACTIVE: "k2",
    });
    const res = await kek(env, db, "GET");
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/PLATFORM_KEK_KEYS is not valid JSON/);
  });

  it("is platform-admin, CSRF and method gated like every other admin mutation", async () => {
    const { db, kv } = await seedSealedRows();
    const env = kekAdminEnv(kv, { PLATFORM_KEK: KEK_OLD });
    expect((await kek(env, db, "POST", { csrf: false })).status).toBe(403);
    expect(
      (await kek(env, db, "GET", { groups: ["someone-else"] })).status,
    ).toBe(403);
    expect((await kek(env, db, "DELETE")).status).toBe(405);
    expect((await kek(env, db, "POST", { body: { limit: 0 } })).status).toBe(
      422,
    );
    expect((await kek(env, db, "POST", { body: { limit: 9999 } })).status).toBe(
      422,
    );
  });
});

describe("keyvault generateEd25519", () => {
  it("yields a PEM that signs a JWS verifiable under its raw public key", async () => {
    const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
    const kid = "kv-test-2026";
    const jws = await signJws({ hello: "world", n: 7 }, privatePkcs8Pem, kid);
    const verified = await verifyJws<{ hello: string; n: number }>(jws, {
      [kid]: publicRawB64url,
    });
    expect(verified).not.toBeNull();
    expect(verified!.kid).toBe(kid);
    expect(verified!.payload).toEqual({ hello: "world", n: 7 });
  });

  it("seals + opens its generated private PEM through the KEK", async () => {
    const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
    const reopened = await open(
      env,
      await seal(env, privatePkcs8Pem, ctx),
      ctx,
    );
    const jws = await signJws({ ok: true }, reopened, "k");
    expect(await verifyJws(jws, { k: publicRawB64url })).not.toBeNull();
  });
});
