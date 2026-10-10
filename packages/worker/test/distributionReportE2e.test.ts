/**
 * P2b-03 — `pkey distribution report` and `pkey distribution rollout|halt|resume` end to end
 * against the real Worker: the CLI's `reportDistribution` and `driveRollout` run unmodified with a
 * `fetchImpl` that hands every request to the Worker's dispatcher, and the test asserts the rows
 * the Worker wrote and what the CLI made of the answers.
 *
 * The `pkeyci_` lookup (`lookupCiToken` in `core/publisher.ts`) is mocked, as in the rollout and availability
 * suites; the token exchange itself is P2-06's (`publishE2e.test.ts`). A static token is what CI
 * that is not GitHub Actions uses, through `PKEY_CI_TOKEN`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(
  () =>
    new Map<
      string,
      { product: string; subject: string; scopes: readonly string[] }
    >(),
);
vi.mock("../src/core/publisher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/publisher.js")>()),
  lookupCiToken: async (_env: unknown, _db: unknown, token: string) =>
    tokens.get(token) ?? null,
}));

import { driveRollout, reportDistribution } from "@polaris-key/cli";
import { makeTestDb } from "./helpers.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { dispatch } from "../src/dispatch.js";
import {
  CONSOLE,
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";

const REPORTER = `pkeyci_${"R".repeat(43)}`;
const ROLLER = `pkeyci_${"O".repeat(43)}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  tokens.clear();
  // The default grant: it reports, but cannot roll out.
  tokens.set(REPORTER, {
    product: SLUG,
    subject: "static:tok_report",
    scopes: ["release:publish", "release:promote", "distribution:report"],
  });
  tokens.set(ROLLER, {
    product: SLUG,
    subject: "static:tok_roll",
    scopes: ["distribution:rollout"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

interface World {
  env: Env;
  db: Db;
}

async function setup(): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const env = envFor();
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  for (const [id, kind] of [
    ["direct", "direct"],
    ["app-store", "app-store"],
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
  return { env, db };
}

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
    out: () => out,
    err: () => err,
  };
}

/** The CLI's options, pointed at the Worker under test. */
function cli(w: World, token: string) {
  const io = capture();
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => dispatch(new Request(input, init), w.env, w.db)) as typeof fetch;
  return {
    io,
    opts: {
      product: SLUG,
      baseUrl: CONSOLE,
      env: { PKEY_CI_TOKEN: token },
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl,
      sleep: async () => {},
    },
  };
}

describe("pkey distribution report, end to end", () => {
  it("records availability and a submission through the real route", async () => {
    const w = await setup();
    const { io, opts } = cli(w, REPORTER);
    const r = await reportDistribution({
      ...opts,
      type: "availability",
      outlet: "app-store",
      version: "1.1.0",
      buildId: "cli-arm64",
      state: "in-review",
      platformRef: '{"ascBuildId":"abc-123"}',
    });
    expect(r.ok).toBe(true);
    expect(io.out()).toContain(
      "Reported availability of v1.1.0/cli-arm64 on app-store: in-review",
    );
    expect(
      await w.db.first(
        "SELECT release_id, build_id, outlet_id, state, platform_ref_json, source FROM dist_availability WHERE product = ?",
        SLUG,
      ),
    ).toEqual({
      release_id: "v1.1.0",
      build_id: "cli-arm64",
      outlet_id: "app-store",
      state: "in-review",
      platform_ref_json: '{"ascBuildId":"abc-123"}',
      source: "ci",
    });

    await reportDistribution({
      ...opts,
      type: "submission",
      outlet: "app-store",
      releaseId: "v1.1.0",
      state: "submitted",
    });
    expect(
      await w.db.first(
        "SELECT state, submitted_at FROM dist_submissions WHERE product = ?",
        SLUG,
      ),
    ).toEqual({ state: "submitted", submitted_at: NOW });
    const audit = await w.db.all<{ action: string; actor_sub: string }>(
      "SELECT action, actor_sub FROM audit WHERE product = ? ORDER BY rowid",
      SLUG,
    );
    expect(audit).toEqual([
      {
        action: "distribution.availability.report",
        actor_sub: "ci:static:tok_report",
      },
      {
        action: "distribution.submission.report",
        actor_sub: "ci:static:tok_report",
      },
    ]);
  });

  it("a refusal fails the command with the Worker's reason and writes nothing", async () => {
    const w = await setup();
    const { opts } = cli(w, REPORTER);
    await expect(
      reportDistribution({
        ...opts,
        type: "availability",
        outlet: "steam",
        releaseId: "v1.1.0",
        state: "live",
      }),
    ).rejects.toThrow(/404 unknown_outlet/);
    await expect(
      reportDistribution({
        ...opts,
        type: "availability",
        outlet: "app-store",
        releaseId: "v1.1.0",
        state: "shipped",
      }),
    ).rejects.toThrow(/422 invalid_state/);
    expect(
      await w.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM dist_availability",
      ),
    ).toEqual({ n: 0 });
  });

  it("a key report outside the inventory is flagged, and the inventory is untouched", async () => {
    const w = await setup();
    await w.db.run(
      `INSERT INTO dist_keys
         (product, purpose, fingerprint_sha256, source, created_at, modified_at)
       VALUES (?, 'release', ?, 'admin', ?, ?)`,
      SLUG,
      "a".repeat(64),
      NOW,
      NOW,
    );
    const { io, opts } = cli(w, REPORTER);
    const r = await reportDistribution({
      ...opts,
      type: "key",
      purpose: "release",
      sha256: "BB:".repeat(31) + "BB",
    });
    expect(r.ok).toBe(false);
    expect(io.err()).toContain("NOT in the product's key inventory");
    expect(
      await w.db.all(
        "SELECT fingerprint_sha256, source FROM dist_keys WHERE product = ? ORDER BY source",
        SLUG,
      ),
    ).toEqual([
      { fingerprint_sha256: "a".repeat(64), source: "admin" },
      { fingerprint_sha256: "b".repeat(64), source: "ci" },
    ]);
  });
});

describe("pkey distribution rollout, halt and resume, end to end", () => {
  it("drive P2b-04's CI rollout routes", async () => {
    const w = await setup();
    const { io, opts } = cli(w, ROLLER);
    const row = () =>
      w.db.first<{ release_id: string; rollout_bp: number; state: string }>(
        `SELECT release_id, rollout_bp, state FROM dist_rollouts
          WHERE product = ? AND outlet_id = 'direct' AND channel = 'stable'`,
        SLUG,
      );
    await driveRollout({
      ...opts,
      command: "rollout",
      outlet: "direct",
      channel: "stable",
      releaseId: "v1.1.0",
      bp: "2500",
    });
    expect(await row()).toEqual({
      release_id: "v1.1.0",
      rollout_bp: 2500,
      state: "active",
    });
    await driveRollout({
      ...opts,
      command: "halt",
      outlet: "direct",
      channel: "stable",
      releaseId: "v1.1.0",
    });
    expect((await row())!.state).toBe("halted");
    await driveRollout({
      ...opts,
      command: "resume",
      outlet: "direct",
      channel: "stable",
    });
    expect((await row())!.state).toBe("active");
    expect(io.out()).toContain("app v1.1.0 on direct/stable: active at 25%");
    const audit = await w.db.all<{ action: string; actor_sub: string }>(
      "SELECT action, actor_sub FROM audit WHERE product = ? ORDER BY rowid",
      SLUG,
    );
    expect(audit.map((a) => a.action)).toEqual([
      "distribution.rollout.set",
      "distribution.rollout.halt",
      "distribution.rollout.resume",
    ]);
    expect(new Set(audit.map((a) => a.actor_sub))).toEqual(
      new Set(["ci:static:tok_roll"]),
    );
  });

  it("a token without distribution:rollout is refused and changes nothing", async () => {
    const w = await setup();
    const { opts } = cli(w, REPORTER);
    await expect(
      driveRollout({
        ...opts,
        command: "rollout",
        outlet: "direct",
        channel: "stable",
        releaseId: "v1.1.0",
        bp: "1000",
      }),
    ).rejects.toThrow(/403 missing_scope/);
    await expect(
      driveRollout({
        ...opts,
        command: "halt",
        outlet: "direct",
        channel: "stable",
      }),
    ).rejects.toThrow(/403 missing_scope/);
    expect(
      await w.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM dist_rollouts",
      ),
    ).toEqual({ n: 0 });
  });
});
