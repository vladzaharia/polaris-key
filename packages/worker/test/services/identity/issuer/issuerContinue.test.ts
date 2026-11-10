/**
 * I-21.8: Continue, Cancel and the consent view for a registered client (V5 §12.13.3 rules 2, 4, 5;
 * D22). Every check Continue re-makes is attacked: a hint of another account, a stale session under
 * `max_age` or `prompt=login`, a declined required claim, a `choice`, a client gone since
 * `authorize`, unaccepted terms and a replay. Time is the injected `now`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { dispatchWith } from "../../../../src/dispatch.js";
import { SETTINGS } from "../../../../src/mount.js";
import {
  setClientStatus,
  updateClient,
  type ClientRecord,
} from "../../../../src/services/identity/issuer/clientsRepo.js";
import {
  getClientGrant,
  putClientGrant,
} from "../../../../src/services/identity/issuer/grantsRepo.js";
import { signIssuerJwt } from "../../../../src/services/identity/issuer/keys.js";
import {
  handleSignInCancel,
  handleSignInContinue,
} from "../../../../src/services/identity/passthrough/continue.js";
import { redeemAuthorizationCode } from "../../../../src/services/identity/passthrough/code.js";
import { signInConsentView } from "../../../../src/services/identity/passthrough/routes.js";
import { NOW } from "../../../seed.js";
import { BASE, SLUG, type World } from "../../connect/connectFixture.js";
import { ingestIdentity } from "./issuerHelpers.js";
import { issuerWorld, mkClient } from "./issuerWorld.js";

const CB = "https://forum.example.com/cb";
const ISSUER = `${BASE}/${SLUG}/identity`;
let w: World;
let client: ClientRecord;
let accountId: string;
let pair: { verifier: string; challenge: string };

const mk = (over: Partial<Parameters<typeof mkClient>[1]> = {}) =>
  mkClient(w, {
    key: "forum",
    type: "spa",
    redirectUris: [CB],
    name: "Forum",
    ...over,
  });

beforeEach(async () => {
  ({ w, accountId, pair } = await issuerWorld());
  client = await mk();
});

/** `authorize` at `at`; the handle and the binder cookie of the browser that made it. */
async function start(extra: Record<string, string> = {}, at = NOW) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: CB,
    scope: "openid profile email offline_access",
    state: "st-1",
    code_challenge: pair.challenge,
    code_challenge_method: "S256",
    ...extra,
  });
  const res = await dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/authorize?${p}`),
    w.env,
    w.db,
    at,
  );
  expect(res.status).toBe(303);
  return {
    handle: /request=(rq_[A-Za-z0-9_-]{22})/.exec(
      res.headers.get("location")!,
    )![1]!,
    cookie: res.headers.get("set-cookie")!.split(";")[0]!,
  };
}

const post = (cookie: string, body: unknown) =>
  new Request(`${BASE}/api/signin/requests/x/continue`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: BASE },
    body: JSON.stringify(body),
  });

type Out = { status: number; json: Record<string, unknown> };
async function cont(
  s: { handle: string; cookie: string },
  body: unknown = {},
  opts: { at?: number; authTime?: number } = {},
): Promise<Out> {
  const at = opts.at ?? NOW;
  const res = await handleSignInContinue(
    post(s.cookie, body),
    w.env,
    w.db,
    { accountId },
    s.handle,
    at,
    SETTINGS,
    opts.authTime ?? at,
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}
const redirectOf = (o: Out) => new URL(o.json.redirect as string);

/** The consent view for a request, as the card reads it (`authTime`: the session's sign-in time). */
const consentOf = async (
  s: { handle: string; cookie: string },
  authTime = NOW,
  withCookie = true,
) =>
  (await signInConsentView(
    w.env,
    w.db,
    new Request(
      `${BASE}/x`,
      withCookie ? { headers: { cookie: s.cookie } } : {},
    ),
    s.handle,
    accountId,
    NOW,
    SETTINGS,
    authTime,
  )) as unknown as { status: number; body: any };

describe("consent view", () => {
  it("lists the requested items in order, marks the required claims, and has no licence line", async () => {
    const s = await start({
      scope: "openid profile email pkey:entitlements offline_access",
    });
    const view = await consentOf(s);
    expect(view.status).toBe(200);
    const body = (view as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({
      items: [
        {
          kind: "profile",
          claims: ["name", "picture", "email"],
          required: ["name"],
        },
        { kind: "entitlements" },
        { kind: "offline" },
      ],
      firstTime: true,
      changed: false,
    });
    expect(body.reauth).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/license|cloudSync/i);
    expect(body.scopeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("asks only for what the request reaches", async () => {
    const s = await start({ scope: "openid" });
    const view = (await consentOf(s)) as { body: { items: unknown[] } };
    expect(view.body.items).toEqual([]);
  });

  it("tells the card to sign in again when the request needs it", async () => {
    const s = await start({ prompt: "login" }, NOW);
    const view = (await consentOf(s, NOW - 5)) as {
      body: { reauth?: boolean };
    };
    expect(view.body.reauth).toBe(true);
    const fresh = (await consentOf(s)) as { body: { reauth?: boolean } };
    expect(fresh.body.reauth).toBeUndefined();
  });

  it("is 404 without the browser's binder, and for a disabled client", async () => {
    const s = await start();
    const none = await consentOf(s, NOW, false);
    expect(none.status).toBe(404);
    await setClientStatus(w.db, SLUG, client.clientId, "disabled", NOW);
    const gone = await consentOf(s);
    expect(gone.status).toBe(404);
  });
});

describe("Continue", () => {
  it("writes the client grant, never app consent, and answers a code with state and iss", async () => {
    const s = await start();
    const out = await cont(s, { consent: { claims: ["name", "email"] } });
    expect(out.status).toBe(200);
    const u = redirectOf(out);
    expect(`${u.origin}${u.pathname}`).toBe(CB);
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("iss")).toBe(ISSUER);
    expect(u.hash).toBe("");
    const grant = (await getClientGrant(
      w.db,
      SLUG,
      accountId,
      client.clientId,
    ))!;
    expect(grant).toMatchObject({
      claimsGranted: ["name", "email"],
      claimsDeclined: ["picture"],
      scopes: ["offline_access"],
    });
    expect(grant.scopeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await w.db.first(
        "SELECT 1 FROM account_product_grants WHERE account_id = ?",
        accountId,
      ),
    ).toBeNull();
    const rec = await redeemAuthorizationCode(
      w.env,
      SLUG,
      u.searchParams.get("code")!,
      pair.challenge,
    );
    expect(rec).toMatchObject({
      clientId: client.clientId,
      redirectUri: CB,
      accountId,
      subject: w.subject,
      scope: ["openid", "profile", "email", "offline_access"],
      choice: null,
      registered: { claims: ["name", "email"], authTime: NOW },
    });
  });

  it("grants everything the request reaches when no consent is sent, and takes the handle", async () => {
    const s = await start();
    expect((await cont(s)).status).toBe(200);
    expect(
      (await getClientGrant(w.db, SLUG, accountId, client.clientId))!
        .claimsGranted,
    ).toEqual(["name", "picture", "email"]);
    expect((await cont(s)).status).toBe(404);
  });

  it("refuses a choice, a declined required claim, a claim not reached and a malformed consent", async () => {
    const s = await start({ scope: "openid profile" });
    for (const body of [
      { choice: { kind: "keep" } },
      { consent: { claims: ["picture"] } },
      { consent: { claims: [] } },
      { consent: { claims: ["name", "email"] } },
      { consent: { claims: "name" } },
      { consent: null },
    ] as const) {
      const out = await cont(s, body);
      expect(out.status, JSON.stringify(body)).toBe(400);
      expect(out.json.error).toBe("bad_request");
    }
    // Nothing was consumed or written: the card can try again.
    expect(
      await getClientGrant(w.db, SLUG, accountId, client.clientId),
    ).toBeNull();
    expect((await cont(s, { consent: { claims: ["name"] } })).status).toBe(200);
  });

  it("an optional-only client may decline everything", async () => {
    await setClientStatus(w.db, SLUG, client.clientId, "disabled", NOW);
    client = await mk({ key: "loose", claimsRequired: [] });
    const s = await start();
    expect((await cont(s, { consent: { claims: [] } })).status).toBe(200);
    expect(
      (await getClientGrant(w.db, SLUG, accountId, client.clientId))!
        .claimsDeclined,
    ).toEqual(["name", "picture", "email"]);
  });

  it("a hint of another account is 409 wrong_account: the person switches, nothing is consumed", async () => {
    const hint = await signIssuerJwt(
      w.env,
      w.db,
      SLUG,
      "JWT",
      {
        iss: ISSUER,
        sub: "ps_" + "q".repeat(22),
        aud: client.clientId,
        exp: NOW - 1,
      },
      NOW,
    );
    const s = await start({ id_token_hint: hint });
    const out = await cont(s);
    expect(out.status).toBe(409);
    expect(out.json.error).toBe("wrong_account");
    expect((await consentOf(s)).body.wrongAccount).toBe(true);
    expect(
      await getClientGrant(w.db, SLUG, accountId, client.clientId),
    ).toBeNull();
    // Still pending: the card can offer to switch account, and Cancel still answers.
    expect((await cont(s)).status).toBe(409);
    // The right account's hint continues.
    const ok = await signIssuerJwt(
      w.env,
      w.db,
      SLUG,
      "JWT",
      { iss: ISSUER, sub: w.subject, aud: client.clientId, exp: NOW - 1 },
      NOW,
    );
    const s2 = await start({ id_token_hint: ok });
    expect(redirectOf(await cont(s2)).searchParams.get("code")).not.toBeNull();
  });

  it("prompt=login and max_age need a sign-in made after the request; auth_time is that time", async () => {
    const login = await start({ prompt: "login" }, NOW + 100);
    // A session from before the request: refused, nothing consumed.
    const stale = await cont(login, {}, { at: NOW + 100, authTime: NOW });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("reauth_required");
    // After signing in again (a session minted after the request), it continues with that time.
    const fresh = await cont(login, {}, { at: NOW + 130, authTime: NOW + 120 });
    expect(fresh.status).toBe(200);
    const rec = await redeemAuthorizationCode(
      w.env,
      SLUG,
      redirectOf(fresh).searchParams.get("code")!,
      pair.challenge,
    );
    expect(rec!.registered!.authTime).toBe(NOW + 120);

    const aged = await start({ max_age: "60" }, NOW + 1000);
    expect(
      (await cont(aged, {}, { at: NOW + 1000, authTime: NOW + 900 })).json
        .error,
    ).toBe("reauth_required");
    const young = await start({ max_age: "60" }, NOW + 1000);
    expect(
      (await cont(young, {}, { at: NOW + 1000, authTime: NOW + 950 })).status,
    ).toBe(200);
    const zero = await start({ max_age: "0" }, NOW + 1000);
    expect(
      (await cont(zero, {}, { at: NOW + 1000, authTime: NOW + 999 })).json
        .error,
    ).toBe("reauth_required");
  });

  it("a client disabled after authorize, or the issuer turned off, is the same 404", async () => {
    const a = await start();
    await setClientStatus(w.db, SLUG, client.clientId, "disabled", NOW);
    expect((await cont(a)).status).toBe(404);
    await setClientStatus(w.db, SLUG, client.clientId, "active", NOW);
    const b = await start();
    await w.db.run(
      "DELETE FROM product_settings WHERE key = 'identity.issuer.enabled'",
    );
    expect((await cont(b)).status).toBe(404);
  });

  it("the product's terms are asked once, and this press may accept them", async () => {
    await ingestIdentity(w.db, SLUG, {
      issuer: { enabled: true },
      terms: { version: "2026-10", url: "https://acme.example/terms" },
    });
    const s = await start();
    const asked = await cont(s);
    expect(asked.status).toBe(409);
    expect(asked.json.error).toBe("terms_required");
    expect((await cont(s, { terms: "2026-09" })).status).toBe(409);
    expect((await cont(s, { terms: "2026-10" })).status).toBe(200);
    const row = await w.db.first(
      "SELECT 1 FROM account_terms_acceptances WHERE account_id = ? AND product = ?",
      accountId,
      SLUG,
    );
    expect(row).not.toBeNull();
  });

  it("writes an audit row without a code or a claim value", async () => {
    const s = await start();
    await cont(s);
    const a = await w.db.first<{ summary: string; target_id: string }>(
      "SELECT summary, target_id FROM audit WHERE action = 'identity.client.continue'",
    );
    expect(a!.target_id).toBe(client.clientId);
    expect(a!.summary).not.toMatch(/code=|ada@/);
  });

  it("a person who had granted before is asked again only for a change; the view says so", async () => {
    await putClientGrant(
      w.db,
      {
        accountId,
        clientId: client.clientId,
        product: SLUG,
        claimsGranted: ["name", "email"],
        claimsDeclined: ["picture"],
        scopes: ["offline_access"],
        scopeHash: "h",
      },
      NOW,
    );
    const s = await start();
    const v = (await consentOf(s)) as {
      body: { firstTime: boolean; changed: boolean };
    };
    expect(v.body).toMatchObject({ firstTime: false, changed: false });
    const s2 = await start({
      scope: "openid profile email offline_access pkey:entitlements",
    });
    const v2 = (await consentOf(s2, NOW)) as { body: { changed: boolean } };
    expect(v2.body.changed).toBe(true);
  });
});

describe("Continue re-checks what the request was registered for", () => {
  it("a redirect URI or scope the developer removed since authorize is the same 404", async () => {
    const a = await start();
    await updateClient(
      w.db,
      SLUG,
      client.clientId,
      { redirectUris: ["https://moved.example.com/cb"] },
      NOW,
    );
    expect((await cont(a)).status).toBe(404);
    await updateClient(
      w.db,
      SLUG,
      client.clientId,
      { redirectUris: [CB] },
      NOW,
    );
    const b = await start();
    await updateClient(
      w.db,
      SLUG,
      client.clientId,
      { scopes: ["openid", "profile"] },
      NOW,
    );
    expect((await cont(b)).status).toBe(404);
  });
});

describe("a decision, once made, stays made (V5 §12.13.6)", () => {
  const decide = async (extra: Record<string, string>, claims?: string[]) => {
    const s = await start(extra);
    const out = await cont(
      s,
      claims === undefined ? {} : { consent: { claims } },
    );
    expect(out.status).toBe(200);
    return s;
  };

  it("a new scope asks only about the new item and never switches a declined claim back on", async () => {
    await decide({ scope: "openid profile email" }, ["name"]);
    const first = await getClientGrant(w.db, SLUG, accountId, client.clientId);
    expect(first).toMatchObject({
      claimsGranted: ["name"],
      claimsDeclined: ["picture", "email"],
    });
    // The client now also asks to stay signed in.
    const s = await start({ scope: "openid profile email offline_access" });
    const view = await consentOf(s);
    expect(view.body.items).toEqual([{ kind: "offline" }]);
    expect(view.body.shared).toEqual(["name"]);
    expect(view.body.changed).toBe(true);
    // One press with no consent posted: the old decisions stand.
    const out = await cont(s);
    expect(out.status).toBe(200);
    const after = (await getClientGrant(
      w.db,
      SLUG,
      accountId,
      client.clientId,
    ))!;
    expect(after).toMatchObject({
      claimsGranted: ["name"],
      claimsDeclined: ["picture", "email"],
      scopes: ["offline_access"],
    });
    const code = await redeemAuthorizationCode(
      w.env,
      SLUG,
      redirectOf(out).searchParams.get("code")!,
      pair.challenge,
    );
    expect(code!.registered!.claims).toEqual(["name"]);
  });

  it("a declined claim cannot be flipped on by a posted consent", async () => {
    await decide({ scope: "openid profile email" }, ["name"]);
    const s = await start({ scope: "openid profile email offline_access" });
    for (const claims of [
      ["picture"],
      ["name", "email"],
      ["name", "picture", "email"],
    ]) {
      const out = await cont(s, { consent: { claims } });
      expect(out.status, claims.join()).toBe(400);
    }
    expect(
      (await getClientGrant(w.db, SLUG, accountId, client.clientId))!
        .claimsDeclined,
    ).toEqual(["picture", "email"]);
  });

  it("a new claim is asked, and merged beside the old decisions", async () => {
    await decide({ scope: "openid profile" }, ["name"]);
    const s = await start({ scope: "openid profile email" });
    expect((await consentOf(s)).body.items).toEqual([
      { kind: "profile", claims: ["email"], required: [] },
    ]);
    await cont(s, { consent: { claims: ["email"] } });
    expect(
      await getClientGrant(w.db, SLUG, accountId, client.clientId),
    ).toMatchObject({
      claimsGranted: ["name", "email"],
      claimsDeclined: ["picture"],
    });
  });

  it("a narrower request keeps the decisions it does not reach", async () => {
    await decide({ scope: "openid profile email" }, ["name", "email"]);
    // A request for the profile alone: nothing undecided, and the email decision is untouched.
    await decide({ scope: "openid profile" });
    const after = (await getClientGrant(
      w.db,
      SLUG,
      accountId,
      client.clientId,
    ))!;
    expect([...after.claimsGranted].sort()).toEqual(["email", "name"]);
    expect(after.claimsDeclined).toEqual(["picture"]);
    // A later request that reaches the email again does not ask about it.
    const s = await start({ scope: "openid profile email" });
    expect((await consentOf(s)).body.items).toEqual([]);
  });

  it("a claim that became required after it was declined is asked again", async () => {
    await decide({ scope: "openid profile email" }, ["name"]);
    await updateClient(
      w.db,
      SLUG,
      client.clientId,
      { claimsRequired: ["name", "email"] },
      NOW,
    );
    const s = await start({ scope: "openid profile email" });
    expect((await consentOf(s)).body.items).toEqual([
      { kind: "profile", claims: ["email"], required: ["email"] },
    ]);
    expect((await cont(s, { consent: { claims: [] } })).status).toBe(400);
    expect((await cont(s, { consent: { claims: ["email"] } })).status).toBe(
      200,
    );
    expect(
      (await getClientGrant(w.db, SLUG, accountId, client.clientId))!
        .claimsGranted,
    ).toEqual(["name", "email"]);
  });

  it("prompt=consent lists everything again, each switch starting from the grant, and the person may change it", async () => {
    await decide({ scope: "openid profile email" }, ["name", "email"]);
    const s = await start({ scope: "openid profile email", prompt: "consent" });
    const view = await consentOf(s);
    expect(view.body.items[0]).toMatchObject({
      kind: "profile",
      claims: ["name", "picture", "email"],
      off: ["picture"],
    });
    await cont(s, { consent: { claims: ["name", "picture"] } });
    expect(
      await getClientGrant(w.db, SLUG, accountId, client.clientId),
    ).toMatchObject({
      claimsGranted: ["name", "picture"],
      claimsDeclined: ["email"],
    });
  });
});

describe("the consent view's terms and the partner flag", () => {
  it("lists the terms until accepted, and Continue with the version accepts them", async () => {
    await ingestIdentity(w.db, SLUG, {
      issuer: { enabled: true },
      terms: { version: "2026-10", url: "https://acme.example/terms" },
    });
    const s = await start();
    expect((await consentOf(s)).body.terms).toEqual({
      version: "2026-10",
      url: "https://acme.example/terms",
    });
    expect((await cont(s)).status).toBe(409);
    expect((await cont(s, { terms: "2026-10" })).status).toBe(200);
    const again = await start();
    expect((await consentOf(again)).body.terms).toBeUndefined();
  });
});

describe("Cancel", () => {
  it("returns access_denied to the registered URI with state and iss, and takes the handle", async () => {
    const s = await start();
    const res = await handleSignInCancel(
      post(s.cookie, {}),
      w.env,
      w.db,
      { accountId },
      s.handle,
      NOW,
    );
    expect(res.status).toBe(200);
    const u = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(`${u.origin}${u.pathname}`).toBe(CB);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("iss")).toBe(ISSUER);
    expect((await cont(s)).status).toBe(404);
    expect(
      await getClientGrant(w.db, SLUG, accountId, client.clientId),
    ).toBeNull();
  });
});
