/**
 * I-21.6 and I-21.7 attack suite: a hostile relying party or a hostile page against the issuer's
 * `authorize` and the card entry (threats IS-3, IS-4, IS-8; V5 §12.13.3). Each case states what the
 * attacker wants and asserts the one outcome that denies it. Time is the injected `now`, never the
 * wall clock.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { dispatchWith } from "../../src/dispatch.js";
import { pkcePair } from "../../src/platform/pkce.js";
import {
  createClient,
  type ClientRecord,
} from "../../src/services/identity/issuer/clientsRepo.js";
import { putClientGrant } from "../../src/services/identity/issuer/grantsRepo.js";
import { signIssuerJwt } from "../../src/services/identity/issuer/keys.js";
import { revokeAllAccountSessions } from "../../src/services/identity/portal/accountSessions.js";
import { PORTAL_COOKIE } from "../../src/services/identity/portal/session.js";
import { NOW, seedProduct } from "../seed.js";
import { issuePortalSessionRow } from "../portalSessionRow.js";
import {
  BASE,
  SLUG,
  world,
  type World,
} from "../services/connect/connectFixture.js";
import { enableIssuer } from "../services/identity/issuer/issuerHelpers.js";

const CB = "https://forum.example.com/cb";
const EVIL = "https://evil.example.com/steal";
const ISSUER = `${BASE}/${SLUG}/identity`;
let w: World;
let victim: ClientRecord;
let accountId: string;
let pair: { verifier: string; challenge: string };

async function mk(key: string, type: "web" | "spa" | "native", uris: string[]) {
  const r = await createClient(
    w.db,
    {
      product: SLUG,
      key,
      origin: "console",
      name: key,
      developerName: null,
      type,
      redirectUris: uris,
      postLogoutRedirectUris: [],
      scopes: ["openid", "profile"],
      claimsRequired: [],
      iconUrl: null,
    },
    NOW,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.client;
}

beforeEach(async () => {
  w = await world();
  (w.env as unknown as Record<string, unknown>).PORTAL_SESSION_SECRET =
    "attack-secret";
  await enableIssuer(w.db, SLUG);
  victim = await mk("forum", "spa", [CB]);
  accountId = (await w.db.first<{ account_id: string }>(
    "SELECT account_id FROM account_product_subjects WHERE product = ? AND subject = ?",
    SLUG,
    w.subject,
  ))!.account_id;
  pair = await pkcePair();
});

const params = (c: ClientRecord, over: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: CB,
    scope: "openid profile",
    code_challenge: pair.challenge,
    code_challenge_method: "S256",
    state: "st",
    ...over,
  });
const authorize = (p: URLSearchParams | string, at = NOW) =>
  dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/authorize?${p}`),
    w.env,
    w.db,
    at,
  );

const grant = (c: ClientRecord, acct = accountId) =>
  putClientGrant(
    w.db,
    {
      accountId: acct,
      clientId: c.clientId,
      product: SLUG,
      claimsGranted: ["name", "picture"],
      claimsDeclined: [],
      scopes: [],
      scopeHash: "h",
    },
    NOW,
  );

async function login(at = NOW) {
  const { token, session } = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId, name: "Ada", email: "ada@example.com" },
    at,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, session };
}

/** The attacker's authorize, then the victim browser's card entry with its own cookies. */
async function none(
  c: ClientRecord,
  over: Record<string, string> = {},
  at = NOW,
) {
  const auth = await authorize(params(c, { prompt: "none", ...over }), at);
  expect(auth.status).toBe(303);
  const loc = new URL(auth.headers.get("location")!, BASE);
  return {
    binder: auth.headers.get("set-cookie")!.split(";")[0]!,
    path: `${loc.pathname}${loc.search}`,
    enter: (cookies: string[], when = at) =>
      dispatchWith(
        new Request(`${BASE}${loc.pathname}${loc.search}`, {
          headers: { cookie: cookies.join("; ") },
        }),
        w.env,
        w.db,
        when,
      ),
  };
}
const where = (res: Response) =>
  new URL(res.headers.get("location") ?? "about:blank");

describe("open redirect (IS-3)", () => {
  it("no redirect_uri trick reaches an unregistered host or injects a header", async () => {
    const tricks = [
      EVIL,
      "https://forum.example.com@evil.example.com/cb",
      "https://evil.example.com\\@forum.example.com/cb",
      "https://forum.example.com.evil.example.com/cb",
      "https://forum.example.com/cb/../../steal",
      "https://forum.example.com/cb%2f..%2fsteal",
      "//evil.example.com/cb",
      "/cb",
      "javascript:alert(1)",
      "data:text/html,x",
      "https://forum.example.com/cb\r\nLocation: https://evil.example.com",
      "https://forum.example.com/cb%0d%0aLocation:%20https://evil.example.com",
      "https://forum․example.com/cb",
      "HTTPS://forum.example.com/cb",
      " https://forum.example.com/cb",
      "https://forum.example.com/cb ",
      "https://forum.example.com/cb\0",
    ];
    for (const uri of tricks) {
      const res = await authorize(
        params(victim, {
          redirect_uri: uri,
          response_type: "token",
          state: "x\r\ny",
        }),
      );
      expect(res.status, JSON.stringify(uri)).toBe(400);
      expect(res.headers.get("location"), JSON.stringify(uri)).toBeNull();
    }
  });

  it("another client's registered URI does not work for this client, nor another product's client id", async () => {
    await mk("other-app", "spa", ["https://other.example.com/cb"]);
    const res = await authorize(
      params(victim, { redirect_uri: "https://other.example.com/cb" }),
    );
    expect(res.status).toBe(400);
    await seedProduct(w.db, "rival");
    await enableIssuer(w.db, "rival");
    const rival = await createClient(
      w.db,
      {
        product: "rival",
        key: "forum",
        origin: "console",
        name: "r",
        developerName: null,
        type: "spa",
        redirectUris: [EVIL],
        postLogoutRedirectUris: [],
        scopes: ["openid"],
        claimsRequired: [],
        iconUrl: null,
      },
      NOW,
    );
    if (!rival.ok) throw new Error(rival.reason);
    const cross = await authorize(params(rival.client, { redirect_uri: EVIL }));
    expect(cross.status).toBe(401);
    expect(cross.headers.get("location")).toBeNull();
  });

  it("errors carry state and iss only as encoded query members, never a fragment or a second location", async () => {
    const res = await authorize(
      params(victim, {
        response_type: "token",
        state: "a&error=none#frag\r\nX: y",
      }),
    );
    expect(res.status).toBe(302);
    const u = where(res);
    expect(`${u.origin}${u.pathname}`).toBe(CB);
    expect(u.hash).toBe("");
    expect(u.searchParams.get("error")).toBe("unsupported_response_type");
    expect(u.searchParams.get("state")).toBe("a&error=none#frag\r\nX: y");
    expect(u.searchParams.get("iss")).toBe(ISSUER);
    expect(res.headers.get("location")).not.toMatch(/[\r\n]/);
  });

  it("an authorization code is never in an error or in any fragment", async () => {
    for (const bad of <Record<string, string>[]>[
      { response_type: "token" },
      { scope: "profile" },
      { response_mode: "fragment" },
      { prompt: "none login" },
    ]) {
      const res = await authorize(params(victim, bad));
      expect(res.headers.get("location")).not.toMatch(/code=|#/);
    }
  });
});

describe("PKCE downgrade (IS-4)", () => {
  it("a public client cannot drop, weaken or mangle its challenge", async () => {
    const attempts: Record<string, string>[] = [
      { code_challenge: "", code_challenge_method: "S256" },
      { code_challenge_method: "plain" },
      { code_challenge_method: "s256" },
      { code_challenge: pair.challenge + "A" },
      { code_challenge: pair.verifier + "=" },
    ];
    for (const over of attempts) {
      const res = await authorize(params(victim, over));
      expect(res.status, JSON.stringify(over)).toBe(302);
      expect(where(res).searchParams.get("error")).toBe("invalid_request");
    }
    const none = new URLSearchParams(params(victim));
    none.delete("code_challenge");
    none.delete("code_challenge_method");
    expect(where(await authorize(none)).searchParams.get("error")).toBe(
      "invalid_request",
    );
    // A nonce is no substitute for a public client's challenge.
    none.set("nonce", "n");
    expect(where(await authorize(none)).searchParams.get("error")).toBe(
      "invalid_request",
    );
  });
});

describe("prompt=none abuse (D4, IS-8)", () => {
  it("another person's session, or none, never yields a code for a client that person never granted", async () => {
    await grant(victim, "someone-else");
    const { cookie } = await login();
    const a = await none(victim);
    const res = await a.enter([a.binder, cookie]);
    expect(where(res).searchParams.get("error")).toBe("consent_required");
    expect(where(res).searchParams.get("code")).toBeNull();
  });

  it("a grant for one client does not cover another client of the same product", async () => {
    await grant(victim);
    const sibling = await mk("sibling", "spa", ["https://sib.example.com/cb"]);
    const { cookie } = await login();
    const a = await none(sibling, {
      redirect_uri: "https://sib.example.com/cb",
    });
    const res = await a.enter([a.binder, cookie]);
    expect(where(res).searchParams.get("error")).toBe("consent_required");
  });

  it("a stolen handle presented by another browser, without its binder, is nothing", async () => {
    await grant(victim);
    const { cookie } = await login();
    const a = await none(victim);
    const res = await a.enter([cookie]);
    expect(res.headers.get("location")).toBeNull();
    // The rightful browser still gets its answer: the stranger burned nothing.
    const ok = await a.enter([a.binder, cookie]);
    expect(where(ok).searchParams.get("code")).not.toBeNull();
  });

  it("an answered request cannot be replayed for a second code", async () => {
    await grant(victim);
    const { cookie } = await login();
    const a = await none(victim);
    expect(
      where(await a.enter([a.binder, cookie])).searchParams.get("code"),
    ).not.toBeNull();
    const again = await a.enter([a.binder, cookie]);
    expect(again.headers.get("location")).toBeNull();
  });

  it("a revoked or expired session is login_required, not a silent sign-in", async () => {
    await grant(victim);
    const { cookie } = await login();
    await revokeAllAccountSessions(w.db, accountId, NOW + 1);
    const a = await none(victim);
    expect(
      where(await a.enter([a.binder, cookie])).searchParams.get("error"),
    ).toBe("login_required");
    const later = NOW + 15 * 86_400;
    const b = await none(victim, {}, later);
    const stale = await login(NOW);
    expect(
      where(await b.enter([b.binder, stale.cookie], later)).searchParams.get(
        "error",
      ),
    ).toBe("login_required");
  });

  it("a hint signed under another product's key, or by none, cannot steer the decision", async () => {
    await seedProduct(w.db, "rival");
    await enableIssuer(w.db, "rival");
    const foreign = await signIssuerJwt(
      w.env,
      w.db,
      "rival",
      "JWT",
      { iss: ISSUER, sub: w.subject },
      NOW,
    );
    const res = await authorize(
      params(victim, { id_token_hint: foreign, prompt: "none" }),
    );
    expect(where(res).searchParams.get("error")).toBe("invalid_request");
  });

  it("an expired hint of the wrong subject cannot be used to learn a session", async () => {
    await grant(victim);
    const { cookie } = await login();
    const hint = await signIssuerJwt(
      w.env,
      w.db,
      SLUG,
      "JWT",
      { iss: ISSUER, sub: "ps_" + "z".repeat(22), exp: NOW - 5 },
      NOW,
    );
    const a = await none(victim, { id_token_hint: hint });
    const res = await a.enter([a.binder, cookie]);
    expect(where(res).searchParams.get("error")).toBe("login_required");
    expect(where(res).searchParams.get("code")).toBeNull();
  });

  it("the answer never lands in a fragment or on a host that is not registered", async () => {
    await grant(victim);
    const { cookie } = await login();
    const a = await none(victim, { state: "s#1" });
    const u = where(await a.enter([a.binder, cookie]));
    expect(`${u.origin}${u.pathname}`).toBe(CB);
    expect(u.hash).toBe("");
    expect(u.href).not.toContain(EVIL);
  });
});
