/**
 * PX-W5 — the portal's device rename (G6), "Get a new key" (G7) and activate preview (G22), plus
 * the claim rules the preview and the claim now share (docs/design/PORTAL.md §4.19, §10.2).
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq as mkLicReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleActivate } from "../src/services/license/activation.js";
import { loadProduct } from "../src/core/products.js";
import { hashKey, mintLicenseKey } from "../src/crypto.js";
import { getTokenRecord } from "../src/kv.js";
import { getDevice, getKey } from "../src/repo.js";
import {
  getOrCreateAccountByEmail,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
  portalSessionAuthenticatedAt,
  verifyPortalSession,
} from "../src/services/identity/portal/session.js";
import {
  DEVICE_LABEL_MAX,
  KEY_REISSUE_MAX_AUTH_AGE_SECONDS,
  maskEmail,
  parseDeviceLabel,
} from "../src/services/identity/portal/selfService.js";
import { enableDownloads, handlePortalApi } from "./portalHarness.js";

const PORTAL_SECRET = "test-portal-session-secret";

function portalEnv(kv = new KvMock()): Env {
  const env = makeEnv(kv, ["djdl"]);
  env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  return env;
}

function withMailbox(
  env: Env,
): Array<{ to: string; subject: string; text: string }> {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  env.EMAIL = {
    send: async (message: { to: string; subject: string; text: string }) => {
      sent.push(message);
    },
  } as unknown as Env["EMAIL"];
  return sent;
}

interface Session {
  cookie: string;
  csrf: string;
  accountId: string;
}

async function portalSession(
  env: Env,
  db: Db,
  email: string,
  issuedAt = NOW,
): Promise<Session> {
  const account = await getOrCreateAccountByEmail(db, email, issuedAt);
  const { token, session } = await issuePortalSession(
    env,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    issuedAt,
  );
  return {
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
    accountId: account.id,
  };
}

async function call(
  env: Env,
  db: Db,
  method: string,
  path: string,
  session: Session | null,
  body?: unknown,
  now = NOW,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (session) {
    headers.cookie = session.cookie;
    headers[PORTAL_CSRF_HEADER] = session.csrf;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const req = new Request(
    `https://key.plrs.im${path}`,
    init,
  ) as unknown as Request;
  return handlePortalApi(req, env, db, path, now);
}

const preview = (env: Env, db: Db, s: Session, key: string, now = NOW) =>
  call(env, db, "POST", "/api/activate/preview", s, { key }, now);
const claim = (env: Env, db: Db, s: Session, key: string, now = NOW) =>
  call(env, db, "POST", "/api/claim/license-key", s, { key }, now);

async function activate(env: Env, db: Db, key: string, deviceId: string) {
  const product = (await loadProduct(env, db, "djdl"))!;
  return handleActivate(
    mkLicReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": deviceId,
    }),
    env,
    db,
    product,
    NOW,
  );
}

// The seeded licence carries ada@example.com (test/seed.ts).
const OWNER_EMAIL = "ada@example.com";

describe("license key masking and device names", () => {
  it("masks an email to its first character and domain", () => {
    expect(maskEmail("Mira@Proton.me")).toBe("m•••@proton.me");
    expect(maskEmail("a@b.co")).toBe("a•••@b.co");
    expect(maskEmail("not-an-email")).toBe("•••");
    expect(maskEmail("@nolocal.io")).toBe("•••");
  });

  it("accepts plain text, clears on null or blank, and refuses everything else", () => {
    expect(parseDeviceLabel("  Studio PC ")).toBe("Studio PC");
    expect(parseDeviceLabel("Laptop – café 🎧")).toBe("Laptop – café 🎧");
    expect(parseDeviceLabel(null)).toBeNull();
    expect(parseDeviceLabel("   ")).toBeNull();
    expect(parseDeviceLabel("x".repeat(DEVICE_LABEL_MAX))).toBe(
      "x".repeat(DEVICE_LABEL_MAX),
    );
    expect(parseDeviceLabel("x".repeat(DEVICE_LABEL_MAX + 1))).toBeUndefined();
    expect(parseDeviceLabel("bad\u0007bell")).toBeUndefined();
    expect(parseDeviceLabel("line\nbreak")).toBeUndefined();
    expect(parseDeviceLabel("Studio\u202eCP")).toBeUndefined(); // bidi override
    expect(parseDeviceLabel("a b")).toBeUndefined();
    expect(parseDeviceLabel(42)).toBeUndefined();
  });
});

describe("POST /api/activate/preview (G22)", () => {
  it("previews an addable key: product, tier, terms, platforms, and writes nothing", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await db.run(
      `INSERT INTO tiers (product, id, label, policy_device_limit, modified_at)
       VALUES ('djdl', 'pro', 'Pro', 3, ?)`,
      NOW,
    );
    const { key } = await seedLicenseWithKey(db, "djdl", { tierId: "pro" });
    await enableDownloads(db, "djdl", NOW);
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, metadata_access, artifacts_access, published_at,
          created_at, modified_at)
       VALUES ('djdl', 'rel_1', '1.0.0', 'public', 'public', ?, ?, ?)`,
      NOW,
      NOW,
      NOW,
    );
    for (const [build, platform] of [
      ["win", "windows"],
      ["mac", "macos"],
      ["mac2", "macos"],
    ]) {
      await db.run(
        `INSERT INTO release_builds
           (product, release_id, build_id, platform, arch, format, created_at, modified_at)
         VALUES ('djdl', 'rel_1', ?, ?, 'x64', 'zip', ?, ?)`,
        build,
        platform,
        NOW,
        NOW,
      );
    }
    const s = await portalSession(env, db, OWNER_EMAIL.replace("ada", "bob"));
    await upsertPortalProductSettings(db, "djdl", { claimByKey: true }, NOW);

    const res = await preview(env, db, s, key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({
      verdict: "addable",
      product: { slug: "djdl", name: "djdl" },
      license: {
        tier: "pro",
        tierLabel: "Pro",
        status: "active",
        expiresAt: null,
        usable: true,
      },
      platforms: ["macos", "windows"],
      entries: null,
    });
    expect(typeof body.license.deviceLimit).toBe("number");
    expect(body.license.id).toBeUndefined(); // not yours yet: no licence id
    expect(JSON.stringify(body)).not.toContain(key);
    expect(JSON.stringify(body)).not.toContain(OWNER_EMAIL);

    // A preview links nothing.
    const list = await call(env, db, "GET", "/api/licenses", s);
    expect(((await list.json()) as { licenses: unknown[] }).licenses).toEqual(
      [],
    );
  });

  it("refuses a malformed key with 422 before any lookup", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const s = await portalSession(env, db, "bob@example.com");
    const cut = mintLicenseKey("djdl").slice(0, -1); // 21 characters after the slug
    expect((await preview(env, db, s, cut)).status).toBe(422);
    expect((await preview(env, db, s, "XXXXX-XXXXX-XXXXX")).status).toBe(422);
  });

  it("answers unknown for an unknown product, an unknown key and a replaced key", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const s = await portalSession(env, db, "bob@example.com");

    const noProduct = await preview(env, db, s, mintLicenseKey("nope"));
    expect(await noProduct.json()).toMatchObject({
      verdict: "unknown",
      product: null,
    });

    const noKey = await preview(env, db, s, mintLicenseKey("djdl"));
    expect(await noKey.json()).toMatchObject({
      verdict: "unknown",
      product: { slug: "djdl" },
    });
  });

  it("answers portal_off when the product manages licences elsewhere", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { key } = await seedLicenseWithKey(db, "djdl");
    await upsertPortalProductSettings(
      db,
      "djdl",
      { licenseKeyClaimEnabled: false },
      NOW,
    );
    const s = await portalSession(env, db, "bob@example.com");
    const body = (await (await preview(env, db, s, key)).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      verdict: "portal_off",
      product: { slug: "djdl" },
    });
    expect(body.license).toBeUndefined();
  });

  it("answers already_yours with the licence id to open", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { key, licenseId } = await seedLicenseWithKey(db, "djdl");
    // Signed in with the licence's own (verified) email: it auto-links on the first request.
    const s = await portalSession(env, db, OWNER_EMAIL);
    const body = (await (await preview(env, db, s, key)).json()) as Record<
      string,
      any
    >;
    expect(body.verdict).toBe("already_yours");
    expect(body.license.id).toBe(licenseId);
  });

  it("answers owned_elsewhere with no ownership details, and the claim refuses it too", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { key, licenseId } = await seedLicenseWithKey(db, "djdl");
    await upsertPortalProductSettings(db, "djdl", { claimByKey: true }, NOW);
    const first = await portalSession(env, db, "first@example.com");
    expect((await claim(env, db, first, key)).status).toBe(200);

    const second = await portalSession(env, db, "second@example.com");
    const body = (await (await preview(env, db, second, key)).json()) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      verdict: "owned_elsewhere",
      product: expect.objectContaining({ slug: "djdl" }),
      entries: null,
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("first@");
    expect(text).not.toContain(first.accountId);
    expect(text).not.toContain(licenseId);

    const refused = await claim(env, db, second, key);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "owned_elsewhere" });
    const list = await call(env, db, "GET", "/api/licenses", second);
    expect(((await list.json()) as { licenses: unknown[] }).licenses).toEqual(
      [],
    );
  });

  it("answers email_mismatch with the masked email, and the claim refuses it too", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { key } = await seedLicenseWithKey(db, "djdl");
    const s = await portalSession(env, db, "bob@example.com");

    const body = (await (await preview(env, db, s, key)).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      verdict: "email_mismatch",
      maskedEmail: "a•••@example.com",
    });
    expect(JSON.stringify(body)).not.toContain(OWNER_EMAIL);
    expect(body.license).toBeUndefined();

    const refused = await claim(env, db, s, key);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: "email_mismatch",
      maskedEmail: "a•••@example.com",
    });

    // The product's claimByKey lifts the rule for both at once.
    await upsertPortalProductSettings(db, "djdl", { claimByKey: true }, NOW);
    expect(await (await preview(env, db, s, key)).json()).toMatchObject({
      verdict: "addable",
    });
    expect((await claim(env, db, s, key)).status).toBe(200);
  });

  it("charges the preview and the claim against one bucket", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { key } = await seedLicenseWithKey(db, "djdl");
    await upsertPortalProductSettings(db, "djdl", { claimByKey: true }, NOW);
    const s = await portalSession(env, db, "bob@example.com");
    for (let i = 0; i < 10; i++) {
      expect((await preview(env, db, s, key)).status).toBe(200);
    }
    expect((await preview(env, db, s, key)).status).toBe(429);
    expect((await claim(env, db, s, key)).status).toBe(429);
  });

  it("requires a session and the CSRF header", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const s = await portalSession(env, db, "bob@example.com");
    expect(
      (await call(env, db, "POST", "/api/activate/preview", null, { key: "x" }))
        .status,
    ).toBe(401);
    const noCsrf = await call(
      env,
      db,
      "POST",
      "/api/activate/preview",
      { ...s, csrf: "" },
      {
        key: "x",
      },
    );
    expect(noCsrf.status).toBe(403);
    expect(
      (await call(env, db, "GET", "/api/activate/preview", s)).status,
    ).toBe(405);
  });
});

describe("POST /api/claim/license-key notifies the licence's own email", () => {
  it("emails the account and, when different, the licence email", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const sent = withMailbox(env);
    await seedProduct(db, "djdl");
    const { key } = await seedLicenseWithKey(db, "djdl");
    await upsertPortalProductSettings(db, "djdl", { claimByKey: true }, NOW);
    const s = await portalSession(env, db, "bob@example.com");
    expect((await claim(env, db, s, key)).status).toBe(200);
    expect(sent.map((m) => m.to).sort()).toEqual([
      OWNER_EMAIL,
      "bob@example.com",
    ]);

    // A second claim of a licence already yours writes and sends nothing.
    sent.length = 0;
    expect((await claim(env, db, s, key)).status).toBe(200);
    expect(sent).toEqual([]);
  });
});

describe("PATCH /api/licenses/:p/:id/devices/:deviceId (G6)", () => {
  async function fixture() {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { key, licenseId } = await seedLicenseWithKey(db, "djdl");
    expect((await activate(env, db, key, "dev-1")).status).toBe(200);
    const owner = await portalSession(env, db, OWNER_EMAIL);
    return {
      db,
      env,
      licenseId,
      owner,
      path: `/api/licenses/djdl/${licenseId}/devices/dev-1`,
    };
  }

  it("renames and clears a device name", async () => {
    const { db, env, owner, path } = await fixture();
    const res = await call(env, db, "PATCH", path, owner, {
      label: "  Studio PC ",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      device: { deviceId: "dev-1", label: "Studio PC" },
    });
    expect((await getDevice(db, "djdl", "dev-1"))?.label).toBe("Studio PC");

    const cleared = await call(env, db, "PATCH", path, owner, { label: "" });
    expect(await cleared.json()).toMatchObject({ device: { label: null } });
    expect((await getDevice(db, "djdl", "dev-1"))?.label).toBeNull();
  });

  it("refuses an unacceptable name and a missing one with 422", async () => {
    const { db, env, owner, path } = await fixture();
    for (const label of ["x".repeat(DEVICE_LABEL_MAX + 1), "a\u202eb", 7]) {
      expect(
        (await call(env, db, "PATCH", path, owner, { label })).status,
      ).toBe(422);
    }
    expect((await call(env, db, "PATCH", path, owner, {})).status).toBe(422);
    expect((await getDevice(db, "djdl", "dev-1"))?.label).toBeNull();
  });

  it("is 404 for someone else's licence, a device of another licence and a portal-off product", async () => {
    const { db, env, licenseId, owner, path } = await fixture();
    const stranger = await portalSession(env, db, "stranger@example.com");
    expect(
      (await call(env, db, "PATCH", path, stranger, { label: "mine" })).status,
    ).toBe(404);

    await seedLicenseWithKey(db, "djdl", { id: "lic_other" });
    const other = await call(
      env,
      db,
      "PATCH",
      `/api/licenses/djdl/lic_other/devices/dev-1`,
      owner,
      { label: "x" },
    );
    expect(other.status).toBe(404);

    await upsertPortalProductSettings(
      db,
      "djdl",
      { portalEnabled: false },
      NOW,
    );
    expect(
      (await call(env, db, "PATCH", path, owner, { label: "x" })).status,
    ).toBe(404);
    expect(licenseId).toBeTruthy();
  });

  it("requires the CSRF header and leaves DELETE as the disconnect", async () => {
    const { db, env, owner, path } = await fixture();
    expect(
      (
        await call(
          env,
          db,
          "PATCH",
          path,
          { ...owner, csrf: "" },
          { label: "x" },
        )
      ).status,
    ).toBe(403);
    expect((await call(env, db, "DELETE", path, owner)).status).toBe(200);
    expect((await getDevice(db, "djdl", "dev-1"))?.status).toBe("deauthorized");
  });
});

describe("POST /api/licenses/:p/:id/keys (G7)", () => {
  async function fixture(opts: { optIn?: boolean } = {}) {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = portalEnv(kv);
    const sent = withMailbox(env);
    await seedProduct(db, "djdl");
    const { key, licenseId } = await seedLicenseWithKey(db, "djdl");
    if (opts.optIn ?? true) {
      await upsertPortalProductSettings(
        db,
        "djdl",
        { keyReissueEnabled: true },
        NOW,
      );
    }
    const activated = await activate(env, db, key, "dev-1");
    const { token } = (await activated.json()) as { token: string };
    const owner = await portalSession(env, db, OWNER_EMAIL);
    return {
      db,
      env,
      sent,
      key,
      token,
      licenseId,
      owner,
      path: `/api/licenses/djdl/${licenseId}/keys`,
    };
  }

  it("replaces the key: shown once, old key stops activating, existing devices keep working", async () => {
    const { db, env, sent, key, token, licenseId, owner, path } =
      await fixture();
    const res = await call(env, db, "POST", path, owner);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      key: string;
      hash: string;
      revokedKeys: number;
    };
    expect(body.key).toMatch(/^pkey_djdl_[A-Za-z0-9_-]{22}$/);
    expect(body.key).not.toBe(key);
    expect(body.revokedKeys).toBe(1);

    expect((await getKey(db, "djdl", await hashKey(key)))?.status).toBe(
      "revoked",
    );
    expect((await getKey(db, "djdl", body.hash))?.status).toBe("active");
    expect((await activate(env, db, key, "dev-2")).status).toBe(401);
    expect((await activate(env, db, body.key, "dev-2")).status).toBe(200);
    // The device activated with the old key keeps its token.
    expect(
      await getTokenRecord(
        env,
        "djdl",
        await hashKey(token, env.KEY_HASH_PEPPER),
      ),
    ).not.toBeNull();

    // Never readable again: the detail lists hashes only.
    const detail = await call(
      env,
      db,
      "GET",
      `/api/licenses/djdl/${licenseId}`,
      owner,
    );
    const detailText = await detail.text();
    expect(detailText).not.toContain(body.key);
    expect(JSON.parse(detailText)).toMatchObject({ canGetNewKey: true });

    expect(sent.map((m) => m.subject)).toContain("Your license has a new key");

    // And the old key is no longer a key anyone can add.
    const stranger = await portalSession(env, db, "x@example.com");
    expect(await (await preview(env, db, stranger, key)).json()).toMatchObject({
      verdict: "unknown",
    });
  });

  it("is hidden (404) unless the product opted in, and for someone else's licence", async () => {
    const off = await fixture({ optIn: false });
    expect(
      (await call(off.env, off.db, "POST", off.path, off.owner)).status,
    ).toBe(404);
    const detail = await call(
      off.env,
      off.db,
      "GET",
      `/api/licenses/djdl/${off.licenseId}`,
      off.owner,
    );
    expect(await detail.json()).toMatchObject({ canGetNewKey: false });

    const on = await fixture();
    const stranger = await portalSession(on.env, on.db, "stranger@example.com");
    expect((await call(on.env, on.db, "POST", on.path, stranger)).status).toBe(
      404,
    );
  });

  it("requires a recent sign-in (step-up) and mints nothing without one", async () => {
    const { db, env, key, owner, path } = await fixture();
    const later = NOW + KEY_REISSUE_MAX_AUTH_AGE_SECONDS + 1;
    const res = await call(env, db, "POST", path, owner, undefined, later);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: "step_up_required",
      maxAgeSeconds: KEY_REISSUE_MAX_AUTH_AGE_SECONDS,
    });
    expect((await getKey(db, "djdl", await hashKey(key)))?.status).toBe(
      "active",
    );

    // Signing in again satisfies it.
    const fresh = await portalSession(env, db, OWNER_EMAIL, later);
    expect(
      (await call(env, db, "POST", path, fresh, undefined, later)).status,
    ).toBe(201);
  });

  it("dates a session issued before iat existed from its expiry", async () => {
    const env = portalEnv();
    const { token } = await issuePortalSession(
      env,
      { accountId: "acct_1" },
      NOW,
    );
    const session = (await verifyPortalSession(env, token, NOW))!;
    expect(portalSessionAuthenticatedAt(session)).toBe(NOW);
    const { iat: _iat, ...legacy } = session;
    expect(portalSessionAuthenticatedAt(legacy)).toBe(NOW);
  });

  it("requires POST and the CSRF header", async () => {
    const { db, env, owner, path } = await fixture();
    expect((await call(env, db, "GET", path, owner)).status).toBe(405);
    expect(
      (await call(env, db, "POST", path, { ...owner, csrf: "" })).status,
    ).toBe(403);
  });
});
