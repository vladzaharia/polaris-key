/**
 * I-21.6: `authorize` for a registered client (V5 §12.13.3). Exact-match redirects, the classes by
 * client type, PKCE or nonce, scope, the error redirects (to the registered URI only, with `state`
 * and `iss`) and `ClientRecord.registered`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { dispatchWith } from "../../../../src/dispatch.js";
import {
  createClient,
  setClientStatus,
  type ClientRecord,
  type NewClient,
} from "../../../../src/services/identity/issuer/clientsRepo.js";
import { signInRequestView } from "../../../../src/services/identity/passthrough/routes.js";
import { readSignInRequest } from "../../../../src/services/identity/passthrough/request.js";
import { NOW } from "../../../seed.js";
import { BASE, SLUG, world, type World } from "../../connect/connectFixture.js";
import { enableIssuer } from "./issuerHelpers.js";

/** The request view's status and body (the 404 has none). */
const viewOf = async (...args: Parameters<typeof signInRequestView>) =>
  (await signInRequestView(...args)) as { status: number; body?: unknown };

const ISSUER = `${BASE}/${SLUG}/identity`;
const CHALLENGE = "A".repeat(43);
const WEB_CB = "https://forum.example.com/auth/cb";

let w: World;
let web: ClientRecord;
let spa: ClientRecord;
let native: ClientRecord;
beforeEach(async () => {
  w = await world();
  await enableIssuer(w.db, SLUG);
  web = await mk("forum", "web", [WEB_CB, "https://forum.example.com/q?a=1"]);
  spa = await mk("spa-app", "spa", ["https://spa.example.com/cb"]);
  native = await mk("desktop", "native", [
    "http://127.0.0.1/callback",
    "http://[::1]/callback",
    "com.acme.desktop:/oauth2redirect",
  ]);
});

async function mk(
  key: string,
  type: NewClient["type"],
  redirectUris: string[],
  over: Partial<NewClient> = {},
): Promise<ClientRecord> {
  const r = await createClient(
    w.db,
    {
      product: SLUG,
      key,
      origin: "console",
      name: `Client ${key}`,
      developerName: null,
      type,
      redirectUris,
      postLogoutRedirectUris: [],
      scopes: [
        "openid",
        "profile",
        "email",
        "pkey:entitlements",
        "offline_access",
      ],
      claimsRequired: [],
      iconUrl: null,
      ...over,
    },
    NOW,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.client;
}

const base = (
  c: ClientRecord,
  over: Record<string, string | undefined> = {},
) => {
  const p: Record<string, string> = {
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: c.redirectUris[0]!,
    scope: "openid profile",
    state: "st-1",
  };
  if (c.type === "web") p.nonce = "n-1";
  else ((p.code_challenge = CHALLENGE), (p.code_challenge_method = "S256"));
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete p[k];
    else p[k] = v;
  }
  return p;
};
const qs = (p: Record<string, string>) => new URLSearchParams(p).toString();
const authorize = (
  p: Record<string, string> | string,
  init: RequestInit = {},
) =>
  dispatchWith(
    new Request(
      `${BASE}/${SLUG}/identity/authorize?${typeof p === "string" ? p : qs(p)}`,
      init,
    ),
    w.env,
    w.db,
    NOW,
  );
const errorOf = (res: Response) => {
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
};

describe("client and redirect URI first", () => {
  it("an unknown, other-product or malformed client id is a page, never a redirect", async () => {
    for (const id of [
      "cl_" + "x".repeat(22),
      "cl_short",
      "cl_" + "x".repeat(23),
      "nobody",
    ]) {
      const res = await authorize(base(web, { client_id: id }));
      expect(res.status, id).toBe(401);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("a disabled client, or the issuer turned off, is invalid_client", async () => {
    await setClientStatus(w.db, SLUG, web.clientId, "disabled", NOW);
    expect((await authorize(base(web))).status).toBe(401);
    await setClientStatus(w.db, SLUG, web.clientId, "active", NOW);
    expect((await authorize(base(web))).status).toBe(303);
    await w.db.run(
      "DELETE FROM product_settings WHERE key = 'identity.issuer.enabled'",
    );
    const off = await authorize(base(web));
    expect(off.status).toBe(401);
    expect(off.headers.get("location")).toBeNull();
  });

  it("a redirect_uri that is not an exact match is a 400 page, whatever else is wrong", async () => {
    const bads = [
      WEB_CB + "/",
      WEB_CB.toUpperCase(),
      "https://forum.example.com/auth/cb?x=1",
      WEB_CB + "#frag",
      "https://forum.example.com:443/auth/cb",
      "https://evil.example.com/auth/cb",
      "https://user@forum.example.com/auth/cb",
      "http://forum.example.com/auth/cb",
      "https://forum.example.com/auth/%63b",
      "https://forum.example.com/auth/cb/../cb",
      "",
      "http://127.0.0.1:8080/callback",
      "com.acme.desktop:/oauth2redirect",
    ];
    for (const uri of bads) {
      // Everything else is wrong too: no response_type, no scope.
      const res = await authorize({
        client_id: web.clientId,
        redirect_uri: uri,
      });
      expect(res.status, uri).toBe(400);
      expect(res.headers.get("location"), uri).toBeNull();
    }
    expect((await authorize({ client_id: web.clientId })).status).toBe(400);
    const repeated = `client_id=${web.clientId}&redirect_uri=${encodeURIComponent(WEB_CB)}&redirect_uri=${encodeURIComponent("https://evil.example.com/")}`;
    expect((await authorize(repeated)).status).toBe(400);
  });

  it("a registered query matches only as registered, and errors join it with &", async () => {
    const q = "https://forum.example.com/q?a=1";
    expect((await authorize(base(web, { redirect_uri: q }))).status).toBe(303);
    expect(
      (
        await authorize(
          base(web, { redirect_uri: "https://forum.example.com/q?a=2" }),
        )
      ).status,
    ).toBe(400);
    const res = await authorize(
      base(web, { redirect_uri: q, response_type: "token" }),
    );
    const loc = res.headers.get("location")!;
    expect(loc.startsWith("https://forum.example.com/q?a=1&error=")).toBe(true);
  });
});

describe("loopback and private-use redirects are for native clients", () => {
  it("accept a loopback port, exact otherwise", async () => {
    for (const uri of [
      "http://127.0.0.1:51234/callback",
      "http://[::1]:1/callback",
      "http://127.0.0.1:65535/callback",
      "http://127.0.0.1/callback",
      "com.acme.desktop:/oauth2redirect",
    ])
      expect(
        (await authorize(base(native, { redirect_uri: uri }))).status,
        uri,
      ).toBe(303);
    for (const uri of [
      "http://127.0.0.1:0/callback",
      "http://127.0.0.1:65536/callback",
      "http://127.0.0.1:08080/callback",
      "http://127.0.0.1:80a/callback",
      "http://localhost:8080/callback",
      "http://127.0.0.1:8080/other",
      "http://127.0.0.1:8080/callback#f",
      "http://127.0.0.1:8080/callback?x=1",
      "http://127.0.0.2:8080/callback",
      "com.acme.desktop:/other",
      "com.acme.desktop://oauth2redirect",
    ])
      expect(
        (await authorize(base(native, { redirect_uri: uri }))).status,
        uri,
      ).toBe(400);
  });

  it("a web or spa client has no port freedom, even for its own https URI", async () => {
    expect(
      (
        await authorize(
          base(web, { redirect_uri: "https://forum.example.com:8443/auth/cb" }),
        )
      ).status,
    ).toBe(400);
    const loop = await mk("spa-loop", "spa", ["https://s.example.com/cb"]);
    expect(
      (
        await authorize(
          base(loop, { redirect_uri: "http://127.0.0.1:8080/cb" }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("errors go to the registered redirect, with state and iss", () => {
  const expectError = (
    res: Response,
    error: string,
    state: string | null = "st-1",
  ) => {
    const u = errorOf(res);
    expect(`${u.origin}${u.pathname}`).toBe(WEB_CB);
    expect(u.searchParams.get("error")).toBe(error);
    expect(u.searchParams.get("iss")).toBe(ISSUER);
    expect(u.searchParams.get("state")).toBe(state);
    expect(u.searchParams.get("code")).toBeNull();
    expect(u.hash).toBe("");
  };

  it("response_type, mode, scope, request objects", async () => {
    expectError(
      await authorize(base(web, { response_type: undefined })),
      "invalid_request",
    );
    expectError(
      await authorize(base(web, { response_type: "token" })),
      "unsupported_response_type",
    );
    expectError(
      await authorize(base(web, { response_type: "id_token" })),
      "unsupported_response_type",
    );
    expectError(
      await authorize(base(web, { response_mode: "fragment" })),
      "invalid_request",
    );
    expectError(
      await authorize(base(web, { response_mode: "form_post" })),
      "invalid_request",
    );
    expectError(
      await authorize(base(web, { scope: "profile email" })),
      "invalid_scope",
    );
    expectError(
      await authorize(base(web, { scope: undefined })),
      "invalid_scope",
    );
    expectError(
      await authorize(base(web, { request: "eyJ" })),
      "request_not_supported",
    );
    expectError(
      await authorize(base(web, { request_uri: "https://x/r" })),
      "request_uri_not_supported",
    );
  });

  it("state: echoed when sent, absent when not, and refused past 512", async () => {
    expectError(
      await authorize(base(web, { state: undefined, response_type: "x" })),
      "unsupported_response_type",
      null,
    );
    const long = "s".repeat(513);
    const res = await authorize(base(web, { state: long }));
    const u = errorOf(res);
    expect(u.searchParams.get("error")).toBe("invalid_request");
    expect(u.searchParams.get("state")).toBeNull();
    expect(
      (await authorize(base(web, { state: "s".repeat(512) }))).status,
    ).toBe(303);
    expect((await authorize(base(web, { state: "a b&c=d" }))).status).toBe(303);
    const e = await authorize(
      base(web, { state: "a b&c=d", response_type: "x" }),
    );
    expect(errorOf(e).searchParams.get("state")).toBe("a b&c=d");
  });

  it("PKCE for public clients, PKCE or nonce for web, never plain", async () => {
    const bad = async (
      c: ClientRecord,
      over: Record<string, string | undefined>,
    ) => {
      const res = await authorize(base(c, over));
      const u = errorOf(res);
      expect(u.searchParams.get("error")).toBe("invalid_request");
      expect(u.searchParams.get("iss")).toBe(ISSUER);
    };
    await bad(spa, {
      code_challenge: undefined,
      code_challenge_method: undefined,
    });
    await bad(spa, { code_challenge_method: "plain" });
    await bad(spa, { code_challenge_method: undefined });
    await bad(spa, { code_challenge: "short" });
    await bad(spa, { code_challenge: "A".repeat(44) });
    await bad(spa, { code_challenge: "A".repeat(42) + "+" });
    await bad(spa, { code_challenge: undefined });
    await bad(spa, {
      nonce: "n",
      code_challenge: undefined,
      code_challenge_method: undefined,
    });
    await bad(native, {
      code_challenge: undefined,
      code_challenge_method: undefined,
    });
    await bad(web, { nonce: undefined });
    await bad(web, { nonce: "" });
    await bad(web, { nonce: "n".repeat(256) });
    await bad(web, {
      code_challenge: CHALLENGE,
      code_challenge_method: "plain",
    });
    await bad(web, { code_challenge: CHALLENGE });
    // Accepted: web with PKCE only, with nonce only, with both; the nonce at its limit.
    expect(
      (
        await authorize(
          base(web, {
            nonce: undefined,
            code_challenge: CHALLENGE,
            code_challenge_method: "S256",
          }),
        )
      ).status,
    ).toBe(303);
    expect(
      (await authorize(base(web, { nonce: "n".repeat(255) }))).status,
    ).toBe(303);
    expect(
      (
        await authorize(
          base(web, {
            code_challenge: CHALLENGE,
            code_challenge_method: "S256",
          }),
        )
      ).status,
    ).toBe(303);
  });

  it("a repeated parameter is invalid_request, never first-wins", async () => {
    const twice = (c: ClientRecord, extra: string) =>
      authorize(`${qs(base(c))}&${extra}`);
    for (const dup of [
      "response_type=code",
      "scope=openid",
      "nonce=n2",
      "state=s2",
      "response_mode=query&response_mode=query",
    ])
      expect(
        errorOf(await twice(web, dup)).searchParams.get("error"),
        dup,
      ).toBe("invalid_request");
    expect(
      errorOf(await twice(spa, "code_challenge=" + CHALLENGE)).searchParams.get(
        "error",
      ),
    ).toBe("invalid_request");
    for (const dup of [
      "prompt=login&prompt=none",
      "max_age=1&max_age=2",
      "id_token_hint=a&id_token_hint=b",
    ])
      expect(
        errorOf(await twice(web, dup)).searchParams.get("error"),
        dup,
      ).toBe("invalid_request");
  });

  it("prompt and max_age", async () => {
    expectError(
      await authorize(base(web, { prompt: "none login" })),
      "invalid_request",
    );
    expectError(
      await authorize(base(web, { prompt: "none consent" })),
      "invalid_request",
    );
    expectError(
      await authorize(base(web, { max_age: "-1" })),
      "invalid_request",
    );
    expectError(
      await authorize(base(web, { max_age: "1.5" })),
      "invalid_request",
    );
    expectError(
      await authorize(base(web, { max_age: "12345678901" })),
      "invalid_request",
    );
    expectError(
      await authorize(base(web, { max_age: "abc" })),
      "invalid_request",
    );
    for (const prompt of [
      "login",
      "consent",
      "login consent",
      "none",
      "select_account",
      "none bogus",
    ])
      expect((await authorize(base(web, { prompt }))).status, prompt).toBe(303);
    expect((await authorize(base(web, { max_age: "0" }))).status).toBe(303);
    expect((await authorize(base(web, { max_age: "3600" }))).status).toBe(303);
  });
});

describe("success", () => {
  async function accepted(
    c: ClientRecord,
    over: Record<string, string | undefined> = {},
  ) {
    const res = await authorize(base(c, over));
    expect(res.status).toBe(303);
    const loc = res.headers.get("location")!;
    expect(loc).toMatch(/\/signin\?request=rq_[A-Za-z0-9_-]{22}/);
    // No code, token or state anywhere in the URL, and none in a fragment.
    expect(loc).not.toMatch(/code=|state=|token|#/);
    const handle = /request=(rq_[A-Za-z0-9_-]{22})/.exec(loc)![1]!;
    const cookie = res.headers.get("set-cookie");
    return { res, handle, cookie: cookie?.split(";")[0] ?? "" };
  }

  it("stores the request and shows the client on the card", async () => {
    const { handle, cookie } = await accepted(web, {
      scope: "openid profile email bogus pkey:licenses",
    });
    const req = new Request("https://key.plrs.im/api/signin/requests/x", {
      headers: { cookie },
    });
    const record = (await readSignInRequest(w.env, req, handle, NOW))!;
    expect(record.authz).toMatchObject({
      clientId: web.clientId,
      redirectUri: WEB_CB,
      state: "st-1",
      codeChallenge: null,
      nonce: "n-1",
      scope: ["openid", "profile", "email"],
      registered: { type: "web", maxAge: null, hintSub: null },
    });
    const view = await viewOf(w.env, w.db, req, handle, NOW, undefined);
    expect(view.status).toBe(200);
    const body = view.body as {
      client: { kind: string; registered: Record<string, unknown> };
    };
    expect(body.client.kind).toBe("web");
    expect(body.client.registered).toEqual({
      clientId: web.clientId,
      name: "Client forum",
      developerName: null,
      iconUrl: null,
      returnHost: "forum.example.com",
      nameVerified: true,
      partner: false,
    });
  });

  it("a client with a developer of its own is a partner", async () => {
    const partner = await mk("partnered", "web", ["https://p.example.com/cb"], {
      developerName: "Partner Ltd",
    });
    const { handle, cookie } = await accepted(partner);
    const req = new Request("https://key.plrs.im/x", { headers: { cookie } });
    const body = (await viewOf(w.env, w.db, req, handle, NOW, undefined))
      .body as {
      client: { registered: { partner: boolean; developerName: string } };
    };
    expect(body.client.registered).toMatchObject({
      partner: true,
      developerName: "Partner Ltd",
    });
  });

  it("scope is cut to the client's registered scopes", async () => {
    const narrow = await mk("narrow", "web", ["https://n.example.com/cb"], {
      scopes: ["openid", "profile"],
    });
    const { handle, cookie } = await accepted(narrow, {
      scope: "openid profile email offline_access",
    });
    const req = new Request("https://key.plrs.im/x", { headers: { cookie } });
    expect(
      (await readSignInRequest(w.env, req, handle, NOW))!.authz!.scope,
    ).toEqual(["openid", "profile"]);
  });

  it("a loopback or private-use request has no return host, and a bad name falls back to the key", async () => {
    const { handle, cookie } = await accepted(native, {
      redirect_uri: "http://127.0.0.1:9999/callback",
    });
    const req = new Request("https://key.plrs.im/x", { headers: { cookie } });
    const body = (await viewOf(w.env, w.db, req, handle, NOW, undefined))
      .body as {
      client: { registered: { returnHost: string | null } };
    };
    expect(body.client.registered.returnHost).toBeNull();
    const rude = await mk("apple-fan", "web", ["https://r.example.com/cb"], {
      name: "Apple Support",
    });
    const second = await accepted(rude);
    const req2 = new Request("https://key.plrs.im/x", {
      headers: { cookie: second.cookie },
    });
    const view = (
      await viewOf(w.env, w.db, req2, second.handle, NOW, undefined)
    ).body as {
      client: { registered: { name: string; nameVerified: boolean } };
    };
    expect(view.client.registered).toMatchObject({
      name: "apple-fan",
      nameVerified: false,
    });
  });

  it("a client disabled after the request leaves no card", async () => {
    const { handle, cookie } = await accepted(web);
    await setClientStatus(w.db, SLUG, web.clientId, "disabled", NOW);
    const req = new Request("https://key.plrs.im/x", { headers: { cookie } });
    expect(
      (await viewOf(w.env, w.db, req, handle, NOW, undefined)).status,
    ).toBe(404);
  });

  it("form POST works for a registered client", async () => {
    const post = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: qs(base(web)),
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(post.status).toBe(303);
  });
});
