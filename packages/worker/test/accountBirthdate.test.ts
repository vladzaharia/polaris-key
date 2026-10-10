import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import { Device, seededWorld, type CardWorld } from "./identityCardHarness.js";
import {
  beginProviderSignIn,
  type ProviderSignIn,
} from "../src/services/identity/card/gate.js";
import type { ProfileView } from "../src/services/identity/card/profile.js";
import {
  BIRTHDATE_MIN,
  birthdateSourceView,
  claimBirthdate,
  connectionSource,
  parseBirthdate,
} from "../src/services/identity/accounts/birthdate.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import { undoMerge } from "../src/services/identity/accounts/mergeUndo.js";
import { deleteAccount } from "../src/services/identity/accounts/deletion.js";
import { EMAIL_ISSUER } from "../src/services/identity/accounts/repo.js";

// I-33 (plans/I-27.md §2.4): the account's optional birth date. Stored only when the person accepts
// it (FinishStep, from a connection's claim) or adds it (Account → Profile); never on a link, in
// the audit or in a log line; never answered outside the person's own profile.

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..");
const ROOT = join(WORKER, "..", "..");
const GATE = "/api/signin/confirm-email";
/** NOW (1_700_000_000) is 2023-11-14 UTC. */
const TODAY = "2023-11-14";
const BIRTHDATE = "1987-02-28";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseBirthdate", () => {
  it.each([
    ["1987-02-28", "1987-02-28"],
    ["2000-02-29", "2000-02-29"], // a leap year
    ["2020-02-29", "2020-02-29"],
    [BIRTHDATE_MIN, BIRTHDATE_MIN],
    [TODAY, TODAY],
    ["2023-11-15", "2023-11-15"], // tomorrow in UTC: already today somewhere east of UTC
  ])("accepts %s", (raw, out) => {
    expect(parseBirthdate(raw, NOW)).toBe(out);
  });

  it.each([
    "1900-02-29", // not a leap year (century)
    "2023-02-29",
    "1987-04-31",
    "1987-13-01",
    "1987-00-10",
    "1987-01-00",
    "1987-01-32",
    "1899-12-31", // before the floor
    "2023-11-16", // the day after tomorrow
    "2999-01-01",
    "0000-02-28", // OIDC's withheld year
    "1987", // OIDC's year alone
    "1987-2-28",
    "87-02-28",
    " 1987-02-28",
    "1987-02-28 ",
    "1987-02-28T00:00:00Z",
    "1987/02/28",
    "28-02-1987",
    "",
  ])("refuses %j", (raw) => {
    expect(parseBirthdate(raw, NOW)).toBeNull();
  });

  it.each([null, undefined, 19870228, { value: "1987-02-28" }, ["1987-02-28"]])(
    "refuses a non-string %j",
    (raw) => {
      expect(parseBirthdate(raw, NOW)).toBeNull();
    },
  );

  it("offers only a full date from a claim", () => {
    expect(claimBirthdate("1987-02-28", NOW)).toBe("1987-02-28");
    expect(claimBirthdate("0000-02-28", NOW)).toBeNull();
    expect(claimBirthdate("1987", NOW)).toBeNull();
  });

  it("spells and reads sources", () => {
    expect(connectionSource("lakeside")).toBe("connection:lakeside");
    expect(connectionSource("bad id")).toBeNull();
    expect(connectionSource("")).toBeNull();
    expect(birthdateSourceView("user")).toEqual({ kind: "user" });
    expect(birthdateSourceView("connection:lakeside")).toEqual({
      kind: "connection",
      connectionId: "lakeside",
    });
    expect(birthdateSourceView("connection:")).toBeNull();
    expect(birthdateSourceView("google")).toBeNull();
    expect(birthdateSourceView(null)).toBeNull();
  });
});

describe("the migrations and their down scripts", () => {
  it("add two nullable columns, and the down scripts drop them again", () => {
    // Every migration in filename order, as `makeTestDb` applies them.
    const sqlite = new Database(":memory:");
    for (const f of readdirSync(join(WORKER, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      sqlite.exec(readFileSync(join(WORKER, "migrations", f), "utf8"));
    const cols = () =>
      (
        sqlite
          .prepare("SELECT name FROM pragma_table_info('accounts')")
          .all() as {
          name: string;
        }[]
      ).map((r) => r.name);
    expect(cols()).toEqual(
      expect.arrayContaining(["birthdate", "birthdate_source"]),
    );
    sqlite.exec(
      "INSERT INTO accounts (id, status, created_at, modified_at) VALUES ('acct_1', 'active', 1, 1)",
    );
    expect(
      sqlite
        .prepare(
          "SELECT birthdate, birthdate_source FROM accounts WHERE id = 'acct_1'",
        )
        .get(),
    ).toEqual({ birthdate: null, birthdate_source: null });
    for (const f of [
      "0111_accounts_birthdate_source.down.sql",
      "0110_accounts_birthdate.down.sql",
    ])
      sqlite.exec(readFileSync(join(WORKER, "scripts", "rollback", f), "utf8"));
    expect(cols()).not.toContain("birthdate");
    expect(cols()).not.toContain("birthdate_source");
    sqlite.close();
  });
});

/** An email-code account in its own browser, with its CSRF token. */
async function emailPerson(
  w: CardWorld,
  email: string,
  ip = "203.0.113.20",
): Promise<{ d: Device; accountId: string }> {
  const d = new Device(w, ip);
  expect((await d.signInWithCode(email)).status).toBe(200);
  await d.me();
  const row = await w.db.first<{ account_id: string }>(
    "SELECT account_id FROM account_links WHERE issuer_key = ? AND subject = ?",
    EMAIL_ISSUER,
    email,
  );
  return { d, accountId: row!.account_id };
}

async function profile(d: Device): Promise<ProfileView> {
  const res = await d.send("GET", "/api/me/profile");
  expect(res.status).toBe(200);
  return ((await res.json()) as { profile: ProfileView }).profile;
}

async function stored(
  w: CardWorld,
  accountId: string,
): Promise<{ birthdate: string | null; birthdate_source: string | null }> {
  return (await w.db.first<{
    birthdate: string | null;
    birthdate_source: string | null;
  }>(
    "SELECT birthdate, birthdate_source FROM accounts WHERE id = ?",
    accountId,
  ))!;
}

describe("Account → Profile adds, changes and removes the birth date", () => {
  it("answers none at first, stores a typed date as the person's, and removes it", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailPerson(w, "ada@example.com");
    expect((await profile(d)).birthdate).toBeNull();
    expect((await profile(d)).birthdateSource).toBeNull();

    const set = await d.send("PATCH", "/api/me/profile", {
      birthdate: BIRTHDATE,
    });
    expect(set.status).toBe(200);
    const after = ((await set.json()) as { profile: ProfileView }).profile;
    expect(after.birthdate).toBe(BIRTHDATE);
    expect(after.birthdateSource).toEqual({ kind: "user" });
    expect(await stored(w, accountId)).toEqual({
      birthdate: BIRTHDATE,
      birthdate_source: "user",
    });

    const changed = await d.send("PATCH", "/api/me/profile", {
      birthdate: "1987-03-01",
    });
    expect(changed.status).toBe(200);
    expect((await stored(w, accountId)).birthdate).toBe("1987-03-01");

    const removed = await d.send("PATCH", "/api/me/profile", {
      birthdate: null,
    });
    expect(removed.status).toBe(200);
    expect(await stored(w, accountId)).toEqual({
      birthdate: null,
      birthdate_source: null,
    });
    // The name and picture were not touched by a birth-date-only edit.
    expect((await profile(d)).displayName).toBe("ada@example.com");
  });

  it.each([
    ["2023-02-29", "invalid_birthdate"],
    ["2030-01-01", "invalid_birthdate"],
    ["1987-02-28T00:00:00Z", "invalid_birthdate"],
    ["", "invalid_birthdate"],
  ])("refuses %j with reason %s and writes nothing", async (raw, reason) => {
    const w = await seededWorld();
    const { d, accountId } = await emailPerson(w, "ada@example.com");
    await d.send("PATCH", "/api/me/profile", { birthdate: BIRTHDATE });
    const res = await d.send("PATCH", "/api/me/profile", {
      birthdate: raw,
      name: "Ada",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: "bad_request", reason }),
    );
    // All or nothing: neither the date nor the name changed.
    expect((await stored(w, accountId)).birthdate).toBe(BIRTHDATE);
    expect((await profile(d)).displayName).toBe("ada@example.com");
  });

  it.each([19870228, true, { value: BIRTHDATE }, [BIRTHDATE]])(
    "refuses a non-string birthdate %j",
    async (raw) => {
      const w = await seededWorld();
      const { d } = await emailPerson(w, "ada@example.com");
      const res = await d.send("PATCH", "/api/me/profile", { birthdate: raw });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "bad_request",
      );
    },
  );

  it("needs a signed-in session and the CSRF header", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailPerson(w, "ada@example.com");
    const csrf = d.csrf;
    d.csrf = null;
    const noCsrf = await d.send("PATCH", "/api/me/profile", {
      birthdate: BIRTHDATE,
    });
    expect(noCsrf.status).toBe(403);
    d.csrf = csrf;
    const stranger = new Device(w, "203.0.113.99");
    expect(
      (
        await stranger.send("PATCH", "/api/me/profile", {
          birthdate: BIRTHDATE,
        })
      ).status,
    ).toBe(401);
    expect((await stored(w, accountId)).birthdate).toBeNull();
  });

  it("keeps a connection's source when the same date is saved again, and records no value in the audit", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailPerson(w, "ada@example.com");
    await w.db.run(
      "UPDATE accounts SET birthdate = ?, birthdate_source = 'connection:lakeside' WHERE id = ?",
      BIRTHDATE,
      accountId,
    );
    expect((await profile(d)).birthdateSource).toEqual({
      kind: "connection",
      connectionId: "lakeside",
    });
    await d.send("PATCH", "/api/me/profile", { birthdate: BIRTHDATE });
    expect((await stored(w, accountId)).birthdate_source).toBe(
      "connection:lakeside",
    );
    await d.send("PATCH", "/api/me/profile", { birthdate: "1987-03-01" });
    expect((await stored(w, accountId)).birthdate_source).toBe("user");
    const audit = await w.db.all<{ summary: string | null; action: string }>(
      "SELECT action, summary FROM portal_audit WHERE account_id = ?",
      accountId,
    );
    expect(audit.some((a) => a.summary === "birth date")).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/1987/);
  });
});

describe("a join and its undo move the birth date as one pair", () => {
  it("fills the survivor's empty birth date, keeps its own, and the undo takes the filled one back", async () => {
    const w = await seededWorld();
    const s = await emailPerson(w, "mara@example.com", "203.0.113.30");
    const a = await emailPerson(w, "a@example.com", "203.0.113.31");
    await w.db.run(
      "UPDATE accounts SET birthdate = ?, birthdate_source = 'connection:lakeside' WHERE id = ?",
      BIRTHDATE,
      a.accountId,
    );
    const ctx = {
      db: w.db,
      env: w.env,
      now: NOW,
      origin: "https://key.plrs.im",
    };
    const merged = await mergeAccounts(ctx, {
      survivor: { accountId: s.accountId, authenticatedAt: NOW },
      absorbed: { accountId: a.accountId, authenticatedAt: NOW },
    });
    if (!merged.ok) throw new Error(merged.reason);
    expect(await stored(w, s.accountId)).toEqual({
      birthdate: BIRTHDATE,
      birthdate_source: "connection:lakeside",
    });
    const undone = await undoMerge(
      ctx,
      { accountId: s.accountId, authenticatedAt: NOW },
      merged.mergeId,
    );
    expect(undone.ok).toBe(true);
    expect(await stored(w, s.accountId)).toEqual({
      birthdate: null,
      birthdate_source: null,
    });
    expect(await stored(w, a.accountId)).toEqual({
      birthdate: BIRTHDATE,
      birthdate_source: "connection:lakeside",
    });
  });

  it("never overwrites the survivor's own birth date", async () => {
    const w = await seededWorld();
    const s = await emailPerson(w, "mara@example.com", "203.0.113.32");
    const a = await emailPerson(w, "a@example.com", "203.0.113.33");
    await w.db.run(
      "UPDATE accounts SET birthdate = '1990-01-01', birthdate_source = 'user' WHERE id = ?",
      s.accountId,
    );
    await w.db.run(
      "UPDATE accounts SET birthdate = ?, birthdate_source = 'connection:lakeside' WHERE id = ?",
      BIRTHDATE,
      a.accountId,
    );
    const ctx = {
      db: w.db,
      env: w.env,
      now: NOW,
      origin: "https://key.plrs.im",
    };
    const merged = await mergeAccounts(ctx, {
      survivor: { accountId: s.accountId, authenticatedAt: NOW },
      absorbed: { accountId: a.accountId, authenticatedAt: NOW },
    });
    expect(merged.ok).toBe(true);
    expect(await stored(w, s.accountId)).toEqual({
      birthdate: "1990-01-01",
      birthdate_source: "user",
    });
  });
});

describe("deleting the account", () => {
  it("clears the birth date at once", async () => {
    const w = await seededWorld();
    const { accountId } = await emailPerson(w, "ada@example.com");
    await w.db.run(
      "UPDATE accounts SET birthdate = ?, birthdate_source = 'user' WHERE id = ?",
      BIRTHDATE,
      accountId,
    );
    await deleteAccount(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      accountId,
    );
    const row = await w.db.first<{ birthdate: string | null }>(
      "SELECT birthdate FROM accounts WHERE id = ?",
      accountId,
    );
    expect(row?.birthdate ?? null).toBeNull();
  });
});

// ── FinishStep's offer: a connection's claim, in the gate record only ──────────────────────────

function viaConnection(
  subject: string,
  birthdate: string | null,
  opts: { email?: string } = {},
): ProviderSignIn {
  return {
    identity: {
      issuerKey: "https://sso.lakeside.example",
      subject,
      kind: "oidc",
      email: opts.email ?? `${subject}@lakeside.example`,
      emailVerified: true,
      displayName: "Tomás Okafor",
    },
    profile: { name: "Tomás Okafor" },
    connection: { id: "lakeside", label: "Lakeside University", birthdate },
  };
}

async function arrive(
  w: CardWorld,
  input: ProviderSignIn,
  ip = "198.51.100.7",
): Promise<Device> {
  const d = new Device(w, ip);
  d.absorb(
    await beginProviderSignIn(
      d.request("GET", "/callback"),
      w.env,
      w.db,
      input,
      NOW,
    ),
  );
  return d;
}

async function gateView(d: Device): Promise<Record<string, any>> {
  return (await (await d.send("GET", GATE)).json()) as Record<string, any>;
}

async function newAccount(w: CardWorld): Promise<{
  id: string;
  birthdate: string | null;
  birthdate_source: string | null;
}> {
  return (await w.db.first<{
    id: string;
    birthdate: string | null;
    birthdate_source: string | null;
  }>("SELECT id, birthdate, birthdate_source FROM accounts"))!;
}

describe("FinishStep's birth date", () => {
  it("is offered, labelled with its connection, only when the claim carried a full date", async () => {
    const w = await seededWorld();
    const d = await arrive(w, viaConnection("tomas", BIRTHDATE));
    const view = await gateView(d);
    expect(view.profile.birthdate).toEqual({
      value: BIRTHDATE,
      offered: BIRTHDATE,
      from: "Lakeside University",
    });
    for (const claim of [null, "0000-02-28", "1987", "2099-01-01", "garbage"]) {
      const w2 = await seededWorld();
      const d2 = await arrive(w2, viaConnection("tomas", claim));
      expect((await gateView(d2)).profile.birthdate).toBeNull();
    }
    // A front door that names no connection offers nothing, whatever else it sends.
    const w3 = await seededWorld();
    const plain = viaConnection("tomas", BIRTHDATE);
    delete plain.connection;
    expect(
      (await gateView(await arrive(w3, plain))).profile.birthdate,
    ).toBeNull();
  });

  it("accepted as offered, is stored with the connection as its source", async () => {
    const w = await seededWorld();
    const d = await arrive(w, viaConnection("tomas", BIRTHDATE));
    const res = await d.send("POST", GATE, {
      choice: "provider",
      birthdate: BIRTHDATE,
    });
    expect(res.status).toBe(200);
    expect(await newAccount(w)).toEqual(
      expect.objectContaining({
        birthdate: BIRTHDATE,
        birthdate_source: "connection:lakeside",
      }),
    );
  });

  it("edited before accepting, is the person's own", async () => {
    const w = await seededWorld();
    const d = await arrive(w, viaConnection("tomas", BIRTHDATE));
    expect(
      (
        await d.send("POST", GATE, {
          choice: "provider",
          birthdate: "1987-03-01",
        })
      ).status,
    ).toBe(200);
    expect(await newAccount(w)).toEqual(
      expect.objectContaining({
        birthdate: "1987-03-01",
        birthdate_source: "user",
      }),
    );
  });

  it("left out, is never stored", async () => {
    const w = await seededWorld();
    const d = await arrive(w, viaConnection("tomas", BIRTHDATE));
    expect((await d.send("POST", GATE, { choice: "provider" })).status).toBe(
      200,
    );
    expect(await newAccount(w)).toEqual(
      expect.objectContaining({ birthdate: null, birthdate_source: null }),
    );
    const w2 = await seededWorld();
    const d2 = await arrive(w2, viaConnection("tomas", BIRTHDATE));
    expect(
      (await d2.send("POST", GATE, { choice: "provider", birthdate: null }))
        .status,
    ).toBe(200);
    expect((await newAccount(w2)).birthdate).toBeNull();
  });

  it("refuses a date nobody offered, and an invalid one, writing no account", async () => {
    const w = await seededWorld();
    const d = await arrive(w, viaConnection("tomas", null));
    const unoffered = await d.send("POST", GATE, {
      choice: "provider",
      birthdate: BIRTHDATE,
    });
    expect(unoffered.status).toBe(400);
    expect(await unoffered.json()).toEqual(
      expect.objectContaining({ reason: "birthdate_not_offered" }),
    );
    const w2 = await seededWorld();
    const d2 = await arrive(w2, viaConnection("tomas", BIRTHDATE));
    const invalid = await d2.send("POST", GATE, {
      choice: "provider",
      birthdate: "1987-02-30",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual(
      expect.objectContaining({ reason: "invalid_birthdate" }),
    );
    for (const x of [w, w2])
      expect(
        (await x.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM accounts"))!
          .n,
      ).toBe(0);
    // The gate is still open: a corrected date passes.
    expect(
      (
        await d2.send("POST", GATE, {
          choice: "provider",
          birthdate: BIRTHDATE,
        })
      ).status,
    ).toBe(200);
  });

  it("survives the code step: a typed address, then the code, stores what was accepted", async () => {
    const w = await seededWorld();
    const d = await arrive(w, viaConnection("tomas", BIRTHDATE));
    const sent = await d.send("POST", GATE, {
      choice: "typed",
      email: "tomas@home.example",
      birthdate: BIRTHDATE,
    });
    expect(sent.status).toBe(200);
    const code = /(\d{3}) (\d{3})/.exec(w.mail.at(-1)!.text)!;
    const ok = await d.send("POST", `${GATE}/verify`, {
      code: `${code[1]}${code[2]}`,
    });
    expect(ok.status).toBe(200);
    expect((await newAccount(w)).birthdate).toBe(BIRTHDATE);
  });

  it("is never kept on a sign-in method, in the audit, in a log line or in mail", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(" "));
      });
    const w = await seededWorld();
    const d = await arrive(w, viaConnection("tomas", BIRTHDATE));
    expect(
      (
        await d.send("POST", GATE, {
          choice: "typed",
          email: "tomas@home.example",
          birthdate: BIRTHDATE,
        })
      ).status,
    ).toBe(200);
    const code = /(\d{3}) (\d{3})/.exec(w.mail.at(-1)!.text)!;
    await d.send("POST", `${GATE}/verify`, { code: `${code[1]}${code[2]}` });
    // Negative control: it was stored, so the absences below mean something.
    expect((await newAccount(w)).birthdate).toBe(BIRTHDATE);
    const links = await w.db.all("SELECT * FROM account_links");
    expect(links.length).toBeGreaterThan(0);
    expect(JSON.stringify(links)).not.toContain("1987");
    expect(JSON.stringify(links)).not.toMatch(/birth/i);
    const audit = await w.db.all("SELECT * FROM portal_audit");
    expect(JSON.stringify(audit)).not.toContain("1987");
    expect(JSON.stringify(w.mail)).not.toContain("1987");
    expect(logged.join("\n")).not.toContain("1987");
    // The gate record is gone once it passed.
    expect((await d.send("GET", GATE)).status).toBe(400);
  });

  it("an existing account keeps the birth date it has: nothing is offered", async () => {
    const w = await seededWorld();
    const first = await arrive(w, viaConnection("tomas", null), "198.51.100.8");
    expect(
      (await first.send("POST", GATE, { choice: "provider" })).status,
    ).toBe(200);
    const { id } = await newAccount(w);
    // An account with no confirmed email meets the gate again; give it a date of its own.
    await w.db.run(
      "UPDATE accounts SET primary_email_verified_at = NULL, birthdate = '1990-01-01', birthdate_source = 'user' WHERE id = ?",
      id,
    );
    const again = await arrive(
      w,
      viaConnection("tomas", BIRTHDATE),
      "198.51.100.9",
    );
    expect((await gateView(again)).profile.birthdate).toBeNull();
  });
});

// ── Apps never receive a birth date: the recorded HTTP conversations ─────────────────────────

describe("no recorded response carries a birth date", () => {
  it("every transcript (and its Godot mirror) is free of a birthdate member", () => {
    const dirs = [
      join(ROOT, "conformance", "transcripts"),
      join(ROOT, "sdks", "godot", "tests", "transcripts"),
    ];
    let files = 0;
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        files++;
        const text = readFileSync(join(dir, f), "utf8");
        expect(`${f}: ${/birth_?date/i.test(text)}`).toBe(`${f}: false`);
      }
    }
    expect(files).toBeGreaterThan(20);
  });
});

// ── Only the person's own code paths read the column ─────────────────────────────────────────

describe("the Worker reads the birth date in the person's own paths only", () => {
  it("names `birthdate` only in the profile, FinishStep and the account lifecycle", () => {
    const allowed = new Set([
      "services/identity/accounts/birthdate.ts",
      "services/identity/accounts/deletion.ts",
      "services/identity/accounts/merge.ts",
      "services/identity/accounts/mergeUndo.ts",
      "services/identity/accounts/repo.ts",
      "services/identity/card/gate.ts",
      "services/identity/card/profile.ts",
      "services/identity/portal/profile.ts",
    ]);
    const src = join(WORKER, "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith(".ts")
            ? [join(dir, e.name)]
            : [],
      );
    // A migration's file name (LATEST_MIGRATION in core/deployIdentity.ts) is not a read.
    const naming = walk(src)
      .filter((f) =>
        /birth_?date/i.test(
          readFileSync(f, "utf8").replace(/\b\d{4}_\w+\.sql\b/g, ""),
        ),
      )
      .map((f) => f.slice(src.length + 1));
    expect(naming.length).toBeGreaterThan(0);
    for (const f of naming)
      expect(`${f}: ${allowed.has(f)}`).toBe(`${f}: true`);
  });
});
