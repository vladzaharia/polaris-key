/**
 * PX-W15: the email gate (PORTAL.md §4.29, §10.2 G31; SIGN-IN.md §3.5), end to end.
 *
 *   - The provider rule through the real front doors (I-06's callbacks into I-07's gate): Google
 *     with `email_verified: false` gets a code; an Apple private-relay address gets none; Steam
 *     starts with an empty field. The confirm step always shows the address it is confirming.
 *   - Google's rule (lead decision, 2026-10-06): `email_verified` stands in for our code only for
 *     `@gmail.com`/`@googlemail.com` or when the signed `hd` claim names the address's domain; a
 *     non-Gmail address without `hd`, or with another domain's `hd`, gets a code.
 *   - No session and no app token before the gate passes: at every step before the pass no
 *     session cookie is set, no `account_sessions` row exists, and every session-gated route
 *     (the account, the sessions list, app consent for a passthrough request, device approval)
 *     refuses. The pass is the one response that opens a session and hands back the request.
 *   - Terms acceptances per account, product and version (`account_terms_acceptances`): a new
 *     version adds a row and keeps the old one; a merge carries them; deletion erases them.
 */

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appleClaims,
  cookieFrom,
  fixture,
  googleClaims,
  makeProviderHarness,
  nonceOf,
  ORIGIN,
  type ProviderHarness,
} from "./identityProviderHarness.js";
import {
  Device,
  lastCode,
  seededWorld,
  type CardWorld,
} from "./identityCardHarness.js";
import { NOW, seedProduct } from "./seed.js";
import { resetProviderCaches } from "../src/services/identity/providers/discovery.js";
import {
  beginProviderSignIn,
  EMAIL_GATE_LANDING,
  providerVouchesForEmail,
  type ProviderSignIn,
} from "../src/services/identity/card/gate.js";
import {
  ACCOUNT_SESSION_COOKIE,
  EMAIL_GATE_COOKIE,
} from "../src/core/accounts/accountCookies.js";
import { PORTAL_COOKIE } from "../src/services/identity/portal/session.js";
import { createSignInRequest } from "../src/services/identity/passthrough/request.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/core/repo.js";
import {
  EMAIL_ISSUER,
  insertAccount,
  insertLink,
} from "../src/services/identity/accounts/repo.js";
import {
  recordTermsAcceptance,
  termsAccepted,
  termsAcceptancesOf,
} from "../src/services/identity/accounts/terms.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import { deleteAccount } from "../src/services/identity/accounts/deletion.js";
import { deleteProduct } from "../src/core/console/repo.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetProviderCaches();
});

const GATE = "/api/signin/confirm-email";

// ── The provider rule, through the real front doors ─────────────────────────────────────────

interface Mail {
  to: string;
  text: string;
}

/** Capture the sign-in mail the gate sends (the provider harness has no mail binding). */
function captureMail(env: Env): Mail[] {
  const mail: Mail[] = [];
  env.EMAIL = {
    send: async (m: Mail) => {
      mail.push({ to: m.to, text: m.text });
    },
  } as unknown as Env["EMAIL"];
  return mail;
}

function codeIn(mail: Mail[], to: string): string {
  const m = [...mail].reverse().find((x) => x.to === to);
  const match = m ? /(\d{3}) (\d{3})/.exec(m.text) : null;
  if (!match) throw new Error(`no code mailed to ${to}`);
  return `${match[1]}${match[2]}`;
}

/** The card driving the gate: the gate cookie only, as the browser holds it. */
function gateCall(
  h: ProviderHarness,
  gate: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return h.request(
    path,
    body === undefined
      ? { cookie: gate }
      : {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify(body),
          cookie: gate,
        },
  );
}

async function accountCount(db: Db): Promise<number> {
  return (
    (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM accounts"))?.n ??
    0
  );
}

async function googleCallback(
  h: ProviderHarness,
  over: Record<string, unknown>,
): Promise<Response> {
  const { location, state, cookie } = await h.start("google");
  h.idToken.google = await h.signGoogle(googleClaims(nonceOf(location), over));
  const qs = new URLSearchParams({
    code: "4/0AQSTgQ-code",
    state,
    scope: "email",
    iss: "https://accounts.google.com",
  });
  return h.request(`/login/google/callback?${qs}`, { cookie });
}

async function appleCallback(
  h: ProviderHarness,
  over: Record<string, unknown> = {},
): Promise<Response> {
  const { location, state, cookie } = await h.start("apple");
  h.idToken.apple = await h.signApple(appleClaims(nonceOf(location), over));
  return h.request("/login/apple/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ state, code: "c0ffee" }).toString(),
    cookie,
  });
}

async function steamCallback(h: ProviderHarness): Promise<Response> {
  const { location, cookie } = await h.start("steam");
  const real = location.searchParams.get("openid.return_to")!;
  const fields = JSON.parse(fixture("steam-assertion.json")) as Record<
    string,
    string
  >;
  fields["openid.return_to"] = real;
  fields["openid.response_nonce"] = `${new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")}8ZvVbJ3TfRZi1M5Xx0M1dXyX5Y4=`;
  const url = new URL(real);
  for (const [k, v] of Object.entries(fields)) url.searchParams.set(k, v);
  return h.request(`${url.pathname}${url.search}`, { cookie });
}

/** The gate the callback opened: its cookie, and the step the card renders. */
async function openedGate(
  h: ProviderHarness,
  callback: Response,
): Promise<{
  gate: string;
  view: {
    provider: string;
    stage: string;
    emailRequired: boolean;
    email: {
      provider: string | null;
      providerVerified: boolean;
      relay: boolean;
      pending: string | null;
      confirmed: string | null;
    };
  };
}> {
  expect(callback.headers.get("location")).toBe(EMAIL_GATE_LANDING);
  expect(cookieFrom(callback, PORTAL_COOKIE)).toBeNull();
  const gate = cookieFrom(callback, EMAIL_GATE_COOKIE);
  expect(gate).toBeTruthy();
  const res = await gateCall(h, gate!, GATE);
  expect(res.status).toBe(200);
  return { gate: gate!, view: await res.json() };
}

describe("the provider rule, through the real front doors (owner, 2026-10-04)", () => {
  it("Google with email_verified: false gets a code to that address, and passes only on it", async () => {
    const h = await makeProviderHarness();
    const mail = captureMail(h.env);
    const callback = await googleCallback(h, { email_verified: false });
    const { gate, view } = await openedGate(h, callback);
    // The step shows the address it would confirm, and that the provider did not verify it.
    expect(view.email).toMatchObject({
      provider: "ada@example.com",
      providerVerified: false,
      relay: false,
    });

    const sent = await gateCall(h, gate, GATE, { choice: "provider" });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({
      status: "code_sent",
      email: "ada@example.com",
      codeLength: 6,
    });
    expect(mail.map((m) => m.to)).toEqual(["ada@example.com"]);
    expect(cookieFrom(sent, PORTAL_COOKIE)).toBeNull();
    expect(await accountCount(h.db)).toBe(0);
    // While the code is out, the step names the address the code went to.
    const pending = await (await gateCall(h, gate, GATE)).json();
    expect(pending).toMatchObject({
      stage: "code_sent",
      email: { pending: "ada@example.com", confirmed: null },
    });

    const right = codeIn(mail, "ada@example.com");
    const wrong = await gateCall(h, gate, `${GATE}/verify`, {
      code: right === "000000" ? "111111" : "000000",
    });
    expect(wrong.status).toBe(400);
    expect(cookieFrom(wrong, PORTAL_COOKIE)).toBeNull();
    expect(await accountCount(h.db)).toBe(0);

    const passed = await gateCall(h, gate, `${GATE}/verify`, { code: right });
    expect(passed.status).toBe(200);
    expect(await passed.json()).toMatchObject({ status: "signed_in" });
    expect(cookieFrom(passed, PORTAL_COOKIE)).toBeTruthy();
    const account = await h.db.first<{
      id: string;
      primary_email: string;
      primary_email_verified_at: number | null;
    }>("SELECT id, primary_email, primary_email_verified_at FROM accounts");
    expect(account?.primary_email).toBe("ada@example.com");
    expect(account?.primary_email_verified_at).not.toBeNull();
    // Our code proved the address (the email method); Google's own claim stays unverified.
    const links = await h.db.all<{ kind: string; email_verified: number }>(
      "SELECT kind, email_verified FROM account_links WHERE account_id = ? ORDER BY kind",
      account!.id,
    );
    expect(links).toEqual([
      { kind: "email", email_verified: 1 },
      { kind: "google", email_verified: 0 },
    ]);
  });

  it("an Apple private-relay address needs no code: Apple verified it", async () => {
    const h = await makeProviderHarness();
    const mail = captureMail(h.env);
    const callback = await appleCallback(h);
    expect(callback.status).toBe(303);
    const { gate, view } = await openedGate(h, callback);
    expect(view.email).toMatchObject({
      provider: "q7x9k2@privaterelay.appleid.com",
      providerVerified: true,
      relay: true,
    });
    expect(await accountCount(h.db)).toBe(0);

    const passed = await gateCall(h, gate, GATE, { choice: "provider" });
    expect(passed.status).toBe(200);
    expect(await passed.json()).toMatchObject({ status: "signed_in" });
    expect(cookieFrom(passed, PORTAL_COOKIE)).toBeTruthy();
    expect(mail).toHaveLength(0);
    expect(
      await h.db.first<{ primary_email: string }>(
        "SELECT primary_email FROM accounts",
      ),
    ).toEqual({ primary_email: "q7x9k2@privaterelay.appleid.com" });
  });

  it("switching from the relay to a typed address asks for a code to the typed one", async () => {
    const h = await makeProviderHarness();
    const mail = captureMail(h.env);
    const { gate } = await openedGate(h, await appleCallback(h));
    const sent = await gateCall(h, gate, GATE, {
      choice: "typed",
      email: "grace@example.com",
    });
    expect(await sent.json()).toMatchObject({
      status: "code_sent",
      email: "grace@example.com",
    });
    expect(mail.map((m) => m.to)).toEqual(["grace@example.com"]);
    expect(await accountCount(h.db)).toBe(0);
  });

  it("Steam starts with an empty field: nothing to accept, and a typed address gets a code", async () => {
    const h = await makeProviderHarness();
    const mail = captureMail(h.env);
    const { gate, view } = await openedGate(h, await steamCallback(h));
    expect(view.provider).toBe("steam");
    expect(view.emailRequired).toBe(true);
    expect(view.email).toMatchObject({
      provider: null,
      providerVerified: false,
      relay: false,
    });

    // There is no provider address to keep.
    const none = await gateCall(h, gate, GATE, { choice: "provider" });
    expect(none.status).toBe(400);
    expect(cookieFrom(none, PORTAL_COOKIE)).toBeNull();

    const sent = await gateCall(h, gate, GATE, {
      choice: "typed",
      email: "robin@example.com",
    });
    expect(await sent.json()).toMatchObject({
      status: "code_sent",
      email: "robin@example.com",
    });
    expect(await accountCount(h.db)).toBe(0);
    const passed = await gateCall(h, gate, `${GATE}/verify`, {
      code: codeIn(mail, "robin@example.com"),
    });
    expect(passed.status).toBe(200);
    expect(cookieFrom(passed, PORTAL_COOKIE)).toBeTruthy();
    const steam = await h.db.first<{ email: string | null }>(
      "SELECT email FROM account_links WHERE kind = 'steam'",
    );
    expect(steam).toEqual({ email: null });
  });
});

describe("Google's email_verified counts only for Gmail or a matching Workspace hd (lead, 2026-10-06)", () => {
  /** The Google link the pass created: its stored address and whether it counts as verified. */
  async function googleLink(
    h: ProviderHarness,
  ): Promise<{ email: string; email_verified: number } | null> {
    return h.db.first<{ email: string; email_verified: number }>(
      "SELECT email, email_verified FROM account_links WHERE kind = 'google'",
    );
  }

  it("a verified Gmail address needs no code", async () => {
    const h = await makeProviderHarness();
    const mail = captureMail(h.env);
    const { gate, view } = await openedGate(
      h,
      await googleCallback(h, { email: "Ada.Lovelace@Gmail.com" }),
    );
    expect(view.email).toMatchObject({
      provider: "ada.lovelace@gmail.com",
      providerVerified: true,
    });
    const passed = await gateCall(h, gate, GATE, { choice: "provider" });
    expect(await passed.json()).toMatchObject({ status: "signed_in" });
    expect(cookieFrom(passed, PORTAL_COOKIE)).toBeTruthy();
    expect(mail).toHaveLength(0);
    expect(await googleLink(h)).toEqual({
      email: "ada.lovelace@gmail.com",
      email_verified: 1,
    });
  });

  it("a Workspace address whose hd names its domain needs no code", async () => {
    const h = await makeProviderHarness();
    const mail = captureMail(h.env);
    const { gate, view } = await openedGate(
      h,
      await googleCallback(h, {
        email: "ada@lumen.example",
        hd: "Lumen.Example",
      }),
    );
    expect(view.email).toMatchObject({
      provider: "ada@lumen.example",
      providerVerified: true,
    });
    const passed = await gateCall(h, gate, GATE, { choice: "provider" });
    expect(await passed.json()).toMatchObject({ status: "signed_in" });
    expect(mail).toHaveLength(0);
    expect(await googleLink(h)).toEqual({
      email: "ada@lumen.example",
      email_verified: 1,
    });
  });

  it("a verified non-Gmail address without hd gets a code; the Google link keeps it unverified", async () => {
    const h = await makeProviderHarness();
    const mail = captureMail(h.env);
    const { gate, view } = await openedGate(
      h,
      await googleCallback(h, { email: "ada@former-employer.example" }),
    );
    // Google said `email_verified: true`, but only that it verified the address once.
    expect(view.email).toMatchObject({
      provider: "ada@former-employer.example",
      providerVerified: false,
    });
    const sent = await gateCall(h, gate, GATE, { choice: "provider" });
    expect(await sent.json()).toMatchObject({
      status: "code_sent",
      email: "ada@former-employer.example",
    });
    expect(cookieFrom(sent, PORTAL_COOKIE)).toBeNull();
    expect(await accountCount(h.db)).toBe(0);
    // The person picks another address instead and proves it: the Google address is stored, but
    // never as verified, so it claims nothing (`verifiedAccountEmails`).
    await gateCall(h, gate, GATE, {
      choice: "typed",
      email: "ada@example.com",
    });
    const passed = await gateCall(h, gate, `${GATE}/verify`, {
      code: codeIn(mail, "ada@example.com"),
    });
    expect(passed.status).toBe(200);
    expect(await googleLink(h)).toEqual({
      email: "ada@former-employer.example",
      email_verified: 0,
    });
  });

  it("an hd that names another domain gets a code", async () => {
    const h = await makeProviderHarness();
    const mail = captureMail(h.env);
    const { gate, view } = await openedGate(
      h,
      await googleCallback(h, {
        email: "ada@lumen.example",
        hd: "other.example",
      }),
    );
    expect(view.email.providerVerified).toBe(false);
    const sent = await gateCall(h, gate, GATE, { choice: "provider" });
    expect(await sent.json()).toMatchObject({ status: "code_sent" });
    expect(mail.map((m) => m.to)).toEqual(["ada@lumen.example"]);
    expect(await accountCount(h.db)).toBe(0);
  });

  it("the predicate: Google by domain or hd, case-insensitive; Apple as before", () => {
    const g = (email: string | null, emailVerified = true) => ({
      kind: "google",
      email,
      emailVerified,
    });
    expect(providerVouchesForEmail(g("ada@gmail.com"), null)).toBe(true);
    expect(providerVouchesForEmail(g("Ada@GoogleMail.COM"), null)).toBe(true);
    expect(
      providerVouchesForEmail(g("ada@lumen.example"), "LUMEN.example"),
    ).toBe(true);
    expect(providerVouchesForEmail(g("ada@lumen.example"), null)).toBe(false);
    expect(providerVouchesForEmail(g("ada@lumen.example"), "")).toBe(false);
    expect(
      providerVouchesForEmail(g("ada@sub.lumen.example"), "lumen.example"),
    ).toBe(false);
    expect(providerVouchesForEmail(g("ada@gmail.com", false), null)).toBe(
      false,
    );
    expect(providerVouchesForEmail(g(null), "gmail.com")).toBe(false);
    expect(
      providerVouchesForEmail(
        {
          kind: "apple",
          email: "q7x9k2@privaterelay.appleid.com",
          emailVerified: true,
        },
        null,
      ),
    ).toBe(true);
    expect(
      providerVouchesForEmail(
        { kind: "apple", email: "grace@example.com", emailVerified: false },
        null,
      ),
    ).toBe(false);
  });
});

// ── No session and no app token before the gate passes ─────────────────────────────────────

const SLUG = "acme";

function google(subject: string, email: string): ProviderSignIn {
  return {
    identity: {
      issuerKey: "https://accounts.google.com",
      subject,
      kind: "google",
      email,
      emailVerified: true,
      displayName: "Ada Lovelace",
    },
  };
}

/** A world whose product runs Identity, so a passthrough request's consent can be read. */
async function identityWorld(): Promise<CardWorld> {
  const w = await seededWorld();
  await setServices(
    w.db,
    SLUG,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: true },
        sync: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
  return w;
}

/** An app sign-in request (PX-W13's handle) bound to this browser. */
async function appRequest(w: CardWorld, d: Device): Promise<string> {
  const { handle, setCookie } = await createSignInRequest(
    w.env,
    d.request("GET", "/signin"),
    { product: SLUG, kind: "web", flowRef: "flow-1" },
    NOW,
  );
  if (setCookie)
    d.absorb(new Response(null, { headers: { "set-cookie": setCookie } }));
  return handle;
}

async function sessionRows(w: CardWorld): Promise<number> {
  return (
    (
      await w.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM account_sessions",
      )
    )?.n ?? 0
  );
}

/**
 * Everything a token or a session would unlock refuses this browser: the account, its sessions,
 * the app's consent for the request, device approval. And no session cookie is in its jar.
 */
async function expectNothingIssued(
  w: CardWorld,
  d: Device,
  handle: string,
  sessionsBefore = 0,
): Promise<void> {
  expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  expect(await sessionRows(w)).toBe(sessionsBefore);
  expect((await d.send("GET", "/api/me")).status).toBe(401);
  expect((await d.send("GET", "/api/sessions")).status).toBe(401);
  expect(
    (await d.send("GET", `/api/signin/requests/${handle}/consent`)).status,
  ).toBe(401);
  expect(
    (await d.send("POST", "/api/device-login/approve", { code: "ABCD-EFGH" }))
      .status,
  ).toBe(401);
}

describe("no session and no app token before the gate passes (G31; SIGN-IN.md §3.5)", () => {
  it("every step before the pass issues nothing; the pass opens the session and hands back the request", async () => {
    const w = await identityWorld();
    const d = new Device(w);
    const handle = await appRequest(w, d);
    const opened = d.absorb(
      await beginProviderSignIn(
        d.request("GET", "/login/google/callback"),
        w.env,
        w.db,
        {
          ...google("g-1", "ada@gmail.com"),
          product: {
            slug: SLUG,
            terms: { url: "https://acme.example/terms", version: "2026-10" },
          },
          returnTo: "/library",
          request: handle,
        },
        NOW,
      ),
    );
    expect(opened.headers.get("location")).toBe(EMAIL_GATE_LANDING);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(true);
    // The request is readable before sign-in (the card shows the app); its consent is not.
    expect((await d.send("GET", `/api/signin/requests/${handle}`)).status).toBe(
      200,
    );
    await expectNothingIssued(w, d, handle);

    // Terms not ticked: refused, nothing written.
    const noTerms = await d.send("POST", GATE, { choice: "provider" });
    expect(noTerms.status).toBe(400);
    await expectNothingIssued(w, d, handle);

    // A typed address: a code is out, nothing issued.
    await d.send("POST", GATE, {
      choice: "typed",
      email: "ada@work.example",
      termsVersion: "2026-10",
    });
    await expectNothingIssued(w, d, handle);

    // A wrong code: still nothing.
    const right = lastCode(w, "ada@work.example");
    const wrong = await d.send("POST", `${GATE}/verify`, {
      code: right === "000000" ? "111111" : "000000",
    });
    expect(wrong.status).toBe(400);
    await expectNothingIssued(w, d, handle);
    expect(
      (await w.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM accounts"))
        ?.n,
    ).toBe(0);

    // Back to the provider's verified address (and the terms): the pass.
    const passed = await d.send("POST", GATE, {
      choice: "provider",
      termsVersion: "2026-10",
    });
    expect(passed.status).toBe(200);
    expect(await passed.json()).toMatchObject({
      status: "signed_in",
      next: "/library",
      request: handle,
    });
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(false);
    expect(await sessionRows(w)).toBe(1);
    expect((await d.send("GET", "/api/me")).status).toBe(200);
    expect(
      (await d.send("GET", `/api/signin/requests/${handle}/consent`)).status,
    ).toBe(200);
  });

  it("an email another account uses stops at the join offer and issues nothing until both are proven", async () => {
    const w = await identityWorld();
    const other = await insertAccount(
      w.db,
      {
        primaryEmail: "ada@gmail.com",
        primaryEmailVerified: true,
        displayName: null,
      },
      NOW,
    );
    await insertLink(
      w.db,
      other.id,
      {
        issuerKey: EMAIL_ISSUER,
        tenantScope: "",
        subject: "ada@gmail.com",
        kind: "email",
        email: "ada@gmail.com",
        emailVerified: true,
        displayName: null,
        amr: null,
      },
      NOW,
    );
    const d = new Device(w);
    const handle = await appRequest(w, d);
    d.absorb(
      await beginProviderSignIn(
        d.request("GET", "/login/google/callback"),
        w.env,
        w.db,
        { ...google("g-2", "ada@gmail.com"), request: handle },
        NOW,
      ),
    );
    const offer = await d.send("POST", GATE, { choice: "provider" });
    expect(offer.status).toBe(409);
    expect(await offer.json()).toMatchObject({
      error: "email_in_use",
      email: "ada@gmail.com",
      proven: false,
    });
    await expectNothingIssued(w, d, handle);
    // Joining without proof of the other account is refused, and still issues nothing.
    const join = await d.send("POST", `${GATE}/join`);
    expect(join.status).toBe(403);
    expect(await join.json()).toMatchObject({ error: "step_up_required" });
    await expectNothingIssued(w, d, handle);
    expect(
      await w.db.first("SELECT id FROM account_links WHERE kind = 'google'"),
    ).toBeNull();
  });

  it("a terms-only gate on an existing account opens no session until the new version is ticked", async () => {
    const w = await identityWorld();
    const terms = (version: string): ProviderSignIn => ({
      ...google("g-3", "ada@gmail.com"),
      product: {
        slug: SLUG,
        terms: { url: "https://acme.example/terms", version },
      },
    });
    const first = new Device(w);
    first.absorb(
      await beginProviderSignIn(
        first.request("GET", "/login/google/callback"),
        w.env,
        w.db,
        terms("2026-10"),
        NOW,
      ),
    );
    expect(
      (
        await first.send("POST", GATE, {
          choice: "provider",
          termsVersion: "2026-10",
        })
      ).status,
    ).toBe(200);
    expect(await sessionRows(w)).toBe(1);

    const next = new Device(w, "198.51.100.30");
    const handle = await appRequest(w, next);
    const opened = next.absorb(
      await beginProviderSignIn(
        next.request("GET", "/login/google/callback"),
        w.env,
        w.db,
        { ...terms("2027-01"), request: handle },
        NOW + 60,
      ),
    );
    expect(opened.headers.get("location")).toBe(EMAIL_GATE_LANDING);
    expect(
      (
        (await (await next.send("GET", GATE)).json()) as {
          emailRequired: boolean;
        }
      ).emailRequired,
    ).toBe(false);
    // The old version does not pass a gate for the new one.
    const stale = await next.send("POST", GATE, { termsVersion: "2026-10" });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({
      error: "terms_required",
      terms: { version: "2027-01" },
    });
    await expectNothingIssued(w, next, handle, 1);
    const passed = await next.send(
      "POST",
      GATE,
      { termsVersion: "2027-01" },
      { now: NOW + 60 },
    );
    expect(passed.status).toBe(200);
    expect(next.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(await sessionRows(w)).toBe(2);
  });
});

// ── Terms acceptances per account, product and version ─────────────────────────────────────

async function account(w: CardWorld, email: string): Promise<string> {
  return (
    await insertAccount(
      w.db,
      { primaryEmail: email, primaryEmailVerified: true, displayName: null },
      NOW,
    )
  ).id;
}

const V1 = { url: "https://acme.example/terms/v1", version: "2026-10" };
const V2 = { url: "https://acme.example/terms/v2", version: "2027-01" };

describe("terms acceptances per account, product and version", () => {
  it("a new version adds a row beside the old one; a repeat keeps the first acceptance", async () => {
    const w = await seededWorld();
    const a = await account(w, "ada@example.com");
    await recordTermsAcceptance(w.db, a, SLUG, V1, NOW);
    await recordTermsAcceptance(w.db, a, SLUG, V2, NOW + 100);
    // Accepting v1 again (another browser) changes neither its time nor its URL.
    await recordTermsAcceptance(
      w.db,
      a,
      SLUG,
      { ...V1, url: "https://acme.example/elsewhere" },
      NOW + 200,
    );
    expect(await termsAcceptancesOf(w.db, a)).toEqual([
      { product: SLUG, version: "2026-10", url: V1.url, accepted_at: NOW },
      {
        product: SLUG,
        version: "2027-01",
        url: V2.url,
        accepted_at: NOW + 100,
      },
    ]);
    expect(await termsAccepted(w.db, a, SLUG, "2026-10")).toBe(true);
    expect(await termsAccepted(w.db, a, SLUG, "2027-02")).toBe(false);
    expect(await termsAccepted(w.db, a, "other", "2026-10")).toBe(false);
  });

  it("a merge carries the absorbed account's acceptances; the survivor's own row stands", async () => {
    const w = await seededWorld();
    const survivor = await account(w, "ada@example.com");
    const absorbed = await account(w, "ada@work.example");
    await recordTermsAcceptance(w.db, survivor, SLUG, V1, NOW);
    await recordTermsAcceptance(w.db, absorbed, SLUG, V1, NOW + 5);
    await recordTermsAcceptance(w.db, absorbed, SLUG, V2, NOW + 10);
    const merged = await mergeAccounts(
      { db: w.db, env: w.env, now: NOW + 20, origin: ORIGIN },
      {
        survivor: { accountId: survivor, authenticatedAt: NOW + 20 },
        absorbed: { accountId: absorbed, authenticatedAt: NOW + 20 },
      },
    );
    expect(merged.ok).toBe(true);
    expect(await termsAcceptancesOf(w.db, survivor)).toEqual([
      { product: SLUG, version: "2026-10", url: V1.url, accepted_at: NOW },
      {
        product: SLUG,
        version: "2027-01",
        url: V2.url,
        accepted_at: NOW + 10,
      },
    ]);
    expect(await termsAcceptancesOf(w.db, absorbed)).toEqual([]);
  });

  it("deleting the account erases them; deleting the product erases that product's", async () => {
    const w = await seededWorld();
    await seedProduct(w.db, "other");
    const a = await account(w, "ada@example.com");
    const b = await account(w, "bea@example.com");
    await recordTermsAcceptance(w.db, a, SLUG, V1, NOW);
    await recordTermsAcceptance(w.db, b, SLUG, V1, NOW);
    await recordTermsAcceptance(w.db, b, "other", V1, NOW);

    const deleted = await deleteAccount(
      { db: w.db, env: w.env, now: NOW + 1, origin: ORIGIN },
      a,
    );
    expect(deleted.ok).toBe(true);
    expect(await termsAcceptancesOf(w.db, a)).toEqual([]);

    await deleteProduct(w.db, SLUG, NOW + 2);
    expect((await termsAcceptancesOf(w.db, b)).map((r) => r.product)).toEqual([
      "other",
    ]);
  });

  it("the migration converges on a replay", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = join(here, "..", "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const mine = files.find((f) =>
      f.endsWith("_account_terms_acceptances.sql"),
    );
    expect(mine).toBeTruthy();
    const sqlite = new Database(":memory:");
    const run = sqlite.exec.bind(sqlite);
    for (const f of files) run(readFileSync(join(dir, f), "utf8"));
    run(readFileSync(join(dir, mine!), "utf8"));
    const cols = sqlite
      .prepare(
        "SELECT name, pk FROM pragma_table_info('account_terms_acceptances')",
      )
      .all() as { name: string; pk: number }[];
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
      "account_id",
      "product",
      "version",
    ]);
    sqlite.close();
  });
});
