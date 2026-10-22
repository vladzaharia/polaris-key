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
import { flowKey } from "../src/services/identity/productOidc/config.js";
import { getArtefact, updateArtefact } from "../src/core/singleUse.js";
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
/** A person's own navigation: the device's link, a typed address, a bookmark. */
const nav = {
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};
/** The code form's GET submission on the customer host. */
const formNav = { ...nav, "sec-fetch-site": "same-origin" };
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
      headers: nav,
    },
  );
  expect(open.status).toBe(303);
  const hop = await send(open.headers.get("location")!);
  expect(hop.status).toBe(303);
  const authorize = new URL(hop.headers.get("location")!);
  return {
    open,
    hop,
    customerCookie: cookieOf(open),
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
  const hop = await send(cb.headers.get("location")!, {
    headers: { cookie: s.customerCookie },
  });
  expect(hop.status).toBe(303);
  const cookie = s.customerCookie;
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
        { headers: nav },
      );
      expect(res.status).toBe(303);
      const to = new URL(res.headers.get("location")!);
      // The API host's bind hop, built from configuration: the token is the only thing in the query.
      expect(to.origin + to.pathname).toBe(`${API}/djdl/identity/auth/device`);
      expect([...to.searchParams.keys()]).toEqual(["bind"]);
      expect(to.searchParams.get("bind")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers.get("location")).not.toContain(g.userCode);
      // The customer host's own binder (host-only), so only this browser reaches the approval.
      expect(res.headers.get("set-cookie")).toMatch(/^__Host-pk_lcb=/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("the hop sets the binder on the API host and goes to the IdP; the token works once", async () => {
    const f = await start();
    const open = await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
      headers: nav,
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
    // N6: it goes back to the customer host (from configuration), not to a key.plrs.im page.
    const again = await send(hopUrl);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(`${CUSTOMER}/device/approve`);
    expect(again.headers.get("set-cookie")).toBeNull();
    // The code is spent: the entry says so.
    expect(
      (
        await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
          headers: nav,
        })
      ).status,
    ).toBe(404);
  });

  it("only a person's own navigation starts a sign-in: everything else gets the form with the code unspent (B3)", async () => {
    const f = await start();
    const cases: Record<string, string>[] = [
      {}, // no Fetch Metadata at all: a link scanner, an unfurler, curl
      { "user-agent": "Slackbot-LinkExpanding 1.0" },
      { ...nav, "sec-fetch-site": "cross-site" },
      { ...nav, "sec-fetch-site": "same-site" },
      { ...nav, "sec-fetch-mode": "no-cors" },
      { ...nav, "sec-fetch-mode": "cors" },
      { ...nav, "sec-fetch-dest": "iframe" },
      { ...nav, "sec-fetch-dest": "image" },
      { "sec-fetch-site": "same-origin" }, // a forged half
      { ...nav, "sec-purpose": "prefetch" },
      { ...nav, "sec-purpose": "prefetch;prerender" },
      { ...nav, purpose: "prefetch" },
      { ...nav, "x-purpose": "preview" },
      { ...nav, "x-moz": "prefetch" },
    ];
    for (const headers of cases) {
      const res = await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
        headers,
      });
      expect(res.status, JSON.stringify(headers)).toBe(200);
      const html = await res.text();
      expect(html).toContain(`value="${f.userCode}"`);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    // The code was never spent: the person's own click goes on.
    expect(
      (
        await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
          headers: nav,
        })
      ).status,
    ).toBe(303);
  });

  it("a typed code (the form's own GET) answers 200 with a meta refresh to the hop, never a redirect chain (B2)", async () => {
    const f = await start();
    const res = await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
      headers: formNav,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // form-action stays 'self': it is not widened to carry the chain.
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("form-action 'self';");
    expect(csp).not.toContain(API);
    const html = await res.text();
    const meta = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(
      html,
    )![1]!;
    expect(meta.startsWith(`${API}/djdl/identity/auth/device?bind=`)).toBe(
      true,
    );
    expect(html).toContain(`href="${meta}"`);
    expect(html).toContain("Continue");
    // The customer host's own binder rides on this response.
    expect(res.headers.get("set-cookie")).toMatch(
      /^__Host-pk_lcb=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
    // The hop works from the page's link.
    expect((await send(meta)).status).toBe(303);
  });

  it("a hop URL handed to another browser does not bind it: no customer-host binder, no approval (B1)", async () => {
    const f = await start();
    // The attacker opens its own code and keeps the hop URL.
    const open = await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
      headers: nav,
    });
    const attackerCookie = cookieOf(open);
    const hopUrl = open.headers.get("location")!;
    // The victim's browser follows the hop (no customer-host cookie) and signs in at the IdP.
    const hop = await send(hopUrl, {
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
    });
    expect(hop.status).toBe(303);
    const authorize = new URL(hop.headers.get("location")!);
    installIdp({ ...PERSON, nonce: authorize.searchParams.get("nonce") });
    const cb = await send(
      `${API}/djdl/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
      { headers: { cookie: cookieOf(hop) } },
    );
    expect(cb.status).toBe(303);
    const approveHop = cb.headers.get("location")!;
    // Victim browser: no customer-host binder.
    const victim = await send(approveHop);
    expect(victim.status).toBe(403);
    expect(victim.headers.get("set-cookie")).toBeNull();
    expect(await victim.text()).toContain("This page has expired");
    // The attacker's own browser cannot use the spent token either.
    const spent = await send(approveHop, {
      headers: { cookie: attackerCookie },
    });
    expect(spent.status).toBe(403);
  });

  it("the same browser that opened the code reaches its approval page (B1)", async () => {
    const f = await start();
    const open = await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
      headers: nav,
    });
    const own = cookieOf(open);
    const hop = await send(open.headers.get("location")!);
    const authorize = new URL(hop.headers.get("location")!);
    installIdp({ ...PERSON, nonce: authorize.searchParams.get("nonce") });
    const cb = await send(
      `${API}/djdl/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
      { headers: { cookie: cookieOf(hop) } },
    );
    const step = await send(cb.headers.get("location")!, {
      headers: { cookie: own },
    });
    expect(step.status).toBe(303);
    expect(step.headers.get("set-cookie")).toBeNull();
    const page = await send(`${CUSTOMER}${step.headers.get("location")}`, {
      headers: { cookie: own },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Sign in on");
    // N7: the always-on device check line.
    expect(html).toContain("Check that your device shows this code.");
  });

  it("the API host takes no confirm POST once the customer host is on (N1)", async () => {
    const f = await start();
    const res = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...same },
      body: `user_code=${f.userCode}`,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${CUSTOMER}/device`);
    expect(await res.text()).not.toContain('name="csrf"');
  });

  it("a surrogate split in the typed code does not throw on the API forward (N8)", async () => {
    const typed = "a".repeat(63) + "\u{1F600}";
    const res = await send(
      `${API}/djdl/identity/auth/device?user_code=${encodeURIComponent(typed)}`,
    );
    expect(res.status).toBe(302);
  });

  it("serves the form with no code, names no product on a miss, and takes no POST", async () => {
    await start();
    expect((await send(`${CUSTOMER}/device`)).status).toBe(200);
    const miss = await send(`${CUSTOMER}/device?user_code=BBBBBBBB`, {
      headers: nav,
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
    const { cb, hop, cookie } = await atApproval(await start());
    const to = new URL(cb.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(`${CUSTOMER}/device/approve`);
    expect([...to.searchParams.keys()]).toEqual(["bind"]);
    expect(cb.headers.get("set-cookie")).toBeNull();
    // The hop cookie is the customer host's own: host-only, Secure, HttpOnly, flow-lived.
    // The cookie is the one set when the code was opened: the hop sets nothing, it only checks it.
    expect(hop.headers.get("set-cookie")).toBeNull();
    expect(hop.headers.get("location")).toBe("/device/approve");
    // Spent: the same URL again is the generic page, with no cookie.
    const replay = await send(cb.headers.get("location")!, {
      headers: { cookie },
    });
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

  // R2-B1 (the second review round): the customer host holds its OWN secret C. B, the API
  // host's binder, is never in a customer-host response, so a cookie the starter keeps from the
  // start response unlocks nothing once the victim's browser does the IdP leg.
  describe("two binders: B on the API host, C on the customer host (R2-B1)", () => {
    const post = (url: string, headers: Record<string, string>, body = "") =>
      send(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body,
      });
    async function startWithDeviceCode() {
      const res = await send(`${API}/djdl/identity/auth/device/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "tv-1" }),
      });
      return (await res.json()) as { userCode: string; deviceCode: string };
    }
    const poll = async (deviceCode: string) =>
      (await (
        await send(`${API}/djdl/identity/auth/device/poll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode, deviceId: "tv-1" }),
        })
      ).json()) as { status: string; token?: string };

    it("the starter keeps its cookie and the hop URL; the victim does the IdP leg; the starter decides nothing", async () => {
      const f = await startWithDeviceCode();
      // The starter opens its own code with curl and keeps cookie C and the hop URL.
      const open = await send(`${CUSTOMER}/device?user_code=${f.userCode}`, {
        headers: nav,
      });
      const attacker = cookieOf(open);
      const hopUrl = open.headers.get("location")!;
      // A page the victim visits navigates the top level to the hop; silent IdP sign-in follows.
      const hop = await send(hopUrl, {
        headers: {
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      });
      const victimB = cookieOf(hop);
      expect(victimB).not.toBe(attacker);
      const authorize = new URL(hop.headers.get("location")!);
      installIdp({ ...PERSON, nonce: authorize.searchParams.get("nonce") });
      const cb = await send(
        `${API}/djdl/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
        { headers: { cookie: victimB } },
      );
      expect(cb.status).toBe(303);
      // B (its value) appears in no customer-host response: not the start response, not the
      // body, not a URL, and not the callback's hop.
      const bValue = victimB.split("=")[1]!;
      expect(open.headers.get("set-cookie")).not.toContain(bValue);
      expect(open.headers.get("location")).not.toContain(bValue);
      expect(cb.headers.get("location")).not.toContain(bValue);
      // The victim's browser (B, no C) is stopped at the customer host.
      const victim = await send(cb.headers.get("location")!, {
        headers: { cookie: victimB },
      });
      expect(victim.status).toBe(403);

      // The starter, with C and no Origin (curl), at the API host's approval route: it never
      // decides. GET goes to the customer page, POST is not found.
      const apiGet = await send(`${API}/djdl/identity/auth/device/approve`, {
        headers: { cookie: attacker },
      });
      expect(apiGet.status).toBe(303);
      expect(apiGet.headers.get("location")).toBe(`${CUSTOMER}/device/approve`);
      expect(await apiGet.text()).not.toContain('name="token"');
      for (const c of [attacker, victimB]) {
        const apiPost = await post(
          `${API}/djdl/identity/auth/device/approve`,
          { cookie: c },
          new URLSearchParams({ token: "x", decision: "approve" }).toString(),
        );
        expect(apiPost.status).toBe(404);
      }
      // The customer host: C was never registered for an approval, so it finds nothing.
      const page = await send(`${CUSTOMER}/device/approve`, {
        headers: { cookie: attacker },
      });
      expect(page.status).toBe(403);
      expect(await page.text()).not.toContain('name="token"');
      // The chooser (API host), with either cookie: refused, and B alone is not enough.
      for (const c of [attacker, victimB]) {
        const choose = await send(`${API}/djdl/identity/auth/choose`, {
          headers: { cookie: c },
        });
        expect(choose.status).toBe(403);
      }
      // The starter's poll stays pending.
      expect((await poll(f.deviceCode)).status).toBe("pending");
    });

    it("the chooser for a device flow opens only after C was shown on the customer host", async () => {
      const f = await startWithDeviceCode();
      const s = await signInStarted(f);
      installIdp({ ...PERSON, nonce: s.nonce });
      const cb = await send(
        `${API}/djdl/identity/auth/callback?code=c&state=${s.state}`,
        { headers: { cookie: s.apiCookie } },
      );
      // Simulate the chooser trigger (a platform product whose account holds a licence).
      const stateKey = await flowKey(env, "djdl", s.state);
      await updateArtefact(env, stateKey, {
        set: { choiceOpen: true, choiceAccount: "acct" },
      });
      const choose = `${API}/djdl/identity/auth/choose`;
      // B alone (the victim's browser, or a B stolen some other way): refused.
      expect(JSON.parse((await getArtefact(env, stateKey))!).customerOk).toBe(
        undefined,
      );
      const before = await send(choose, { headers: { cookie: s.apiCookie } });
      expect(before.status).toBe(403);
      expect(await before.text()).toContain("This page has expired");
      // The person: B-token and C at the customer host, then on to the chooser.
      const step = await send(cb.headers.get("location")!, {
        headers: { cookie: s.customerCookie },
      });
      expect(step.status).toBe(303);
      const onward = await send(`${CUSTOMER}${step.headers.get("location")}`, {
        headers: { cookie: s.customerCookie },
      });
      expect(onward.status).toBe(303);
      expect(onward.headers.get("location")).toBe(choose);
      // C was shown: the flow now lets the API host's chooser open (the fake account here is
      // not linked, so the page itself ends at its own checks).
      const stored = await getArtefact(env, stateKey);
      expect(JSON.parse(stored!).customerOk).toBe(true);
    });

    it("the real person, in one browser, approves and the device gets its token", async () => {
      const f = await startWithDeviceCode();
      const { page, cookie } = await atApproval(f);
      expect(page.status).toBe(200);
      const token = /name="token" value="([^"]+)"/.exec(await page.text())![1]!;
      // A POST with neither Fetch Metadata nor Origin is a script: refused.
      const bare = await post(
        `${CUSTOMER}/device/approve`,
        { cookie },
        new URLSearchParams({ token, decision: "approve" }).toString(),
      );
      expect(bare.status).toBe(403);
      const ok = await post(
        `${CUSTOMER}/device/approve`,
        { cookie, origin: CUSTOMER },
        new URLSearchParams({ token, decision: "approve" }).toString(),
      );
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("is signed in on");
      const done = await poll(f.deviceCode);
      expect(["ready", "confirm"]).toContain(done.status);
    });
  });
});
