// LK-SKIP.3b (WIRE-CONTRACT-V5 §12.4.2): `POST /api/signin/requests/:handle/key`, the card's
// "Continue without an account". Each refusal is pinned in the contract's order, and none of them
// may consume the request. The key is in the body only: the redirect, the code record and the
// audit never hold it.

import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { dispatchWith } from "../../src/dispatch.js";
import { SETTINGS } from "../../src/mount.js";
import { KvMock } from "../kvMock.js";
import { claimRace } from "../helpers/claimRace.js";
import { makeTestDb } from "../helpers.js";
import { portalHooksFor } from "../portalHarness.js";
import {
  NOW,
  makeEnv,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "../seed.js";
import { setServices } from "../../src/core/products/store.js";
import { invalidatePlatformSettings } from "../../src/core/platformSettings.js";
import { hashKey, mintLicenseKey } from "../../src/platform/crypto.js";
import {
  KEY_ENTRY_LIMIT_SETTING,
  recordPortalKeyEntry,
} from "../../src/core/licensing/keyEntries.js";
import {
  SERVICE_SLUGS,
  serializeServices,
  type ServicesMap,
} from "../../src/core/services.js";
import { setDeviceSubject } from "../../src/core/accounts/accountSubjects.js";
import { subjectFor } from "../../src/core/accounts/accountSubjects.js";
import { getOrCreateAccountByEmail } from "../../src/services/identity/portal/repo.js";
import { handlePortalApi as portalApi } from "../../src/services/identity/portal/api.js";
import {
  issueAuthorizationCode,
  redeemAuthorizationCode,
} from "../../src/services/identity/passthrough/code.js";
import {
  createSignInRequest,
  readSignInRequest,
} from "../../src/services/identity/passthrough/request.js";
import {
  KEY_RETURN_RATE,
  KEY_RETURN_REQUEST_RATE,
} from "../../src/services/identity/passthrough/keyReturn.js";
import type { SqliteDb } from "../../src/db/sqlite.js";
import type { Env } from "../../src/platform/env.js";

const SLUG = "tidewater";
const BASE = "https://key.plrs.im";
const APP = "https://app.example";
const CB = `${APP}/auth/callback`;
const STATE = "s".repeat(24);
const VERIFIER = "v".repeat(48);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let db: SqliteDb;
let env: Env;
let key: string;
let licenseId: string;

/** The product runs License, Config and Identity, less what `off` names. */
async function services(off: readonly string[] = []) {
  const map = Object.fromEntries(
    SERVICE_SLUGS.map((slug) => [
      slug,
      {
        enabled:
          ["license", "config", "identity"].includes(slug) &&
          !off.includes(slug),
      },
    ]),
  ) as ServicesMap;
  await setServices(
    db,
    SLUG,
    serializeServices({ services: map }),
    "manifest",
    NOW,
  );
}

async function productSetting(name: string, valueJson: string) {
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, ?, ?, 'manifest', ?, 'test')`,
    SLUG,
    name,
    valueJson,
    NOW,
  );
}

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  await seedProduct(db, SLUG);
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    JSON.stringify([APP]),
    SLUG,
  );
  await productSetting("identity.redirectPaths", '["/auth/callback"]');
  await services();
  ({ key, licenseId } = await seedLicenseWithKey(db, SLUG));
});

const gate = (v: string | undefined) =>
  ((env as unknown as Record<string, string | undefined>)[
    "LAUNCH_IDENTITY_RETURNKEY"
  ] = v);

/** `authorize` with the key return opted in (or not), and the handle and binder it hands out. */
async function begin(over: Record<string, string> = { key_return: "allow" }) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: SLUG,
    redirect_uri: CB,
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...over,
  });
  const res = await dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/authorize?${q}`) as never,
    env,
    db,
    NOW,
  );
  expect(res.status).toBe(303);
  const handle = new URL(res.headers.get("location")!).searchParams.get(
    "request",
  )!;
  const binder = res.headers.get("set-cookie")!.split(";")[0]!;
  return { handle, binder };
}

interface Press {
  binder?: string | null;
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
  raw?: string;
  type?: string | null;
}

function press(handle: string, p: Press = {}): Promise<Response> {
  const path = `/api/signin/requests/${handle}/key`;
  const raw =
    p.raw ?? (p.body !== undefined ? JSON.stringify(p.body) : undefined);
  const method = p.method ?? "POST";
  return portalApi(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(p.binder ? { cookie: p.binder } : {}),
        ...(p.type === null
          ? {}
          : { "content-type": p.type ?? "application/json" }),
        ...(p.headers ?? {}),
      },
      ...(raw !== undefined && method !== "GET" ? { body: raw } : {}),
    }),
    env,
    db,
    path,
    NOW,
    portalHooksFor(env, db),
    SETTINGS,
  );
}

const withKey = (k = key) => ({ key: k });

const DEVICE_A = "KEYRETURNDEVICE000000000000000001";
const DEVICE_B = "KEYRETURNDEVICE000000000000000002";

/** `POST identity/token` as the SDK sends it. */
function redeem(
  code: string,
  opts: {
    device?: string;
    bearer?: string;
    verifier?: string;
    db?: SqliteDb;
  } = {},
): Promise<Response> {
  return dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-pkey-device": opts.device ?? DEVICE_A,
        ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: SLUG,
        code,
        code_verifier: opts.verifier ?? VERIFIER,
        redirect_uri: CB,
      }).toString(),
    }) as never,
    env,
    opts.db ?? db,
    NOW,
  );
}

/** A `license_owned` refusal: the link to the card, and neither the key nor the account. */
async function expectOwned(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as Record<string, string>;
  expect(body.error).toBe("license_owned");
  expect(body.signInUrl).toBe(`${BASE}/signin?product=${SLUG}`);
  expect(JSON.stringify(body)).not.toContain(key);
  expect(JSON.stringify(body)).not.toContain("acct_x");
}

/** `token` refuses a code as `invalid_grant`. */
async function expectInvalidGrant(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid_grant" });
}

/** One card press for the key, and the code it issued. */
async function codeNow(k = key): Promise<string> {
  const { handle, binder } = await begin();
  const res = await press(handle, { binder, body: withKey(k) });
  expect(res.status).toBe(200);
  return codeFrom(res);
}

/** The code in a successful press's redirect. */
async function codeFrom(res: Response): Promise<string> {
  const { redirect } = (await res.json()) as { redirect: string };
  return new URL(redirect).searchParams.get("code")!;
}

/** The request is still there: nothing consumed it. */
async function alive(handle: string, binder: string): Promise<boolean> {
  const req = new Request(`${BASE}/x`, { headers: { cookie: binder } });
  return (await readSignInRequest(env, req, handle, NOW)) !== null;
}

async function setRefusals(on: boolean) {
  await db.run(
    `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
     VALUES ('KEYENTRY_REFUSALS', ?, 1, ?, 'test')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    JSON.stringify(on ? "on" : "off"),
    NOW,
  );
  invalidatePlatformSettings(env, db);
}

describe("POST /api/signin/requests/:handle/key: success", () => {
  it("answers the redirect with a code, state and iss, and the key nowhere", async () => {
    const { handle, binder } = await begin();
    const res = await press(handle, { binder, body: withKey() });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { redirect } = (await res.json()) as { redirect: string };
    const to = new URL(redirect);
    expect(to.origin + to.pathname).toBe(CB);
    expect([...to.searchParams.keys()].sort()).toEqual([
      "code",
      "iss",
      "state",
    ]);
    expect(to.searchParams.get("state")).toBe(STATE);
    expect(to.searchParams.get("iss")).toBe(`${BASE}/${SLUG}/identity`);
    expect(redirect).not.toContain(key);
  });

  it("issues a code that names the key by hash and the licence, with no account", async () => {
    const { handle, binder } = await begin();
    const res = await press(handle, { binder, body: withKey() });
    const code = await codeFrom(res);
    const record = await redeemAuthorizationCode(env, SLUG, code, CHALLENGE);
    expect(record).toMatchObject({
      kind: "key",
      product: SLUG,
      clientId: SLUG,
      redirectUri: CB,
      licenseId,
      keyHash: await hashKey(key, env.KEY_HASH_PEPPER),
      accountId: "",
      subject: "",
      scope: [],
      choice: null,
    });
    expect(JSON.stringify(record)).not.toContain(key);
  });

  it("takes the request: a second press is 404", async () => {
    const { handle, binder } = await begin();
    expect((await press(handle, { binder, body: withKey() })).status).toBe(200);
    expect(await alive(handle, binder)).toBe(false);
    expect((await press(handle, { binder, body: withKey() })).status).toBe(404);
  });

  it("two presses at once: one code, one 404", async () => {
    const { handle, binder } = await begin();
    const out = await Promise.all([
      press(handle, { binder, body: withKey() }),
      press(handle, { binder, body: withKey() }),
    ]);
    expect(out.map((r) => r.status).sort()).toEqual([200, 404]);
  });

  it("audits signin.key with the licence, no actor and no key", async () => {
    const { handle, binder } = await begin();
    await press(handle, { binder, body: withKey() });
    const rows = await db.all<Record<string, unknown>>(
      "SELECT * FROM audit WHERE action = 'signin.key'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      product: SLUG,
      target_kind: "license",
      target_id: licenseId,
      actor_sub: null,
      actor_name: null,
      actor_email: null,
    });
    const all = await db.all<Record<string, unknown>>("SELECT * FROM audit");
    expect(JSON.stringify(all)).not.toContain(key);
  });

  it("accepts a key with surrounding whitespace, as the preview does", async () => {
    const { handle, binder } = await begin();
    const res = await press(handle, { binder, body: withKey(` ${key}\n`) });
    expect(res.status).toBe(200);
  });

  it("a key code is invalid_grant at a token that predates the key kind (account path, no account)", async () => {
    // A `token` built before LK-SKIP reads every code as an account code. The same record without
    // its `kind` stands in for it: an empty account and subject resolve to no one.
    const { handle, binder } = await begin();
    const res = await press(handle, { binder, body: withKey() });
    const record = await redeemAuthorizationCode(
      env,
      SLUG,
      await codeFrom(res),
      CHALLENGE,
    );
    const { kind: _kind, ...legacy } = record!;
    const code = await issueAuthorizationCode(env, legacy, CHALLENGE);
    const out = await redeem(code);
    expect(out.status).toBe(400);
    expect(await out.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("refusals, in the contract's order (§12.4.2 item 3)", () => {
  it("1: a method other than POST is 405", async () => {
    const { handle, binder } = await begin();
    for (const method of ["GET", "PUT", "DELETE"])
      expect((await press(handle, { binder, method })).status, method).toBe(
        405,
      );
    expect(await alive(handle, binder)).toBe(true);
  });

  it("1: cross-origin is 404, before the body is looked at", async () => {
    const { handle, binder } = await begin();
    const foreign: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example" },
    ];
    for (const headers of foreign) {
      const res = await press(handle, { binder, headers, raw: "not json" });
      expect(res.status, JSON.stringify(headers)).toBe(404);
    }
    expect(await alive(handle, binder)).toBe(true);
  });

  it.each([
    ["a form content type", { type: "application/x-www-form-urlencoded" }],
    ["text/plain", { type: "text/plain" }],
    ["no content type", { type: null }],
    ["a body that is not JSON", { raw: "not json" }],
    ["a JSON array", { raw: "[1]" }],
    ["JSON null", { raw: "null" }],
    ["an empty body", { raw: "" }],
    [
      "a body over 1 KiB",
      { raw: JSON.stringify({ key, pad: "x".repeat(1100) }) },
    ],
  ] as const)("1: %s is 400 invalid_request", async (_n, over) => {
    const { handle, binder } = await begin();
    const res = await press(handle, {
      binder,
      ...(!("raw" in over) ? { body: withKey() } : {}),
      ...over,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect(await alive(handle, binder)).toBe(true);
  });

  it("2: ten calls a minute per network, charged before any lookup, then 429 with retryAfter", async () => {
    // An unknown handle: every call is a 404 after the budget is charged.
    const ghost = "rq_" + "A".repeat(22);
    for (let i = 0; i < KEY_RETURN_RATE.limit; i++)
      expect((await press(ghost, { body: withKey() })).status, `${i}`).toBe(
        404,
      );
    const res = await press(ghost, { body: withKey() });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: "rate_limited",
      retryAfter: KEY_RETURN_RATE.windowSec,
    });
    expect(res.headers.get("retry-after")).toBe(
      String(KEY_RETURN_RATE.windowSec),
    );
  });

  it("2: the network budget refuses a real request too, and consumes nothing", async () => {
    const { handle, binder } = await begin();
    const ghost = "rq_" + "B".repeat(22);
    for (let i = 0; i < KEY_RETURN_RATE.limit; i++)
      await press(ghost, { body: withKey() });
    expect((await press(handle, { binder, body: withKey() })).status).toBe(429);
    expect(await alive(handle, binder)).toBe(true);
  });

  describe("3: one 404 shape", () => {
    async function expectGone(handle: string, binder: string | null) {
      const res = await press(handle, { binder, body: withKey() });
      expect(res.status).toBe(404);
      return res.text();
    }

    it("for no binder, a wrong binder, an unknown and a malformed handle", async () => {
      const { handle, binder } = await begin();
      const bodies = [
        await expectGone(handle, null),
        await expectGone(handle, "__Host-pk_req=" + "C".repeat(43)),
        await expectGone("rq_" + "D".repeat(22), binder),
        await expectGone("nope", binder),
      ];
      expect(new Set(bodies).size).toBe(1);
      expect(await alive(handle, binder)).toBe(true);
    });

    it("for a request that did not opt in", async () => {
      const { handle, binder } = await begin({});
      const body = await expectGone(handle, binder);
      expect(body).toBe(await expectGone("rq_" + "E".repeat(22), binder));
      expect(await alive(handle, binder)).toBe(true);
    });

    it("for purpose=attach (the opt-in is dropped at authorize)", async () => {
      const { handle, binder } = await begin({
        key_return: "allow",
        purpose: "attach",
      });
      await expectGone(handle, binder);
    });

    it("for a device-code request, which never carries the opt-in", async () => {
      const made = await createSignInRequest(
        env,
        new Request(`${BASE}/x`),
        {
          product: SLUG,
          kind: "device",
          deviceLabel: "TV",
          userCode: "ABCD-EFGH",
          flowRef: "flow",
        },
        NOW,
      );
      const binder = made.setCookie!.split(";")[0]!;
      await expectGone(made.handle, binder);
      expect(await alive(made.handle, binder)).toBe(true);
    });

    it.each([["off"], ["runtime"], [undefined]] as const)(
      "with the launch gate %s, even for a request recorded while it was on",
      async (v) => {
        const { handle, binder } = await begin();
        gate(v);
        await expectGone(handle, binder);
        expect(await alive(handle, binder)).toBe(true);
      },
    );

    it("with License off", async () => {
      const { handle, binder } = await begin();
      await services(["license"]);
      await expectGone(handle, binder);
    });

    it("with Identity off", async () => {
      const { handle, binder } = await begin();
      await services(["identity"]);
      await expectGone(handle, binder);
    });

    it("is the same body for every cause", async () => {
      const a = await begin();
      const b = await begin({});
      const bodies = new Set([
        await expectGone(a.handle, null),
        await expectGone(b.handle, b.binder),
      ]);
      gate("off");
      bodies.add(await expectGone(a.handle, a.binder));
      expect(bodies.size).toBe(1);
    });
  });

  it("4: five tries per request handle, then 429 even with the right key", async () => {
    const { handle, binder } = await begin();
    for (let i = 0; i < KEY_RETURN_REQUEST_RATE.limit; i++)
      expect(
        (await press(handle, { binder, body: withKey("pkey_nope") })).status,
      ).toBe(422);
    const res = await press(handle, { binder, body: withKey() });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: "rate_limited",
      retryAfter: KEY_RETURN_REQUEST_RATE.windowSec,
    });
    expect(await alive(handle, binder)).toBe(true);
  });

  it("4: the handle's budget is not the network's: another handle still works", async () => {
    const a = await begin();
    for (let i = 0; i < KEY_RETURN_REQUEST_RATE.limit; i++)
      await press(a.handle, { binder: a.binder, body: withKey("pkey_nope") });
    const b = await begin();
    expect(
      (await press(b.handle, { binder: b.binder, body: withKey() })).status,
    ).toBe(200);
  });

  describe("5: the key", () => {
    it.each([
      ["no key", {}],
      ["a number", { key: 5 }],
      ["an empty key", { key: "" }],
      ["not the shape of a key", { key: "pkey_tidewater_short" }],
      ["a license-looking string of the wrong shape", { key: "hello" }],
    ] as const)("%s is 422 bad_request", async (_n, body) => {
      const { handle, binder } = await begin();
      const res = await press(handle, { binder, body });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
      expect(await alive(handle, binder)).toBe(true);
    });

    it("an unknown key is 401 unauthorized", async () => {
      const { handle, binder } = await begin();
      const res = await press(handle, {
        binder,
        body: withKey(mintLicenseKey(SLUG)),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
      expect(await alive(handle, binder)).toBe(true);
    });

    it("another product's key is 401, whether or not that key exists", async () => {
      await seedProduct(db, "other");
      const other = await seedLicenseWithKey(db, "other");
      const { handle, binder } = await begin();
      for (const k of [other.key, mintLicenseKey("other")])
        expect((await press(handle, { binder, body: withKey(k) })).status).toBe(
          401,
        );
      expect(await alive(handle, binder)).toBe(true);
    });

    it("a replaced (inactive) key is 401", async () => {
      await db.run(
        "UPDATE keys_index SET status = 'revoked' WHERE product = ? AND license_id = ?",
        SLUG,
        licenseId,
      );
      const { handle, binder } = await begin();
      expect((await press(handle, { binder, body: withKey() })).status).toBe(
        401,
      );
      expect(await alive(handle, binder)).toBe(true);
    });

    it.each([
      [
        "suspended (disabled)",
        "UPDATE licenses SET status = 'disabled' WHERE product = ?",
      ],
      ["expired", "UPDATE licenses SET expires_at = 1 WHERE product = ?"],
    ])(
      "a %s licence is 401 unauthorized and the request is not consumed",
      async (_n, sql) => {
        await db.run(sql, SLUG);
        const { handle, binder } = await begin();
        const res = await press(handle, { binder, body: withKey() });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: "unauthorized" });
        expect(await alive(handle, binder)).toBe(true);
      },
    );

    it("an unknown and a malformed key are told apart exactly as the preview does", async () => {
      const { handle, binder } = await begin();
      expect((await press(handle, { binder, body: withKey("x") })).status).toBe(
        422,
      );
      expect(
        (await press(handle, { binder, body: withKey(mintLicenseKey(SLUG)) }))
          .status,
      ).toBe(401);
    });
  });

  describe("6: an owned licence", () => {
    beforeEach(async () => {
      await db.run(
        "UPDATE licenses SET account_id = 'acct_x' WHERE product = ? AND id = ?",
        SLUG,
        licenseId,
      );
    });

    it("is 403 license_owned with signInUrl, with refusals off", async () => {
      const { handle, binder } = await begin();
      const res = await press(handle, { binder, body: withKey() });
      await expectOwned(res);
      expect(await alive(handle, binder)).toBe(true);
    });

    it("is the same with refusals on", async () => {
      await setRefusals(true);
      const { handle, binder } = await begin();
      const res = await press(handle, { binder, body: withKey() });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "license_owned" });
    });
  });

  describe("7: the key-entry limit", () => {
    async function atLimit() {
      await productSetting(KEY_ENTRY_LIMIT_SETTING, "1");
      await recordPortalKeyEntry(db, SLUG, licenseId, NOW);
    }

    it("with refusals on and used at the limit: 403 key_entry_limit with the meter", async () => {
      await atLimit();
      await setRefusals(true);
      const { handle, binder } = await begin();
      const res = await press(handle, { binder, body: withKey() });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "key_entry_limit",
        keyEntries: { used: 1, limit: 1 },
      });
      expect(await alive(handle, binder)).toBe(true);
    });

    it("with refusals off the licence is admitted at the limit", async () => {
      await atLimit();
      await setRefusals(false);
      const { handle, binder } = await begin();
      expect((await press(handle, { binder, body: withKey() })).status).toBe(
        200,
      );
    });

    it("under the limit it is admitted with refusals on", async () => {
      await setRefusals(true);
      const { handle, binder } = await begin();
      expect((await press(handle, { binder, body: withKey() })).status).toBe(
        200,
      );
    });
  });

  it("does not read the portal switches: a product with its portal off still returns", async () => {
    await db.run(
      "UPDATE portal_product_settings SET portal_enabled = 0 WHERE product = ?",
      SLUG,
    );
    const { handle, binder } = await begin();
    expect((await press(handle, { binder, body: withKey() })).status).toBe(200);
  });
});

describe("POST identity/token for a key code (§12.4.2 items 5 and 6, §12.5 rule 3)", () => {
  beforeEach(() => gate("on"));

  const devices = () =>
    db.all<Record<string, unknown>>(
      "SELECT device_id, license_id, status, bound_by, subject FROM devices WHERE product = ? ORDER BY device_id",
      SLUG,
    );
  const entries = () =>
    db.all<Record<string, unknown>>(
      "SELECT surface, device_id FROM license_key_entries WHERE product = ? AND license_id = ?",
      SLUG,
      licenseId,
    );

  /** A device holding a token through the key, signed in to an account (a pairwise subject). */
  async function signedInDevice(deviceId: string) {
    const res = await dispatchWith(
      new Request(`${BASE}/${SLUG}/license/activate`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "x-pkey-device": deviceId },
      }) as never,
      env,
      db,
      NOW,
    );
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const acct = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
    const subject = await subjectFor(db, acct.id, SLUG, NOW);
    expect(await setDeviceSubject(env, db, SLUG, deviceId, subject)).toBe(true);
    return { token, subject };
  }

  it("binds the device by key and answers the key-return body", async () => {
    const res = await redeem(await codeNow());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, any>;
    expect(body).toEqual({
      access_token: expect.stringMatching(/^pkeyt_/),
      token_type: "Bearer",
      via: "key",
      scope: "",
      schemaVersion: expect.any(Number),
      device: expect.any(Object),
      license: expect.objectContaining({ id: licenseId }),
      subject: null,
      keyEntries: { used: 1, limit: 10 },
    });
    expect(await devices()).toEqual([
      {
        device_id: DEVICE_A,
        license_id: licenseId,
        status: "authorized",
        bound_by: "key",
        subject: null,
      },
    ]);
    expect(await entries()).toEqual([
      { surface: "browser", device_id: DEVICE_A },
    ]);
  });

  it("the token it hands out works as a device token", async () => {
    const body = (await (await redeem(await codeNow())).json()) as {
      access_token: string;
    };
    const doc = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/subject`, {
        headers: {
          authorization: `Bearer ${body.access_token}`,
          "x-pkey-device": DEVICE_A,
        },
      }) as never,
      env,
      db,
      NOW,
    );
    expect(doc.status).toBe(200);
    expect(await doc.json()).toEqual({ subject: null });
  });

  it("audits signin.token.key with the device and the licence, and holds the key nowhere", async () => {
    const out = await redeem(await codeNow());
    const rows = await db.all<Record<string, unknown>>(
      "SELECT * FROM audit WHERE action = 'signin.token.key'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_kind: "device",
      target_id: DEVICE_A,
      parent_id: licenseId,
      actor_sub: null,
    });
    const all = await db.all<Record<string, unknown>>("SELECT * FROM audit");
    expect(JSON.stringify(all)).not.toContain(key);
    expect(JSON.stringify(await out.text())).not.toContain(key);
    expect(
      await db.all("SELECT 1 FROM audit WHERE action = 'signin.token'"),
    ).toHaveLength(0);
  });

  it("is single use: the same code again is invalid_grant, and a wrong verifier ends it", async () => {
    const code = await codeNow();
    expect((await redeem(code)).status).toBe(200);
    const again = await redeem(code);
    await expectInvalidGrant(again);
    const second = await codeNow();
    const wrong = await redeem(second, { verifier: "w".repeat(48) });
    expect(wrong.status).toBe(400);
    expect((await redeem(second)).status).toBe(400);
  });

  it("counts the entry once: a second code for the same device adds nothing", async () => {
    expect((await redeem(await codeNow())).status).toBe(200);
    const again = await redeem(await codeNow());
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).keyEntries).toEqual({
      used: 1,
      limit: 10,
    });
    expect(await entries()).toHaveLength(1);
  });

  describe("the gate and the services, read again at token", () => {
    it("launch.identityKeyReturn off: invalid_grant, nothing bound", async () => {
      const code = await codeNow();
      gate("off");
      const res = await redeem(code);
      await expectInvalidGrant(res);
      expect(await devices()).toEqual([]);
    });

    it("License off in the window: invalid_grant, nothing bound", async () => {
      const code = await codeNow();
      await services(["license"]);
      const res = await redeem(code);
      await expectInvalidGrant(res);
      expect(await devices()).toEqual([]);
      expect(await entries()).toEqual([]);
    });

    it("Identity off in the window: the route is gone, and nothing is bound", async () => {
      const code = await codeNow();
      await services(["identity"]);
      expect((await redeem(code)).status).toBe(404);
      expect(await devices()).toEqual([]);
      expect(await entries()).toEqual([]);
    });
  });

  describe("the key and the licence, re-resolved by the code's key hash", () => {
    it("a key revoked in the window: invalid_grant", async () => {
      const code = await codeNow();
      await db.run(
        "UPDATE keys_index SET status = 'revoked' WHERE product = ?",
        SLUG,
      );
      const res = await redeem(code);
      await expectInvalidGrant(res);
      expect(await devices()).toEqual([]);
    });

    it("a key that now opens another licence: invalid_grant", async () => {
      const code = await codeNow();
      await db.run(
        "UPDATE keys_index SET license_id = 'lic_other' WHERE product = ?",
        SLUG,
      );
      expect((await redeem(code)).status).toBe(400);
      expect(await devices()).toEqual([]);
    });

    it.each([
      [
        "suspended (disabled)",
        "UPDATE licenses SET status = 'disabled' WHERE product = ?",
      ],
      ["expired", "UPDATE licenses SET expires_at = 1 WHERE product = ?"],
    ])("a licence %s in the window: invalid_grant", async (_n, sql) => {
      const code = await codeNow();
      await db.run(sql, SLUG);
      const res = await redeem(code);
      await expectInvalidGrant(res);
      expect(await devices()).toEqual([]);
    });

    it("a record without its key hash or licence is invalid_grant", async () => {
      const code = await issueAuthorizationCode(
        env,
        {
          kind: "key",
          product: SLUG,
          clientId: SLUG,
          redirectUri: CB,
          accountId: "",
          subject: "",
          scope: [],
          choice: null,
          nonce: null,
          licenseChoice: "card",
        },
        CHALLENGE,
      );
      expect((await redeem(code)).status).toBe(400);
    });
  });

  describe("an owned licence never moves by key (S-16 D24)", () => {
    for (const refusals of [false, true]) {
      it(`claimed into an account in the window: 403 license_owned, refusals ${refusals ? "on" : "off"}`, async () => {
        await setRefusals(refusals);
        const code = await codeNow();
        await db.run(
          "UPDATE licenses SET account_id = 'acct_x' WHERE product = ? AND id = ?",
          SLUG,
          licenseId,
        );
        const res = await redeem(code);
        expect(res.headers.get("cache-control")).toBe("no-store");
        await expectOwned(res);
        expect(await devices()).toEqual([]);
        expect(await entries()).toEqual([]);
        // The refusal spent the code.
        expect((await redeem(code)).status).toBe(400);
      });
    }
  });

  describe("claimed between the read and the seat (CORE-SEAT-GUARD)", () => {
    for (const refusals of [false, true]) {
      it(`403 license_owned, no seat and no counted entry, refusals ${refusals ? "on" : "off"}`, async () => {
        await setRefusals(refusals);
        const code = await codeNow();
        // The licence is read unowned; the claim lands before the seat batch.
        const race = claimRace(db, licenseId);
        const res = await redeem(code, { db: race.db });
        expect(race.fired()).toBe(1);
        await expectOwned(res);
        expect(await devices()).toEqual([]);
        expect(await entries()).toEqual([]);
        expect(
          await db.all(
            "SELECT reason FROM license_refusals WHERE product = ? AND license_id = ?",
            SLUG,
            licenseId,
          ),
        ).toEqual([{ reason: "license_owned" }]);
        expect((await redeem(code)).status).toBe(400);
      });
    }
  });

  describe("the key-entry limit", () => {
    // The card's press came first, under the limit; another entry arrives inside the window.
    let code: string;
    beforeEach(async () => {
      await productSetting(KEY_ENTRY_LIMIT_SETTING, "1");
      code = await codeNow();
      await recordPortalKeyEntry(db, SLUG, licenseId, NOW);
    });

    it("refusals on and used at the limit: 403 key_entry_limit with the meter, nothing bound", async () => {
      await setRefusals(true);
      const res = await redeem(code);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "key_entry_limit",
        keyEntries: { used: 1, limit: 1 },
      });
      expect(await devices()).toEqual([]);
      expect(await entries()).toEqual([{ surface: "portal", device_id: null }]);
    });

    it("refusals off: admitted past the limit and counted", async () => {
      await setRefusals(false);
      const res = await redeem(code);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).keyEntries).toEqual({
        used: 2,
        limit: 1,
      });
    });
  });

  describe("the seat rules are license/activate's", () => {
    beforeEach(async () => {
      await seedTier(db, SLUG, "solo", { deviceLimit: 1 });
      await db.run(
        "UPDATE licenses SET tier_id = 'solo' WHERE product = ? AND id = ?",
        SLUG,
        licenseId,
      );
    });

    it("device_limit is flat, spends the code and takes no seat; the retry from a fresh press meets the same limit", async () => {
      expect((await redeem(await codeNow(), { device: DEVICE_B })).status).toBe(
        200,
      );
      const code = await codeNow();
      const res = await redeem(code);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "device_limit",
        limit: 1,
        deviceCount: 1,
      });
      expect(await devices()).toHaveLength(1);
      expect((await redeem(code)).status).toBe(400);
      // A fresh press, a fresh code: the same answer until a seat is free.
      const retry = await redeem(await codeNow());
      expect(retry.status).toBe(403);
      await db.run(
        "UPDATE devices SET status = 'deauthorized', seat_no = NULL WHERE product = ? AND device_id = ?",
        SLUG,
        DEVICE_B,
      );
      const ok = await redeem(await codeNow());
      expect(ok.status).toBe(200);
    });
  });

  describe("subject: null, with or without the device's own bearer", () => {
    // A key entry re-binds the device with no account (U-02), as `license/activate` does, so a
    // binding the device held is cleared and the answer says so.
    it("with the device's own bearer: null, and the binding it held is cleared", async () => {
      const { token } = await signedInDevice(DEVICE_A);
      const res = await redeem(await codeNow(), { bearer: token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.subject).toBeNull();
      expect(body.keyEntries).toEqual({ used: 1, limit: 10 });
      expect((await devices())[0]).toMatchObject({
        subject: null,
        bound_by: "key",
      });
    });

    it("without the bearer: null", async () => {
      await signedInDevice(DEVICE_A);
      const res = await redeem(await codeNow());
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).subject).toBeNull();
    });

    it("with another device's bearer: null, and that device keeps its binding", async () => {
      const other = await signedInDevice(DEVICE_B);
      const res = await redeem(await codeNow(), { bearer: other.token });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).subject).toBeNull();
      const rows = await devices();
      expect(rows.find((d) => d.device_id === DEVICE_B)?.subject).toBe(
        other.subject,
      );
    });

    it("with a made-up bearer: null", async () => {
      await signedInDevice(DEVICE_A);
      const res = await redeem(await codeNow(), { bearer: "pkeyt_nope" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).subject).toBeNull();
    });
  });

  it("does not write the pairwise subject for a device it binds", async () => {
    await redeem(await codeNow());
    expect(
      await db.all(
        "SELECT 1 FROM account_product_subjects WHERE product = ?",
        SLUG,
      ),
    ).toEqual([]);
  });
});

describe("key return on a pushed request", () => {
  const LOOP = "http://127.0.0.1:49152/pkey/callback";

  async function pushedHandle(uri?: string) {
    if (uri === undefined) {
      const res = await dispatchWith(
        new Request(`${BASE}/${SLUG}/identity/request`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-pkey-device": DEVICE_A,
          },
          body: new URLSearchParams({
            response_type: "code",
            client_id: SLUG,
            redirect_uri: LOOP,
            state: STATE,
            code_challenge: CHALLENGE,
            code_challenge_method: "S256",
            key_return: "allow",
            device_name: "Ada's Mac",
          }).toString(),
        }) as never,
        env,
        db,
        NOW,
      );
      expect(res.status).toBe(201);
      uri = ((await res.json()) as { request_uri: string }).request_uri;
    }
    const res = await dispatchWith(
      new Request(
        `${BASE}/${SLUG}/identity/authorize?${new URLSearchParams({ client_id: SLUG, request_uri: uri })}`,
      ) as never,
      env,
      db,
      NOW,
    );
    expect(res.status).toBe(303);
    return {
      uri,
      handle: new URL(res.headers.get("location")!).searchParams.get(
        "request",
      )!,
      binder: res.headers.get("set-cookie")!.split(";")[0]!,
    };
  }

  it("two reopened handles yield one code", async () => {
    const a = await pushedHandle();
    const b = await pushedHandle(a.uri);
    const first = await press(a.handle, {
      binder: a.binder,
      body: withKey(),
    });
    expect(first.status).toBe(200);
    const second = await press(b.handle, {
      binder: b.binder,
      body: withKey(),
    });
    expect(second.status).toBe(404);
  });

  it("the code is redeemed only by the pushing device", async () => {
    const a = await pushedHandle();
    const res = await press(a.handle, { binder: a.binder, body: withKey() });
    expect(res.status).toBe(200);
    const code = new URL(
      ((await res.json()) as { redirect: string }).redirect,
    ).searchParams.get("code")!;
    const wrong = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-pkey-device": DEVICE_B,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: SLUG,
          code,
          code_verifier: VERIFIER,
          redirect_uri: LOOP,
        }).toString(),
      }) as never,
      env,
      db,
      NOW,
    );
    await expectInvalidGrant(wrong);
  });
});
