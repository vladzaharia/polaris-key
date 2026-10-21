// P6-02 — the platform-admin trust-policy resource (`console/handlers/trustPolicy.ts`):
// `GET|PUT|DELETE /manage/api/products/<slug>/trust-policy`. Platform admins only, validated
// field by field (an invalid body writes nothing), every write audited, and `source` tracking who
// owns the row (`default` until an admin sets it).

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import { CONSOLE, envFor } from "./releaseRoutesFixture.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import {
  DEFAULT_TRUST_POLICY,
  parseTrustPolicy,
} from "../src/core/trust/deviceTrust.js";
import { loadProduct } from "../src/core/products.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";

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
  opts: {
    body?: unknown;
    groups?: string[];
    path?: string;
    stepUp?: boolean;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { token, session } = await issueSession(
    w.env,
    {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: opts.groups ?? ["platform-admins"],
      ...(opts.stepUp ? { authTime: NOW, stepUp: true } : {}),
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

const GUARD = (expectedVersion: number) => ({
  expectedVersion,
  reason: "Moving to a new Apple team",
  confirm: "core.trustPolicy",
});

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
    const r = await call(w, "DELETE", { stepUp: true, body: GUARD(1) });
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
        JSON.stringify({
          ...POLICY,
          cloudSyncWrite: "basic",
          laterOp: "attested",
        }),
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

// ST-12: the guarded write path. A tightening change is L1 (the area is enough); a relaxing one is
// L2 (a fresh step-up, expectedVersion, a reason and the typed key). A version that moved is 409.
describe("guarded writes", () => {
  const RELAXED = { ...POLICY, enforce: false };

  it("GET answers the version to send back; a tightening PUT bumps it and needs no step-up", async () => {
    const w = await world();
    expect((await call(w, "GET")).body.version).toBe(0);
    const put = await call(w, "PUT", {
      body: { policy: POLICY, expectedVersion: 0 },
    });
    expect(put.status).toBe(200);
    expect((await call(w, "GET")).body.version).toBe(1);
  });

  it("a relaxing PUT is refused without a step-up, a version, a reason or the typed key, and writes nothing", async () => {
    const w = await world();
    await call(w, "PUT", { body: POLICY });
    const before = await stored(w.db);
    const g = GUARD(1);
    const noStep = await call(w, "PUT", {
      body: { policy: RELAXED, ...g },
    });
    expect(noStep.status).toBe(403);
    expect(noStep.body.code).toBe("step_up_required");
    for (const [drop, reason] of [
      ["expectedVersion", "expected_version_required"],
      ["reason", "reason_required"],
      ["confirm", "confirm_required"],
    ] as const) {
      const body = { policy: RELAXED, ...g } as Record<string, unknown>;
      delete body[drop];
      const r = await call(w, "PUT", { body, stepUp: true });
      expect(r.status, drop).toBe(400);
      expect(r.body.reason, drop).toBe(reason);
    }
    const wrong = await call(w, "PUT", {
      body: { policy: RELAXED, ...g, confirm: "yes" },
      stepUp: true,
    });
    expect(wrong.body.reason).toBe("confirm_required");
    expect(await stored(w.db)).toEqual(before);
    expect(await audits(w.db)).toEqual(["trust_policy.set"]);
  });

  it("a relaxing PUT with the whole guard writes, audits and records the reason", async () => {
    const w = await world();
    await call(w, "PUT", { body: POLICY });
    const r = await call(w, "PUT", {
      body: { policy: RELAXED, ...GUARD(1) },
      stepUp: true,
    });
    expect(r.status).toBe(200);
    expect(JSON.parse((await stored(w.db))!.trust_policy_json!).enforce).toBe(
      false,
    );
    expect(await audits(w.db)).toEqual([
      "trust_policy.set",
      "trust_policy.set",
    ]);
    const row = await w.db.first<{ reason: string | null }>(
      "SELECT reason FROM audit WHERE action = 'trust_policy.set' ORDER BY at DESC, rowid DESC",
    );
    expect(row?.reason).toBe("Moving to a new Apple team");
  });

  it("every relaxing shape is caught, and tightening shapes are not", async () => {
    const { relaxesTrustPolicy } =
      await import("../src/core/trust/deviceTrust.js");
    const P = parseTrustPolicy(JSON.stringify(POLICY));
    const relaxing = [
      { ...P, mint: "basic" },
      { ...P, enforce: false },
      { ...P, appAttest: null },
      { ...P, appAttest: { teamId: "ZZZZZ99999", environment: "development" } },
      { ...P, appAttest: { teamId: "ABCDE12345", environment: "development" } },
      { ...P, playIntegrity: null },
      { ...P, playIntegrity: { cloudProjectNumber: "999" } },
      {
        ...P,
        playIntegrity: {
          cloudProjectNumber: "123456789012",
          allowTestingResponses: true,
        },
      },
      DEFAULT_TRUST_POLICY,
    ] as const;
    // `development` is the fixture's own environment, so lift it to production to compare.
    const prod = {
      ...P,
      appAttest: { teamId: "ABCDE12345", environment: "production" },
    } as typeof P;
    for (const after of relaxing) {
      const base = after === relaxing[4] ? prod : P;
      expect(relaxesTrustPolicy(base, after as typeof P)).toBe(true);
    }
    expect(relaxesTrustPolicy(P, P)).toBe(false);
    expect(relaxesTrustPolicy(DEFAULT_TRUST_POLICY, P)).toBe(false);
    expect(relaxesTrustPolicy(P, { ...P, gatedDelivery: "attested" })).toBe(
      false,
    );
    expect(relaxesTrustPolicy(P, prod)).toBe(false);
  });

  it("DELETE of a non-default policy is L2; of the default it is not", async () => {
    const w = await world();
    expect((await call(w, "DELETE")).status).toBe(200);
    await call(w, "PUT", { body: POLICY });
    const bare = await call(w, "DELETE", { stepUp: true });
    expect(bare.status).toBe(400);
    expect(bare.body.reason).toBe("expected_version_required");
    const noStep = await call(w, "DELETE", { body: GUARD(1) });
    expect(noStep.body.code).toBe("step_up_required");
  });

  it("a version that moved is a 409 version_conflict and writes nothing", async () => {
    const w = await world();
    await call(w, "PUT", { body: POLICY });
    await call(w, "PUT", {
      body: { policy: { ...POLICY, mint: "basic" }, ...GUARD(1) },
      stepUp: true,
    });
    const stale = await call(w, "PUT", {
      body: { policy: POLICY, expectedVersion: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.reason).toBe("version_conflict");
    expect(JSON.parse((await stored(w.db))!.trust_policy_json!).mint).toBe(
      "basic",
    );
  });

  it("a member without the keys area cannot write, even with the whole guard", async () => {
    const w = await world();
    const r = await call(w, "PUT", {
      body: { policy: POLICY, expectedVersion: 0 },
      groups: ["someone-else"],
      stepUp: true,
    });
    expect(r.status).toBe(403);
    expect(await audits(w.db)).toEqual([]);
  });
});
