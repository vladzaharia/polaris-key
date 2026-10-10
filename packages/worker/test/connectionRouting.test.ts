import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import {
  Device,
  lastCode,
  seededWorld,
  type CardWorld,
} from "./identityCardHarness.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import {
  ACCOUNT_SESSION_COOKIE,
  SIGNIN_FLOW_COOKIE,
} from "../src/core/accounts/accountCookies.js";
import { insertConnection } from "./connectionFixtures.js";

// I-30 (plans/I-27.md §2.3 "Routing", "Enforce"; §10): identifier-first routing in
// `POST /api/signin/email/start`. A DNS-verified domain of an active connection answers `next`
// and sends nothing; an enforced domain never gets an email code or magic link; the answer
// depends on the domain only.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const START = "/api/signin/email/start";
const RESEND = "/api/signin/email/resend";
const VERIFY = "/api/signin/email/verify";

/** A connection claiming `domain`, verified unless `verified: false`. */
async function connectionWith(
  w: CardWorld,
  opts: {
    id?: string;
    domain: string;
    verified?: boolean;
    enforce?: boolean;
    audience?: string;
    status?: string;
  },
): Promise<void> {
  const id = opts.id ?? "acme-sso";
  await insertConnection(w.db, {
    id,
    label: "Acme SSO",
    audience: opts.audience,
    status: opts.status,
  });
  await w.db.run(
    `INSERT INTO identity_connection_domains (connection_id, scope, domain, token, verified_at,
       checked_at, enforce) VALUES (?, 'platform', ?, 'tok', ?, ?, ?)`,
    id,
    opts.domain,
    opts.verified === false ? null : NOW,
    NOW,
    opts.enforce ? 1 : 0,
  );
}

/** An answer minus its random values (the flow cookie's secret). */
async function shape(res: Response): Promise<unknown> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = k === "set-cookie" ? v.replace(/=[^;]+;/, "=<secret>;") : v;
  });
  return { status: res.status, headers, body: await res.text() };
}

const ssoNext = (enforced: boolean) => ({
  kind: "sso",
  connection: { id: "acme-sso", label: "Acme SSO" },
  enforced,
});

describe("routing", () => {
  it("a verified domain answers next and sends nothing", async () => {
    const w = await seededWorld();
    await connectionWith(w, { domain: "acme.example" });
    const d = new Device(w);
    const res = await d.send("POST", START, { email: "ada@acme.example" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, resendIn: 0, next: ssoNext(false) });
    expect(w.mail).toEqual([]);
    expect(d.jar.has(SIGNIN_FLOW_COOKIE)).toBe(true);
  });

  it("known and unknown addresses in a routed domain answer identical bytes", async () => {
    const w = await seededWorld();
    await connectionWith(w, { domain: "acme.example" });
    await getOrCreateAccountByEmail(w.db, "known@acme.example", NOW);
    const known = await new Device(w, "198.51.100.1").send("POST", START, {
      email: "known@acme.example",
    });
    const unknown = await new Device(w, "198.51.100.2").send("POST", START, {
      email: "nobody@acme.example",
    });
    expect(await shape(known)).toEqual(await shape(unknown));
    expect(w.mail).toEqual([]);
  });

  it("known and unknown addresses in an enforced domain answer identical bytes", async () => {
    const w = await seededWorld();
    await connectionWith(w, { domain: "acme.example", enforce: true });
    await getOrCreateAccountByEmail(w.db, "known@acme.example", NOW);
    const known = await new Device(w, "198.51.100.1").send("POST", START, {
      email: "known@acme.example",
    });
    const unknown = await new Device(w, "198.51.100.2").send("POST", START, {
      email: "nobody@acme.example",
    });
    expect(await shape(known)).toEqual(await shape(unknown));
    expect(w.mail).toEqual([]);
  });

  it("an unrouted domain is unchanged: one email, identical bytes for known and unknown", async () => {
    const w = await seededWorld();
    await connectionWith(w, { domain: "acme.example" });
    await getOrCreateAccountByEmail(w.db, "known@other.example", NOW);
    const known = await new Device(w, "198.51.100.1").send("POST", START, {
      email: "known@other.example",
    });
    const unknown = await new Device(w, "198.51.100.2").send("POST", START, {
      email: "nobody@other.example",
    });
    const knownShape = (await shape(known)) as { body: string };
    expect(knownShape).toEqual(await shape(unknown));
    expect(JSON.parse(knownShape.body).next).toBeUndefined();
    expect(w.mail.map((m) => m.to).sort()).toEqual([
      "known@other.example",
      "nobody@other.example",
    ]);
  });

  it("picking the code: resend sends it at once, and the code signs in", async () => {
    const w = await seededWorld();
    await connectionWith(w, { domain: "acme.example" });
    const d = new Device(w);
    await d.send("POST", START, { email: "ada@acme.example" });
    const resend = await d.send("POST", RESEND, {});
    expect(resend.status).toBe(200);
    expect(w.mail.map((m) => m.to)).toEqual(["ada@acme.example"]);
    const verify = await d.send("POST", VERIFY, {
      code: lastCode(w, "ada@acme.example"),
    });
    expect(verify.status).toBe(200);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
  });

  it('`method: "code"` on the start sends the code at once on a routed domain', async () => {
    const w = await seededWorld();
    await connectionWith(w, { domain: "acme.example" });
    const res = await new Device(w).send("POST", START, {
      email: "ada@acme.example",
      method: "code",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { next?: unknown }).next).toBeUndefined();
    expect(w.mail.map((m) => m.to)).toEqual(["ada@acme.example"]);
  });
});

describe("enforce", () => {
  it("an enforced domain never gets an email, whatever the start asks", async () => {
    const w = await seededWorld();
    await connectionWith(w, { domain: "acme.example", enforce: true });
    const d = new Device(w);
    for (const body of [
      { email: "ada@acme.example" },
      { email: "ada@acme.example", method: "code" },
    ]) {
      const res = await d.send("POST", START, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ next: ssoNext(true) });
    }
    // No flow, so nothing to resend either.
    expect(d.jar.has(SIGNIN_FLOW_COOKIE)).toBe(false);
    expect((await d.send("POST", RESEND, {})).status).toBe(400);
    expect(w.mail).toEqual([]);
  });

  it("a domain enforced after the start: resend and an earlier code are refused", async () => {
    const w = await seededWorld();
    await connectionWith(w, { domain: "acme.example" });
    const d = new Device(w);
    await d.send("POST", START, { email: "ada@acme.example", method: "code" });
    const code = lastCode(w, "ada@acme.example");
    await w.db.run(
      "UPDATE identity_connection_domains SET enforce = 1 WHERE domain = 'acme.example'",
    );
    const resend = await d.send("POST", RESEND, {}, { now: NOW + 120 });
    expect(resend.status).toBe(403);
    expect(await resend.json()).toMatchObject({
      error: "auth_method_disabled",
      next: ssoNext(true),
    });
    expect(w.mail).toHaveLength(1);
    const verify = await d.send("POST", VERIFY, { code });
    expect(verify.status).toBe(403);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("the Kelvin-sign spelling of an enforced domain gets no email either", async () => {
    // `strictEmail` lower-cases first, so U+212A folds into ASCII "k" and the address mailed would
    // be the enforced domain's: routing reads that same parsed address, so enforce still holds.
    const w = await seededWorld();
    await connectionWith(w, { domain: "key.example", enforce: true });
    const res = await new Device(w).send("POST", START, {
      email: "ada@\u212Aey.example",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ next: { enforced: true } });
    expect(w.mail).toEqual([]);
  });
});

describe("fail closed", () => {
  it("an unverified domain never routes and never enforces", async () => {
    const w = await seededWorld();
    await connectionWith(w, {
      domain: "acme.example",
      verified: false,
      enforce: true,
    });
    const res = await new Device(w).send("POST", START, {
      email: "ada@acme.example",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { next?: unknown }).next).toBeUndefined();
    expect(w.mail.map((m) => m.to)).toEqual(["ada@acme.example"]);
  });

  it("subdomains, suffix lookalikes, punycode, an operators-only or disabled connection never route", async () => {
    for (const [conn, email] of [
      [{ domain: "acme.example", enforce: true }, "ada@sub.acme.example"],
      [{ domain: "acme.example", enforce: true }, "ada@evil-acme.example"],
      [{ domain: "acme.example", enforce: true }, "ada@acme.example.evil.net"],
      [{ domain: "acme.example", enforce: true }, "ada@xn--acm-gla.example"],
      [
        { domain: "acme.example", enforce: true, audience: "operators" },
        "ada@acme.example",
      ],
      [
        { domain: "acme.example", enforce: true, status: "disabled" },
        "ada@acme.example",
      ],
    ] as const) {
      const w = await seededWorld();
      await connectionWith(w, conn);
      const res = await new Device(w).send("POST", START, { email });
      expect(res.status, email).toBe(200);
      expect(
        ((await res.json()) as { next?: unknown }).next,
        email,
      ).toBeUndefined();
      expect(
        w.mail.map((m) => m.to),
        email,
      ).toEqual([email]);
    }
  });

  it("a Cyrillic lookalike is not an address at all", async () => {
    const w = await seededWorld();
    await connectionWith(w, { domain: "acme.example", enforce: true });
    const res = await new Device(w).send("POST", START, {
      email: "ada@\u0430cme.example",
    });
    expect(res.status).toBe(422);
    expect(w.mail).toEqual([]);
  });
});
