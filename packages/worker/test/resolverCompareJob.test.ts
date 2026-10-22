/**
 * P2-12.7 (plans/P2-12.md §6.5): `update.resolver-compare`, the report-only P0-49 job that runs
 * every comparator probe through both update steps, one product at a time, with pacing.
 *
 * The world is the golden matrix's: a product synced from the fake GitHub through the real sync.
 * The job's GitHub fetch is the fake behind a wrapper that can answer 429, report a low quota or
 * throw the upstream-limit error, so the pacing is driven from outside.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW } from "./seed.js";
import { KvMock } from "./kvMock.js";
import { installDigestStream } from "./r2Mock.js";
import {
  envFor,
  github,
  release,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { syncReleaseStore } from "../src/services/release/sync.js";
import { UpstreamRateLimitedError } from "../src/services/release/github.js";
import type { Release, ReleaseAsset } from "../src/services/release/github.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import {
  COMPARE_ROW_CAP,
  RESOLVER_SWITCH_RULE,
  compareProbe,
  createResolverCompareJob,
  reportDetail,
  resolverCompareJob,
  type CompareRow,
  type ResolverClass,
} from "../src/services/update/resolverCompare.js";
import { loadProduct } from "../src/core/products.js";
import { getReleaseConfig } from "../src/services/release/config.js";
import { buildProbes } from "../src/services/update/resolverCompare.js";
import { apply, down, dryRun } from "../src/core/migrate/runner.js";
import type { MigrationContext } from "../src/core/migrate/job.js";
import { migrationJobs } from "../src/core/contributions.js";
import "../src/mount.js";

const ACTOR = { sub: "op", name: "Op", email: null };

function asset(id: number, name: string): ReleaseAsset {
  return {
    id,
    name,
    size: 1000 + id,
    content_type: "application/octet-stream",
    browser_download_url: `https://github.com/acme/djdl/releases/download/x/${name}`,
  };
}

function rel(tag: string, n: number, over: Partial<Release> = {}): Release {
  const v = tag.replace(/^v/, "");
  return release(
    tag,
    [
      asset(n * 10 + 1, `djdl-${v}-arm64.dmg`),
      asset(n * 10 + 2, `djdl-${v}-x86_64.dmg`),
      asset(n * 10 + 3, `djdl-arm64`),
    ],
    {
      published_at: `2026-01-${String(n).padStart(2, "0")}T03:04:05Z`,
      ...over,
    },
  );
}

/** How the wrapped GitHub misbehaves, switched from the tests. */
interface Mode {
  /** Answer 429 to every API call after this many have passed (-1: never). */
  limitAfter: number;
  /** An `x-ratelimit-remaining` header on every API answer. */
  remaining: string | null;
  /** Throw the upstream-limit error from a list read. */
  throwOnList: boolean;
  calls: number;
}

interface World {
  db: Db;
  env: Env;
  kv: KvMock;
  state: { releases: Release[] };
  mode: Mode;
  fetchImpl: FetchImpl;
  ctx: (at?: number) => MigrationContext;
}

async function world(
  releases: Release[],
  config: Record<string, unknown> = {},
): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db, config);
  const kv = new KvMock();
  const env = envFor({ kv });
  const state = { releases };
  const gh = github(state);
  const mode: Mode = {
    limitAfter: -1,
    remaining: null,
    throwOnList: false,
    calls: 0,
  };
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    if (new URL(url).hostname === "api.github.com") {
      mode.calls += 1;
      if (mode.throwOnList && /\/releases\?per_page/.test(url))
        throw new UpstreamRateLimitedError("budget", 30);
      if (mode.limitAfter >= 0 && mode.calls > mode.limitAfter)
        return new Response("slow down", {
          status: 429,
          headers: { "retry-after": "120" },
        });
    }
    const res = await gh.fetchImpl(input, init);
    if (mode.remaining === null) return res;
    const headers = new Headers(res.headers);
    headers.set("x-ratelimit-remaining", mode.remaining);
    return new Response(res.body, { status: res.status, headers });
  };
  await syncReleaseStore(env, db, SLUG, NOW, gh.fetchImpl);
  return {
    db,
    env,
    kv,
    state,
    mode,
    fetchImpl,
    ctx: (at = NOW) => ({ env, db, now: at }),
  };
}

const PLAIN = () => [
  rel("v1.3.0-beta.1", 4, { prerelease: true }),
  rel("v1.2.0", 3),
  rel("v1.1.0", 2),
  rel("v1.0.0", 1),
];

type Detail = {
  probes: number;
  compared: number;
  resumedFrom: number;
  counts: Partial<Record<ResolverClass, number>>;
  rows: Array<{ surface: string; probe: string; class: ResolverClass }>;
  truncated: number;
  paused?: { reason: string; until: number | null; unrun: number };
};

async function plan(
  w: World,
  job = createResolverCompareJob({ fetchImpl: w.fetchImpl }),
  at = NOW,
) {
  const p = await job.plan(w.ctx(at), SLUG);
  return { changes: p.changes, detail: p.detail as Detail };
}

beforeAll(() => installDigestStream());
afterAll(() => undefined);

describe("update.resolver-compare: shape", () => {
  it("is registered, report only, and names the switch rule", () => {
    const job = migrationJobs().find(
      (j) => j.id === "update.resolver-compare",
    )!;
    expect(job).toBe(resolverCompareJob);
    expect(job.delegatedTo).toBe(RESOLVER_SWITCH_RULE);
    expect(RESOLVER_SWITCH_RULE).toMatch(/switch rule/);
  });

  it("has a unit per product with a resolved release config", async () => {
    const w = await world(PLAIN());
    expect(await resolverCompareJob.units(w.ctx())).toEqual([SLUG]);
    await w.db.run(
      "UPDATE release_config SET gh_installation_id = NULL WHERE product = ?",
      SLUG,
    );
    expect(await resolverCompareJob.units(w.ctx())).toEqual([]);
  });
});

describe("update.resolver-compare: dry run and report", () => {
  it("compares every probe, reports class counts and changes nothing but the report", async () => {
    const w = await world([rel("v1.1.0", 2), rel("v1.0.0", 1)]);
    const job = createResolverCompareJob({ fetchImpl: w.fetchImpl });
    const tables = ["release_metadata", "release_config", "release_yanks"];
    const count = async () =>
      Promise.all(
        tables.map((t) =>
          w.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`),
        ),
      );
    const before = await count();
    const run = await dryRun(w.ctx(), job, ACTOR);
    expect(run.status).toBe("reported");
    expect(run.units.map((u) => u.unit)).toEqual([SLUG]);
    const u = run.units[0]!;
    const d = u.detail as Detail;
    expect(d.compared).toBe(d.probes);
    expect(d.paused).toBeUndefined();
    expect(d.counts.identical).toBeGreaterThan(0);
    // Only the acknowledged beta-includes-stable differences on a plain product.
    expect(Object.keys(d.counts).sort()).toEqual(
      ["beta-includes-stable", "identical"].sort(),
    );
    expect(d.rows.every((r) => r.class === "beta-includes-stable")).toBe(true);
    expect(u.planned).toBe(0);
    expect(run.changes).toBe(0);
    expect(await count()).toEqual(before);
    // The checkpoint of a finished unit is gone.
    expect(
      w.kv.keys().filter((k) => k.endsWith("resolver-compare:cursor")),
    ).toEqual([]);
  });

  it("carries a row as {surface, probe, old, new, class}", async () => {
    const w = await world([rel("v1.1.0", 2), rel("v1.0.0", 1)]);
    const { detail } = await plan(w);
    const row = detail.rows[0] as unknown as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ["class", "new", "old", "probe", "surface"].sort(),
    );
    expect(Object.keys(row.old as object)).toEqual(
      expect.arrayContaining([
        "status",
        "contentType",
        "cacheControl",
        "bodySha256",
      ]),
    );
  });

  it("caps the rows, worst first, while the counts still cover every row", () => {
    const outcome = {
      status: 200,
      contentType: "x",
      cacheControl: null,
      bodySha256: "a".repeat(64),
      version: "1.0.0",
    };
    const mk = (i: number, cls: ResolverClass): CompareRow => ({
      product: SLUG,
      surface: "version",
      probe: `p${i}`,
      old: outcome,
      new: outcome,
      class: cls,
    });
    const rows = [
      ...Array.from({ length: 100 }, (_, i) => mk(i, "beta-includes-stable")),
      mk(100, "unexpected"),
      mk(101, "identical"),
    ];
    const d = reportDetail(rows);
    expect(d.rows).toHaveLength(COMPARE_ROW_CAP);
    expect(d.rows[0]!.class).toBe("unexpected");
    expect(d.truncated).toBe(101 - COMPARE_ROW_CAP);
    expect(d.counts).toEqual({
      "beta-includes-stable": 100,
      unexpected: 1,
      identical: 1,
    });
    expect(d.rows[0]!.old.bodySha256).toBe("a".repeat(12));
  });
});

describe("update.resolver-compare: each class", () => {
  it("unexpected: a store row that disagrees with GitHub for no listed reason", async () => {
    const w = await world([rel("v1.1.0", 2), rel("v1.0.0", 1)]);
    await w.db.run(
      "UPDATE release_metadata SET published_at = published_at + 86400 WHERE product = ? AND release_id = 'v1.1.0'",
      SLUG,
    );
    const { changes, detail } = await plan(w);
    expect(detail.counts.unexpected).toBeGreaterThan(0);
    expect(detail.rows[0]!.class).toBe("unexpected");
    expect(changes).toBeGreaterThanOrEqual(detail.counts.unexpected!);
  });

  it("stale-store: GitHub published a release the store has not synced", async () => {
    const w = await world([rel("v1.0.0", 1)]);
    w.state.releases = [rel("v1.1.0", 2), rel("v1.0.0", 1)];
    const { changes, detail } = await plan(w);
    expect(detail.counts["stale-store"]).toBeGreaterThan(0);
    expect(changes).toBeGreaterThan(0);
  });

  it("beta-includes-stable and duplicate-version are expected: they do not count as changes", async () => {
    const w = await world([
      rel("v1.2.0", 3),
      rel("1.2.0", 4),
      rel("v1.1.0", 2),
    ]);
    const { changes, detail } = await plan(w);
    expect(detail.counts["beta-includes-stable"]).toBeGreaterThan(0);
    expect(detail.counts["duplicate-version"]).toBeGreaterThan(0);
    expect(detail.counts.unexpected ?? 0).toBe(0);
    expect(changes).toBe(0);
  });

  it("upstream-error: the legacy read is refused by the upstream limit", async () => {
    const w = await world(PLAIN());
    w.mode.throwOnList = true;
    const { changes, detail } = await plan(w);
    expect(detail.counts["upstream-error"]).toBe(1);
    // The row stops the product: the rest is unrun, and all of it blocks the switch.
    expect(detail.paused?.reason).toBe("upstream rate limited");
    expect(detail.paused!.unrun).toBeGreaterThan(0);
    expect(changes).toBe(1 + detail.paused!.unrun);
    expect(detail.rows[0]!.class).toBe("upstream-error");
  });
});

describe("update.resolver-compare: pull-request selectors", () => {
  const RUNS = /\/actions\/workflows\/ci\.yml\/runs\?event=pull_request/;

  it("probes pr-<n> for a workflow product from one runs call, once per unit", async () => {
    const w = await world(PLAIN(), { channel_workflow: "ci.yml" });
    const runs: string[] = [];
    const inner = w.fetchImpl;
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = String(input);
      if (RUNS.test(url)) {
        runs.push(url);
        return new Response(
          JSON.stringify({
            workflow_runs: [
              { pull_requests: [{ number: 7 }, { number: 9 }] },
              { pull_requests: [{ number: 7 }] },
              { pull_requests: [] },
            ],
          }),
          { status: 200 },
        );
      }
      return inner(input, init);
    };
    const plain = await world(PLAIN());
    const base = (await plan(plain)).detail.probes;
    const job = createResolverCompareJob({ fetchImpl });
    const { detail } = await plan(w, job);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("status=success&per_page=10");
    // Two pull requests add their selectors on every surface that probes a moving selector.
    expect(detail.probes).toBeGreaterThan(base);
    // Product without a workflow: no runs call at all.
    expect(
      (await plan(plain, createResolverCompareJob({ fetchImpl }))).detail
        .probes,
    ).toBe(base);
    expect(runs).toHaveLength(1);
  });
});

describe("update.resolver-compare: pacing", () => {
  it("pauses on a GitHub 429, holds still while paused, and resumes at the checkpoint", async () => {
    const w = await world(PLAIN());
    const baseline = await plan(await world(PLAIN()));
    w.mode.limitAfter = 3;
    const first = await plan(w);
    expect(first.detail.paused?.reason).toBe("github 429");
    expect(first.detail.paused!.unrun).toBeGreaterThan(0);
    expect(first.detail.compared).toBeLessThan(first.detail.probes);
    const until = first.detail.paused!.until!;
    expect(until).toBeGreaterThanOrEqual(NOW + 120);
    expect(w.kv.keys().some((k) => k.endsWith("resolver-compare:pause"))).toBe(
      true,
    );
    // The platform-wide marker is not a product-scoped key, so no product slug can share it.
    expect(w.kv.keys()).toContain("rc:resolver-compare:pause");
    expect(w.kv.keys().some((k) => k.endsWith("resolver-compare:cursor"))).toBe(
      true,
    );

    // Inside the pause nothing reaches GitHub.
    w.mode.limitAfter = -1;
    const calls = w.mode.calls;
    const during = await plan(w, undefined, NOW + 10);
    expect(w.mode.calls).toBe(calls);
    expect(during.detail.paused?.reason).toBe("github 429");
    expect(during.detail.compared).toBe(first.detail.compared);

    // After the pause it resumes where it stopped, and ends where an unbroken run does.
    const done = await plan(w, undefined, until + 1);
    expect(done.detail.paused).toBeUndefined();
    expect(done.detail.resumedFrom).toBeGreaterThan(0);
    expect(done.detail.counts).toEqual(baseline.detail.counts);
    expect(done.changes).toBe(0);
    expect(
      w.kv.keys().filter((k) => k.endsWith("resolver-compare:cursor")),
    ).toEqual([]);
  });

  it("pauses when x-ratelimit-remaining drops under 500", async () => {
    const w = await world(PLAIN());
    w.mode.remaining = "499";
    const { changes, detail } = await plan(w);
    expect(detail.paused?.reason).toBe("github x-ratelimit-remaining 499");
    expect(detail.compared).toBeLessThan(detail.probes);
    expect(changes).toBe(detail.paused!.unrun);
    // 500 is enough.
    const ok = await world(PLAIN());
    ok.mode.remaining = "500";
    expect((await plan(ok)).detail.paused).toBeUndefined();
  });

  it("resumes after a killed call from its last checkpoint", async () => {
    const w = await world(PLAIN());
    const baseline = await plan(await world(PLAIN()));
    const killed = createResolverCompareJob({
      fetchImpl: w.fetchImpl,
      onProbe: (_p, i) => {
        if (i === 24) throw new Error("killed");
      },
    });
    await expect(killed.plan(w.ctx(), SLUG)).rejects.toThrow("killed");
    const resumed = await plan(w);
    // Checkpoints every ten probes: 0-9, 10-19; the call died inside the third.
    expect(resumed.detail.resumedFrom).toBe(20);
    expect(resumed.detail.compared).toBe(resumed.detail.probes);
    expect(resumed.detail.counts).toEqual(baseline.detail.counts);
    expect(resumed.detail.rows).toEqual(baseline.detail.rows);
  });

  it("starts over when the probe list changed since the checkpoint", async () => {
    const w = await world(PLAIN());
    const killed = createResolverCompareJob({
      fetchImpl: w.fetchImpl,
      onProbe: (_p, i) => {
        if (i === 12) throw new Error("killed");
      },
    });
    await expect(killed.plan(w.ctx(), SLUG)).rejects.toThrow("killed");
    await w.db.run(
      "UPDATE release_config SET manual_channels_json = ? WHERE product = ?",
      JSON.stringify([{ name: "nightly", regex: "nightly" }]),
      SLUG,
    );
    expect((await plan(w)).detail.resumedFrom).toBe(0);
  });
});

describe("update.resolver-compare: the legacy resolution cache", () => {
  it("never reads or writes the real resolution cache, so a stale entry cannot skew a row", async () => {
    const w = await world([rel("v1.1.0", 2), rel("v1.0.0", 1)]);
    const cfg = (await getReleaseConfig(w.db, SLUG))!;
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    const probe = buildProbes({ channels: [], stableVersion: null }).find(
      (p) => p.surface === "version" && p.probe === "stable",
    )!;
    const ctx = {
      req: new Request(`https://key.plrs.im/${SLUG}/update/version`),
      env: w.env,
      db: w.db,
      product,
      cfg,
      origin: "https://key.plrs.im",
      now: NOW,
      fetchImpl: w.fetchImpl,
    };
    // Serving populates the real cache; a change that does not bump the generation leaves it stale.
    await compareProbe(w.db, cfg, probe, ctx);
    const cached = w.kv
      .keys()
      .filter((k) => k.includes(":release-resolution:"));
    expect(cached.length).toBeGreaterThan(0);
    for (const k of cached) await w.kv.put(k, JSON.stringify(rel("v0.5.0", 9)));
    const skewed = await compareProbe(w.db, cfg, probe, ctx);
    expect(skewed.old.version).toBe("0.5.0"); // the control: the real cache skews a probe
    expect(skewed.class).not.toBe("identical");

    const { detail } = await plan(w);
    expect(detail.counts["unexpected"] ?? 0).toBe(0);
    expect(detail.counts["stale-store"] ?? 0).toBe(0);
    // The job left the poisoned entries as it found them.
    for (const k of cached)
      expect(JSON.parse((await w.kv.get(k))!).tag_name).toBe("v0.5.0");
  });
});

describe("update.resolver-compare: delegated", () => {
  it("answers delegated to apply and down, and writes no apply row", async () => {
    const w = await world(PLAIN());
    const job = createResolverCompareJob({ fetchImpl: w.fetchImpl });
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(await apply(w.ctx(), job, ACTOR, report.id)).toEqual({
      ok: false,
      reason: "delegated",
    });
    expect(await down(w.ctx(), job, ACTOR, report.id)).toEqual({
      ok: false,
      reason: "delegated",
    });
    expect(
      await w.db.first(
        "SELECT id FROM data_migration_runs WHERE source_id = ?",
        report.id,
      ),
    ).toBeNull();
    await expect(job.apply(w.ctx(), SLUG)).rejects.toThrow("delegated");
    await expect(job.down(w.ctx(), SLUG)).rejects.toThrow("delegated");
  });
});
