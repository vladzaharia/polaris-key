/**
 * I-21.12: `end-session` and Polaris Locker's sign-out page (V5 §12.13.9; OIDC RP-Initiated Logout
 * 1.0; threat IS-13). `end-session` validates and hands the browser to `/signout`; the person
 * decides there. Time is the injected `now`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchWith } from "../../../../src/dispatch.js";
import type { ClientRecord } from "../../../../src/services/identity/issuer/clientsRepo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../../../../src/services/identity/portal/session.js";
import { END_SESSION_HANDLE_TTL_SECONDS } from "@polaris-key/protocol/identity";
import type { EndSessionView } from "@polaris-key/protocol/identity";
import { NOW } from "../../../seed.js";
import { issuePortalSessionRow } from "../../../portalSessionRow.js";
import { BASE, SLUG, type World } from "../../connect/connectFixture.js";
import { holdWallClock, idHint, setCookies } from "./endSessionKit.js";
import { ingestIdentity } from "./issuerHelpers.js";
import { issuerWorld, mkClient } from "./issuerWorld.js";

const CB = "https://forum.example.com/cb";
const OUT = "https://forum.example.com/bye";
const ISSUER = `${BASE}/${SLUG}/identity`;
const ENDPOINT = `${ISSUER}/end-session`;
let w: World, accountId: string, client: ClientRecord;

// The portal API reads the wall clock (`handlePortal`): hold it at the injected time.
holdWallClock();
beforeEach(async () => {
  ({ w, accountId } = await issuerWorld());
  (w.env as unknown as Record<string, unknown>).PORTAL_SESSION_SECRET =
    "test-portal-secret";
  client = await mkClient(w, {
    key: "forum",
    type: "web",
    name: "Forum",
    developerName: "Forum Ltd",
    redirectUris: [CB],
    postLogoutRedirectUris: [OUT],
  });
});

const hint = (over: Record<string, unknown> = {}, sub = w.subject) =>
  idHint(w, client.clientId, { sub, ...over });

const send = (url: string, init: RequestInit = {}, at = NOW) =>
  dispatchWith(new Request(url, init), w.env, w.db, at);

/** `end-session` with `params`: the answer, and (on success) the handle and the binder cookie. */
async function endSession(
  params: Record<string, string>,
  opts: { method?: "GET" | "POST"; at?: number } = {},
) {
  const p = new URLSearchParams(params);
  const res =
    opts.method === "POST"
      ? await send(
          ENDPOINT,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: p.toString(),
          },
          opts.at,
        )
      : await send(`${ENDPOINT}?${p}`, {}, opts.at);
  const loc = res.headers.get("location");
  const handle = loc ? new URL(loc).searchParams.get("request") : null;
  const binder = res.headers.get("set-cookie")?.split(";")[0] ?? null;
  return { res, handle, binder, loc };
}

const session = async () => {
  const { token, session: s } = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId, name: "Ada", email: "ada@example.com" },
    NOW,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: s.csrf };
};

const api = (
  handle: string,
  tail: "" | "/confirm" | "/cancel",
  cookies: string[],
  extra: Record<string, string> = {},
  method = tail === "" ? "GET" : "POST",
  at = NOW,
) =>
  send(
    `${BASE}/api/signout/requests/${handle}${tail}`,
    {
      method,
      headers: {
        cookie: cookies.join("; "),
        "sec-fetch-site": "same-origin",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    },
    at,
  );

const liveSessions = async () =>
  (await w.db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM account_sessions WHERE account_id = ? AND revoked_at IS NULL",
    accountId,
  ))!.n;

describe("end-session", () => {
  it("hands the browser to /signout with a handle, a binder and no-store", async () => {
    const { res, handle, binder } = await endSession({
      id_token_hint: await hint(),
      post_logout_redirect_uri: OUT,
      state: "st-1",
    });
    expect(res.status).toBe(303);
    expect(handle).toMatch(/^eo_[A-Za-z0-9_-]{22}$/);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/signout");
    expect(binder).toMatch(/^__Host-pk_req=/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // The URL holds the handle only: nothing the relying party sent.
    expect(res.headers.get("location")).not.toContain("st-1");
    expect(res.headers.get("location")).not.toContain("forum.example.com");
  });

  it("a form POST reads the body alone; the query is ignored", async () => {
    const { res, handle } = await endSession(
      { client_id: client.clientId, post_logout_redirect_uri: OUT },
      { method: "POST" },
    );
    expect(res.status).toBe(303);
    expect(handle).not.toBeNull();
    const viaQuery = await send(`${ENDPOINT}?client_id=${client.clientId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    // No client in the body: the request names none, which is allowed.
    expect(viaQuery.status).toBe(303);
    const wrongType = await send(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(wrongType.status).toBe(400);
  });

  it("names the client by client_id alone, by the hint alone, or by both", async () => {
    const named: Record<string, string>[] = [
      { client_id: client.clientId },
      { id_token_hint: await hint() },
      { id_token_hint: await hint(), client_id: client.clientId },
      {},
    ];
    for (const p of named)
      expect(
        (await endSession(p)).res.status,
        JSON.stringify(Object.keys(p)),
      ).toBe(303);
  });

  it("an unknown or disabled client is the invalid_client page, never a redirect", async () => {
    for (const id of ["cl_" + "z".repeat(22), SLUG, "nonsense"]) {
      const { res } = await endSession({ client_id: id });
      expect(res.status, id).toBe(401);
      expect(res.headers.get("location")).toBeNull();
    }
    await w.db.run(
      "UPDATE identity_clients SET status = 'disabled' WHERE client_id = ?",
      client.clientId,
    );
    const { res } = await endSession({
      id_token_hint: await hint(),
      post_logout_redirect_uri: OUT,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a refusal speaks about signing out, gives one instruction and a way to sign out of Polaris Locker", async () => {
    const refused: Record<string, string>[] = [
      { client_id: "cl_" + "z".repeat(22) },
      { post_logout_redirect_uri: OUT },
    ];
    for (const params of refused) {
      const { res } = await endSession(params);
      const html = await res.text();
      expect(html).toContain("Couldn&#x27;t finish signing out");
      expect(html).toContain("sign-out isn&#x27;t set up correctly");
      expect(html).toContain("Sign out in Polaris Locker");
      expect(html).not.toMatch(/Sign-in can|try again|close this page/i);
    }
  });

  it("answers the registry's 404 while the issuer is off", async () => {
    await ingestIdentity(w.db, SLUG, { issuer: { enabled: false } });
    expect((await endSession({})).res.status).toBe(404);
  });

  it("is a navigation: no CORS headers", async () => {
    const { res } = await endSession({});
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the sign-out page and its routes", () => {
  async function ask(
    opts: { session?: boolean; params?: Record<string, string> } = {},
  ) {
    const e = await endSession(
      opts.params ?? {
        id_token_hint: await hint(),
        post_logout_redirect_uri: OUT,
        state: "st-9",
      },
    );
    const s = opts.session ? await session() : null;
    return {
      handle: e.handle!,
      cookies: [e.binder!, ...(s ? [s.cookie] : [])],
      csrf: s?.csrf ?? null,
    };
  }

  it("the page is the card shell for the browser that holds the binder, and 404 for any other", async () => {
    const { handle, cookies } = await ask();
    const page = await send(`${BASE}/signout?request=${handle}`, {
      headers: { cookie: cookies.join("; ") },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await send(`${BASE}/signout?request=${handle}`)).status).toBe(404);
    expect(
      (
        await send(`${BASE}/signout?request=eo_${"A".repeat(22)}`, {
          headers: { cookie: cookies[0]! },
        })
      ).status,
    ).toBe(200); // the shell reads nothing; the JSON routes are what answer only the binder's browser
    expect(
      (await send(`${BASE}/signout`, { headers: { cookie: cookies[0]! } }))
        .status,
    ).toBe(404);
    expect(
      (
        await send(`${BASE}/signout?request=rq_${"A".repeat(22)}`, {
          headers: { cookie: cookies[0]! },
        })
      ).status,
    ).toBe(404);
  });

  it("the view names the client, the return host and whether a session exists", async () => {
    const out = await ask({ session: true });
    const res = await api(out.handle, "", out.cookies);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const v = (await res.json()) as EndSessionView;
    expect(v).toMatchObject({
      request: out.handle,
      product: { slug: SLUG },
      client: { name: "Forum", developerName: "Forum Ltd", nameVerified: true },
      returns: true,
      returnHost: "forum.example.com",
      signedIn: true,
      expiresAt: NOW + END_SESSION_HANDLE_TTL_SECONDS,
    });
    const anon = await ask();
    const v2 = (await (
      await api(anon.handle, "", anon.cookies)
    ).json()) as EndSessionView;
    expect(v2.signedIn).toBe(false);
    const bare = await ask({ params: {} });
    const v3 = (await (
      await api(bare.handle, "", bare.cookies)
    ).json()) as EndSessionView;
    expect(v3).toMatchObject({
      client: null,
      returns: false,
      returnHost: null,
    });
  });

  it("Sign out ends this browser's session, clears its cookie, audits it and returns with state", async () => {
    const out = await ask({ session: true });
    expect(await liveSessions()).toBe(1);
    const res = await api(out.handle, "/confirm", out.cookies, {
      [PORTAL_CSRF_HEADER]: out.csrf!,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: `${OUT}?state=st-9` });
    const cleared = setCookies(res).find((c) =>
      c.startsWith(`${PORTAL_COOKIE}=`),
    );
    expect(cleared).toContain("Max-Age=0");
    expect(await liveSessions()).toBe(0);
    const audit = await w.db.first<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM audit WHERE action = 'identity.session.end'",
    );
    expect(audit?.target_id).toBe(client.clientId);
    // The handle is spent.
    expect(
      (
        await api(out.handle, "/confirm", out.cookies, {
          [PORTAL_CSRF_HEADER]: out.csrf!,
        })
      ).status,
    ).toBe(404);
  });

  it("Stay signed in ends nothing and returns the same way", async () => {
    const out = await ask({ session: true });
    const res = await api(out.handle, "/cancel", out.cookies, {
      [PORTAL_CSRF_HEADER]: out.csrf!,
    });
    expect(await res.json()).toEqual({ redirect: `${OUT}?state=st-9` });
    expect(setCookies(res)).toEqual([]);
    expect(await liveSessions()).toBe(1);
  });

  it("with no return the answer is null; with no state the return has no query", async () => {
    const a = await ask({
      session: true,
      params: { client_id: client.clientId },
    });
    expect(
      await (
        await api(a.handle, "/confirm", a.cookies, {
          [PORTAL_CSRF_HEADER]: a.csrf!,
        })
      ).json(),
    ).toEqual({ redirect: null });
    const b = await ask({
      params: { client_id: client.clientId, post_logout_redirect_uri: OUT },
    });
    expect(await (await api(b.handle, "/confirm", b.cookies)).json()).toEqual({
      redirect: OUT,
    });
  });

  it("a person with no session on this host can still be returned", async () => {
    const out = await ask();
    const res = await api(out.handle, "/confirm", out.cookies);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: `${OUT}?state=st-9` });
  });

  it("a client disabled since the request returns nowhere", async () => {
    const out = await ask({ session: true });
    await w.db.run(
      "UPDATE identity_clients SET status = 'disabled' WHERE client_id = ?",
      client.clientId,
    );
    const v = (await (
      await api(out.handle, "", out.cookies)
    ).json()) as EndSessionView;
    expect(v).toMatchObject({ client: null, returns: false });
    const res = await api(out.handle, "/confirm", out.cookies, {
      [PORTAL_CSRF_HEADER]: out.csrf!,
    });
    expect(await res.json()).toEqual({ redirect: null });
  });

  it("a handle lives 120 seconds", async () => {
    const out = await ask({ session: true });
    expect((await api(out.handle, "", out.cookies)).status).toBe(200);
    vi.setSystemTime((NOW + END_SESSION_HANDLE_TTL_SECONDS + 1) * 1000);
    expect((await api(out.handle, "", out.cookies)).status).toBe(404);
  });
});

describe("a customer host on another origin", () => {
  it("passes the bind hop: one use, the binder cookie set there, nothing of the request in the URL", async () => {
    (w.env as unknown as Record<string, unknown>).CONSOLE_ORIGIN = BASE;
    (w.env as unknown as Record<string, unknown>).CUSTOMER_ORIGIN =
      "https://polaris.locker";
    const { res, handle } = await endSession({
      id_token_hint: await hint(),
      post_logout_redirect_uri: OUT,
      state: "st-2",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toBeNull();
    const hop = new URL(res.headers.get("location")!);
    expect(hop.origin).toBe("https://polaris.locker");
    expect(hop.pathname).toBe("/signout");
    expect(hop.searchParams.get("request")).toBe(handle);
    const bind = hop.searchParams.get("bind")!;
    expect(bind).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hop.search).not.toContain("st-2");

    const hopped = await send(hop.href);
    expect(hopped.status).toBe(303);
    expect(hopped.headers.get("location")).toBe(`/signout?request=${handle}`);
    const cookie = hopped.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).toMatch(/^__Host-pk_req=/);
    // The token is single use, and a token never opens another handle.
    expect((await send(hop.href)).status).toBe(404);
    const view = await send(
      `https://polaris.locker/api/signout/requests/${handle}`,
      {
        headers: { cookie, "sec-fetch-site": "same-origin" },
      },
    );
    expect(view.status).toBe(200);
  });
});
