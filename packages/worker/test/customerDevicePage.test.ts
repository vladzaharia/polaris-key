// LXF-DEV (supersedes LK-04 A1's same-host exception): the device-code pages on the customer host.
// `/device` and `/tv` find the product through the global index and carry on THEIR OWN host: a live
// code goes straight to sign-in (no confirm page), and the approval, denied and done pages are
// served at `<customer>/device/approve`. The only hops are the two the host-only `__Host-` binder
// needs: the customer host hands it to the API host for the IdP's callback (a single-use bind
// token, 120 s) and the callback hands it back for the approval. A forwarded link still cannot
// complete a flow in another browser: the binder is set only in the browser that opened the code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { issuerMetadataResponse } from "./oidcIssuerFake.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { dispatchWith } from "../src/dispatch.js";
import {
  serializeServices,
  SERVICE_SLUGS,
  type ServicesMap,
} from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

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

const API = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";

let db: SqliteDb;
let env: Env;
let priv: CryptoKey;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), ["djdl"]);
  env.CONSOLE_ORIGIN = API;
  env.CUSTOMER_ORIGIN = CUSTOMER;
  await seedProduct(db, "djdl");
  const map = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [
      s,
      { enabled: ["license", "config", "identity"].includes(s) },
    ]),
  ) as ServicesMap;
  await setServices(
    db,
    "djdl",
    serializeServices({ services: map }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "custom",
    "https://id.example",
    "client-djdl",
    null,
    JSON.stringify([`${API}/djdl/identity/auth/callback`]),
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
  const pair = await generateKeyPair("ES256", { extractable: true });
  priv = pair.privateKey;
  idpKey.getKey = async () =>
    importJWK(
      { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "test-idp" },
      "ES256",
    );
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
          .setIssuer("https://id.example")
          .setAudience("client-djdl")
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

const send = (url: string, init: RequestInit = {}) =>
  dispatchWith(new Request(url, init), env, db, NOW);

async function start() {
  const res = await send(`${API}/djdl/identity/auth/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "tv-1" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
  };
}

const same = { "sec-fetch-site": "same-origin" };
const cookieOf = (res: Response) =>
  res.headers.get("set-cookie")!.split(";")[0]!;

/** The customer host opens a live code, the hop hands the binder to the API host, and the browser
 *  is at the IdP: the confirming browser's cookies, the flow's `state` and `nonce`. */
async function signInStarted(
  f: { userCode: string },
  suffix = "",
  path = "/device",
) {
  const open = await send(
    `${CUSTOMER}${path}?user_code=${f.userCode}${suffix}`,
    {
      headers: same,
    },
  );
  expect(open.status).toBe(303);
  const hop = await send(open.headers.get("location")!);
  expect(hop.status).toBe(303);
  const authorize = new URL(hop.headers.get("location")!);
  return {
    open,
    hop,
    apiCookie: cookieOf(hop),
    state: authorize.searchParams.get("state")!,
    nonce: authorize.searchParams.get("nonce")!,
  };
}

const PERSON = {
  sub: "person-sub",
  email: "ada@example.com",
  email_verified: true,
  name: "Ada",
  groups: ["members"],
};

/** The IdP's callback on the API host, then the approval hop to the customer host. */
async function atApproval(f: { userCode: string }) {
  const s = await signInStarted(f);
  installIdp({ ...PERSON, nonce: s.nonce });
  const cb = await send(
    `${API}/djdl/identity/auth/callback?code=c&state=${s.state}`,
    { headers: { cookie: s.apiCookie } },
  );
  expect(cb.status).toBe(303);
  const hop = await send(cb.headers.get("location")!);
  expect(hop.status).toBe(303);
  const cookie = cookieOf(hop);
  const page = await send(`${CUSTOMER}${hop.headers.get("location")}`, {
    headers: { cookie },
  });
  return { s, cb, hop, cookie, page };
}

describe("the device pages on the customer host", () => {
  it("start hands out the customer host's page", async () => {
    const f = await start();
    expect(f.verificationUri).toBe(`${CUSTOMER}/device`);
    expect(f.verificationUriComplete).toBe(
      `${CUSTOMER}/device?user_code=${f.userCode}`,
    );
  });

  it("a live code goes straight to sign-in: a 303 to the bind hop, no page, no cookie, no code in the URL", async () => {
    const f = await start();
    for (const path of ["/device", "/tv"]) {
      const g = path === "/device" ? f : await start();
      const res = await send(
        `${CUSTOMER}${path}?user_code=${g.userCode.toLowerCase()}`,
        { headers: same },
      );
      expect(res.status).toBe(303);
      const to = new URL(res.headers.get("location")!);
      // The API host's bind hop, built from configuration: the token is the only thing in the query.
      expect(to.origin + to.pathname).toBe(`${API}/djdl/identity/auth/device`);
      expect([...to.searchParams.keys()]).toEqual(["bind"]);
      expect(to.searchParams.get("bind")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers.get("location")).not.toContain(g.userCode);
      // __Host- cookies are host-only: nothing is set on the customer host for the IdP leg.
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("the hop sets the binder on the API host and goes to the IdP; the token works once", async () => {
    const f = await start();
    const open = await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
      headers: same,
    });
    const hopUrl = open.headers.get("location")!;
    const hop = await send(hopUrl);
    expect(hop.status).toBe(303);
    expect(new URL(hop.headers.get("location")!).origin).toBe(
      "https://id.example",
    );
    expect(hop.headers.get("set-cookie")).toMatch(
      /^__Host-pk_lcb=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(hop.headers.get("referrer-policy")).toBe("no-referrer");
    // A second visit (a replay, a forwarded copy of the hop URL) gets the generic page and no cookie.
    const again = await send(hopUrl);
    expect(again.status).toBe(403);
    expect(again.headers.get("set-cookie")).toBeNull();
    // The code is spent: the entry says so.
    expect(
      (
        await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
          headers: same,
        })
      ).status,
    ).toBe(404);
  });

  it("a link followed from another site, or prefetched, starts nothing: the form with the code filled in", async () => {
    const f = await start();
    for (const headers of [
      { "sec-fetch-site": "cross-site" } as Record<string, string>,
      { "sec-purpose": "prefetch" },
    ]) {
      const res = await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
        headers,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`value="${f.userCode}"`);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    // The code was not spent: the same-origin press goes on.
    expect(
      (
        await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
          headers: same,
        })
      ).status,
    ).toBe(303);
  });

  it("serves the form with no code, names no product on a miss, and takes no POST", async () => {
    await start();
    expect((await send(`${CUSTOMER}/device`)).status).toBe(200);
    const miss = await send(`${CUSTOMER}/device?user_code=BBBBBBBB`, {
      headers: same,
    });
    expect(miss.status).toBe(404);
    expect((await miss.text()).toLowerCase()).not.toContain("djdl");
    expect(
      (
        await send(`${CUSTOMER}/device`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "user_code=BBBBBBBB",
        })
      ).status,
    ).toBe(405);
  });

  it("the entry form stays on the customer host: form-action is 'self' only", async () => {
    await start();
    for (const path of ["/device", "/tv", "/device?user_code=BBBBBBBB"]) {
      const res = await send(`${CUSTOMER}${path}`, { headers: same });
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("form-action 'self';");
      expect(csp).not.toContain(API);
    }
  });

  it("the product path stays unreachable on the customer host", async () => {
    expect((await send(`${CUSTOMER}/djdl/identity/auth/device`)).status).toBe(
      404,
    );
    expect(
      (await send(`${CUSTOMER}/djdl/identity/auth/device/approve`)).status,
    ).toBe(404);
  });

  it("the API host's product page forwards to the customer host and never shows the old confirm", async () => {
    const f = await start();
    const res = await send(
      `${API}/djdl/identity/auth/device?user_code=${f.userCode}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${CUSTOMER}/device?user_code=${f.userCode}`,
    );
    const tv = await send(`${API}/djdl/identity/auth/device?tv=1`);
    expect(tv.headers.get("location")).toBe(`${CUSTOMER}/tv`);
    // The forward is a GET only, and never lands on a host the request names.
    const evil = await send(`${API}/djdl/identity/auth/device?user_code=x`, {
      headers: { host: "evil.example" },
    });
    expect(new URL(evil.headers.get("location")!).origin).toBe(CUSTOMER);
  });

  it("/device/approve exists on the customer host only", async () => {
    expect((await send(`${API}/device/approve`)).status).toBe(404);
    expect((await send(`${CUSTOMER}/device/approve`)).status).toBe(403);
  });

  it("the IdP's callback hands the binder back to the customer host with a single-use token and sets no cookie", async () => {
    const { cb, hop } = await atApproval(await start());
    const to = new URL(cb.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(`${CUSTOMER}/device/approve`);
    expect([...to.searchParams.keys()]).toEqual(["bind"]);
    expect(cb.headers.get("set-cookie")).toBeNull();
    // The hop cookie is the customer host's own: host-only, Secure, HttpOnly, flow-lived.
    expect(hop.headers.get("set-cookie")).toMatch(
      /^__Host-pk_lcb=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(hop.headers.get("location")).toBe("/device/approve");
    // Spent: the same URL again is the generic page, with no cookie.
    const replay = await send(cb.headers.get("location")!);
    expect(replay.status).toBe(403);
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  it("the approval page is served on the customer host, posts back to it, and names no API host", async () => {
    const { page, cookie } = await atApproval(await start());
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Sign in on");
    expect(html).toContain(`action="${CUSTOMER}/device/approve"`);
    expect(html).not.toContain("key.plrs.im");
    expect(html).toMatch(/start this\? Deny/);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action 'self'",
    );
    // The page is reached through the binder alone: no cookie, no page.
    const bare = await send(`${CUSTOMER}/device/approve`);
    expect(bare.status).toBe(403);
    void cookie;
  });

  it("approve and deny take the single-use token, the binder and a same-origin POST, and nothing else", async () => {
    const { page, cookie } = await atApproval(await start());
    const token = /name="token" value="([^"]+)"/.exec(await page.text())![1]!;
    const post = (headers: Record<string, string>, c: string | null = cookie) =>
      send(`${CUSTOMER}/device/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(c ? { cookie: c } : {}),
          ...headers,
        },
        body: new URLSearchParams({ token, decision: "approve" }).toString(),
      });
    // Another site, the API host's origin, or a forged Origin: refused before anything is read.
    for (const headers of [
      { "sec-fetch-site": "cross-site" } as Record<string, string>,
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example" },
      { origin: API },
    ]) {
      const res = await post(headers);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("This page has expired");
    }
    // No binder: refused.
    expect((await post(same, null)).status).toBe(403);
    // A different browser's binder: refused.
    expect((await post(same, "__Host-pk_lcb=" + "A".repeat(43))).status).toBe(
      403,
    );
    // The flow is still undecided: the same-origin press with the binder wins.
    const ok = await post({ origin: CUSTOMER });
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("is signed in on");
    expect(html).not.toContain("key.plrs.im");
    // The binder is dropped with the flow.
    expect(ok.headers.get("set-cookie")).toMatch(
      /^__Host-pk_lcb=; Path=\/; Max-Age=0;/,
    );
    // A replay finds nothing.
    expect((await post(same)).status).toBe(403);
  });

  it("Deny ends the sign-in on the customer host", async () => {
    const { page, cookie } = await atApproval(await start());
    const token = /name="token" value="([^"]+)"/.exec(await page.text())![1]!;
    const res = await send(`${CUSTOMER}/device/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        ...same,
      },
      body: new URLSearchParams({ token, decision: "deny" }).toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign-in denied");
    expect(html).not.toContain("key.plrs.im");
  });

  it("no customer origin: the old behaviour, a relative 302 to the product's page", async () => {
    delete env.CUSTOMER_ORIGIN;
    const f = await start();
    const res = await send(`${API}/device?user_code=${f.userCode}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/djdl/identity/auth/device?user_code=${f.userCode}`,
    );
    const form = await send(`${API}/device`);
    expect(form.headers.get("content-security-policy")).toContain(
      "form-action 'self';",
    );
  });
});
