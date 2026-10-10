// P6-02 — the platform-admin trust-policy resource (`admin/handlers/trustPolicy.ts`):
// `GET|PUT|DELETE /manage/api/products/<slug>/trust-policy`. Platform admins only, validated
// field by field (an invalid body writes nothing), every write audited, and `source` tracking who
// owns the row (`default` until an admin sets it).

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import { CONSOLE, envFor } from "./releaseRoutesFixture.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import {
  DEFAULT_TRUST_POLICY,
  parseTrustPolicy,
} from "../src/core/deviceTrust.js";
import { loadProduct } from "../src/core/products.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";

const SLUG = "djdl";

async function world(): Promise<{ db: Db; env: Env }> {
  const db = makeTestDb();
  const env = envFor();
  await seedProduct(db, SLUG);
  return { db, env };
}

async function call(
  w: { db: Db; env: Env },
  method: string,
  opts: { body?: unknown; groups?: string[]; path?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { token, session } = await issueSession(
    w.env,
    {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: opts.groups ?? ["platform-admins"],
    },
    NOW,
  );
  const full = `/api/products/${SLUG}/trust-policy${opts.path ?? ""}`;
  const res = await handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    w.env,
    w.db,
    full,
    { now: NOW },
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function stored(db: Db) {
  return db.first<{
    trust_policy_json: string | null;
    trust_policy_source: string;
  }>(
    "SELECT trust_policy_json, trust_policy_source FROM products WHERE slug = ?",
    SLUG,
  );
}

async function audits(db: Db): Promise<string[]> {
  return (
    await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE action LIKE 'trust_policy.%' ORDER BY at, rowid",
    )
  ).map((r) => r.action);
}

const POLICY = {
  mint: "attested",
  gatedDelivery: "basic",
  commerceClaim: "attested",
  enforce: true,
  appAttest: { teamId: "ABCDE12345", environment: "development" },
  playIntegrity: { cloudProjectNumber: "123456789012" },
};

describe("trust-policy admin resource", () => {
  it("refuses a session outside the platform-admin group on every method", async () => {
    const w = await world();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const r = await call(w, method, {
        groups: ["someone-else"],
        ...(method === "PUT" ? { body: POLICY } : {}),
      });
      expect(r.status, method).toBe(403);
    }
    expect(await stored(w.db)).toEqual({
      trust_policy_json: null,
      trust_policy_source: "default",
    });
    expect(await audits(w.db)).toEqual([]);
  });

  it("GET answers the default policy before anything is set", async () => {
    const w = await world();
    const r = await call(w, "GET");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      policy: DEFAULT_TRUST_POLICY,
      source: "default",
    });
  });

  it("PUT persists the policy with source admin, audits it, and the product loads it", async () => {
    const w = await world();
    const r = await call(w, "PUT", { body: POLICY });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ policy: POLICY, source: "admin" });
    const row = await stored(w.db);
    expect(row?.trust_policy_source).toBe("admin");
    expect(JSON.parse(row!.trust_policy_json!)).toEqual(POLICY);
    expect(await audits(w.db)).toEqual(["trust_policy.set"]);
    expect((await call(w, "GET")).body).toMatchObject({
      policy: POLICY,
      source: "admin",
    });
    expect((await loadProduct(w.env, w.db, SLUG))!.trustPolicy).toEqual(POLICY);
  });

  it("an unknown member or a malformed teamId is 400 and writes nothing", async () => {
    const w = await world();
    for (const body of [
      { ...POLICY, surprise: true },
      { ...POLICY, appAttest: { teamId: "abc", environment: "production" } },
      { ...POLICY, mint: "trusted" },
      { ...POLICY, playIntegrity: { cloudProjectNumber: "12ab" } },
      {
        ...POLICY,
        playIntegrity: {
          cloudProjectNumber: "1",
          allowTestingResponses: "yes",
        },
      },
    ]) {
      const r = await call(w, "PUT", { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(await stored(w.db)).toEqual({
      trust_policy_json: null,
      trust_policy_source: "default",
    });
    expect(await audits(w.db)).toEqual([]);
  });

  it("DELETE returns to the default with source default, audited", async () => {
    const w = await world();
    await call(w, "PUT", { body: POLICY });
    const r = await call(w, "DELETE");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      policy: DEFAULT_TRUST_POLICY,
      source: "default",
    });
    expect(await stored(w.db)).toEqual({
      trust_policy_json: null,
      trust_policy_source: "default",
    });
    expect(await audits(w.db)).toEqual([
      "trust_policy.set",
      "trust_policy.reset",
    ]);
  });

  it("405 on another method, 404 on a sub-path", async () => {
    const w = await world();
    expect((await call(w, "POST", { body: POLICY })).status).toBe(405);
    expect((await call(w, "GET", { path: "/extra" })).status).toBe(404);
  });
});

// The expand step for the trust-policy column (plans/U-01b.md §6.1): a policy a later build stored
// with an operation this build does not know still reads with its other members, while the PUT
// stays strict.
describe("stored policies from a later build", () => {
  const LATER = { mint: "attested", enforce: true, cloudSyncWrite: "attested" };

  it("parse with the unknown operation dropped and every other member kept", () => {
    expect(parseTrustPolicy(JSON.stringify(LATER))).toEqual({
      ...DEFAULT_TRUST_POLICY,
      mint: "attested",
      enforce: true,
    });
    expect(
      parseTrustPolicy(
        JSON.stringify({ ...POLICY, cloudSyncWrite: "basic", laterOp: "attested" }),
      ),
    ).toEqual(POLICY);
  });

  it("load that way from the products row", async () => {
    const w = await world();
    await w.db.run(
      "UPDATE products SET trust_policy_json = ?, trust_policy_source = 'admin' WHERE slug = ?",
      JSON.stringify(LATER),
      SLUG,
    );
    expect((await loadProduct(w.env, w.db, SLUG))!.trustPolicy).toMatchObject({
      mint: "attested",
      enforce: true,
    });
  });

  it("are still refused by the PUT", async () => {
    const w = await world();
    const r = await call(w, "PUT", { body: LATER });
    expect(r.status).toBe(400);
    expect(await stored(w.db)).toEqual({
      trust_policy_json: null,
      trust_policy_source: "default",
    });
  });

  it("read as the default when an unknown member is not a trust level (negative control)", () => {
    expect(
      parseTrustPolicy(
        JSON.stringify({ mint: "attested", enforce: true, laterOp: "strict" }),
      ),
    ).toEqual(DEFAULT_TRUST_POLICY);
    expect(
      parseTrustPolicy(JSON.stringify({ mint: "attested", extra: { a: 1 } })),
    ).toEqual(DEFAULT_TRUST_POLICY);
    // A known operation with a bad value is not rescued either.
    expect(
      parseTrustPolicy(JSON.stringify({ mint: "strict", enforce: true })),
    ).toEqual(DEFAULT_TRUST_POLICY);
  });
});
