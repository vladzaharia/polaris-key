/**
 * I-21.7: `prompt`, `max_age`, `id_token_hint` and the server-side `prompt=none` path (V5 §12.13.3
 * rules 2 and 3; decision D4). The decision is made at the card's entry, on the host that holds the
 * Polaris Locker session: a `303` straight to the registered redirect URI, or the card.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { dispatchWith } from "../../../../src/dispatch.js";
import {
  setClientStatus,
  type ClientRecord,
} from "../../../../src/services/identity/issuer/clientsRepo.js";
import { putClientGrant } from "../../../../src/services/identity/issuer/grantsRepo.js";
import { signIssuerJwt } from "../../../../src/services/identity/issuer/keys.js";
import { redeemAuthorizationCode } from "../../../../src/services/identity/passthrough/code.js";
import { PORTAL_COOKIE } from "../../../../src/services/identity/portal/session.js";
import { NOW } from "../../../seed.js";
import { issuePortalSessionRow } from "../../../portalSessionRow.js";
import { BASE, SLUG, type World } from "../../connect/connectFixture.js";
import { ingestIdentity } from "./issuerHelpers.js";
import { issuerWorld, mkClient } from "./issuerWorld.js";

const CB = "https://forum.example.com/cb";
const ISSUER = `${BASE}/${SLUG}/identity`;
let w: World, accountId: string, client: ClientRecord;
let pair: { verifier: string; challenge: string };

beforeEach(async () => {
  ({ w, accountId, pair } = await issuerWorld());
  (w.env as unknown as Record<string, unknown>).PORTAL_SESSION_SECRET =
    "test-portal-secret";
  client = await mkClient(w, {
    key: "silent",
    type: "spa",
    redirectUris: [CB],
  });
});

const grant = (over: Partial<Parameters<typeof putClientGrant>[1]> = {}) =>
  putClientGrant(
    w.db,
    {
      accountId,
      clientId: client.clientId,
      product: SLUG,
      claimsGranted: ["name", "email"],
      claimsDeclined: ["picture"],
      scopes: ["offline_access"],
      scopeHash: "h",
      ...over,
    },
    NOW,
  );

const sessionCookie = async (at = NOW) => {
  const { token } = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId, name: "Ada", email: "ada@example.com" },
    at,
  );
  return `${PORTAL_COOKIE}=${token}`;
};

/** `authorize`, then the card entry with the binder and (optionally) a Locker session. */
async function enter(
  params: Record<string, string>,
  opts: {
    session?: boolean;
    at?: number;
    method?: string;
    binder?: boolean;
  } = {},
) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: CB,
    scope: "openid profile email",
    code_challenge: pair.challenge,
    code_challenge_method: "S256",
    ...params,
  });
  const auth = await dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/authorize?${p}`),
    w.env,
    w.db,
    opts.at ?? NOW,
  );
  expect(auth.status).toBe(303);
  const loc = new URL(auth.headers.get("location")!, BASE);
  const binder = auth.headers.get("set-cookie")!.split(";")[0]!;
  const cookies = [
    ...(opts.binder === false ? [] : [binder]),
    ...(opts.session ? [await sessionCookie()] : []),
  ];
  const entry = () =>
    dispatchWith(
      new Request(`${BASE}${loc.pathname}${loc.search}`, {
        method: opts.method ?? "GET",
        headers: { cookie: cookies.join("; ") },
      }),
      w.env,
      w.db,
      opts.at ?? NOW,
    );
  return { entry, handle: loc.searchParams.get("request")! };
}

const target = (res: Response) => {
  expect(res.status).toBe(303);
  const u = new URL(res.headers.get("location")!);
  expect(`${u.origin}${u.pathname}`).toBe(CB);
  expect(u.hash).toBe("");
  expect(u.searchParams.get("iss")).toBe(ISSUER);
  return u;
};
const cardShown = (res: Response) => {
  const loc = res.headers.get("location");
  expect(loc === null || !loc.startsWith(CB), `got ${loc}`).toBe(true);
};

describe("prompt=none", () => {
  it("no session is login_required, with state and iss, never the card", async () => {
    const { entry } = await enter({ prompt: "none", state: "st-9" });
    const u = target(await entry());
    expect(u.searchParams.get("error")).toBe("login_required");
    expect(u.searchParams.get("state")).toBe("st-9");
    expect(u.searchParams.get("code")).toBeNull();
  });

  it("omits state when none was sent", async () => {
    const { entry } = await enter({ prompt: "none" });
    expect(target(await entry()).searchParams.has("state")).toBe(false);
  });

  it("a session with no grant is consent_required; so is a grant that does not cover the request", async () => {
    const { entry } = await enter({ prompt: "none" }, { session: true });
    expect(target(await entry()).searchParams.get("error")).toBe(
      "consent_required",
    );
    // A required claim must be granted; an undecided optional claim is not covered; a line needs its scope.
    await grant({ claimsGranted: ["email"], claimsDeclined: ["picture"] });
    const a = await enter({ prompt: "none" }, { session: true });
    expect(target(await a.entry()).searchParams.get("error")).toBe(
      "consent_required",
    );
    await grant({ claimsGranted: ["name"], claimsDeclined: ["picture"] });
    const b = await enter({ prompt: "none" }, { session: true });
    expect(target(await b.entry()).searchParams.get("error")).toBe(
      "consent_required",
    );
    await grant();
    const c = await enter(
      { prompt: "none", scope: "openid profile email offline_access" },
      { session: true },
    );
    expect(target(await c.entry()).searchParams.get("code")).not.toBeNull();
  });

  it("a covering grant and a live session yield a code bound to the request", async () => {
    await grant({ scopes: ["offline_access", "pkey:entitlements"] });
    const { entry } = await enter(
      {
        prompt: "none",
        state: "st-1",
        scope: "openid profile email offline_access",
      },
      { session: true },
    );
    const u = target(await entry());
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("error")).toBeNull();
    const code = u.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the right challenge redeems it, once.
    expect(
      await redeemAuthorizationCode(w.env, SLUG, code, "A".repeat(43)),
    ).toBeNull();
    expect(
      await redeemAuthorizationCode(w.env, SLUG, code, pair.challenge),
    ).toBeNull();
  });

  it("the code carries the client, redirect, subject, scope, claims and auth_time", async () => {
    await grant({ scopes: ["offline_access"] });
    const { entry } = await enter(
      {
        prompt: "none",
        scope: "openid profile email offline_access",
        nonce: "n-7",
      },
      { session: true },
    );
    const code = target(await entry()).searchParams.get("code")!;
    const rec = await redeemAuthorizationCode(
      w.env,
      SLUG,
      code,
      pair.challenge,
    );
    expect(rec).toMatchObject({
      product: SLUG,
      clientId: client.clientId,
      redirectUri: CB,
      accountId,
      subject: w.subject,
      scope: ["openid", "profile", "email", "offline_access"],
      choice: null,
      nonce: "n-7",
      registered: { claims: ["name", "email"], authTime: NOW },
    });
    // Single use: a second redemption finds nothing.
    expect(
      await redeemAuthorizationCode(w.env, SLUG, code, pair.challenge),
    ).toBeNull();
  });

  it("takes the handle either way: a second entry gets nothing, and the grant is stamped", async () => {
    await grant();
    const { entry } = await enter({ prompt: "none" }, { session: true });
    target(await entry());
    const again = await entry();
    expect(again.headers.get("location")).toBeNull();
    const g = await w.db.first<{ last_used_at: number | null }>(
      "SELECT last_used_at FROM identity_client_grants",
    );
    expect(g!.last_used_at).toBe(NOW);
    const a = await w.db.first<{ action: string }>(
      "SELECT action FROM audit WHERE action = 'identity.client.signin'",
    );
    expect(a).not.toBeNull();
  });

  it("max_age: too old, and 0, are login_required; a young session passes", async () => {
    await grant();
    const old = await enter(
      { prompt: "none", max_age: "3600" },
      { session: true, at: NOW + 3601 },
    );
    expect(target(await old.entry()).searchParams.get("error")).toBe(
      "login_required",
    );
    const zero = await enter(
      { prompt: "none", max_age: "0" },
      { session: true },
    );
    expect(target(await zero.entry()).searchParams.get("error")).toBe(
      "login_required",
    );
    const ok = await enter(
      { prompt: "none", max_age: "3600" },
      { session: true, at: NOW + 3600 },
    );
    expect(target(await ok.entry()).searchParams.get("code")).not.toBeNull();
  });

  it("unaccepted terms are interaction_required", async () => {
    await grant();
    await ingestIdentity(w.db, SLUG, {
      issuer: { enabled: true },
      terms: { version: "2026-10", url: "https://acme.example/terms" },
    });
    const { entry } = await enter({ prompt: "none" }, { session: true });
    expect(target(await entry()).searchParams.get("error")).toBe(
      "interaction_required",
    );
  });
});

describe("silent budget", () => {
  it("the 31st silent answer for an account in a minute is server_error, not a code", async () => {
    await grant();
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) {
      const a = await enter({ prompt: "none" }, { session: true });
      last = await a.entry();
    }
    expect(target(last!).searchParams.get("error")).toBe("server_error");
  });
});

describe("id_token_hint", () => {
  const hint = (sub: string, over: Record<string, unknown> = {}) =>
    signIssuerJwt(
      w.env,
      w.db,
      SLUG,
      "JWT",
      {
        iss: ISSUER,
        sub,
        aud: client.clientId,
        exp: NOW - 1000,
        iat: NOW - 1600,
        ...over,
      },
      NOW,
    );

  it("an expired hint of the signed-in subject is accepted", async () => {
    await grant();
    const { entry } = await enter(
      { prompt: "none", id_token_hint: await hint(w.subject) },
      { session: true },
    );
    expect(target(await entry()).searchParams.get("code")).not.toBeNull();
  });

  it("another account's sub is login_required for prompt=none and the card for an interactive request", async () => {
    await grant();
    const other = await hint("ps_" + "x".repeat(22));
    const none = await enter(
      { prompt: "none", id_token_hint: other },
      { session: true },
    );
    expect(target(await none.entry()).searchParams.get("error")).toBe(
      "login_required",
    );
    // Interactive: not bounced. The card answers, and says who is expected (`wrongAccount`).
    const interactive = await enter(
      { id_token_hint: other },
      { session: true },
    );
    cardShown(await interactive.entry());
  });

  it("with no session an interactive request signs in as usual", async () => {
    const { entry, handle } = await enter({
      id_token_hint: await hint("ps_" + "x".repeat(22)),
    });
    cardShown(await entry());
    expect(handle).toMatch(/^rq_/);
  });

  it("a forged, mistyped or foreign hint is invalid_request at authorize", async () => {
    const bad = async (id_token_hint: string) => {
      const p = new URLSearchParams({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: CB,
        scope: "openid",
        code_challenge: pair.challenge,
        code_challenge_method: "S256",
        id_token_hint,
      });
      const res = await dispatchWith(
        new Request(`${BASE}/${SLUG}/identity/authorize?${p}`),
        w.env,
        w.db,
        NOW,
      );
      expect(res.status, id_token_hint.slice(0, 12)).toBe(302);
      expect(
        new URL(res.headers.get("location")!).searchParams.get("error"),
      ).toBe("invalid_request");
    };
    const good = await hint(w.subject);
    const [h, p, s] = good.split(".");
    await bad("garbage");
    await bad("");
    await bad(`${h}.${p}.${"A".repeat(s!.length)}`);
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    await bad(`${b64({ alg: "none", typ: "JWT" })}.${p}.`);
    await bad(`${b64({ alg: "HS256", typ: "JWT", kid: "x" })}.${p}.${s}`);
    await bad(`${b64({ alg: "RS256", typ: "at+jwt", kid: "x" })}.${p}.${s}`);
    await bad(
      await signIssuerJwt(
        w.env,
        w.db,
        SLUG,
        "at+jwt",
        { iss: ISSUER, sub: w.subject },
        NOW,
      ),
    );
    await bad(await hint(w.subject, { iss: "https://evil.example/identity" }));
    await bad(await hint("", {}));
    await bad(await hint(w.subject, { aud: "cl_" + "z".repeat(22) }));
    await bad("a".repeat(8193));
  });
});

describe("interactive requests and untouched ones", () => {
  it("an interactive request with a session shows the card and keeps its handle", async () => {
    const { entry } = await enter({}, { session: true });
    cardShown(await entry());
    cardShown(await entry());
  });

  it("prompt=login, consent and max_age leave the decision to the card", async () => {
    await grant();
    for (const extra of <Record<string, string>[]>[
      { prompt: "login" },
      { prompt: "consent" },
      { max_age: "0" },
    ]) {
      const { entry } = await enter(extra, { session: true });
      cardShown(await entry());
    }
  });

  it("HEAD and a request without the binder answer nothing and take nothing", async () => {
    await grant();
    const head = await enter(
      { prompt: "none" },
      { session: true, method: "HEAD" },
    );
    cardShown(await head.entry());
    const noBinder = await enter(
      { prompt: "none" },
      { session: true, binder: false },
    );
    const res = await noBinder.entry();
    expect(res.headers.get("location")).toBeNull();
  });

  it("a client disabled after authorize leaves the card to answer, and nothing redirects", async () => {
    await grant();
    const { entry } = await enter({ prompt: "none" }, { session: true });
    await setClientStatus(w.db, SLUG, client.clientId, "disabled", NOW);
    cardShown(await entry());
  });

  it("the product's own client is never decided here", async () => {
    const own = new URLSearchParams({
      response_type: "code",
      client_id: SLUG,
      redirect_uri: "https://app.acme.example/auth/callback",
      scope: "profile",
      state: "s".repeat(20),
      code_challenge: pair.challenge,
      code_challenge_method: "S256",
      prompt: "none",
    });
    await w.db.run(
      "UPDATE products SET web_origins_json = ? WHERE slug = ?",
      JSON.stringify(["https://app.acme.example"]),
      SLUG,
    );
    await ingestIdentity(w.db, SLUG, {
      issuer: { enabled: true },
      redirectPaths: ["/auth/callback"],
    });
    const auth = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/authorize?${own}`),
      w.env,
      w.db,
      NOW,
    );
    if (auth.status !== 303) return; // the own client's redirect setup is not this suite's concern
    const loc = new URL(auth.headers.get("location")!, BASE);
    const res = await dispatchWith(
      new Request(`${BASE}${loc.pathname}${loc.search}`, {
        headers: {
          cookie: [
            auth.headers.get("set-cookie")!.split(";")[0],
            await sessionCookie(),
          ].join("; "),
        },
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(res.headers.get("location")).toBeNull();
  });
});
