/**
 * I-21.12 attack suite: a hostile relying party or a hostile page against `end-session` and the
 * sign-out page (threat IS-13; V5 §12.13.9). Each case states what the attacker wants and asserts
 * the one outcome that denies it. Time is the injected `now`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchWith } from "../../src/dispatch.js";
import type { ClientRecord } from "../../src/services/identity/issuer/clientsRepo.js";
import { signIssuerJwt } from "../../src/services/identity/issuer/keys.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../../src/services/identity/portal/session.js";
import { NOW } from "../seed.js";
import { issuePortalSessionRow } from "../portalSessionRow.js";
import { BASE, SLUG, type World } from "../services/connect/connectFixture.js";
import {
  issuerWorld,
  mkClient,
} from "../services/identity/issuer/issuerWorld.js";

const OUT = "https://forum.example.com/bye";
const EVIL = "https://evil.example.com/steal";
const ISSUER = `${BASE}/${SLUG}/identity`;
const ENDPOINT = `${ISSUER}/end-session`;
let w: World;
let accountId: string;
let victim: ClientRecord;
let other: ClientRecord;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  ({ w, accountId } = await issuerWorld());
  (w.env as unknown as Record<string, unknown>).PORTAL_SESSION_SECRET =
    "attack-secret";
  victim = await mkClient(w, {
    key: "forum",
    type: "web",
    redirectUris: ["https://forum.example.com/cb"],
    postLogoutRedirectUris: [OUT],
  });
  other = await mkClient(w, {
    key: "other",
    type: "web",
    redirectUris: ["https://other.example.com/cb"],
    postLogoutRedirectUris: ["https://other.example.com/bye"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Every `Set-Cookie` of a response, one per entry. */
const setCookies = (res: Response): string[] =>
  (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie();

const send = (url: string, init: RequestInit = {}) =>
  dispatchWith(new Request(url, init), w.env, w.db, NOW);

const hint = (
  c: ClientRecord,
  over: Record<string, unknown> = {},
  typ: "JWT" | "at+jwt" = "JWT",
) =>
  signIssuerJwt(
    w.env,
    w.db,
    SLUG,
    typ,
    {
      iss: ISSUER,
      sub: w.subject,
      aud: c.clientId,
      exp: NOW - 100,
      iat: NOW - 700,
      ...over,
    },
    NOW,
  );

const end = (p: Record<string, string>, init: RequestInit = {}) =>
  send(`${ENDPOINT}?${new URLSearchParams(p)}`, init);

/** The two answers that mean "never redirected to anything the request sent". */
const refused = (res: Response, status: 400 | 401) => {
  expect(res.status).toBe(status);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("set-cookie")).toBeNull();
};

const liveSessions = async () =>
  (await w.db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM account_sessions WHERE account_id = ? AND revoked_at IS NULL",
    accountId,
  ))!.n;

const login = async () => {
  const { token, session } = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId, name: "Ada", email: "ada@example.com" },
    NOW,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf };
};

describe("an open redirect through post_logout_redirect_uri", () => {
  const variants: Record<string, string> = {
    "another host": EVIL,
    "a prefix of the registered string": OUT.slice(0, -1),
    "the registered string with a path added": `${OUT}/x`,
    "a trailing slash": `${OUT}/`,
    "a query added": `${OUT}?next=${encodeURIComponent(EVIL)}`,
    "a fragment added": `${OUT}#${EVIL}`,
    "userinfo that hides the host":
      "https://forum.example.com@evil.example.com/bye",
    "an upper-case host": "https://FORUM.example.com/bye",
    "a port": "https://forum.example.com:8443/bye",
    "http for https": "http://forum.example.com/bye",
    "a percent-encoded path": "https://forum.example.com/%62ye",
    "a javascript URL": "javascript:alert(1)",
    "a protocol-relative URL": "//evil.example.com/bye",
    "a backslash": "https://forum.example.com\\@evil.example.com/bye",
    "a different client's registered return": "https://other.example.com/bye",
    "an empty string": "",
  };
  for (const [name, uri] of Object.entries(variants))
    it(`refuses ${name}, renders a page and never redirects`, async () => {
      refused(
        await end({
          client_id: victim.clientId,
          post_logout_redirect_uri: uri,
          state: "s",
        }),
        400,
      );
      // With the hint too (the common request) the answer is the same.
      refused(
        await end({
          id_token_hint: await hint(victim),
          post_logout_redirect_uri: uri,
        }),
        400,
      );
    });

  it("refuses a return with no client at all", async () => {
    refused(await end({ post_logout_redirect_uri: OUT }), 400);
  });

  it("refuses a return registered by an unknown or disabled client", async () => {
    refused(
      await end({
        client_id: "cl_" + "q".repeat(22),
        post_logout_redirect_uri: OUT,
      }),
      401,
    );
    await w.db.run(
      "UPDATE identity_clients SET status = 'disabled' WHERE client_id = ?",
      victim.clientId,
    );
    refused(
      await end({
        client_id: victim.clientId,
        post_logout_redirect_uri: OUT,
      }),
      401,
    );
  });

  it("a repeated parameter cannot smuggle a second return", async () => {
    const q = `client_id=${victim.clientId}&post_logout_redirect_uri=${encodeURIComponent(OUT)}&post_logout_redirect_uri=${encodeURIComponent(EVIL)}`;
    refused(await send(`${ENDPOINT}?${q}`), 400);
    refused(
      await send(
        `${ENDPOINT}?client_id=${victim.clientId}&client_id=${other.clientId}`,
      ),
      400,
    );
  });

  it("a POST ignores a return smuggled in the query", async () => {
    const res = await send(
      `${ENDPOINT}?client_id=${victim.clientId}&post_logout_redirect_uri=${encodeURIComponent(EVIL)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: victim.clientId }).toString(),
      },
    );
    expect(res.status).toBe(303);
    const handle = new URL(res.headers.get("location")!).searchParams.get(
      "request",
    )!;
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const view = await send(`${BASE}/api/signout/requests/${handle}/cancel`, {
      method: "POST",
      headers: {
        cookie,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(await view.json()).toEqual({ redirect: null });
  });
});

describe("a hostile id_token_hint", () => {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  const bad = async (hintValue: string) =>
    refused(
      await end({
        id_token_hint: hintValue,
        post_logout_redirect_uri: OUT,
      }),
      400,
    );

  it("refuses the same hints `authorize` refuses", async () => {
    const good = await hint(victim);
    const [h, p, s] = good.split(".") as [string, string, string];
    await bad("not-a-jwt");
    await bad(`${b64({ alg: "none", typ: "JWT" })}.${p}.`);
    await bad(`${b64({ alg: "HS256", typ: "JWT", kid: "x" })}.${p}.${s}`);
    await bad(`${h}.${p}.${"A".repeat(s.length)}`);
    await bad(await hint(victim, {}, "at+jwt"));
    await bad(await hint(victim, { iss: "https://evil.example/identity" }));
    await bad(await hint(victim, { sub: "" }));
    await bad("a".repeat(8193));
  });

  it("refuses a hint naming a client that is not the one in the request", async () => {
    refused(
      await end({
        client_id: other.clientId,
        id_token_hint: await hint(victim),
        post_logout_redirect_uri: "https://other.example.com/bye",
      }),
      400,
    );
  });

  it("a forged audience that names a real client does not borrow its return", async () => {
    // Signed by nobody: the unverified `aud` only picks the client, and verification then fails.
    const forged = `${b64({ alg: "RS256", typ: "JWT", kid: "x" })}.${b64({ iss: ISSUER, sub: w.subject, aud: victim.clientId })}.AAAA`;
    await bad(forged);
  });

  it("a hint of another product's issuer is refused", async () => {
    await bad(await hint(victim, { iss: `${BASE}/other-product/identity` }));
  });
});

describe("logout CSRF", () => {
  async function ask() {
    const res = await end({
      id_token_hint: await hint(victim),
      post_logout_redirect_uri: OUT,
      state: "st",
    });
    expect(res.status).toBe(303);
    return {
      handle: new URL(res.headers.get("location")!).searchParams.get(
        "request",
      )!,
      binder: res.headers.get("set-cookie")!.split(";")[0]!,
    };
  }
  const call = (
    handle: string,
    tail: string,
    cookie: string,
    extra: Record<string, string> = {},
    method = "POST",
  ) =>
    send(`${BASE}/api/signout/requests/${handle}${tail}`, {
      method,
      headers: {
        cookie,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        ...extra,
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });

  it("end-session itself ends nothing, for a person with a live session", async () => {
    const s = await login();
    expect(await liveSessions()).toBe(1);
    const res = await send(
      `${ENDPOINT}?client_id=${victim.clientId}&post_logout_redirect_uri=${encodeURIComponent(OUT)}`,
      { headers: { cookie: s.cookie } },
    );
    expect(res.status).toBe(303);
    expect(await liveSessions()).toBe(1);
    expect(setCookies(res).join(";")).not.toContain(`${PORTAL_COOKIE}=;`);
  });

  it("loading the page and the view ends nothing", async () => {
    const s = await login();
    const { handle, binder } = await ask();
    const cookie = `${binder}; ${s.cookie}`;
    expect(
      (await send(`${BASE}/signout?request=${handle}`, { headers: { cookie } }))
        .status,
    ).toBe(200);
    expect((await call(handle, "", cookie, {}, "GET")).status).toBe(200);
    expect(await liveSessions()).toBe(1);
  });

  it("Sign out without the CSRF header, or with a wrong one, ends nothing and keeps the handle", async () => {
    const s = await login();
    const { handle, binder } = await ask();
    const cookie = `${binder}; ${s.cookie}`;
    expect((await call(handle, "/confirm", cookie)).status).toBe(403);
    expect(
      (
        await call(handle, "/confirm", cookie, {
          [PORTAL_CSRF_HEADER]: "x".repeat(22),
        })
      ).status,
    ).toBe(403);
    expect(await liveSessions()).toBe(1);
    // The right header, afterwards, still works: the failed tries did not spend the handle.
    expect(
      (await call(handle, "/confirm", cookie, { [PORTAL_CSRF_HEADER]: s.csrf }))
        .status,
    ).toBe(200);
    expect(await liveSessions()).toBe(0);
  });

  it("a cross-site POST ends nothing", async () => {
    const s = await login();
    const { handle, binder } = await ask();
    const cookie = `${binder}; ${s.cookie}`;
    for (const site of ["cross-site", "same-site", "none"])
      expect(
        (
          await call(handle, "/confirm", cookie, {
            "sec-fetch-site": site,
            [PORTAL_CSRF_HEADER]: s.csrf,
          })
        ).status,
        site,
      ).toBe(404);
    const noMeta = await send(
      `${BASE}/api/signout/requests/${handle}/confirm`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: "https://evil.example.com",
          [PORTAL_CSRF_HEADER]: s.csrf,
        },
        body: "{}",
      },
    );
    expect(noMeta.status).toBe(404);
    expect(await liveSessions()).toBe(1);
  });

  it("GET cannot confirm or cancel", async () => {
    const s = await login();
    const { handle, binder } = await ask();
    const cookie = `${binder}; ${s.cookie}`;
    for (const tail of ["/confirm", "/cancel"])
      expect((await call(handle, tail, cookie, {}, "GET")).status).toBe(405);
    expect(await liveSessions()).toBe(1);
  });

  it("another browser, holding the session but not the binder, cannot read or answer the handle", async () => {
    const s = await login();
    const { handle } = await ask();
    for (const cookie of [
      s.cookie,
      `__Host-pk_req=${"A".repeat(43)}; ${s.cookie}`,
    ]) {
      expect((await call(handle, "", cookie, {}, "GET")).status).toBe(404);
      expect(
        (
          await call(handle, "/confirm", cookie, {
            [PORTAL_CSRF_HEADER]: s.csrf,
          })
        ).status,
      ).toBe(404);
    }
    expect(await liveSessions()).toBe(1);
  });

  it("a handle answers once; a second press and a press of the other button are both refused", async () => {
    const s = await login();
    const { handle, binder } = await ask();
    const cookie = `${binder}; ${s.cookie}`;
    const h = { [PORTAL_CSRF_HEADER]: s.csrf };
    expect((await call(handle, "/cancel", cookie, h)).status).toBe(200);
    expect((await call(handle, "/confirm", cookie, h)).status).toBe(404);
    expect(await liveSessions()).toBe(1);
  });

  it("Sign out ends this browser's session and no other of the account", async () => {
    const a = await login();
    await login();
    expect(await liveSessions()).toBe(2);
    const { handle, binder } = await ask();
    await call(handle, "/confirm", `${binder}; ${a.cookie}`, {
      [PORTAL_CSRF_HEADER]: a.csrf,
    });
    expect(await liveSessions()).toBe(1);
  });

  it("a client disabled after the request is not returned to", async () => {
    const { handle, binder } = await ask();
    await w.db.run(
      "UPDATE identity_clients SET status = 'disabled' WHERE client_id = ?",
      victim.clientId,
    );
    const v = (await (await call(handle, "", binder, {}, "GET")).json()) as {
      client: unknown;
    };
    expect(v.client).toBeNull();
  });
});

describe("denial of service", () => {
  it("end-session is 30 a minute per network and fails closed", async () => {
    const hit = () =>
      send(`${ENDPOINT}?client_id=${victim.clientId}`, {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      });
    for (let i = 0; i < 30; i++) expect((await hit()).status).toBe(303);
    expect((await hit()).status).toBe(429);
    // Another network has its own budget.
    expect(
      (
        await send(`${ENDPOINT}?client_id=${victim.clientId}`, {
          headers: { "cf-connecting-ip": "203.0.113.10" },
        })
      ).status,
    ).toBe(303);
  });

  it("an oversized state is refused before anything is stored", async () => {
    refused(
      await end({
        client_id: victim.clientId,
        post_logout_redirect_uri: OUT,
        state: "s".repeat(513),
      }),
      400,
    );
  });
});
