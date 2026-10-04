/**
 * A-17a — the App Store Connect operation ledger, the before/after projection with redaction, the
 * audit rows (product trail and platform trail), and the budget meter (notes/S-14 §5.5, §7.3,
 * §7.4). Apple is a scripted fake: no live call is made.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { AdminSession } from "../src/admin/session.js";
import {
  ascOpId,
  beginAscOperation,
  getAscOperation,
  isAmbiguousFailure,
  listAscOperations,
  performAscWrite,
  type AscOpKey,
  type AscWriteStep,
} from "../src/core/asc/ledger.js";
import { projectAscResource } from "../src/core/asc/audit.js";
import {
  budgetAllows,
  pollBudget,
  readRate,
  recordTeamRate,
  TEAM_RATE_KEY,
  writeRate,
} from "../src/core/asc/budget.js";
import {
  AscError,
  AscWriteDenied,
  type AscResource,
} from "../src/core/asc/client.js";

const SESSION: AdminSession = {
  sub: "u1",
  name: "Ada",
  email: "ada@example.test",
  groups: ["admins"],
  csrf: "c",
  exp: NOW + 3600,
};

const TEAM_KEY: AscOpKey = {
  scope: "team",
  product: null,
  op: "bundle_id.register",
  naturalKey: "gg.acme.djdl",
  idempotencyKey: "0f8e2d3c-1111-4222-8333-944455556666",
};

const BUNDLE: AscResource = {
  type: "bundleIds",
  id: "HPA5436NK7",
  attributes: {
    identifier: "gg.acme.djdl",
    name: "djdl",
    platform: "IOS",
    seedId: "TEAM123",
  },
};

/** A scripted step: `find` answers from `state`, `write` creates (or throws `fail`). */
function step(
  over: Partial<AscWriteStep> & {
    state?: { existing: AscResource | null };
    fail?: unknown;
  } = {},
) {
  const state = over.state ?? { existing: null };
  const calls = { find: 0, write: 0, reread: 0 };
  const s: AscWriteStep = {
    key: TEAM_KEY,
    request: { identifier: "gg.acme.djdl", platform: "IOS" },
    session: SESSION,
    now: NOW,
    find: async () => {
      calls.find++;
      return state.existing;
    },
    write: async () => {
      calls.write++;
      if (over.fail) throw over.fail;
      state.existing = BUNDLE;
      return { type: "bundleIds", id: BUNDLE.id };
    },
    reread: async () => {
      calls.reread++;
      return BUNDLE;
    },
    resultIds: (r) => ({ bundleId: r.id }),
    summary: (r) => `Registered bundle id ${String(r.attributes?.identifier)}`,
    ...over,
  };
  return { s, calls, state };
}

async function platformRows(db: ReturnType<typeof makeTestDb>) {
  return db.all<{
    action: string;
    actor_sub: string;
    target_id: string;
    summary: string;
    before_json: string | null;
    after_json: string | null;
  }>("SELECT * FROM platform_audit ORDER BY at, id");
}

describe("performAscWrite", () => {
  it("pre-reads, writes, re-reads, projects before and after, and audits once (team scope)", async () => {
    const db = makeTestDb();
    const { s, calls } = step();
    const r = await performAscWrite(db, s);
    expect(r).toMatchObject({
      outcome: "written",
      resultIds: { bundleId: "HPA5436NK7" },
      before: null,
      after: {
        type: "bundleIds",
        id: "HPA5436NK7",
        attributes: { identifier: "gg.acme.djdl", platform: "IOS" },
      },
    });
    expect(calls).toEqual({ find: 1, write: 1, reread: 1 });
    const row = await getAscOperation(db, await ascOpId(TEAM_KEY));
    expect(row).toMatchObject({
      scope: "team",
      product: null,
      op: "bundle_id.register",
      state: "done",
      actor: "u1",
      result_ids_json: '{"bundleId":"HPA5436NK7"}',
    });
    const audits = await platformRows(db);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "platform.asc.bundle_id.register",
      actor_sub: "u1",
      target_id: "HPA5436NK7",
    });
    expect(audits[0]!.summary).toMatch(
      /^Registered bundle id gg\.acme\.djdl \[op [0-9a-f]{12}\]$/,
    );
    expect(JSON.parse(audits[0]!.after_json!)).toMatchObject({
      id: "HPA5436NK7",
    });
  });

  it("a replay of a done operation answers the stored row without calling Apple", async () => {
    const db = makeTestDb();
    await performAscWrite(db, step().s);
    const { s, calls } = step();
    const r = await performAscWrite(db, s);
    expect(r.outcome).toBe("replayed");
    expect(calls).toEqual({ find: 0, write: 0, reread: 0 });
    expect(await platformRows(db)).toHaveLength(1);
  });

  it("the same key with a different body is a conflict", async () => {
    const db = makeTestDb();
    await performAscWrite(db, step().s);
    const { s, calls } = step({ request: { identifier: "gg.acme.other" } });
    expect((await performAscWrite(db, s)).outcome).toBe("conflict");
    expect(calls.write).toBe(0);
  });

  it("an object that already exists is found, not created, and not audited", async () => {
    const db = makeTestDb();
    const { s, calls } = step({ state: { existing: BUNDLE } });
    const r = await performAscWrite(db, s);
    expect(r).toMatchObject({
      outcome: "existing",
      resultIds: { bundleId: "HPA5436NK7" },
    });
    expect(calls.write).toBe(0);
    expect(await platformRows(db)).toEqual([]);
  });

  it("Apple's 409 for a duplicate is re-checked and read as already existing (A-17h)", async () => {
    const db = makeTestDb();
    const state = { existing: null as AscResource | null };
    const { s } = step({
      state,
      write: async () => {
        state.existing = BUNDLE; // someone else created it meanwhile
        throw new AscError(
          409,
          "POST",
          "/v1/bundleIds",
          "ENTITY_ERROR.ATTRIBUTE.INVALID",
        );
      },
    });
    expect((await performAscWrite(db, s)).outcome).toBe("existing");
    expect((await getAscOperation(db, await ascOpId(TEAM_KEY)))!.state).toBe(
      "done",
    );
  });

  it("a 5xx after the write is ambiguous; the retry re-reads first and finds it", async () => {
    const db = makeTestDb();
    const state = { existing: null as AscResource | null };
    const first = step({
      state,
      write: async () => {
        state.existing = BUNDLE; // it DID land
        throw new AscError(503, "POST", "/v1/bundleIds");
      },
    });
    await expect(performAscWrite(db, first.s)).rejects.toBeInstanceOf(AscError);
    const row = await getAscOperation(db, await ascOpId(TEAM_KEY));
    expect(row).toMatchObject({ state: "ambiguous", apple_status: 503 });
    const retry = step({ state });
    expect((await performAscWrite(db, retry.s)).outcome).toBe("existing");
    expect(retry.calls).toMatchObject({ find: 1, write: 0 });
  });

  it("Apple's refusal is failed with its status and code token, never its body; a retry may run", async () => {
    const db = makeTestDb();
    const { s } = step({
      fail: new AscError(
        422,
        "POST",
        "/v1/bundleIds",
        "ENTITY_ERROR.ATTRIBUTE.INVALID",
      ),
    });
    await expect(performAscWrite(db, s)).rejects.toBeInstanceOf(AscError);
    expect(await getAscOperation(db, await ascOpId(TEAM_KEY))).toMatchObject({
      state: "failed",
      apple_status: 422,
      apple_code: "ENTITY_ERROR.ATTRIBUTE.INVALID",
      before_json: null,
      after_json: null,
    });
    const retry = step();
    expect((await performAscWrite(db, retry.s)).outcome).toBe("written");
  });

  it("a gate refusal is recorded failed and re-thrown", async () => {
    const db = makeTestDb();
    const { s } = step({
      fail: new AscWriteDenied("POST", "/v1/certificates", "not_allowed"),
    });
    await expect(performAscWrite(db, s)).rejects.toBeInstanceOf(AscWriteDenied);
    expect((await getAscOperation(db, await ascOpId(TEAM_KEY)))!.state).toBe(
      "failed",
    );
  });

  it("a failed pre-read leaves the row pending (nothing reached Apple)", async () => {
    const db = makeTestDb();
    const { s } = step({
      find: async () => {
        throw new AscError(500, "GET", "/v1/bundleIds");
      },
    });
    await expect(performAscWrite(db, s)).rejects.toBeInstanceOf(AscError);
    expect((await getAscOperation(db, await ascOpId(TEAM_KEY)))!.state).toBe(
      "pending",
    );
    const again = await beginAscOperation(db, TEAM_KEY, s.request, "u1", NOW);
    expect(again).toMatchObject({ kind: "proceed", resumed: true });
  });

  it("product scope writes the product's audit trail and keeps before/after on the ledger", async () => {
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    const key: AscOpKey = {
      scope: "product",
      product: "djdl",
      op: "beta_group.create",
      naturalKey: "External testers",
      idempotencyKey: "1f8e2d3c-1111-4222-8333-944455556666",
    };
    const group: AscResource = {
      type: "betaGroups",
      id: "bg-1",
      attributes: { name: "External testers", isInternalGroup: false },
    };
    const r = await performAscWrite(db, {
      ...step().s,
      key,
      write: async () => group,
      reread: async () => group,
      resultIds: (x) => ({ betaGroup: x.id }),
      summary: () => "Created TestFlight group External testers",
    });
    expect(r.outcome).toBe("written");
    const rows = await db.all<{
      action: string;
      actor_sub: string;
      target_id: string;
    }>("SELECT action, actor_sub, target_id FROM audit WHERE product = 'djdl'");
    expect(rows).toEqual([
      {
        action: "distribution.asc.beta_group.create",
        actor_sub: "u1",
        target_id: "bg-1",
      },
    ]);
    expect(await platformRows(db)).toEqual([]);
    const listed = await listAscOperations(db, {
      scope: "product",
      product: "djdl",
    });
    expect(listed.map((x) => x.op)).toEqual(["beta_group.create"]);
    expect(JSON.parse(listed[0]!.after_json!)).toEqual({
      type: "betaGroups",
      id: "bg-1",
      attributes: { name: "External testers", isInternalGroup: false },
    });
    expect(
      await listAscOperations(db, { scope: "product", product: "other" }),
    ).toEqual([]);
  });

  it("refuses a key whose product does not match its scope, or a bad Idempotency-Key", async () => {
    const db = makeTestDb();
    await expect(
      beginAscOperation(db, { ...TEAM_KEY, product: "djdl" }, {}, "u1", NOW),
    ).rejects.toThrow("scope");
    await expect(
      beginAscOperation(
        db,
        { ...TEAM_KEY, idempotencyKey: "x" },
        {},
        "u1",
        NOW,
      ),
    ).rejects.toThrow("Idempotency-Key");
    // Testers' emails are never stored: an email-shaped natural key is refused, nothing written.
    await expect(
      beginAscOperation(
        db,
        {
          ...TEAM_KEY,
          op: "beta_tester.invite",
          naturalKey: "ada@example.test",
        },
        {},
        "u1",
        NOW,
      ),
    ).rejects.toThrow("email");
    expect(
      await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM asc_operations"),
    ).toEqual({ n: 0 });
    await expect(
      db.run(
        `INSERT INTO asc_operations (op_id, scope, product, op, natural_key, state, request_hash, actor, created_at)
         VALUES ('o', 'product', NULL, 'x', 'k', 'pending', 'h', 'u', 0)`,
      ),
    ).rejects.toThrow();
  });

  it("the request hash ignores key order", async () => {
    const db = makeTestDb();
    await beginAscOperation(
      db,
      TEAM_KEY,
      { a: 1, b: { c: 2, d: 3 } },
      "u1",
      NOW,
    );
    const again = await beginAscOperation(
      db,
      TEAM_KEY,
      { b: { d: 3, c: 2 }, a: 1 },
      "u1",
      NOW,
    );
    expect(again.kind).toBe("proceed");
  });
});

describe("isAmbiguousFailure", () => {
  it("5xx and network failures may have landed; 4xx and gate refusals did not", () => {
    expect(isAmbiguousFailure(new AscError(502, "POST", "/v1/x"))).toBe(true);
    expect(isAmbiguousFailure(new TypeError("network"))).toBe(true);
    expect(isAmbiguousFailure(new AscError(409, "POST", "/v1/x"))).toBe(false);
    expect(
      isAmbiguousFailure(new AscWriteDenied("POST", "/v1/x", "not_allowed")),
    ).toBe(false);
  });
});

describe("projection and redaction", () => {
  it("keeps only the type's allow-listed attributes", () => {
    expect(
      projectAscResource({
        type: "webhooks",
        id: "wh-1",
        attributes: {
          name: "n",
          url: "https://h/x",
          secret: "s3cr3t",
          enabled: true,
        },
      }),
    ).toEqual({
      type: "webhooks",
      id: "wh-1",
      attributes: { name: "n", url: "https://h/x", enabled: true },
    });
  });

  it("never stores tester emails or names, review contacts or demo passwords", () => {
    const tester = projectAscResource({
      type: "betaTesters",
      id: "t1",
      attributes: {
        email: "player@example.test",
        firstName: "P",
        lastName: "Q",
        inviteType: "EMAIL",
        state: "INVITED",
      },
    });
    expect(JSON.stringify(tester)).not.toMatch(/example\.test|"P"|"Q"/);
    const review = projectAscResource({
      type: "appStoreReviewDetails",
      id: "r1",
      attributes: {
        contactEmail: "a@b.c",
        contactPhone: "+1",
        demoAccountPassword: "hunter2",
      },
    });
    expect(review).toEqual({
      type: "appStoreReviewDetails",
      id: "r1",
      attributes: {},
    });
  });

  it("bounds strings and drops nested values", () => {
    const p = projectAscResource({
      type: "apps",
      id: "1",
      attributes: { name: "x".repeat(1000), bundleId: { nested: true } },
    });
    expect((p!.attributes.name as string).length).toBe(300);
    expect(p!.attributes).not.toHaveProperty("bundleId");
    expect(projectAscResource(null)).toBeNull();
  });
});

describe("the budget meter", () => {
  it("the team key has one platform-wide slot, shared by every product and the listing", async () => {
    const kv = new KvMock();
    const env = makeEnv(kv, []);
    await recordTeamRate(env, { limit: 3600, remaining: 3000 }, NOW);
    expect(kv.keys()).toEqual([TEAM_RATE_KEY]);
    for (const product of ["djdl", "other"])
      expect(
        await readRate(env, product, { source: "platform" }, NOW + 60),
      ).toMatchObject({
        limit: 3600,
        remaining: 3000,
      });
    // A product's own key is its own budget.
    expect(
      await readRate(
        env,
        "djdl",
        { source: "product", credentialId: "asc" },
        NOW,
      ),
    ).toBeNull();
    await writeRate(
      env,
      "djdl",
      { source: "product", credentialId: "asc" },
      { limit: 3600, remaining: 10 },
      NOW,
    );
    expect(
      await readRate(env, "other", { source: "platform" }, NOW),
    ).toMatchObject({
      remaining: 3000,
    });
    // An observation older than the rolling hour says nothing.
    expect(
      await readRate(env, "djdl", { source: "platform" }, NOW + 3601),
    ).toBeNull();
  });

  it("operators are never refused; background work yields to the poller first", () => {
    const full = { limit: 3600, remaining: 3000 };
    const low = { limit: 3600, remaining: 400 };
    const empty = { limit: 3600, remaining: 50 };
    expect([full, low, empty].map((r) => budgetAllows(r, "operator"))).toEqual([
      true,
      true,
      true,
    ]);
    expect([full, low, empty].map((r) => budgetAllows(r, "poll"))).toEqual([
      true,
      true,
      false,
    ]);
    expect(
      [full, low, empty].map((r) => budgetAllows(r, "background")),
    ).toEqual([true, false, false]);
    expect(budgetAllows(null, "background")).toBe(true);
    expect(pollBudget(low)).toBe("reduced");
  });
});
