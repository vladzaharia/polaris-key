import { describe, expect, it } from "vitest";
import { NOW } from "./seed.js";
import { Device, seededWorld, type CardWorld } from "./identityCardHarness.js";
import { SoftAuthenticator, FLAG_UP } from "./softAuthenticator.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import {
  ACCOUNT_SESSION_COOKIE,
  PASSKEY_FLOW_COOKIE,
} from "../src/core/accountCookies.js";
import { upsertPortalProductSettings } from "../src/services/identity/portal/repo.js";
import {
  STEP_UP_MAX_AGE_SECONDS,
  unlinkIdentity,
} from "../src/services/identity/accounts/links.js";
import { NUDGE_REPEAT_SECONDS } from "../src/services/identity/card/finish.js";
import {
  MAX_PASSKEYS_PER_ACCOUNT,
  type PasskeyRow,
} from "../src/services/identity/passkeys/repo.js";
import { counterRegressed } from "../src/services/identity/passkeys/webauthn.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";

// I-16: passkeys on key.plrs.im (S-16 §5.4 items 7, 14 and 17; PORTAL.md §4.1, §4.10, §4.26).
// Enrolment only after email verification, one random account-level user handle, the card's
// sign-in ceremony with single-use challenges, origin and RP-id binding, required user
// verification and the counter rule, and removal under step-up and the last-method guard.

const OPTIONS = "/api/signin/passkey/options";
const VERIFY = "/api/signin/passkey/verify";
const MINE = "/api/me/passkeys";

interface Signed {
  d: Device;
  accountId: string;
}

/** A browser signed in by an email code (so the account's primary email is verified). */
async function emailAccount(
  w: CardWorld,
  email = "ada@example.com",
  now = NOW,
): Promise<Signed> {
  const d = new Device(w);
  const res = await d.signInWithCode(email, now);
  expect(res.status).toBe(200);
  expect((await d.me(now)).status).toBe(200);
  const row = await w.db.first<{ id: string }>(
    "SELECT id FROM accounts WHERE primary_email = ?",
    email,
  );
  return { d, accountId: row!.id };
}

/** A browser signed in to an account with NO email: a Steam-only account (its only method). */
async function steamOnlyAccount(w: CardWorld, now = NOW): Promise<Signed> {
  const accountId = "acct_steamonly";
  await w.db.run(
    `INSERT INTO accounts (id, status, primary_email, primary_email_verified_at, display_name,
                           created_at, modified_at, last_sign_in_at)
     VALUES (?, 'active', NULL, NULL, 'marafox', ?, ?, ?)`,
    accountId,
    now,
    now,
    now,
  );
  await w.db.run(
    `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
                                email, email_verified, created_at, last_used_at)
     VALUES ('lnk_steam', ?, 'steam', '', '76561198000000000', 'steam', NULL, 0, ?, ?)`,
    accountId,
    now,
    now,
  );
  const d = new Device(w);
  const { token } = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId, name: "marafox", email: null },
    now,
    ["steam"],
  );
  d.jar.set(ACCOUNT_SESSION_COOKIE, token);
  expect((await d.me(now)).status).toBe(200);
  return { d, accountId };
}

/** The whole "Add a passkey" ceremony in a signed-in browser. */
async function addPasskey(
  d: Device,
  auth: SoftAuthenticator,
  now = NOW,
  overrides: Parameters<SoftAuthenticator["register"]>[1] = {},
): Promise<Response> {
  const start = await d.send("POST", `${MINE}/options`, {}, { now });
  if (start.status !== 200) return start;
  const { options } = (await start.json()) as {
    options: Parameters<SoftAuthenticator["register"]>[0];
  };
  const response = await auth.register(options, overrides);
  return d.send("POST", MINE, { response }, { now });
}

/** The card's passkey sign-in in `d`: a challenge, the authenticator's assertion, the verify. */
async function passkeySignIn(
  d: Device,
  auth: SoftAuthenticator,
  overrides: Parameters<SoftAuthenticator["assert"]>[1] = {},
  now = NOW,
): Promise<{ res: Response; response: Record<string, unknown> }> {
  const start = await d.send("POST", OPTIONS, {}, { now });
  expect(start.status).toBe(200);
  const { options } = (await start.json()) as {
    options: { challenge: string; rpId: string };
  };
  const response = await auth.assert(options, overrides);
  const res = await d.send("POST", VERIFY, { response }, { now });
  return { res, response };
}

async function passkeyRows(w: CardWorld): Promise<PasskeyRow[]> {
  return w.db.all<PasskeyRow>(
    "SELECT * FROM account_passkeys ORDER BY created_at",
  );
}

async function auditActions(
  w: CardWorld,
  accountId: string,
): Promise<string[]> {
  const rows = await w.db.all<{ action: string }>(
    "SELECT action FROM portal_audit WHERE account_id = ? ORDER BY at, id",
    accountId,
  );
  return rows.map((r) => r.action);
}

describe("passkey enrolment", () => {
  it("is refused before email verification", async () => {
    const w = await seededWorld();
    const { d, accountId } = await steamOnlyAccount(w);
    const auth = await SoftAuthenticator.create();

    const start = await d.send("POST", `${MINE}/options`, {});
    expect(start.status).toBe(403);
    expect(await start.json()).toMatchObject({
      error: "forbidden",
      reason: "email_unverified",
    });
    // No challenge was issued, so a forged registration has nothing to complete.
    const forged = await auth.register({
      challenge: "AAAA",
      rp: { id: "key.plrs.im" },
      user: { id: "AAAA" },
    });
    const add = await d.send("POST", MINE, { response: forged });
    expect(add.status).toBe(400);
    expect(await add.json()).toMatchObject({ error: "signin_expired" });

    const list = await d.send("GET", MINE);
    expect(await list.json()).toEqual({
      passkeys: [],
      canAdd: false,
      reason: "email_unverified",
    });
    expect(await passkeyRows(w)).toHaveLength(0);
    const handle = await w.db.first<{ passkey_user_handle: string | null }>(
      "SELECT passkey_user_handle FROM accounts WHERE id = ?",
      accountId,
    );
    expect(handle?.passkey_user_handle).toBeNull();
  });

  it("is refused once the email is gone too, between the challenge and the answer", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    const auth = await SoftAuthenticator.create();
    const start = await d.send("POST", `${MINE}/options`, {});
    expect(start.status).toBe(200);
    const { options } = (await start.json()) as {
      options: Parameters<SoftAuthenticator["register"]>[0];
    };
    await w.db.run(
      "UPDATE accounts SET primary_email_verified_at = NULL WHERE id = ?",
      accountId,
    );
    const add = await d.send("POST", MINE, {
      response: await auth.register(options),
    });
    expect(add.status).toBe(403);
    expect(await add.json()).toMatchObject({ reason: "email_unverified" });
    expect(await passkeyRows(w)).toHaveLength(0);
  });

  it("needs a fresh sign-in (step-up)", async () => {
    const w = await seededWorld();
    const { d } = await emailAccount(w);
    const later = NOW + STEP_UP_MAX_AGE_SECONDS + 1;
    const start = await d.send("POST", `${MINE}/options`, {}, { now: later });
    expect(start.status).toBe(401);
    expect(await start.json()).toMatchObject({
      error: "step_up_required",
      maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
    });
  });

  it("adds a passkey under one random account-level user handle, audited and emailed", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    const phone = await SoftAuthenticator.create();
    const laptop = await SoftAuthenticator.create({ alg: "Ed25519" });

    const first = await d.send("POST", `${MINE}/options`, {});
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      options: {
        rp: { id: string; name: string };
        user: { id: string; name: string };
        authenticatorSelection: Record<string, unknown>;
        attestation: string;
        pubKeyCredParams: Array<{ alg: number }>;
        excludeCredentials: Array<{ id: string }>;
      };
    };
    const o = firstBody.options;
    expect(o.rp).toEqual({ id: "key.plrs.im", name: "Polaris Key" });
    expect(o.user.name).toBe("ada@example.com");
    expect(o.attestation).toBe("none");
    expect(o.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    expect(o.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);
    // The handle is 32 random bytes, never the account id.
    expect(o.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(o.user.id).not.toContain(accountId);
    const added = await d.send("POST", MINE, {
      response: await phone.register(
        o as unknown as Parameters<SoftAuthenticator["register"]>[0],
      ),
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      ok: true,
      passkey: { id: phone.id, createdAt: NOW },
    });

    // The second passkey lands under the SAME handle, and the first is excluded.
    const second = await d.send("POST", `${MINE}/options`, {});
    const secondOptions = ((await second.json()) as typeof firstBody).options;
    expect(secondOptions.user.id).toBe(o.user.id);
    expect(secondOptions.excludeCredentials.map((c) => c.id)).toEqual([
      phone.id,
    ]);
    const added2 = await d.send("POST", MINE, {
      response: await laptop.register(
        secondOptions as unknown as Parameters<
          SoftAuthenticator["register"]
        >[0],
      ),
    });
    expect(added2.status).toBe(201);

    const rows = await passkeyRows(w);
    expect(rows.map((r) => r.credential_id).sort()).toEqual(
      [phone.id, laptop.id].sort(),
    );
    for (const r of rows) {
      expect(r.account_id).toBe(accountId);
      expect(r.rp_id).toBe("key.plrs.im");
      expect(r.user_handle).toBe(o.user.id);
      expect(r.sign_count).toBe(0);
      expect(JSON.parse(r.transports_json!)).toEqual(["internal", "hybrid"]);
    }
    const stored = await w.db.first<{ passkey_user_handle: string }>(
      "SELECT passkey_user_handle FROM accounts WHERE id = ?",
      accountId,
    );
    expect(stored?.passkey_user_handle).toBe(o.user.id);
    // Each passkey is a sign-in method (its twin link), and each addition is recorded and mailed.
    const links = await w.db.all<{ kind: string; subject: string }>(
      "SELECT kind, subject FROM account_links WHERE account_id = ? AND issuer_key = 'passkey'",
      accountId,
    );
    expect(links.map((l) => l.subject).sort()).toEqual(
      [phone.id, laptop.id].sort(),
    );
    expect(links.every((l) => l.kind === "passkey")).toBe(true);
    expect(
      (await auditActions(w, accountId)).filter(
        (a) => a === "account.link.add",
      ),
    ).toHaveLength(2);
    expect(
      w.mail.filter(
        (m) =>
          m.to === "ada@example.com" &&
          m.subject === "A passkey was connected to your Polaris Key account",
      ),
    ).toHaveLength(2);
  });

  it("refuses an attestation for another origin, another RP id, or without user verification", async () => {
    const w = await seededWorld();
    const { d } = await emailAccount(w);
    const auth = await SoftAuthenticator.create();
    for (const bad of [
      { origin: "https://key.plrs.im.evil.example" },
      { origin: "https://evil.example" },
      { rpId: "evil.example" },
      { flags: FLAG_UP },
      { type: "webauthn.get" },
    ]) {
      const res = await addPasskey(d, auth, NOW, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
    }
    expect(await passkeyRows(w)).toHaveLength(0);
  });

  it("a registration challenge is used once", async () => {
    const w = await seededWorld();
    const { d } = await emailAccount(w);
    const auth = await SoftAuthenticator.create();
    const start = await d.send("POST", `${MINE}/options`, {});
    const { options } = (await start.json()) as {
      options: Parameters<SoftAuthenticator["register"]>[0];
    };
    const response = await auth.register(options);
    expect((await d.send("POST", MINE, { response })).status).toBe(201);
    const again = await d.send("POST", MINE, { response });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "signin_expired" });
  });

  it("never overwrites a credential id another account holds", async () => {
    const w = await seededWorld();
    const ada = await emailAccount(w, "ada@example.com");
    const auth = await SoftAuthenticator.create();
    expect((await addPasskey(ada.d, auth)).status).toBe(201);
    const before = (await passkeyRows(w))[0]!;

    // The same credential (an authenticator can choose its own ids) offered to another account.
    const eve = await emailAccount(w, "eve@example.com");
    const res = await addPasskey(eve.d, auth);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "link_conflict" });
    const after = await passkeyRows(w);
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
  });

  it("refuses a key of an algorithm it did not offer (ES384)", async () => {
    const w = await seededWorld();
    const { d } = await emailAccount(w);
    const res = await addPasskey(
      d,
      await SoftAuthenticator.create({ alg: "ES384" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
    expect(await passkeyRows(w)).toHaveLength(0);
  });

  it(`caps an account at ${MAX_PASSKEYS_PER_ACCOUNT} passkeys`, async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    for (let i = 0; i < MAX_PASSKEYS_PER_ACCOUNT; i++) {
      await w.db.run(
        `INSERT INTO account_passkeys (credential_id, account_id, public_key, sign_count, rp_id,
                                       user_handle, created_at)
         VALUES (?, ?, 'pk', 0, 'key.plrs.im', 'h', ?)`,
        `cred${i}`,
        accountId,
        NOW,
      );
      await w.db.run(
        `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
                                    email_verified, created_at, last_used_at)
         VALUES (?, ?, 'passkey', '', ?, 'passkey', 0, ?, ?)`,
        `lnk_pk${i}`,
        accountId,
        `cred${i}`,
        NOW,
        NOW,
      );
    }
    const res = await d.send("POST", `${MINE}/options`, {});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "limit" });
  });
});

describe("passkey sign-in on the card", () => {
  async function enrolled(
    w: CardWorld,
    opts: { synced?: boolean; alg?: "ES256" | "Ed25519" | "RS256" } = {},
  ): Promise<{ auth: SoftAuthenticator; accountId: string }> {
    const { d, accountId } = await emailAccount(w);
    const auth = await SoftAuthenticator.create(opts);
    expect((await addPasskey(d, auth)).status).toBe(201);
    return { auth, accountId };
  }

  it("signs in with a passkey in a new browser", async () => {
    const w = await seededWorld();
    const { auth, accountId } = await enrolled(w);
    const browser = new Device(w, "198.51.100.40");
    const later = NOW + 3600;

    const start = await browser.send(
      "POST",
      OPTIONS,
      { returnTo: "/#/library" },
      { now: later },
    );
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as {
      options: {
        challenge: string;
        rpId: string;
        userVerification: string;
        allowCredentials?: unknown[];
      };
      expiresIn: number;
    };
    expect(startBody.options.rpId).toBe("key.plrs.im");
    expect(startBody.options.userVerification).toBe("required");
    // Discoverable: no credential list, so the challenge names no account.
    expect(startBody.options.allowCredentials ?? []).toEqual([]);
    expect(startBody.expiresIn).toBe(300);
    const cookie = start.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${PASSKEY_FLOW_COOKIE}=`));
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
      expect(cookie).toContain(attr);
    expect(cookie).not.toContain("Domain");

    const res = await browser.send(
      "POST",
      VERIFY,
      { response: await auth.assert(startBody.options) },
      { now: later },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "signed_in",
      next: "/#/library",
      nudge: false,
    });
    expect(browser.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(browser.jar.has(PASSKEY_FLOW_COOKIE)).toBe(false);
    const me = await browser.me(later);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      account: { email: "ada@example.com" },
    });
    const session = await w.db.first<{ amr_json: string }>(
      "SELECT amr_json FROM account_sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT 1",
      accountId,
    );
    expect(JSON.parse(session!.amr_json)).toEqual(["passkey"]);
    const row = (await passkeyRows(w))[0]!;
    expect(row.last_used_at).toBe(later);
    expect(await auditActions(w, accountId)).toContain("portal.login.passkey");
    // A passkey never creates an account.
    const accounts = await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM accounts",
    );
    expect(accounts?.n).toBe(1);
  });

  for (const alg of ["Ed25519", "RS256"] as const) {
    it(`signs in with an ${alg} passkey too`, async () => {
      const w = await seededWorld();
      const { auth } = await enrolled(w, { alg });
      const { res } = await passkeySignIn(new Device(w), auth);
      expect(res.status).toBe(200);
    });
  }

  it("a challenge replay fails: the same answer twice, or an old answer to a new challenge", async () => {
    const w = await seededWorld();
    const { auth } = await enrolled(w);
    const attacker = new Device(w, "198.51.100.66");
    const start = await attacker.send("POST", OPTIONS, {});
    const { options } = (await start.json()) as {
      options: { challenge: string };
    };
    const flow = attacker.jar.get(PASSKEY_FLOW_COOKIE)!;
    const response = await auth.assert(options);
    expect((await attacker.send("POST", VERIFY, { response })).status).toBe(
      200,
    );

    // The same response with the same flow cookie: the challenge was consumed.
    const replay = new Device(w, "198.51.100.67");
    replay.jar.set(PASSKEY_FLOW_COOKIE, flow);
    const again = await replay.send("POST", VERIFY, { response });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "signin_expired" });
    expect(replay.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);

    // The same response against a fresh challenge: the signed challenge does not match.
    await replay.send("POST", OPTIONS, {});
    const stale = await replay.send("POST", VERIFY, { response });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ error: "unauthorized" });
    expect(replay.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("a failed attempt spends the challenge", async () => {
    const w = await seededWorld();
    const { auth } = await enrolled(w);
    const d = new Device(w);
    const start = await d.send("POST", OPTIONS, {});
    const { options } = (await start.json()) as {
      options: { challenge: string };
    };
    const flow = d.jar.get(PASSKEY_FLOW_COOKIE)!;
    const bad = await d.send("POST", VERIFY, {
      response: await auth.assert(options, { flags: FLAG_UP }),
    });
    expect(bad.status).toBe(401);
    d.jar.set(PASSKEY_FLOW_COOKIE, flow);
    const good = await d.send("POST", VERIFY, {
      response: await auth.assert(options),
    });
    expect(good.status).toBe(400);
    expect(await good.json()).toMatchObject({ error: "signin_expired" });
  });

  it("refuses an assertion made for another origin or another RP id", async () => {
    const w = await seededWorld();
    const { auth } = await enrolled(w);
    for (const bad of [
      { origin: "https://evil.example" },
      { origin: "https://login.key.plrs.im" },
      { origin: "http://key.plrs.im" },
      { rpId: "evil.example" },
      { rpId: "plrs.im" },
    ]) {
      const d = new Device(w);
      const { res } = await passkeySignIn(d, auth, bad);
      expect(res.status, JSON.stringify(bad)).toBe(401);
      expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    }
  });

  it("requires user verification and user presence", async () => {
    const w = await seededWorld();
    const { auth } = await enrolled(w);
    for (const flags of [FLAG_UP, 0x04, 0]) {
      const { res } = await passkeySignIn(new Device(w), auth, { flags });
      expect(res.status, `flags ${flags}`).toBe(401);
    }
  });

  it("refuses a signature from another key", async () => {
    const w = await seededWorld();
    const { auth } = await enrolled(w);
    const other = await SoftAuthenticator.create();
    const { res } = await passkeySignIn(new Device(w), auth, {
      signWith: other,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthorized",
      message:
        "That passkey didn't work. Try again, or use another way to sign in.",
    });
  });

  it("needs the user handle the passkey was created under", async () => {
    const w = await seededWorld();
    const { auth } = await enrolled(w);
    for (const userHandle of [null, "c29tZW9uZS1lbHNl"]) {
      const { res } = await passkeySignIn(new Device(w), auth, { userHandle });
      expect(res.status, String(userHandle)).toBe(401);
    }
  });

  it("names an unknown passkey as unknown, and nothing else", async () => {
    const w = await seededWorld();
    await enrolled(w);
    const stranger = await SoftAuthenticator.create();
    stranger.userHandle = "c29tZW9uZQ";
    const { res } = await passkeySignIn(new Device(w), stranger);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: "unauthorized",
      unknownCredential: true,
    });
  });

  it("refuses a signature counter that did not advance, and records it", async () => {
    const w = await seededWorld();
    const { auth, accountId } = await enrolled(w, { synced: false });
    const first = await passkeySignIn(new Device(w), auth);
    expect(first.res.status).toBe(200);
    expect((await passkeyRows(w))[0]!.sign_count).toBe(1);

    // A copy of the authenticator, still at counter 1.
    const clone = await passkeySignIn(new Device(w), auth, { counter: 1 });
    expect(clone.res.status).toBe(401);
    expect((await passkeyRows(w))[0]!.sign_count).toBe(1);
    expect(await auditActions(w, accountId)).toContain(
      "account.passkey.counter_regressed",
    );
    // The real one carries on.
    const next = await passkeySignIn(new Device(w), auth);
    expect(next.res.status).toBe(200);
    expect((await passkeyRows(w))[0]!.sign_count).toBe(2);
  });

  it("does not record a counter regression for a forged assertion", async () => {
    const w = await seededWorld();
    const { auth, accountId } = await enrolled(w, { synced: false });
    expect((await passkeySignIn(new Device(w), auth)).res.status).toBe(200);
    const other = await SoftAuthenticator.create();
    const forged = await passkeySignIn(new Device(w), auth, {
      counter: 1,
      signWith: other,
    });
    expect(forged.res.status).toBe(401);
    expect(await auditActions(w, accountId)).not.toContain(
      "account.passkey.counter_regressed",
    );
  });

  it("the counter rule (WebAuthn §7.2 step 22)", () => {
    expect(counterRegressed(0, 0)).toBe(false); // synced passkeys
    expect(counterRegressed(0, 1)).toBe(false);
    expect(counterRegressed(5, 6)).toBe(false);
    expect(counterRegressed(5, 5)).toBe(true);
    expect(counterRegressed(5, 4)).toBe(true);
    expect(counterRegressed(5, 0)).toBe(true);
    expect(counterRegressed(0, 0)).toBe(false);
  });

  it("never creates an account: a passkey whose sign-in method is gone is refused", async () => {
    const w = await seededWorld();
    const { auth, accountId } = await enrolled(w);
    await w.db.run(
      "DELETE FROM account_links WHERE account_id = ? AND issuer_key = 'passkey'",
      accountId,
    );
    const { res } = await passkeySignIn(new Device(w), auth);
    expect(res.status).toBe(401);
    const accounts = await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM accounts",
    );
    expect(accounts?.n).toBe(1);
  });

  it("without the flow cookie there is nothing to complete", async () => {
    const w = await seededWorld();
    const { auth } = await enrolled(w);
    const d = new Device(w);
    const start = await d.send("POST", OPTIONS, {});
    const { options } = (await start.json()) as {
      options: { challenge: string };
    };
    d.jar.delete(PASSKEY_FLOW_COOKIE);
    const res = await d.send("POST", VERIFY, {
      response: await auth.assert(options),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "signin_expired" });
  });

  it("is served only on the console origin", async () => {
    const w = await seededWorld();
    w.env.CONSOLE_ORIGIN = "https://key-staging.plrs.im";
    const res = await new Device(w).send("POST", OPTIONS, {});
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "auth_method_disabled" });
  });

  it("is off while the portal is off, and accepts only POST", async () => {
    const w = await seededWorld();
    expect((await new Device(w).send("GET", OPTIONS)).status).toBe(405);
    await upsertPortalProductSettings(
      w.db,
      "acme",
      { portalEnabled: false },
      NOW,
    );
    const res = await new Device(w).send("POST", OPTIONS, {});
    expect(res.status).toBe(404);
  });

  it("rejects a return URL off this origin", async () => {
    const w = await seededWorld();
    const res = await new Device(w).send("POST", OPTIONS, {
      returnTo: "https://evil.example/",
    });
    expect(res.status).toBe(400);
  });

  it("the capabilities advertise passkeys", async () => {
    const w = await seededWorld();
    const res = await new Device(w).send("GET", "/api/capabilities");
    expect(await res.json()).toMatchObject({ auth: { passkey: true } });
  });
});

describe("passkey removal and the settings list", () => {
  it("removing the last sign-in method is refused", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    const auth = await SoftAuthenticator.create();
    expect((await addPasskey(d, auth)).status).toBe(201);
    // Take the email method away through the link engine: the passkey is the only way in now.
    const email = await w.db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE account_id = ? AND issuer_key = 'email'",
      accountId,
    );
    const removedEmail = await unlinkIdentity(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      { accountId, authenticatedAt: NOW },
      email!.id,
    );
    expect(removedEmail).toEqual({ ok: true });

    const res = await d.send("DELETE", `${MINE}/${auth.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "last_link" });
    expect(await passkeyRows(w)).toHaveLength(1);
    expect((await passkeySignIn(new Device(w), auth)).res.status).toBe(200);
  });

  it("the link engine refuses removing the last method when it is the passkey's own", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    const auth = await SoftAuthenticator.create();
    expect((await addPasskey(d, auth)).status).toBe(201);
    const email = await w.db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE account_id = ? AND issuer_key = 'email'",
      accountId,
    );
    const ctx = {
      db: w.db,
      env: w.env,
      now: NOW,
      origin: "https://key.plrs.im",
    };
    const proof = { accountId, authenticatedAt: NOW };
    expect(await unlinkIdentity(ctx, proof, email!.id)).toEqual({ ok: true });
    const passkeyLink = await w.db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE account_id = ? AND issuer_key = 'passkey'",
      accountId,
    );
    expect(await unlinkIdentity(ctx, proof, passkeyLink!.id)).toEqual({
      ok: false,
      error: "last_link",
    });
  });

  it("removal needs a fresh sign-in", async () => {
    const w = await seededWorld();
    const { d } = await emailAccount(w);
    const auth = await SoftAuthenticator.create();
    expect((await addPasskey(d, auth)).status).toBe(201);
    const res = await d.send("DELETE", `${MINE}/${auth.id}`, undefined, {
      now: NOW + STEP_UP_MAX_AGE_SECONDS + 1,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "step_up_required" });
    expect(await passkeyRows(w)).toHaveLength(1);
  });

  it("removes a passkey: both rows go, it is audited and emailed, and it no longer signs in", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    const auth = await SoftAuthenticator.create();
    expect((await addPasskey(d, auth)).status).toBe(201);
    const res = await d.send("DELETE", `${MINE}/${auth.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await passkeyRows(w)).toHaveLength(0);
    const link = await w.db.first(
      "SELECT id FROM account_links WHERE issuer_key = 'passkey'",
    );
    expect(link).toBeNull();
    expect(await auditActions(w, accountId)).toContain("account.link.remove");
    expect(
      w.mail.some(
        (m) =>
          m.subject ===
          "A passkey was disconnected from your Polaris Key account",
      ),
    ).toBe(true);
    const { res: signIn } = await passkeySignIn(new Device(w), auth);
    expect(signIn.status).toBe(401);
    expect(await signIn.json()).toMatchObject({ unknownCredential: true });
  });

  it("the link engine's generic unlink takes the passkey's WebAuthn material with it", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    const auth = await SoftAuthenticator.create();
    expect((await addPasskey(d, auth)).status).toBe(201);
    const link = await w.db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE account_id = ? AND issuer_key = 'passkey'",
      accountId,
    );
    const result = await unlinkIdentity(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      { accountId, authenticatedAt: NOW },
      link!.id,
    );
    expect(result).toEqual({ ok: true });
    expect(await passkeyRows(w)).toHaveLength(0);
  });

  it("another account's passkey is not found", async () => {
    const w = await seededWorld();
    const ada = await emailAccount(w, "ada@example.com");
    const auth = await SoftAuthenticator.create();
    expect((await addPasskey(ada.d, auth)).status).toBe(201);
    const eve = await emailAccount(w, "eve@example.com");
    const res = await eve.d.send("DELETE", `${MINE}/${auth.id}`);
    expect(res.status).toBe(404);
    expect(await passkeyRows(w)).toHaveLength(1);
  });

  it("lists the account's passkeys without the account id", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    const auth = await SoftAuthenticator.create();
    const res0 = await d.send("GET", MINE);
    expect(await res0.json()).toEqual({
      passkeys: [],
      canAdd: true,
      reason: null,
    });
    expect((await addPasskey(d, auth, NOW, {})).status).toBe(201);
    await passkeySignIn(new Device(w), auth, {}, NOW + 60);
    const res = await d.send("GET", MINE);
    const text = await res.text();
    expect(text).not.toContain(accountId);
    const link = await w.db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE issuer_key = 'passkey'",
    );
    expect(JSON.parse(text)).toEqual({
      passkeys: [
        {
          id: auth.id,
          methodId: link!.id,
          createdAt: NOW,
          lastUsedAt: NOW + 60,
          transports: ["internal", "hybrid"],
          synced: true,
          aaguid: "00000000-0000-0000-0000-000000000000",
          addedFrom: null,
        },
      ],
      canAdd: true,
      reason: null,
    });
  });

  it("the list and the changes need the session, and the changes the CSRF header", async () => {
    const w = await seededWorld();
    const anon = new Device(w);
    expect((await anon.send("GET", MINE)).status).toBe(401);
    const { d } = await emailAccount(w);
    d.csrf = null;
    expect((await d.send("POST", `${MINE}/options`, {})).status).toBe(403);
  });
});

describe("the post-sign-in nudge", () => {
  it("a first sign-in is nudged, and the passkey offer is open once the email is verified", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    const res = await d.signInWithCode("ada@example.com");
    expect(await res.json()).toMatchObject({
      status: "signed_in",
      nudge: true,
    });
    await d.me();
    expect(await (await d.send("GET", MINE)).json()).toMatchObject({
      canAdd: true,
      reason: null,
    });
    // Straight from the nudge: the sign-in is the step-up.
    expect((await addPasskey(d, await SoftAuthenticator.create())).status).toBe(
      201,
    );
  });

  it("a passkey counts as a second way in: the 30-day repeat stops", async () => {
    const later = NOW + NUDGE_REPEAT_SECONDS + 60;
    const w1 = await seededWorld();
    const alone = await emailAccount(w1);
    expect(alone.d).toBeDefined();
    const again1 = await new Device(w1).signInWithCode(
      "ada@example.com",
      later,
    );
    expect(await again1.json()).toMatchObject({ nudge: true });

    const w2 = await seededWorld();
    const withKey = await emailAccount(w2);
    expect(
      (await addPasskey(withKey.d, await SoftAuthenticator.create())).status,
    ).toBe(201);
    const again2 = await new Device(w2).signInWithCode(
      "ada@example.com",
      later,
    );
    expect(await again2.json()).toMatchObject({ nudge: false });
  });
});

describe("merging accounts with passkeys", () => {
  async function handleOf(
    w: CardWorld,
    accountId: string,
  ): Promise<string | null> {
    const row = await w.db.first<{ passkey_user_handle: string | null }>(
      "SELECT passkey_user_handle FROM accounts WHERE id = ?",
      accountId,
    );
    return row?.passkey_user_handle ?? null;
  }

  it("a survivor with no user handle takes the absorbed account's, and its passkeys keep signing in", async () => {
    const w = await seededWorld();
    const absorbed = await emailAccount(w, "old@example.com");
    const auth = await SoftAuthenticator.create();
    expect((await addPasskey(absorbed.d, auth)).status).toBe(201);
    const handle = await handleOf(w, absorbed.accountId);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const survivor = await emailAccount(w, "new@example.com");
    expect(await handleOf(w, survivor.accountId)).toBeNull();

    const merged = await mergeAccounts(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      {
        survivor: { accountId: survivor.accountId, authenticatedAt: NOW },
        absorbed: { accountId: absorbed.accountId, authenticatedAt: NOW },
      },
    );
    expect(merged).toMatchObject({ ok: true });
    expect(await handleOf(w, survivor.accountId)).toBe(handle);
    expect((await passkeyRows(w))[0]).toMatchObject({
      account_id: survivor.accountId,
      user_handle: handle,
    });

    // The moved passkey signs in to the survivor, and the next one lands under the same handle.
    const browser = new Device(w);
    expect((await passkeySignIn(browser, auth)).res.status).toBe(200);
    expect(await (await browser.me()).json()).toMatchObject({
      account: { email: "new@example.com" },
    });
    const start = await survivor.d.send("POST", `${MINE}/options`, {});
    expect(start.status).toBe(200);
    const { options } = (await start.json()) as {
      options: {
        user: { id: string };
        excludeCredentials: Array<{ id: string }>;
      };
    };
    expect(options.user.id).toBe(handle);
    expect(options.excludeCredentials.map((c) => c.id)).toEqual([auth.id]);
  });

  it("a survivor that has a user handle keeps it", async () => {
    const w = await seededWorld();
    const absorbed = await emailAccount(w, "old@example.com");
    expect(
      (await addPasskey(absorbed.d, await SoftAuthenticator.create())).status,
    ).toBe(201);
    const survivor = await emailAccount(w, "new@example.com");
    const own = await SoftAuthenticator.create();
    expect((await addPasskey(survivor.d, own)).status).toBe(201);
    const kept = await handleOf(w, survivor.accountId);
    expect(kept).not.toBe(await handleOf(w, absorbed.accountId));

    const merged = await mergeAccounts(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      {
        survivor: { accountId: survivor.accountId, authenticatedAt: NOW },
        absorbed: { accountId: absorbed.accountId, authenticatedAt: NOW },
      },
    );
    expect(merged).toMatchObject({ ok: true });
    expect(await handleOf(w, survivor.accountId)).toBe(kept);
    expect(
      (await passkeyRows(w)).every((r) => r.account_id === survivor.accountId),
    ).toBe(true);
  });
});
