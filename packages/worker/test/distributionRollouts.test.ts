/**
 * P2b-04 — outlet-scoped rollouts and halts (`services/distribution/rollouts.ts`) through both
 * front doors: the CI routes (`pkeyci_` + the opt-in `distribution:rollout` scope) and the
 * console's admin API. One implementation, so the transition table, the mirrored-row refusal and
 * the audit are pinned once for each door.
 *
 * The `pkeyci_` lookup seam (`core/ciTokens.ts`) is mocked, as in the P2-05 policy suite.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(
  () =>
    new Map<
      string,
      { product: string; subject: string; scopes: readonly string[] }
    >(),
);
vi.mock("../src/core/ciTokens.js", () => ({
  lookupCiToken: async (_env: unknown, _db: unknown, token: string) =>
    tokens.get(token) ?? null,
}));

import { makeTestDb } from "./helpers.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { buildHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import { loadProduct } from "../src/core/products.js";
import {
  ROLLOUT_STATES,
  TRANSITIONS,
  type RolloutVerb,
} from "../src/services/distribution/rollouts.js";
import {
  auditRows,
  call,
  CONSOLE,
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";

const ROLLER = "pkeyci_roller";
const PROMOTER = "pkeyci_promoter";
const OTHER_PRODUCT = "pkeyci_other";

beforeEach(() => {
  tokens.clear();
  tokens.set(ROLLER, {
    product: SLUG,
    subject: "static:tok_1",
    scopes: ["distribution:rollout"],
  });
  // The default grant (P2-02) does NOT include `distribution:rollout`: it is opt-in.
  tokens.set(PROMOTER, {
    product: SLUG,
    subject: "repo:acme/djdl:environment:release",
    scopes: ["release:publish", "release:promote", "distribution:report"],
  });
  tokens.set(OTHER_PRODUCT, {
    product: "other",
    subject: "static:tok_3",
    scopes: ["distribution:rollout"],
  });
});

interface World {
  env: Env;
  db: Db;
  gh: ReturnType<typeof github>;
}

async function setup(): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const env = envFor();
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  // The implicit `direct` outlet (P2b-02) and a store outlet.
  for (const [id, kind] of [
    ["direct", "direct"],
    ["play", "play"],
  ] as const) {
    await db.run(
      `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
       VALUES (?, ?, ?, '{}', ?, ?)`,
      SLUG,
      id,
      kind,
      NOW,
      NOW,
    );
  }
  return { env, db, gh };
}

function ci(
  w: World,
  path: string,
  token: string | null,
  body: unknown = {},
): Promise<Response> {
  return call(
    w.env,
    w.db,
    w.gh.fetchImpl,
    `${CONSOLE}/${SLUG}/distribution/rollouts${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

async function admin(
  w: World,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/distribution${path}`;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    w.env,
    w.db,
    full,
    { now: NOW },
  );
}

async function rolloutRow(w: World, outlet = "direct", channel = "stable") {
  return w.db.first<{
    release_id: string;
    rollout_bp: number;
    rollout_salt: string;
    state: string;
    source: string;
    updated_by: string;
  }>(
    `SELECT release_id, rollout_bp, rollout_salt, state, source, updated_by FROM dist_rollouts
      WHERE product = ? AND deliverable_id = 'app' AND outlet_id = ? AND channel = ?`,
    SLUG,
    outlet,
    channel,
  );
}

async function setState(w: World, state: string): Promise<void> {
  await w.db.run(
    "UPDATE dist_rollouts SET state = ? WHERE product = ?",
    state,
    SLUG,
  );
}

describe("CI rollout routes: authentication and scope", () => {
  it("refuses a missing, unknown or other product's token with 401", async () => {
    const w = await setup();
    for (const token of [null, "ghs_not_ci", "pkeyci_unknown", OTHER_PRODUCT]) {
      const res = await ci(w, "/direct/stable", token, {
        releaseId: "v1.1.0",
        bp: 1000,
      });
      expect(res.status, String(token)).toBe(401);
    }
    expect(await rolloutRow(w)).toBeNull();
  });

  it("needs distribution:rollout: the default publishing grant is refused 403", async () => {
    const w = await setup();
    const res = await ci(w, "/direct/stable", PROMOTER, {
      releaseId: "v1.1.0",
      bp: 1000,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      reason: "missing_scope",
      scope: "distribution:rollout",
    });
    expect(await rolloutRow(w)).toBeNull();
  });

  it("answers only POST; any other method is the registry's not-found", async () => {
    const w = await setup();
    const res = await call(
      w.env,
      w.db,
      w.gh.fetchImpl,
      `${CONSOLE}/${SLUG}/distribution/rollouts/direct/stable`,
      { headers: { authorization: `Bearer ${ROLLER}` } },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found" } });
  });
});

describe("rollout semantics", () => {
  it("starts a rollout: active, a fresh 16-byte salt, the actor recorded and audited", async () => {
    const w = await setup();
    const res = await ci(w, "/direct/stable", ROLLER, {
      releaseId: "v1.1.0",
      bp: 2500,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      rollout: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.rollout).toMatchObject({
      deliverableId: "app",
      outletId: "direct",
      channel: "stable",
      releaseId: "v1.1.0",
      rolloutBp: 2500,
      state: "active",
      mirrored: false,
      source: "ci",
      startedAt: expect.any(Number),
      updatedBy: "ci:static:tok_1",
    });
    expect(body.rollout.rolloutSalt).toMatch(/^[0-9a-f]{32}$/);
    const audit = await auditRows(w.db);
    expect(audit.at(-1)).toMatchObject({
      action: "distribution.rollout.set",
      actor_sub: "ci:static:tok_1",
      target_id: "app:direct:stable",
    });
  });

  it("keeps the salt while the same release ramps, and draws a new one for a new release", async () => {
    const w = await setup();
    await ci(w, "/direct/stable", ROLLER, { releaseId: "v1.0.0", bp: 1000 });
    const first = (await rolloutRow(w))!;
    await ci(w, "/direct/stable", ROLLER, { releaseId: "v1.0.0", bp: 5000 });
    const ramped = (await rolloutRow(w))!;
    expect(ramped.rollout_bp).toBe(5000);
    expect(ramped.rollout_salt).toBe(first.rollout_salt);

    // A new release is a new rollout, whatever state the previous one was in.
    await ci(w, "/direct/stable/halt", ROLLER);
    await ci(w, "/direct/stable", ROLLER, { releaseId: "v1.1.0", bp: 100 });
    const next = (await rolloutRow(w))!;
    expect(next).toMatchObject({
      release_id: "v1.1.0",
      rollout_bp: 100,
      state: "active",
    });
    expect(next.rollout_salt).not.toBe(first.rollout_salt);
  });

  it("enforces the transition table for every verb from every state", async () => {
    const w = await setup();
    await ci(w, "/direct/stable", ROLLER, { releaseId: "v1.1.0", bp: 1000 });
    for (const verb of Object.keys(TRANSITIONS) as Exclude<
      RolloutVerb,
      "set"
    >[]) {
      for (const from of ROLLOUT_STATES) {
        await setState(w, from);
        const res = await ci(w, `/direct/stable/${verb}`, ROLLER);
        const allowed = TRANSITIONS[verb].from.includes(from);
        expect(res.status, `${verb} from ${from}`).toBe(allowed ? 200 : 409);
        const row = (await rolloutRow(w))!;
        if (allowed) {
          expect(row.state).toBe(TRANSITIONS[verb].to);
        } else {
          expect(row.state).toBe(from);
          expect(await res.json()).toMatchObject({
            reason: "invalid_transition",
          });
        }
      }
    }
    // The table itself, as the brief states it.
    expect(TRANSITIONS).toEqual({
      pause: { from: ["active"], to: "paused" },
      resume: { from: ["paused", "halted"], to: "active" },
      halt: { from: ["active", "paused"], to: "halted" },
      complete: { from: ["active"], to: "complete" },
    });
  });

  it("completes at 10000 basis points", async () => {
    const w = await setup();
    await ci(w, "/direct/stable", ROLLER, { releaseId: "v1.1.0", bp: 300 });
    const res = await ci(w, "/direct/stable/complete", ROLLER);
    expect(res.status).toBe(200);
    expect(await rolloutRow(w)).toMatchObject({
      state: "complete",
      rollout_bp: 10000,
    });
  });

  it("refuses a percentage change while halted or complete", async () => {
    const w = await setup();
    await ci(w, "/direct/stable", ROLLER, { releaseId: "v1.1.0", bp: 300 });
    for (const state of ["halted", "complete"]) {
      await setState(w, state);
      const res = await ci(w, "/direct/stable", ROLLER, {
        releaseId: "v1.1.0",
        bp: 900,
      });
      expect(res.status, state).toBe(409);
      expect((await rolloutRow(w))!.rollout_bp).toBe(300);
    }
  });

  it("refuses a verb naming a release other than the row's (stale_release)", async () => {
    const w = await setup();
    await ci(w, "/direct/stable", ROLLER, { releaseId: "v1.1.0", bp: 300 });
    const res = await ci(w, "/direct/stable/halt", ROLLER, {
      releaseId: "v1.0.0",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "stale_release" });
    expect((await rolloutRow(w))!.state).toBe("active");
  });

  it("validates the outlet, channel, release, percentage and that a rollout exists", async () => {
    const w = await setup();
    const cases: Array<[string, unknown, number, string]> = [
      [
        "/nowhere/stable",
        { releaseId: "v1.1.0", bp: 1 },
        404,
        "unknown_outlet",
      ],
      [
        "/direct/Not_A_Channel",
        { releaseId: "v1.1.0", bp: 1 },
        404,
        "unknown_channel",
      ],
      [
        "/direct/stable",
        { releaseId: "v9.9.9", bp: 1 },
        404,
        "unknown_release",
      ],
      [
        "/direct/stable",
        { releaseId: "v1.1.0", bp: 10001 },
        422,
        "invalid_body",
      ],
      ["/direct/stable", { releaseId: "v1.1.0", bp: 1.5 }, 422, "invalid_body"],
      ["/direct/stable", { bp: 1 }, 422, "invalid_body"],
      [
        "/direct/stable",
        { deliverable: "nope", releaseId: "v1.1.0", bp: 1 },
        404,
        "unknown_deliverable",
      ],
      ["/direct/stable/pause", {}, 404, "no_rollout"],
    ];
    for (const [path, body, status, reason] of cases) {
      const res = await ci(w, path, ROLLER, body);
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(status);
      expect(await res.json()).toMatchObject({ reason });
    }
    expect(await rolloutRow(w)).toBeNull();
  });

  it("keeps the reason on the console's 404s (A-9)", async () => {
    const w = await setup();
    const cases: Array<[string, unknown, string]> = [
      ["/nowhere/stable", { releaseId: "v1.1.0", bp: 1 }, "unknown_outlet"],
      [
        "/direct/Not_A_Channel",
        { releaseId: "v1.1.0", bp: 1 },
        "unknown_channel",
      ],
      ["/direct/stable", { releaseId: "v9.9.9", bp: 1 }, "unknown_release"],
      [
        "/direct/stable",
        { deliverable: "nope", releaseId: "v1.1.0", bp: 1 },
        "unknown_deliverable",
      ],
      ["/direct/stable/pause", {}, "no_rollout"],
    ];
    for (const [path, body, reason] of cases) {
      const res = await admin(w, "POST", `/rollouts${path}`, body);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toMatchObject({
        code: "not_found",
        reason,
      });
    }
    expect(await rolloutRow(w)).toBeNull();
  });

  it("refuses to roll out a yanked release", async () => {
    const w = await setup();
    await w.db.run(
      "INSERT INTO release_yanks (product, release_id, reason, at, by) VALUES (?, 'v1.1.0', 'broken', ?, 'admin:u1')",
      SLUG,
      NOW,
    );
    const res = await ci(w, "/direct/stable", ROLLER, {
      releaseId: "v1.1.0",
      bp: 100,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "release_yanked" });
  });

  it("refuses every direct edit of a mirrored row, from CI and from the console", async () => {
    const w = await setup();
    await w.db.run(
      `INSERT INTO dist_rollouts
         (product, deliverable_id, outlet_id, channel, release_id, rollout_bp, rollout_salt,
          state, mirrored, source, started_at, updated_at, updated_by)
       VALUES (?, 'app', 'play', 'stable', 'v1.1.0', 2000, ?, 'active', 1, 'play', ?, ?, 'play')`,
      SLUG,
      "ab".repeat(16),
      NOW,
      NOW,
    );
    for (const path of [
      "/play/stable",
      "/play/stable/pause",
      "/play/stable/halt",
      "/play/stable/complete",
    ]) {
      const viaCi = await ci(w, path, ROLLER, { releaseId: "v1.1.0", bp: 10 });
      expect(viaCi.status, path).toBe(409);
      expect(await viaCi.json()).toMatchObject({ reason: "rollout_mirrored" });
      const viaAdmin = await admin(w, "POST", `/rollouts${path}`, {
        releaseId: "v1.1.0",
        bp: 10,
      });
      expect(viaAdmin.status, path).toBe(409);
    }
    expect(await rolloutRow(w, "play")).toMatchObject({
      state: "active",
      rollout_bp: 2000,
      source: "play",
    });
    expect(
      (await auditRows(w.db)).filter((r) =>
        r.action.startsWith("distribution.rollout"),
      ),
    ).toEqual([]);
  });
});

describe("rollout controls in the console", () => {
  it("lists rollouts, and audits each verb with the session's subject", async () => {
    const w = await setup();
    const started = await admin(w, "POST", "/rollouts/direct/beta", {
      releaseId: "v1.1.0",
      bp: 5000,
    });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      rollout: { state: "active", source: "admin", updatedBy: "admin:u1" },
    });
    expect((await admin(w, "POST", "/rollouts/direct/beta/halt")).status).toBe(
      200,
    );
    expect(
      (await admin(w, "POST", "/rollouts/direct/beta/resume")).status,
    ).toBe(200);

    const list = await admin(w, "GET", "/rollouts");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      rollouts: Array<Record<string, unknown>>;
    };
    expect(body.rollouts).toEqual([
      expect.objectContaining({
        outletId: "direct",
        channel: "beta",
        state: "active",
      }),
    ]);
    // No implementation-status caveat rides along: the signed feed carries halts (P3-03).
    expect(body).not.toHaveProperty("effect");

    const actions = (await auditRows(w.db))
      .filter((r) => r.action.startsWith("distribution.rollout"))
      .map((r) => [r.action, r.actor_sub]);
    expect(actions).toEqual([
      ["distribution.rollout.set", "u1"],
      ["distribution.rollout.halt", "u1"],
      ["distribution.rollout.resume", "u1"],
    ]);
  });

  it("an invalid console transition is a 409 and writes nothing", async () => {
    const w = await setup();
    await admin(w, "POST", "/rollouts/direct/stable", {
      releaseId: "v1.1.0",
      bp: 100,
    });
    const res = await admin(w, "POST", "/rollouts/direct/stable/resume");
    expect(res.status).toBe(409);
    expect((await rolloutRow(w))!.state).toBe("active");
  });
});

describe("the delivery hook reads rollouts", () => {
  it("delivery.rollout() answers the row for one outlet's channel, or null", async () => {
    const w = await setup();
    await ci(w, "/direct/stable", ROLLER, { releaseId: "v1.1.0", bp: 4200 });
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    const delivery = buildHooks(SERVICES, product.services, {
      env: w.env,
      db: w.db,
      product,
      now: NOW,
    }).delivery()!;
    expect(
      await delivery.rollout({
        deliverable: "app",
        outlet: "direct",
        channel: "stable",
      }),
    ).toMatchObject({ releaseId: "v1.1.0", rolloutBp: 4200, state: "active" });
    expect(
      await delivery.rollout({
        deliverable: "app",
        outlet: "direct",
        channel: "beta",
      }),
    ).toBeNull();
  });
});
