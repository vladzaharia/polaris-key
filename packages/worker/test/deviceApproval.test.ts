// I-37: the explicit approval of a device-code sign-in (R1-07 / R8-03, reduced).
//
// The browser binder proves which browser confirmed the code; it cannot prove that the person in
// it holds the device. After sign-in the flow stops at `GET|POST /<p>/identity/auth/device/approve`
// and the device's poll answers `pending` until the person presses "Sign in on {device}". These
// tests drive the real handlers end to end (start, confirm, callback, approval, poll).

import { issuerMetadataResponse } from "./oidcIssuerFake.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  deviceFlowKey,
  flowKey,
  handleAuthCallback,
  handleAuthDeviceApprove,
  handleAuthDeviceEntry,
  handleAuthDevicePoll,
  handleAuthDeviceStart,
  handleAuthDeviceVerify,
} from "../src/services/identity/oidc.js";
import { choiceKey } from "../src/services/identity/productOidc/chooser.js";
import { hashKey } from "../src/platform/crypto.js";
import {
  decideDeviceFlow,
  denyChosenDeviceFlow,
} from "../src/services/identity/productOidc/deviceApproval.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { artefacts } from "./singleUseMock.js";

const idpKey = vi.hoisted(() => ({
  getKey: null as null | (() => Promise<unknown>),
}));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () => {
      if (!idpKey.getKey) throw new Error("no test IdP key installed");
      return idpKey.getKey();
    },
  };
});

const ORIGIN = "https://key.plrs.im";
const ISSUER = "https://id.example";
const AUD = "client-djdl";
const APPROVE = `${ORIGIN}/djdl/identity/auth/device/approve`;
const FORM = {
  "content-type": "application/x-www-form-urlencoded",
  "sec-fetch-site": "same-origin",
};

let db: SqliteDb;
let env: Env;
let product: Product;
let priv: CryptoKey;

const req = (url: string, init?: RequestInit): Request =>
  new Request(url, init) as unknown as Request;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), ["djdl"]);
  await seedProduct(db, "djdl");
  await db.run(
    `INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret,
       redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)`,
    "djdl",
    "custom",
    ISSUER,
    AUD,
    null,
    JSON.stringify([`${ORIGIN}/djdl/identity/auth/callback`]),
    JSON.stringify({ members: { role: "user", tier: "pro" } }),
  );
  await db.run(
    `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days,
       policy_device_limit, modified_by, modified_at) VALUES (?,?,?,?,?,?,?,?)`,
    "djdl",
    "pro",
    "Pro",
    null,
    365,
    50,
    null,
    NOW,
  );
  product = (await loadProduct(env, db, "djdl"))!;
  const pair = await generateKeyPair("ES256", { extractable: true });
  priv = pair.privateKey;
  const pub = await importJWK(
    { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "test-idp" },
    "ES256",
  );
  idpKey.getKey = async () => pub;
});

afterEach(() => {
  vi.restoreAllMocks();
  idpKey.getKey = null;
});

function installIdp(claims: Record<string, unknown>): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL) => {
      const u = typeof input === "string" ? input : input.toString();
      const meta = await issuerMetadataResponse(u, idpKey.getKey);
      if (meta) return meta;
      if (u.includes("/api/oidc/token")) {
        const idToken = await new SignJWT(claims)
          .setProtectedHeader({ alg: "ES256", kid: "test-idp" })
          .setIssuer(ISSUER)
          .setAudience(AUD)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(priv);
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
  );
}

interface Started {
  deviceCode: string;
  userCode: string;
  deviceId: string;
}

/** The device starts a flow. `country` is what Cloudflare's edge says about the starter. */
async function startFlow(
  deviceId = "tv-1",
  deviceName: string | undefined = "Living room PC",
  country = "PT",
): Promise<Started> {
  const res = await handleAuthDeviceStart(
    req(`${ORIGIN}/djdl/identity/auth/device/start`, {
      method: "POST",
      headers: { "cf-ipcountry": country },
      body: JSON.stringify({ deviceId, deviceName }),
    }),
    env,
    db,
    product,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { deviceCode: string; userCode: string };
  return { deviceCode: body.deviceCode, userCode: body.userCode, deviceId };
}

interface Confirmed extends Started {
  state: string;
  nonce: string;
  /** The `Cookie` header of the browser that confirmed the code (the real binder). */
  cookie: string;
}

/** A person types the code into `/device` and presses Continue: the browser gets the binder. */
async function confirmCode(
  started: Started,
  ip = "198.51.100.1",
): Promise<Confirmed> {
  const url = `${ORIGIN}/djdl/identity/auth/device`;
  const page = await handleAuthDeviceEntry(
    req(`${url}?user_code=${started.userCode}`, {
      headers: { "cf-connecting-ip": ip },
    }),
    env,
    product,
  );
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  const res = await handleAuthDeviceEntry(
    req(url, {
      method: "POST",
      headers: { ...FORM, "cf-connecting-ip": ip },
      body: new URLSearchParams({
        user_code: started.userCode,
        csrf,
      }).toString(),
    }),
    env,
    product,
  );
  expect(res.status).toBe(303);
  const authorize = new URL(res.headers.get("location")!);
  return {
    ...started,
    state: authorize.searchParams.get("state")!,
    nonce: authorize.searchParams.get("nonce")!,
    cookie: res.headers.get("set-cookie")!.split(";")[0]!,
  };
}

const PERSON = {
  sub: "person-sub",
  email: "ada@example.com",
  email_verified: true,
  name: "Ada",
  groups: ["members"],
};

/** The IdP leg: the browser carrying `cookie` lands on the callback signed in as `who`. */
async function callback(
  c: Confirmed,
  cookie = c.cookie,
  who: Record<string, unknown> = PERSON,
): Promise<Response> {
  installIdp({ ...who, nonce: c.nonce });
  return handleAuthCallback(
    req(`${ORIGIN}/djdl/identity/auth/callback?code=c&state=${c.state}`, {
      headers: { cookie },
    }),
    env,
    db,
    product,
    NOW,
  );
}

async function getApprove(
  cookie: string | null,
  headers: Record<string, string> = {},
  now = NOW,
): Promise<Response> {
  return handleAuthDeviceApprove(
    req(APPROVE, { headers: { ...(cookie ? { cookie } : {}), ...headers } }),
    env,
    db,
    product,
    now,
  );
}

const tokenOf = async (page: Response): Promise<string> =>
  /name="token" value="([^"]+)"/.exec(await page.text())![1]!;

async function postApprove(
  cookie: string | null,
  fields: Record<string, string>,
  headers: Record<string, string> = FORM,
  now = NOW,
): Promise<Response> {
  return handleAuthDeviceApprove(
    req(APPROVE, {
      method: "POST",
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields).toString(),
    }),
    env,
    db,
    product,
    now,
  );
}

/** Confirm, sign in, and open the approval page: the person is now looking at it. */
async function atApprovalPage(started?: Started) {
  const c = await confirmCode(started ?? (await startFlow()));
  const cb = await callback(c);
  expect(cb.status).toBe(303);
  expect(cb.headers.get("location")).toBe(APPROVE);
  const page = await getApprove(c.cookie);
  expect(page.status).toBe(200);
  const html = await page.clone().text();
  return { c, page, html, token: await tokenOf(page) };
}

let pollAt = NOW + 10;
async function poll(
  s: Started,
  extra: Record<string, unknown> = {},
): Promise<{ status: string; [k: string]: unknown }> {
  pollAt += 3;
  const res = await handleAuthDevicePoll(
    req(`${ORIGIN}/djdl/identity/auth/device/poll`, {
      method: "POST",
      body: JSON.stringify({
        deviceCode: s.deviceCode,
        deviceId: s.deviceId,
        ...extra,
      }),
    }),
    env,
    db,
    product,
    pollAt,
  );
  return (await res.json()) as { status: string };
}

const count = async (table: "licenses" | "devices" | "audit") =>
  (await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE product = 'djdl'`,
  ))!.n;

async function flowOf(c: Confirmed): Promise<Record<string, unknown> | null> {
  const raw = await artefacts(env).get(await flowKey(env, "djdl", c.state));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe("the gate: nothing account-bound until the person approves", () => {
  it("every poll answers pending after sign-in: no identity, no confirm, no token, no row", async () => {
    const { c } = await atApprovalPage();
    const before = {
      licenses: await count("licenses"),
      devices: await count("devices"),
      audit: await count("audit"),
    };
    for (const extra of [
      {},
      { confirmIdentity: true },
      { confirmIdentity: true, attachLicense: true },
    ]) {
      const out = await poll(c, extra);
      expect(out).toEqual({ status: "pending" });
    }
    expect({
      licenses: await count("licenses"),
      devices: await count("devices"),
      audit: await count("audit"),
    }).toEqual(before);
  });

  it("approval makes the next poll ready, with exactly one device row", async () => {
    const { c, token } = await atApprovalPage();
    const done = await postApprove(c.cookie, { token, decision: "approve" });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("is signed in on");
    expect(done.headers.get("set-cookie")).toContain("Max-Age=0");
    const out = await poll(c);
    expect(out.status).toBe("ready");
    expect(out.identity).toEqual({ name: "Ada", email: "ada@example.com" });
    expect(await count("devices")).toBe(1);
    // Approving is audited, naming the device label and nothing else.
    const rows = await db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM audit WHERE product = 'djdl' AND action LIKE 'identity.signin.device_%'",
    );
    expect(rows).toEqual([
      {
        action: "identity.signin.device_approved",
        summary: "Approved the sign-in on Living room PC",
      },
    ]);
  });

  it("confirm never offers an attach, whatever the device asks", async () => {
    const { c, token } = await atApprovalPage();
    await postApprove(c.cookie, { token, decision: "approve" });
    const shown = await poll(c, { confirmIdentity: true });
    expect(shown).toMatchObject({ status: "confirm", attachable: false });
  });

  it("the callback is not the approval: a record with no approvedAt stays pending, then times out", async () => {
    const { c } = await atApprovalPage();
    expect((await flowOf(c))!.approvedAt).toBeUndefined();
    expect((await poll(c)).status).toBe("pending");
    // The flow expires unapproved (600 s): the device is told the code is gone.
    await artefacts(env).delete(await flowKey(env, "djdl", c.state));
    expect((await poll(c)).status).toBe("timeout");
  });
});

describe("Deny", () => {
  for (const [label, press] of [["Deny", "deny"]] as const) {
    it(`${label}: the poll answers error, nothing is written, the identity is gone`, async () => {
      const { c, token } = await atApprovalPage();
      const before = {
        licenses: await count("licenses"),
        devices: await count("devices"),
      };
      const res = await postApprove(c.cookie, { token, decision: press });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Sign-in denied");
      expect(await poll(c)).toEqual({ status: "error" });
      expect(await poll(c, { confirmIdentity: true })).toEqual({
        status: "error",
      });
      const flow = await flowOf(c);
      expect(flow!.error).toBe("denied");
      expect(flow!.identity).toBeUndefined();
      expect(flow!.claimAccount).toBeUndefined();
      expect(flow!.approvedAt).toBeUndefined();
      expect({
        licenses: await count("licenses"),
        devices: await count("devices"),
      }).toEqual(before);
      // A second decision, from the same cookie, is refused and changes nothing.
      const again = await postApprove(c.cookie, { token, decision: "approve" });
      expect(again.status).toBe(403);
      expect(await poll(c)).toEqual({ status: "error" });
    });
  }

  it("a denied decision is audited without the place, code or state", async () => {
    const { c, token } = await atApprovalPage();
    await postApprove(c.cookie, { token, decision: "deny" });
    const row = await db.first<{ summary: string; action: string }>(
      "SELECT action, summary FROM audit WHERE action = 'identity.signin.device_denied'",
    );
    expect(row!.summary).toBe("Denied the sign-in on Living room PC");
    expect(row!.summary).not.toContain(c.userCode);
    expect(row!.summary).not.toContain(c.state);
    expect(row!.summary).not.toContain("Portugal");
  });
});

describe("forgery: each is refused generically and writes nothing", () => {
  async function untouched(c: Confirmed): Promise<void> {
    const flow = await flowOf(c);
    expect(flow?.approvedAt).toBeUndefined();
    expect(flow?.error).toBeUndefined();
    expect((await poll(c)).status).toBe("pending");
    expect(await count("devices")).toBe(0);
  }

  it("no binder cookie: the page is 'Start again', whoever asks", async () => {
    const { c, token } = await atApprovalPage();
    for (const res of [
      await getApprove(null),
      await postApprove(null, { token, decision: "approve" }),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Start again on your device");
    }
    await untouched(c);
  });

  it("a foreign binder (another browser that confirmed another code) reaches nothing", async () => {
    const mine = await atApprovalPage();
    const other = await confirmCode(await startFlow("tv-2", "Other"));
    const { token } = mine;
    // The other browser has a real binder but no signed-in flow: its index is not written.
    const res = await postApprove(other.cookie, { token, decision: "approve" });
    expect(res.status).toBe(403);
    await untouched(mine.c);
    // …and a forwarded page for the first flow, opened in a browser with no binder at all.
    expect((await getApprove(null)).status).toBe(403);
  });

  it("a cross-site POST is refused even with the real binder and token", async () => {
    const { c, token } = await atApprovalPage();
    for (const site of ["cross-site", "same-site", "none"]) {
      const res = await postApprove(
        c.cookie,
        { token, decision: "approve" },
        { ...FORM, "sec-fetch-site": site },
      );
      expect(res.status, site).toBe(403);
    }
    await untouched(c);
  });

  it("a missing, empty or unknown decision, or a missing token: back to the page", async () => {
    const { c, token } = await atApprovalPage();
    for (const fields of [
      { token },
      { token, decision: "" },
      { token, decision: "maybe" },
      { decision: "approve" },
      { token: "", decision: "approve" },
    ]) {
      const res = await postApprove(c.cookie, fields as Record<string, string>);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${APPROVE}?again=1`);
    }
    await untouched(c);
  });

  it("a replayed, stale or foreign token is a 303 and writes nothing", async () => {
    const { c, token: first } = await atApprovalPage();
    // A second render replaces the token: the first page's token is stale.
    const second = await tokenOf(await getApprove(c.cookie));
    expect(second).not.toBe(first);
    const stale = await postApprove(c.cookie, {
      token: first,
      decision: "approve",
    });
    expect(stale.status).toBe(303);
    // The redirect carries no state, only "again".
    expect(stale.headers.get("location")).toBe(`${APPROVE}?again=1`);
    const again = await handleAuthDeviceApprove(
      req(`${APPROVE}?again=1`, { headers: { cookie: c.cookie } }),
      env,
      db,
      product,
      NOW,
    );
    const againHtml = await again.text();
    expect(againHtml).toContain("Check the details, then choose again.");
    const current = /name="token" value="([^"]+)"/.exec(againHtml)![1]!;
    // A token minted for ANOTHER flow is foreign.
    const other = await atApprovalPage(await startFlow("tv-9", "Other"));
    const foreign = await postApprove(c.cookie, {
      token: other.token,
      decision: "approve",
    });
    expect(foreign.status).toBe(303);
    await untouched(c);
    // The current token still works once, and a replay of it is refused.
    const ok = await postApprove(c.cookie, {
      token: current,
      decision: "approve",
    });
    expect(ok.status).toBe(200);
    const replay = await postApprove(c.cookie, {
      token: current,
      decision: "approve",
    });
    expect(replay.status).toBe(403);
  });

  it("an expired flow is 'Start again' and approves nothing", async () => {
    const { c, token } = await atApprovalPage();
    await artefacts(env).delete(await flowKey(env, "djdl", c.state));
    const res = await postApprove(c.cookie, { token, decision: "approve" });
    expect(res.status).toBe(403);
    expect((await poll(c)).status).toBe("timeout");
    expect(await count("devices")).toBe(0);
  });

  it("a flow confirmed but not signed in has no page", async () => {
    const c = await confirmCode(await startFlow());
    expect((await getApprove(c.cookie)).status).toBe(403);
    const res = await postApprove(c.cookie, {
      token: "x",
      decision: "approve",
    });
    expect(res.status).toBe(403);
    expect((await flowOf(c))!.approvedAt).toBeUndefined();
  });

  it("a request handle or __Host-pk_req alone is not an approval", async () => {
    const { c, token } = await atApprovalPage();
    for (const cookie of [
      "__Host-pk_req=anything",
      "__Host-pk_req=anything; __Host-pk_lcb=short",
    ]) {
      const res = await postApprove(cookie, { token, decision: "approve" });
      expect(res.status).toBe(403);
    }
    await untouched(c);
  });

  it("the label, user code, state and handle cannot approve: only the token does", async () => {
    const { c, token } = await atApprovalPage();
    const res = await postApprove(c.cookie, {
      decision: "approve",
      deviceName: "Evil",
      user_code: c.userCode,
      state: c.state,
      request: "handle",
      approvedAt: "1",
    });
    expect(res.status).toBe(303);
    await untouched(c);
    expect(token).toBeTruthy();
  });

  it("the device code and a user code do not find the flow on /device/verify", async () => {
    const { c } = await atApprovalPage();
    const res = await handleAuthDeviceVerify(
      req(
        `${ORIGIN}/djdl/identity/auth/device/verify?device_code=${c.deviceCode}`,
        {
          method: "POST",
          headers: { ...FORM, cookie: c.cookie },
          body: "decision=approve",
        },
      ),
    );
    expect(res.status).toBe(403);
    await untouched(c);
  });

  it("the chooser's index is the only way in: a cookie whose index is gone is 'Start again'", async () => {
    const { c, token } = await atApprovalPage();
    const binder = c.cookie.split("=")[1]!;
    await artefacts(env).delete(
      choiceKey("djdl", await hashKey(binder, env.KEY_HASH_PEPPER)),
    );
    const res = await postApprove(c.cookie, { token, decision: "approve" });
    expect(res.status).toBe(403);
    await untouched(c);
  });
});

describe("races: exactly one outcome", () => {
  it("approve against approve", async () => {
    const { c, token } = await atApprovalPage();
    const [a, b] = await Promise.all([
      postApprove(c.cookie, { token, decision: "approve" }),
      postApprove(c.cookie, { token, decision: "approve" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 303]);
    expect((await poll(c)).status).toBe("ready");
    expect(await count("devices")).toBe(1);
  });

  it("approve against deny", async () => {
    const { c, token } = await atApprovalPage();
    const [a, b] = await Promise.all([
      postApprove(c.cookie, { token, decision: "approve" }),
      postApprove(c.cookie, { token, decision: "deny" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 303]);
    const out = (await poll(c)).status;
    // Whichever won, the loser changed nothing: ready with one device, or error with none.
    if (out === "ready") expect(await count("devices")).toBe(1);
    else {
      expect(out).toBe("error");
      expect(await count("devices")).toBe(0);
    }
  });

  it("approve against expiry", async () => {
    const { c, token } = await atApprovalPage();
    await artefacts(env).delete(await flowKey(env, "djdl", c.state));
    const res = await postApprove(c.cookie, { token, decision: "approve" });
    expect(res.status).toBe(403);
    expect((await poll(c)).status).toBe("timeout");
  });

  it("a poll during approval sees pending, then ready", async () => {
    const { c, token } = await atApprovalPage();
    const [polled, approved] = await Promise.all([
      poll(c),
      postApprove(c.cookie, { token, decision: "approve" }),
    ]);
    expect(approved.status).toBe(200);
    expect(["pending", "ready"]).toContain(polled.status);
    if (polled.status === "pending")
      expect((await poll(c)).status).toBe("ready");
    expect(await count("devices")).toBe(1);
  });
});

describe("legacy records fail closed", () => {
  it("a record with a device id but no viaDeviceCode reaches the approval page and never activates", async () => {
    const c = await confirmCode(await startFlow());
    const key = await flowKey(env, "djdl", c.state);
    const flow = JSON.parse((await artefacts(env).get(key))!);
    delete flow.viaDeviceCode;
    await artefacts(env).put(key, JSON.stringify(flow));
    const licenses = await count("licenses");
    const cb = await callback(c);
    expect(cb.status).toBe(303);
    expect(cb.headers.get("location")).toBe(APPROVE);
    expect(await count("licenses")).toBe(licenses);
    expect((await poll(c)).status).toBe("pending");
    expect((await getApprove(c.cookie)).status).toBe(200);
  });

  it("a malformed approvedAt is unapproved", async () => {
    const { c } = await atApprovalPage();
    const key = await flowKey(env, "djdl", c.state);
    const flow = JSON.parse((await artefacts(env).get(key))!);
    for (const bad of ["yes", true, null, {}]) {
      await artefacts(env).put(
        key,
        JSON.stringify({ ...flow, approvedAt: bad }),
      );
      expect((await poll(c)).status, JSON.stringify(bad)).toBe("pending");
    }
  });
});

describe("the other routes", () => {
  it("/device/verify answers start-again and reads nothing", async () => {
    const s = await startFlow();
    const before = await artefacts(env).get(
      await deviceFlowKey(env, "djdl", s.deviceCode),
    );
    const res = await handleAuthDeviceVerify(
      req(
        `${ORIGIN}/djdl/identity/auth/device/verify?device_code=${s.deviceCode}`,
      ),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Start again on your device");
    expect(
      await artefacts(env).get(await deviceFlowKey(env, "djdl", s.deviceCode)),
    ).toBe(before);
  });

  it("neither entry page names the product before the code resolves (B9.3)", async () => {
    const own = await handleAuthDeviceEntry(
      req(`${ORIGIN}/djdl/identity/auth/device`),
      env,
      product,
    );
    const html = await own.text();
    expect(html).toContain("Enter the code from your device");
    expect(html).toContain(
      "Only use a code your own device shows, not one somebody sent you.",
    );
    // No app strip, no app name: the form's own action URL is the only place the slug appears.
    expect(html).not.toContain('<div class="ac-head">');
    expect(html).not.toContain("<bdi>");
  });

  it("before sign-in the confirmation approves nothing: Continue to sign in", async () => {
    const s = await startFlow();
    const page = await handleAuthDeviceEntry(
      req(`${ORIGIN}/djdl/identity/auth/device?user_code=${s.userCode}`),
      env,
      product,
    );
    const html = await page.text();
    expect(html).toContain("Continue to sign in");
    expect(html).not.toMatch(/Sign in on /);
  });

  it("authDeviceApprove is limited per network (60 a minute) and fails closed", async () => {
    let last = 200;
    for (let i = 0; i < 61; i++) {
      const res = await getApprove(null, { "cf-connecting-ip": "203.0.113.5" });
      last = res.status;
    }
    expect(last).toBe(429);
    // Another network is unaffected.
    expect(
      (await getApprove(null, { "cf-connecting-ip": "203.0.113.6" })).status,
    ).toBe(403);
    // With the limiter unreachable the step refuses rather than opening up.
    env.RL = {
      idFromName: () => "x",
      get: () => {
        throw new Error("limiter down");
      },
    } as unknown as Env["RL"];
    const down = await getApprove(null, { "cf-connecting-ip": "203.0.113.7" });
    expect(down.status).toBe(429);
  });
});

describe("what the page shows", () => {
  it("shows the app, account, device, code, place and expiry, and posts only a token", async () => {
    const { html, c, page } = await atApprovalPage();
    expect(html).toContain("Sign in on \u2068Living room PC\u2069?");
    // Initial focus is the heading, so a carried-over Enter cannot approve unread.
    expect(html).toContain('<h1 tabindex="-1" autofocus>');
    expect(html).not.toContain("autofocus><span>");
    expect(html).toContain('name="decision" value="deny">Deny</button>');
    expect(html).not.toContain("Not you?");
    expect(html).toContain("Only sign in if");
    expect(html).toContain("Didn't start this? Deny.");
    expect(html).toContain("Ada");
    expect(html).toContain("ada@example.com");
    expect(html).toContain(`<span class="code">${c.userCode}</span>`);
    expect(html).toMatch(/just now from Portugal/);
    expect(html).toContain("wants you to sign in");
    expect(html).toContain('class="ac-passport"');
    expect(html).toContain("Polaris Locker signs you in for");
    expect(html).not.toMatch(/<script|\sstyle=/i);
    // No secret and no handle: not the device code, `state`, the nonce, or the binder.
    for (const secret of [
      c.deviceCode,
      c.state,
      c.nonce,
      c.cookie.split("=")[1]!,
    ])
      expect(html).not.toContain(secret);
    expect(html).not.toContain("data-request");
    // The user agent, platform, version, IP and device id are never shown.
    expect(html).not.toContain("tv-1");
    expect(page.headers.get("location")).toBeNull();
  });

  it("headers: no-store, no-referrer, frame-ancestors none, form-action self", async () => {
    const { page } = await atApprovalPage();
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("form-action 'self' https:");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });

  it("the device label is escaped, normalised, and the redirect carries nothing", async () => {
    const started = await startFlow("tv-xss", '<img src=x onerror="alert(1)">');
    const c = await confirmCode(started);
    const cb = await callback(c);
    expect(cb.headers.get("location")).toBe(APPROVE);
    expect(cb.headers.get("cache-control")).toBe("no-store");
    expect(cb.headers.get("referrer-policy")).toBe("no-referrer");
    // Not the device code, `state` or any handle in the Location.
    for (const secret of [c.deviceCode, c.state, c.userCode])
      expect(cb.headers.get("location")).not.toContain(secret);
    const html = await (await getApprove(c.cookie)).text();
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain("&lt;img src=x");
    // A device that sent no label is "Unnamed device".
    const bare = await confirmCode(await startFlow("tv-bare", ""));
    await callback(bare);
    expect(await (await getApprove(bare.cookie)).text()).toContain(
      "Sign in on \u2068Unnamed device\u2069?",
    );
  });

  it("the mismatch callout shows when the countries differ or either is unknown, and only then", async () => {
    // Started in PT.
    const same = await atApprovalPage();
    // The approver's request carries no country: unknown, so the callout shows.
    expect(same.html).toContain("This sign-in started in Portugal.");
    expect(same.html).not.toContain("not where you are");
    expect(same.html).toContain("Only continue if");
    const sameRes = await getApprove(same.c.cookie, { "cf-ipcountry": "PT" });
    expect(await sameRes.text()).not.toContain("not where you are");
    const elsewhere = await getApprove(same.c.cookie, { "cf-ipcountry": "US" });
    expect(await elsewhere.text()).toContain("not where you are");
    // A start with no place at all.
    const nowhere = await confirmCode(await startFlow("tv-x", "Box", "XX"));
    await callback(nowhere);
    const html = await (
      await getApprove(nowhere.cookie, { "cf-ipcountry": "PT" })
    ).text();
    expect(html).toContain("We can&#x27;t tell where this sign-in started.");
    expect(html).not.toMatch(/Started .* from /);
  });

  it("the place comes from the edge only: client headers and body cannot set it", async () => {
    const res = await handleAuthDeviceStart(
      req(`${ORIGIN}/djdl/identity/auth/device/start`, {
        method: "POST",
        headers: {
          "cf-ipcountry": "PT",
          "x-forwarded-for": "8.8.8.8",
          "x-pkey-country": "FR",
        },
        body: JSON.stringify({
          deviceId: "tv-p",
          deviceName: "Box",
          startPlace: { country: "FR", label: "Paris, France" },
          country: "FR",
        }),
      }),
      env,
      db,
      product,
    );
    const body = (await res.json()) as { deviceCode: string; userCode: string };
    const c = await confirmCode({
      deviceCode: body.deviceCode,
      userCode: body.userCode,
      deviceId: "tv-p",
    });
    await callback(c);
    const flow = await flowOf(c);
    expect(flow!.startPlace).toEqual({ country: "PT", label: "Portugal" });
    const html = await (await getApprove(c.cookie)).text();
    expect(html).not.toContain("Paris");
  });
});

describe("the compare-and-sets pin their expectations (each fails if its check is removed)", () => {
  async function setFlow(c: Confirmed, over: Record<string, unknown>) {
    const key = await flowKey(env, "djdl", c.state);
    const flow = JSON.parse((await artefacts(env).get(key))!);
    await artefacts(env).put(key, JSON.stringify({ ...flow, ...over }));
    return { key, flow: { ...flow, ...over } };
  }

  it("a page bound to another browser's binder is 'Start again' (binder equality)", async () => {
    const { c } = await atApprovalPage();
    await setFlow(c, {
      binder: await hashKey("someone-else", env.KEY_HASH_PEPPER),
    });
    expect((await getApprove(c.cookie)).status).toBe(403);
    expect(
      (await postApprove(c.cookie, { token: "x", decision: "approve" })).status,
    ).toBe(403);
  });

  it("decide refuses a flow already denied, even with the current token", async () => {
    const { c, token } = await atApprovalPage();
    const { key, flow } = await setFlow(c, { error: "denied" });
    const ok = await decideDeviceFlow(
      env,
      db,
      product,
      key,
      flow,
      await hashKey(token, env.KEY_HASH_PEPPER),
      "approve",
      NOW,
    );
    expect(ok).toBe(false);
    expect(
      JSON.parse((await artefacts(env).get(key))!).approvedAt,
    ).toBeUndefined();
  });

  it("decide refuses a flow already approved, so a deny cannot overwrite it", async () => {
    const { c, token } = await atApprovalPage();
    const { key, flow } = await setFlow(c, { approvedAt: NOW });
    const ok = await decideDeviceFlow(
      env,
      db,
      product,
      key,
      flow,
      await hashKey(token, env.KEY_HASH_PEPPER),
      "deny",
      NOW,
    );
    expect(ok).toBe(false);
    expect(JSON.parse((await artefacts(env).get(key))!).error).toBeUndefined();
  });

  it("a chooser Cancel cannot deny a flow that was already approved", async () => {
    const { c } = await atApprovalPage();
    const { key, flow } = await setFlow(c, { approvedAt: NOW });
    expect(await denyChosenDeviceFlow(env, db, product, key, flow, NOW)).toBe(
      false,
    );
    expect(JSON.parse((await artefacts(env).get(key))!).error).toBeUndefined();
  });
});

describe("the endings are pages", () => {
  it("not entitled is a Locker refusal page, not JSON", async () => {
    await db
      .run(
        "UPDATE products SET auto_issue_json = NULL, default_tier_json = NULL WHERE slug = 'djdl'",
      )
      .catch(() => undefined);
    const c = await confirmCode(await startFlow());
    const res = await callback(c, c.cookie, { ...PERSON, groups: ["randos"] });
    {
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("You can&#x27;t sign in here");
    }
  });

  it("the done page names the app and where to look", async () => {
    const { c, token } = await atApprovalPage();
    const done = await postApprove(c.cookie, { token, decision: "approve" });
    const html = await done.text();
    expect(html).toContain("is signed in on");
    expect(html).toContain("it continues by itself.");
    expect(html).toContain("You can close this page.");
    expect(html).not.toContain("<title>Sign in on");
  });

  it("the page title carries no bidi isolates", async () => {
    const { html } = await atApprovalPage();
    const title = /<title>([^<]*)<\/title>/.exec(html)![1]!;
    expect(title).not.toMatch(/[\u2068\u2069]/);
  });
});
