import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import {
  Device,
  lastCode,
  seededWorld,
  type CardWorld,
} from "./identityCardHarness.js";
import {
  beginProviderSignIn,
  EMAIL_GATE_LANDING,
  type ProviderSignIn,
} from "../src/services/identity/card/gate.js";
import { CODE_VERIFY_PER_IP_MINUTE } from "../src/services/identity/card/emailSignIn.js";
import {
  ACCOUNT_SESSION_COOKIE,
  EMAIL_GATE_COOKIE,
} from "../src/core/accountCookies.js";
import {
  EMAIL_ISSUER,
  insertAccount,
  insertLink,
} from "../src/services/identity/accounts/repo.js";

// I-07: the required interstitial on a first provider sign-in (S-16 owner decisions, 2026-10-04:
// a provider-verified email needs no code; an email owned by another account offers to join,
// never silently and never by email match alone; PORTAL.md §4.29, G31).

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const GATE = "/api/signin/confirm-email";
const GOOGLE = "https://accounts.google.com";

function google(
  subject: string,
  email: string | null,
  emailVerified = true,
): ProviderSignIn {
  return {
    identity: {
      issuerKey: GOOGLE,
      subject,
      kind: "google",
      email,
      emailVerified,
      displayName: "Ada Lovelace",
    },
  };
}

/** A Google Workspace sign-in: `hd` names the address's domain, so Google vouches for it
 *  (PX-W15; a non-Gmail address without a matching `hd` gets our code). */
function workspace(subject: string, email: string): ProviderSignIn {
  return {
    ...google(subject, email),
    hostedDomain: email.slice(email.indexOf("@") + 1),
  };
}

/** The front door's hand-off, as a device: the gate cookie lands in its jar. */
async function arrive(
  w: CardWorld,
  d: Device,
  input: ProviderSignIn,
  now = NOW,
): Promise<Response> {
  const res = await beginProviderSignIn(
    d.request("GET", "/signin/google/callback"),
    w.env,
    w.db,
    input,
    now,
  );
  return d.absorb(res);
}

async function count(w: CardWorld, table: string): Promise<number> {
  return (
    (await w.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))
      ?.n ?? 0
  );
}

async function linksOf(w: CardWorld, accountId: string): Promise<string[]> {
  return (
    await w.db.all<{ kind: string; subject: string }>(
      "SELECT kind, subject FROM account_links WHERE account_id = ? ORDER BY kind, subject",
      accountId,
    )
  ).map((l) => `${l.kind}:${l.subject}`);
}

/** An account that signs in with `email` as an email method (the email-code sign-in made it). */
async function emailAccount(w: CardWorld, email: string): Promise<string> {
  const d = new Device(w, "192.0.2.250");
  expect((await d.signInWithCode(email)).status).toBe(200);
  const row = await w.db.first<{ account_id: string }>(
    "SELECT account_id FROM account_links WHERE issuer_key = ? AND subject = ?",
    EMAIL_ISSUER,
    email,
  );
  return row!.account_id;
}

describe("the gate opens before any account exists", () => {
  it("a first Google sign-in redirects to the card's step and writes no account or session", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    const res = await arrive(w, d, google("g-1", "ada@gmail.com"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(EMAIL_GATE_LANDING);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(true);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(await count(w, "accounts")).toBe(0);
    expect(await count(w, "account_sessions")).toBe(0);
    const view = await (await d.send("GET", GATE)).json();
    expect(view).toEqual(
      expect.objectContaining({
        status: "gate",
        provider: "google",
        stage: "choose",
        emailRequired: true,
        email: expect.objectContaining({
          provider: "ada@gmail.com",
          providerVerified: true,
          relay: false,
        }),
      }),
    );
    // The view never carries an account id.
    expect(JSON.stringify(view)).not.toMatch(/acct_/);
  });
});

describe("the verified-email rule (owner, 2026-10-04)", () => {
  it("a Google email with email_verified: true completes without a code", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com"));
    const res = await d.send("POST", GATE, { choice: "provider" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({ status: "signed_in", next: "/" }),
    );
    expect(w.mail).toHaveLength(0);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(false);
    const account = await w.db.first<{
      id: string;
      primary_email: string;
      primary_email_verified_at: number | null;
    }>("SELECT id, primary_email, primary_email_verified_at FROM accounts");
    expect(account).toEqual(
      expect.objectContaining({
        primary_email: "ada@gmail.com",
        primary_email_verified_at: NOW,
      }),
    );
    expect(await linksOf(w, account!.id)).toEqual([
      "email:ada@gmail.com",
      "google:g-1",
    ]);
  });

  it("an Apple private-relay address is accepted as the provider verified it", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await arrive(w, d, {
      identity: {
        issuerKey: "https://appleid.apple.com",
        subject: "apple-1",
        kind: "apple",
        email: "x7q2@privaterelay.appleid.com",
        emailVerified: true,
      },
    });
    const view = (await (await d.send("GET", GATE)).json()) as {
      email: { relay: boolean };
    };
    expect(view.email.relay).toBe(true);
    expect((await d.send("POST", GATE, { choice: "provider" })).status).toBe(
      200,
    );
    expect(w.mail).toHaveLength(0);
  });

  it("a typed address requires a code", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com"));
    const sent = await d.send("POST", GATE, {
      choice: "typed",
      email: "ada@work.example",
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual(
      expect.objectContaining({
        status: "code_sent",
        email: "ada@work.example",
      }),
    );
    expect(await count(w, "accounts")).toBe(0);
    const wrong = await d.send("POST", `${GATE}/verify`, {
      code: "000000" === lastCode(w, "ada@work.example") ? "111111" : "000000",
    });
    expect(wrong.status).toBe(400);
    const ok = await d.send("POST", `${GATE}/verify`, {
      code: lastCode(w, "ada@work.example"),
    });
    expect(ok.status).toBe(200);
    expect(
      (
        await w.db.first<{ primary_email: string }>(
          "SELECT primary_email FROM accounts",
        )
      )?.primary_email,
    ).toBe("ada@work.example");
  });

  it("the code check shares the email card's per-IP verify limit", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com"));
    await d.send("POST", GATE, { choice: "typed", email: "ada@work.example" });
    const wrongCode =
      "000000" === lastCode(w, "ada@work.example") ? "111111" : "000000";
    for (let i = 0; i < CODE_VERIFY_PER_IP_MINUTE; i++) {
      const res = await d.send("POST", `${GATE}/verify`, { code: wrongCode });
      expect(res.status).toBe(400);
    }
    const limited = await d.send("POST", `${GATE}/verify`, {
      code: lastCode(w, "ada@work.example"),
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });

  it("an unverified provider email requires a code", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com", false));
    const res = await d.send("POST", GATE, { choice: "provider" });
    expect(await res.json()).toEqual(
      expect.objectContaining({ status: "code_sent" }),
    );
    expect(w.mail.map((m) => m.to)).toEqual(["ada@gmail.com"]);
    expect(await count(w, "accounts")).toBe(0);
  });

  it("Steam starts with an empty field: there is no provider email to accept", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await arrive(w, d, {
      identity: {
        issuerKey: "steam",
        subject: "76561198000000000",
        kind: "steam",
        displayName: "ada_plays",
      },
    });
    const view = (await (await d.send("GET", GATE)).json()) as {
      email: { provider: string | null; providerVerified: boolean };
    };
    expect(view.email).toEqual(
      expect.objectContaining({ provider: null, providerVerified: false }),
    );
    expect((await d.send("POST", GATE, { choice: "provider" })).status).toBe(
      400,
    );
    expect(
      (
        await d.send("POST", GATE, {
          choice: "typed",
          email: "ada@example.com",
        })
      ).status,
    ).toBe(200);
  });

  it("runs once: the next sign-in with the same identity goes straight through", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com"));
    await d.send("POST", GATE, { choice: "provider" });
    const again = new Device(w, "198.51.100.9");
    const res = await arrive(w, again, {
      ...google("g-1", "ada@gmail.com"),
      returnTo: "/library",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/library");
    expect(again.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(again.jar.has(EMAIL_GATE_COOKIE)).toBe(false);
    expect(await count(w, "accounts")).toBe(1);
  });
});

describe("the join offer (owner, 2026-10-04)", () => {
  it("an email owned by another account never creates a second account and never joins silently", async () => {
    const w = await seededWorld();
    const ada = await emailAccount(w, "ada@example.com");
    const d = new Device(w);
    await arrive(w, d, workspace("g-1", "ada@example.com"));
    const res = await d.send("POST", GATE, { choice: "provider" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: "email_in_use", proven: false }),
    );
    expect(await count(w, "accounts")).toBe(1);
    expect(await linksOf(w, ada)).toEqual(["email:ada@example.com"]);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    // Taking the offer without proving the other account is refused.
    const join = await d.send("POST", `${GATE}/join`);
    expect(join.status).toBe(403);
    expect(await join.json()).toEqual(
      expect.objectContaining({ error: "step_up_required" }),
    );
    expect(await linksOf(w, ada)).toEqual(["email:ada@example.com"]);
  });

  it("joins once both are proven in one session: a fresh sign-in to the other account in this browser", async () => {
    const w = await seededWorld();
    const ada = await emailAccount(w, "ada@example.com");
    const d = new Device(w);
    await arrive(w, d, workspace("g-1", "ada@example.com"));
    await d.send("POST", GATE, { choice: "provider" });
    // The same browser signs in to the existing account by any of its methods...
    expect((await d.signInWithCode("ada@example.com")).status).toBe(200);
    // ...then confirms the join.
    const join = await d.send("POST", `${GATE}/join`);
    expect(join.status).toBe(200);
    expect(await join.json()).toEqual(
      expect.objectContaining({ status: "signed_in", joined: true }),
    );
    expect(await count(w, "accounts")).toBe(1);
    expect(await linksOf(w, ada)).toEqual([
      "email:ada@example.com",
      "google:g-1",
    ]);
  });

  it("a code to the address proves the other account only when it is an active email method there", async () => {
    const w = await seededWorld();
    const ada = await emailAccount(w, "ada@example.com");
    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com"));
    await d.send("POST", GATE, { choice: "typed", email: "ada@example.com" });
    const res = await d.send("POST", `${GATE}/verify`, {
      code: lastCode(w, "ada@example.com"),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: "email_in_use", proven: true }),
    );
    const join = await d.send("POST", `${GATE}/join`);
    expect(join.status).toBe(200);
    expect(await linksOf(w, ada)).toEqual([
      "email:ada@example.com",
      "google:g-1",
    ]);
  });

  it("a code to an address that is only another account's primary email proves nothing", async () => {
    const w = await seededWorld();
    const other = await insertAccount(
      w.db,
      {
        primaryEmail: "ada@example.com",
        primaryEmailVerified: true,
        displayName: "Ada",
      },
      NOW,
    );
    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com"));
    await d.send("POST", GATE, { choice: "typed", email: "ada@example.com" });
    const res = await d.send("POST", `${GATE}/verify`, {
      code: lastCode(w, "ada@example.com"),
    });
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: "email_in_use", proven: false }),
    );
    expect((await d.send("POST", `${GATE}/join`)).status).toBe(403);
    expect(await linksOf(w, other.id)).toEqual([]);
    expect(await count(w, "accounts")).toBe(1);
  });

  it("an identity that already has an account merges into the email's account (I-05, D21)", async () => {
    const w = await seededWorld();
    const ada = await emailAccount(w, "ada@example.com");
    // The Google identity has its own account with no confirmed email yet (an older sign-in).
    const stray = await insertAccount(
      w.db,
      { primaryEmail: null, primaryEmailVerified: false, displayName: "Ada" },
      NOW,
    );
    await insertLink(
      w.db,
      stray.id,
      {
        issuerKey: GOOGLE,
        tenantScope: "",
        subject: "g-1",
        kind: "google",
        email: null,
        emailVerified: false,
        displayName: "Ada",
        amr: null,
      },
      NOW,
    );
    const d = new Device(w);
    const res = await arrive(w, d, google("g-1", null));
    expect(res.headers.get("location")).toBe(EMAIL_GATE_LANDING);
    await d.send("POST", GATE, { choice: "typed", email: "ada@example.com" });
    await d.send("POST", `${GATE}/verify`, {
      code: lastCode(w, "ada@example.com"),
    });
    const join = await d.send("POST", `${GATE}/join`);
    expect(join.status).toBe(200);
    expect(await join.json()).toEqual(
      expect.objectContaining({ joined: true }),
    );
    // The email's account survives; the stray one is gone, leaving its tombstone.
    expect(await linksOf(w, ada)).toEqual([
      "email:ada@example.com",
      "google:g-1",
    ]);
    expect(
      await w.db.first("SELECT id FROM accounts WHERE id = ?", stray.id),
    ).toBeNull();
    expect(
      (
        await w.db.first<{ merged_into: string }>(
          "SELECT merged_into FROM account_tombstones WHERE id = ?",
          stray.id,
        )
      )?.merged_into,
    ).toBe(ada);
  });

  it("declining is choosing a different email", async () => {
    const w = await seededWorld();
    await emailAccount(w, "ada@example.com");
    const d = new Device(w);
    await arrive(w, d, workspace("g-1", "ada@example.com"));
    expect((await d.send("POST", GATE, { choice: "provider" })).status).toBe(
      409,
    );
    await d.send("POST", GATE, {
      choice: "typed",
      email: "ada.new@example.com",
    });
    const res = await d.send("POST", `${GATE}/verify`, {
      code: lastCode(w, "ada.new@example.com"),
    });
    expect(res.status).toBe(200);
    expect(await count(w, "accounts")).toBe(2);
  });
});

describe("terms", () => {
  const withTerms = (version: string): ProviderSignIn => ({
    ...google("g-1", "ada@gmail.com"),
    product: {
      slug: "acme",
      terms: { url: "https://acme.example/terms", version },
    },
  });

  it("the gate does not pass until this version is accepted; acceptance is kept per version", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await arrive(w, d, withTerms("2026-10"));
    const refused = await d.send("POST", GATE, { choice: "provider" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual(
      expect.objectContaining({ error: "terms_required" }),
    );
    expect(await count(w, "accounts")).toBe(0);
    const ok = await d.send("POST", GATE, {
      choice: "provider",
      termsVersion: "2026-10",
    });
    expect(ok.status).toBe(200);
    // PX-W15: one row per account, product and version (`account_terms_acceptances`).
    expect(
      await w.db.all<{ product: string; version: string }>(
        "SELECT product, version FROM account_terms_acceptances",
      ),
    ).toEqual([{ product: "acme", version: "2026-10" }]);

    // Same version: straight through. A new version asks again (terms only).
    const same = new Device(w, "198.51.100.20");
    expect(
      (await arrive(w, same, withTerms("2026-10"))).headers.get("location"),
    ).toBe("/");
    const next = new Device(w, "198.51.100.21");
    expect(
      (await arrive(w, next, withTerms("2027-01"))).headers.get("location"),
    ).toBe(EMAIL_GATE_LANDING);
    const view = (await (await next.send("GET", GATE)).json()) as {
      emailRequired: boolean;
    };
    expect(view.emailRequired).toBe(false);
    expect(
      (await next.send("POST", GATE, { termsVersion: "2027-01" })).status,
    ).toBe(200);
    // The new version is added beside the old one, which is kept.
    expect(
      (
        await w.db.all<{ version: string }>(
          "SELECT version FROM account_terms_acceptances ORDER BY version",
        )
      ).map((r) => r.version),
    ).toEqual(["2026-10", "2027-01"]);
  });
});

describe("an account that can't sign in (SIGN-IN.md §3.13, Account disabled)", () => {
  it("a provider sign-in gets the page, with another account as the way on", async () => {
    const w = await seededWorld();
    const a = await insertAccount(
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
      a.id,
      {
        issuerKey: GOOGLE,
        tenantScope: "",
        subject: "g-disabled",
        kind: "google",
        email: "ada@gmail.com",
        emailVerified: true,
        displayName: null,
        amr: null,
      },
      NOW,
    );
    await w.db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      a.id,
    );
    for (const [returnTo, href] of [
      ["/#/p/acme", "/#/p/acme"],
      [null, "/"],
    ] as const) {
      const d = new Device(w);
      const res = await arrive(w, d, {
        ...google("g-disabled", "ada@gmail.com"),
        returnTo,
      });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toMatch(/This account can(&#39;|&#x27;|')t sign in/);
      expect(html).toContain(
        `<a class="button" href="${href}">Sign in with another account</a>`,
      );
      expect(html).not.toContain("Polaris Key support");
      expect(html).not.toContain("Back to ");
      expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
      expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(false);
    }
  });
});

describe("the gate's lifecycle", () => {
  it("cancel ends it; a later step answers expired", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com"));
    const gateCookie = d.jar.get(EMAIL_GATE_COOKIE)!;
    expect((await d.send("POST", `${GATE}/cancel`)).status).toBe(200);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(false);
    d.jar.set(EMAIL_GATE_COOKIE, gateCookie);
    expect((await d.send("POST", GATE, { choice: "provider" })).status).toBe(
      400,
    );
    expect(await count(w, "accounts")).toBe(0);
  });

  it("another browser without the gate cookie cannot drive it", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com"));
    const other = new Device(w, "198.51.100.99");
    expect((await other.send("GET", GATE)).status).toBe(400);
    expect(
      (await other.send("POST", GATE, { choice: "provider" })).status,
    ).toBe(400);
  });
});
