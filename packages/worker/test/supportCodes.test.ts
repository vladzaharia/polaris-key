/**
 * I-41: readable support codes.
 *
 *   - the shape: nine characters from a 30-symbol alphabet without lookalikes, shown `XXX-XXX-XXX`;
 *   - the draw is uniform (rejection sampling) and a collision is redrawn;
 *   - what a person or operator types is normalised, and a lookalike is "not a code";
 *   - one stable code per (product, person);
 *   - the console route resolves a code only for an operator who may read that product's users,
 *     and answers a code of another product exactly like an unknown one;
 *   - the Users page search finds the person by code, within the product.
 */
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { PRINCIPALS } from "./rbacFixtures.js";
import type { Env } from "../src/platform/env.js";
import {
  SUPPORT_CODE_ALPHABET,
  SUPPORT_CODE_PATTERN,
  parseSupportCode,
  supportCodeCheck,
  existingSupportCode,
  formatSupportCode,
  mintSupportCode,
  normalizeSupportCode,
  resolveSupportCode,
  supportCodeFor,
} from "../src/core/accounts/supportCodes.js";
import { subjectFor } from "../src/core/accounts/accountSubjects.js";
import { listProductUsers } from "../src/services/identity/accounts/productUsers.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { handleAdminApi } from "../src/console/api.js";
import { ADMIN_COOKIE } from "../src/core/console/session.js";
import { SUPPORT_CODE_LOOKUPS_PER_MINUTE } from "../src/console/handlers/supportCodes.js";
import { consoleTestSession } from "./consoleSessionHelper.js";

const SYNTHETIC = new Map<string, unknown>();
vi.mock("../src/core/rbac/principal.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../src/core/rbac/principal.js")>();
  return {
    ...real,
    resolvePrincipal: async (
      ...args: Parameters<typeof real.resolvePrincipal>
    ) => SYNTHETIC.get(args[2].sub) ?? real.resolvePrincipal(...args),
  };
});
for (const p of Object.values(PRINCIPALS)) if (p) SYNTHETIC.set(p.memberId, p);

describe("the code's shape", () => {
  it("is nine symbols of a 30-symbol alphabet with no lookalikes", () => {
    expect(SUPPORT_CODE_ALPHABET).toHaveLength(30);
    expect(new Set(SUPPORT_CODE_ALPHABET).size).toBe(30);
    for (const bad of "01ILOU")
      expect(SUPPORT_CODE_ALPHABET).not.toContain(bad);
    for (let i = 0; i < 200; i++) {
      const code = mintSupportCode();
      expect(code).toHaveLength(9);
      for (const ch of code) expect(SUPPORT_CODE_ALPHABET).toContain(ch);
      expect(formatSupportCode(code)).toMatch(SUPPORT_CODE_PATTERN);
    }
  });

  it("ends in a check symbol that catches any one wrong symbol", () => {
    for (let n = 0; n < 200; n++) {
      const code = mintSupportCode();
      expect(supportCodeCheck(code.slice(0, 8))).toBe(code[8]);
      expect(parseSupportCode(code)).toEqual({ kind: "code", code });
      for (let i = 0; i < 9; i++)
        for (const ch of SUPPORT_CODE_ALPHABET) {
          if (ch === code[i]) continue;
          const wrong = code.slice(0, i) + ch + code.slice(i + 1);
          expect(parseSupportCode(wrong).kind, wrong).toBe("bad_check");
        }
    }
    expect(parseSupportCode("K7M-4QX-9TB")).toEqual({ kind: "bad_check" });
    expect(parseSupportCode("K7M-4QX-9T0")).toEqual({ kind: "not_code" });
  });

  it("groups three by three with dashes", () => {
    expect(formatSupportCode("K7M4QX9TZ")).toBe("K7M-4QX-9TZ");
  });

  it("rejects the biased tail of the range: every symbol is equally likely", () => {
    // 2^32 is not a multiple of 30; a draw in the leftover tail is thrown away, not folded.
    const reject = Math.floor(0x1_0000_0000 / 30) * 30;
    const draws = [
      reject,
      0xffff_ffff,
      ...Array.from({ length: 8 }, (_, i) => i),
    ];
    let i = 0;
    // Eight random symbols, then their check symbol.
    expect(mintSupportCode(() => draws[i++]!)).toBe("23456789J");
    expect(i).toBe(draws.length);
  });
});

describe("normalising what is typed", () => {
  it("ignores case, spaces, dashes and dots", () => {
    for (const typed of [
      "k7m-4qx-9tz",
      "K7M 4QX 9TZ",
      " k7m.4qx.9tz ",
      "K7M4QX9TZ",
      "k7m - 4qx - 9tz",
    ])
      expect(normalizeSupportCode(typed), typed).toBe("K7M4QX9TZ");
  });

  it("answers null for anything that is not a code, a lookalike included", () => {
    for (const typed of [
      "",
      "K7M-4QX",
      "K7M-4QX-9TZ-2",
      "K7M-4QX-9TB", // a wrong check symbol is no code
      "K7M-4QX-9T0", // zero
      "K7M-4QX-9TO",
      "K7M-4QX-9T1",
      "K7M-4QX-9TI",
      "K7M-4QX-9TL",
      "K7M-4QX-9TU",
      "ps_Vq3nT8uB1xYk0LpR4sZ7cA",
      "é7M-4QX-9TZ",
      "x".repeat(500),
    ])
      expect(normalizeSupportCode(typed), typed).toBeNull();
  });
});

describe("minting and resolving", () => {
  it("is stable for one person in one product, and different across products and people", async () => {
    const db = makeTestDb();
    const a = await supportCodeFor(db, "djdl", "ps_a", NOW);
    expect(a).toMatch(SUPPORT_CODE_PATTERN);
    expect(await supportCodeFor(db, "djdl", "ps_a", NOW + 99)).toBe(a);
    expect(await existingSupportCode(db, "djdl", "ps_a")).toBe(a);
    expect(await existingSupportCode(db, "djdl", "ps_b")).toBeNull();
    const other = await supportCodeFor(db, "acme", "ps_a", NOW);
    const b = await supportCodeFor(db, "djdl", "ps_b", NOW);
    expect(new Set([a, other, b]).size).toBe(3);
    expect(await w(db)).toBe(3);
  });

  it("redraws on a collision with another person's code", async () => {
    const db = makeTestDb();
    const first = await supportCodeFor(db, "djdl", "ps_a", NOW);
    const taken = first.replaceAll("-", "");
    // The second person's first draw is the taken code; the next is free.
    const seq = [...taken.slice(0, 8)].map((ch) =>
      SUPPORT_CODE_ALPHABET.indexOf(ch),
    );
    const fresh = [0, 1, 2, 3, 4, 5, 6, 7];
    const draws = [...seq, ...fresh];
    let i = 0;
    const second = await supportCodeFor(
      db,
      "djdl",
      "ps_b",
      NOW,
      () => draws[i++]!,
    );
    expect(second.replaceAll("-", "")).toBe("23456789J");
    expect(second).not.toBe(first);
    expect(await existingSupportCode(db, "djdl", "ps_a")).toBe(first);
  });

  it("resolves a typed code to its product and subject", async () => {
    const db = makeTestDb();
    const code = await supportCodeFor(db, "djdl", "ps_a", NOW);
    expect(await resolveSupportCode(db, code.toLowerCase())).toEqual({
      product: "djdl",
      subject: "ps_a",
    });
    expect(await resolveSupportCode(db, "222-222-222")).toBeNull();
    expect(await resolveSupportCode(db, "nonsense")).toBeNull();
  });
});

async function w(db: ReturnType<typeof makeTestDb>): Promise<number> {
  return (await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM support_codes",
  ))!.n;
}

// ── The console ─────────────────────────────────────────────────────────────────────────────

async function consoleWorld() {
  const db = makeTestDb();
  const env: Env = makeEnv(new KvMock(), ["alpha", "beta"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "admins";
  for (const slug of ["alpha", "beta"]) await seedProduct(db, slug);
  return { db, env };
}

async function get(
  w: Awaited<ReturnType<typeof consoleWorld>>,
  path: string,
  as: keyof typeof PRINCIPALS | "root",
  now = NOW,
) {
  const sub = as === "root" ? "u-root" : PRINCIPALS[as]!.memberId;
  const { token, session } = await consoleTestSession(
    w.env,
    w.db,
    {
      sub,
      name: as,
      email: `${as}@example.test`,
      groups: as === "root" ? ["admins"] : [],
    },
    now,
  );
  // The console resolves the member id from the account; the seam is keyed by it.
  const synthetic = SYNTHETIC.get(sub);
  if (synthetic) SYNTHETIC.set(session.sub, synthetic);
  const res = await handleAdminApi(
    new Request(`https://key.plrs.im/manage/api${path}`, {
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    }),
    w.env,
    w.db,
    `/api${path}`,
    now,
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("GET /manage/api/support-codes/<code>", () => {
  async function seeded() {
    const w = await consoleWorld();
    const acct = await getOrCreateAccountByEmail(w.db, "p@x.io", NOW);
    const subject = await subjectFor(w.db, acct.id, "alpha", NOW);
    const code = await supportCodeFor(w.db, "alpha", subject, NOW);
    return { ...w, acct, subject, code };
  }

  it("resolves a code for an operator who may read that product's users, however it is typed", async () => {
    const w = await seeded();
    for (const typed of [
      w.code,
      w.code.toLowerCase(),
      w.code.replaceAll("-", " "),
    ]) {
      const res = await get(
        w,
        `/support-codes/${encodeURIComponent(typed)}`,
        "alphaAdmin",
      );
      expect(res, typed).toEqual({
        status: 200,
        body: { product: "alpha", subject: w.subject },
      });
    }
    expect((await get(w, `/support-codes/${w.code}`, "root")).status).toBe(200);
  });

  it("answers product B's operator the same 404 as an unknown code", async () => {
    const w = await seeded();
    const bSubject = await subjectFor(w.db, w.acct.id, "beta", NOW);
    const bCode = await supportCodeFor(w.db, "beta", bSubject, NOW);
    // alpha's operator asks for beta's code, an unknown code, a malformed one and a subject.
    const answers = new Set<string>();
    for (const typed of [bCode, "222-222-222", "nope", w.subject]) {
      const r = await get(
        w,
        `/support-codes/${encodeURIComponent(typed)}`,
        "alphaAdmin",
      );
      answers.add(JSON.stringify(r));
    }
    expect(answers.size).toBe(1);
    expect([...answers][0]).toContain('"status":404');
    expect([...answers][0]).not.toContain("beta");
    // Her own product's code still works for her, and beta's for a root operator.
    expect(
      (await get(w, `/support-codes/${w.code}`, "alphaAdmin")).status,
    ).toBe(200);
    expect((await get(w, `/support-codes/${bCode}`, "root")).body).toEqual({
      product: "beta",
      subject: bSubject,
    });
  });

  it("refuses an operator without the product's Core area like an unknown code", async () => {
    const w = await seeded();
    expect((await get(w, `/support-codes/${w.code}`, "alphaShip")).status).toBe(
      404,
    );
    expect((await get(w, `/support-codes/${w.code}`, "stranger")).status).toBe(
      403,
    );
  });

  it("is limited per operator", async () => {
    const w = await seeded();
    for (let i = 0; i < SUPPORT_CODE_LOOKUPS_PER_MINUTE; i++)
      expect(
        (await get(w, "/support-codes/222-222-222", "alphaAdmin")).status,
      ).toBe(404);
    expect(
      (await get(w, "/support-codes/222-222-222", "alphaAdmin")).status,
    ).toBe(429);
    expect((await get(w, "/support-codes/222-222-222", "root")).status).toBe(
      404,
    );
  });
});

describe("the Users page search", () => {
  it("still finds a buyer by an email prefix that is shaped like a code (regression)", async () => {
    const w = await consoleWorld();
    const acct = await getOrCreateAccountByEmail(w.db, "p@x.io", NOW);
    const subject = await subjectFor(w.db, acct.id, "alpha", NOW);
    await seedLicenseWithKey(w.db, "alpha", { id: "lic_alpha_sarah" });
    await w.db.run(
      "UPDATE licenses SET email = ?, account_id = ? WHERE id = ?",
      "sarah.berger@example.com",
      acct.id,
      "lic_alpha_sarah",
    );
    const code = await supportCodeFor(w.db, "alpha", subject, NOW);
    for (const q of [
      "sarah",
      "sarah.berg",
      "SARAH BERG".replace(" ", "."),
      code,
    ])
      expect(
        (
          await listProductUsers(w.db, "alpha", { identityOn: false, q })
        ).users.map((u) => u.subject),
        q,
      ).toEqual([subject]);
  });

  it("finds a person by code within the product, listed even before a licence", async () => {
    const w = await consoleWorld();
    const acct = await getOrCreateAccountByEmail(w.db, "p@x.io", NOW);
    const subject = await subjectFor(w.db, acct.id, "alpha", NOW);
    const code = await supportCodeFor(w.db, "alpha", subject, NOW);
    // Unlisted without a code search (nothing holds a licence yet).
    expect(
      (await listProductUsers(w.db, "alpha", { identityOn: false })).users,
    ).toEqual([]);
    for (const q of [code, code.toLowerCase(), code.replaceAll("-", "")]) {
      const page = await listProductUsers(w.db, "alpha", {
        identityOn: false,
        q,
      });
      expect(
        page.users.map((u) => [u.subject, u.supportCode]),
        q,
      ).toEqual([[subject, code]]);
    }
    // Another product's page does not find it.
    expect(
      (await listProductUsers(w.db, "beta", { identityOn: false, q: code }))
        .users,
    ).toEqual([]);
  });
});
