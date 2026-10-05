import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import { Device, seededWorld } from "./identityCardHarness.js";
import {
  ACCOUNT_SESSION_COOKIE,
  EMAIL_GATE_COOKIE,
  SIGNIN_FLOW_COOKIE,
  stripAccountCookies,
  withoutAccountCookies,
  withoutAccountSetCookies,
} from "../src/core/accountCookies.js";
import { issuePortalSession } from "../src/services/identity/portal/session.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { subjectFor } from "../src/core/accountSubjects.js";

// I-07: account sessions (S-16 §5.4 item 7): host-only, revocable, listable, "sign out
// everywhere"; a cookie is good only while its server-side row is.

afterEach(() => {
  vi.useRealTimers();
});

describe("account sessions", () => {
  it("a signed cookie with no server-side row is refused", async () => {
    const w = await seededWorld();
    const account = await getOrCreateAccountByEmail(
      w.db,
      "ada@example.com",
      NOW,
    );
    const { token } = await issuePortalSession(
      w.env,
      { accountId: account.id, email: "ada@example.com" },
      NOW,
    );
    const d = new Device(w);
    d.jar.set(ACCOUNT_SESSION_COOKIE, token);
    expect((await d.me()).status).toBe(401);
  });

  it("lists the live sessions with the current one marked, and ends another one", async () => {
    const w = await seededWorld();
    const laptop = new Device(w, "198.51.100.1");
    const phone = new Device(w, "198.51.100.2");
    await laptop.signInWithCode("ada@example.com");
    await phone.signInWithCode("ada@example.com", NOW + 10);
    await laptop.me();
    const list = (await (await laptop.send("GET", "/api/sessions")).json()) as {
      sessions: Array<{ id: string; current: boolean; methods: string[] }>;
    };
    expect(list.sessions).toHaveLength(2);
    expect(list.sessions.filter((s) => s.current)).toHaveLength(1);
    expect(list.sessions.every((s) => s.methods.join() === "email")).toBe(true);
    const other = list.sessions.find((s) => !s.current)!;
    const ended = await laptop.send("DELETE", `/api/sessions/${other.id}`);
    expect(ended.status).toBe(200);
    expect(await ended.json()).toEqual({ ok: true, current: false });
    expect((await phone.me()).status).toBe(401);
    expect((await laptop.me()).status).toBe(200);
    // Ending it again, or someone else's, is not found.
    expect(
      (await laptop.send("DELETE", `/api/sessions/${other.id}`)).status,
    ).toBe(404);
  });

  it("a session id of another account cannot be ended", async () => {
    const w = await seededWorld();
    const ada = new Device(w, "198.51.100.1");
    const bob = new Device(w, "198.51.100.2");
    await ada.signInWithCode("ada@example.com");
    await bob.signInWithCode("bob@example.com");
    await ada.me();
    await bob.me();
    const bobs = (await (await bob.send("GET", "/api/sessions")).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(
      (await ada.send("DELETE", `/api/sessions/${bobs.sessions[0]!.id}`))
        .status,
    ).toBe(404);
    expect((await bob.me()).status).toBe(200);
  });

  it("sign out everywhere ends every session, this one included, and clears the cookie", async () => {
    const w = await seededWorld();
    const laptop = new Device(w, "198.51.100.1");
    const phone = new Device(w, "198.51.100.2");
    await laptop.signInWithCode("ada@example.com");
    await phone.signInWithCode("ada@example.com");
    await laptop.me();
    const out = await laptop.send("POST", "/api/sessions/sign-out-everywhere");
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true, ended: 2, devices: 0 });
    expect(laptop.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect((await phone.me()).status).toBe(401);
  });

  it("sign out everywhere also drops every device's binding to the account (Core's hook)", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await d.signInWithCode("ada@example.com");
    await d.me();
    const account = await getOrCreateAccountByEmail(
      w.db,
      "ada@example.com",
      NOW,
    );
    const subject = await subjectFor(w.db, account.id, "acme", NOW);
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, bound_by)
       VALUES ('acme', 'dev-1', '', 'authorized', ?, ?, ?, 'key')`,
      NOW,
      NOW,
      subject,
    );
    const out = await d.send("POST", "/api/sessions/sign-out-everywhere");
    expect(await out.json()).toEqual({ ok: true, ended: 1, devices: 1 });
    const device = await w.db.first<{ subject: string | null; status: string }>(
      "SELECT subject, status FROM devices WHERE device_id = 'dev-1'",
    );
    // The binding is gone; a key-bound device keeps its licence and stays authorized.
    expect(device).toEqual({ subject: null, status: "authorized" });
  });

  it("session mutations need the CSRF header", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await d.signInWithCode("ada@example.com");
    const res = await d.send("POST", "/api/sessions/sign-out-everywhere");
    expect(res.status).toBe(403);
  });

  it("signing out ends the server-side session: a copied cookie is dead too", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await d.signInWithCode("ada@example.com");
    const copied = d.jar.get(ACCOUNT_SESSION_COOKIE)!;
    const out = await d.send("POST", "/logout");
    expect(out.status).toBe(302);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    const thief = new Device(w, "198.51.100.200");
    thief.jar.set(ACCOUNT_SESSION_COOKIE, copied);
    expect((await thief.me()).status).toBe(401);
  });

  it("an expired session row is refused even with a valid signature", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await d.signInWithCode("ada@example.com");
    await w.db.run("UPDATE account_sessions SET expires_at = ?", NOW - 1);
    expect((await d.me()).status).toBe(401);
  });

  it("the account cookie is host-only, HttpOnly, Secure and SameSite=Lax", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await d.send("POST", "/api/signin/email/start", {
      email: "ada@example.com",
    });
    const code = /(\d{3}) (\d{3})/.exec(w.mail[0]!.text)!;
    const req = d.request("POST", "/api/signin/email/verify", {
      code: code[1]! + code[2]!,
    });
    const { handlePortal } =
      await import("../src/services/identity/portal/index.js");
    const res = await handlePortal(
      req,
      w.env,
      w.db,
      "/api/signin/email/verify",
      { now: NOW },
    );
    const h = res.headers as Headers & { getSetCookie(): string[] };
    const session = h
      .getSetCookie()
      .find((c) => c.startsWith(`${ACCOUNT_SESSION_COOKIE}=`))!;
    expect(ACCOUNT_SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(session).toContain(attr);
    }
    expect(session).not.toMatch(/Domain=/i);
  });
});

describe("the account realm never reaches a product route (unit)", () => {
  it("strips every account-realm cookie and keeps the rest", () => {
    expect(
      stripAccountCookies(
        `a=1; ${ACCOUNT_SESSION_COOKIE}=s; ${SIGNIN_FLOW_COOKIE}=f; ${EMAIL_GATE_COOKIE}=g; b=2`,
      ),
    ).toBe("a=1; b=2");
    expect(stripAccountCookies(`${ACCOUNT_SESSION_COOKIE}=s`)).toBeNull();
    const req = withoutAccountCookies(
      new Request("https://key.plrs.im/acme/license/token", {
        headers: { cookie: `${ACCOUNT_SESSION_COOKIE}=s` },
      }) as unknown as Request,
    );
    expect(req.headers.get("cookie")).toBeNull();
  });

  it("drops a product's Set-Cookie for an account-realm cookie and keeps its own", () => {
    const headers = new Headers();
    headers.append("set-cookie", `${ACCOUNT_SESSION_COOKIE}=evil; Path=/`);
    headers.append("set-cookie", "app=1; Path=/acme");
    const out = withoutAccountSetCookies(
      new Response("ok", { headers }) as unknown as Response,
    );
    const all = (
      out.headers as Headers & { getSetCookie(): string[] }
    ).getSetCookie();
    expect(all).toEqual(["app=1; Path=/acme"]);
  });
});
