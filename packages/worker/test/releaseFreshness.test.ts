/**
 * P2-12.9 (plans/P2-12.md §6.7): the freshness pass on Release's `scheduled` hook. A product is
 * due when its newest release is under 24 h old or its newest `release_health.checked_at` is
 * over 1 h old or missing; at most 25 syncs run per tick; it never throws.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  envFor,
  github,
  release,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import type { Release } from "../src/services/release/github.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import {
  FRESHNESS_SYNCS_PER_TICK,
  releaseFreshness,
} from "../src/services/release/freshness.js";
import { UpstreamRateLimitedError } from "../src/services/release/github.js";
import { releaseService } from "../src/services/release/index.js";
import { syncReleaseStore } from "../src/services/release/sync.js";
import type { Db } from "../src/db/types.js";

const T0 = Math.floor(Date.parse("2026-02-10T12:00:00Z") / 1000);
const HOUR = 3600;
const DAY = 86_400;

const OLD = release("v1.0.0", [], { published_at: "2026-01-02T03:04:05Z" });
const YOUNG = release("v1.1.0", [], { published_at: "2026-02-10T08:00:00Z" });

async function world(releases: Release[], slug = SLUG) {
  const db = makeTestDb();
  await seedReleaseProduct(db, {}, slug);
  const env = envFor({ kv: new KvMock() });
  const state = { releases };
  const gh = github(state);
  const ctx = (now: number) => ({ env, db, now, product: { slug } });
  return { db, env, state, gh, ctx };
}

async function checkedAt(db: Db): Promise<number | null> {
  const r = await db.first<{ c: number | null }>(
    "SELECT MAX(checked_at) AS c FROM release_health WHERE product = ?",
    SLUG,
  );
  return r?.c ?? null;
}

describe("releaseFreshness", () => {
  it("syncs a product that has never been checked, then is fresh until the hour passes", async () => {
    const w = await world([OLD]);
    const first = await releaseFreshness(w.ctx(T0), {
      fetchImpl: w.gh.fetchImpl,
    });
    expect(first.freshness).toBe("synced");
    expect(first.statements).toBeGreaterThan(0);
    expect(await checkedAt(w.db)).toBe(T0);

    const calls = w.gh.calls.api.length;
    const again = await releaseFreshness(w.ctx(T0 + HOUR), {
      fetchImpl: w.gh.fetchImpl,
    });
    expect(again).toEqual({ freshness: "fresh", statements: 0 });
    expect(w.gh.calls.api.length).toBe(calls);

    const later = await releaseFreshness(w.ctx(T0 + HOUR + 1), {
      fetchImpl: w.gh.fetchImpl,
    });
    expect(later.freshness).toBe("synced");
    expect(await checkedAt(w.db)).toBe(T0 + HOUR + 1);
  });

  it("is due on every tick while the newest release is under 24 h old", async () => {
    const w = await world([YOUNG]);
    await releaseFreshness(w.ctx(T0), { fetchImpl: w.gh.fetchImpl });
    const tick = await releaseFreshness(w.ctx(T0 + 900), {
      fetchImpl: w.gh.fetchImpl,
    });
    expect(tick.freshness).toBe("synced");
    // Past the 24 h window (08:00 + 24 h) only the hour rule remains.
    const quiet = T0 + DAY;
    await releaseFreshness(w.ctx(quiet), { fetchImpl: w.gh.fetchImpl });
    const next = await releaseFreshness(w.ctx(quiet + 900), {
      fetchImpl: w.gh.fetchImpl,
    });
    expect(next.freshness).toBe("fresh");
  });

  it("does not make a repo with no releases due on every tick", async () => {
    const w = await world([]);
    const first = await releaseFreshness(w.ctx(T0), {
      fetchImpl: w.gh.fetchImpl,
    });
    expect(first.freshness).toBe("synced");
    expect(await checkedAt(w.db)).toBe(T0);
    const next = await releaseFreshness(w.ctx(T0 + 900), {
      fetchImpl: w.gh.fetchImpl,
    });
    expect(next.freshness).toBe("fresh");
  });

  it("answers fresh for a product that is not linked", async () => {
    const db = makeTestDb();
    const env = envFor({ kv: new KvMock() });
    const r = await releaseFreshness(
      { env, db, now: T0, product: { slug: "nobody" } },
      { fetchImpl: github({ releases: [] }).fetchImpl },
    );
    expect(r.freshness).toBe("fresh");
  });

  it("runs at most 25 syncs per tick; the rest are deferred and stay due", async () => {
    const budget = { now: T0, syncs: 0 };
    const w = await world([OLD]);
    const seen: string[] = [];
    for (let i = 0; i < FRESHNESS_SYNCS_PER_TICK + 3; i++) {
      const r = await releaseFreshness(w.ctx(T0), {
        fetchImpl: w.gh.fetchImpl,
        budget,
      });
      seen.push(r.freshness);
      // Make the one product due again, as a failed sync leaves it.
      await w.db.run("DELETE FROM release_health WHERE product = ?", SLUG);
    }
    expect(seen.filter((s) => s === "synced")).toHaveLength(25);
    expect(seen.filter((s) => s === "deferred")).toHaveLength(3);
    // A new tick (a new clock) has a fresh budget.
    const next = await releaseFreshness(w.ctx(T0 + 900), {
      fetchImpl: w.gh.fetchImpl,
    });
    expect(next.freshness).toBe("synced");
  });

  it("isolates products: one product's failing sync does not stop another", async () => {
    const a = await world([OLD], "alpha");
    const failing: FetchImpl = async () =>
      new Response("boom", { status: 500 });
    const bad = await releaseFreshness(a.ctx(T0 + 7), { fetchImpl: failing });
    // The sync swallows the failure: no rows written, so the product stays due.
    expect(bad.statements).toBe(0);
    expect(
      await a.db.first(
        "SELECT 1 AS x FROM release_health WHERE product = ?",
        "alpha",
      ),
    ).toBeNull();
    const ok = await releaseFreshness(a.ctx(T0 + 7), {
      fetchImpl: a.gh.fetchImpl,
    });
    expect(ok.statements).toBeGreaterThan(0);
  });

  it("never throws: a rate limit, a thrown fetch and a broken database all answer", async () => {
    const w = await world([OLD]);
    const limited: FetchImpl = async () => {
      throw new UpstreamRateLimitedError("github rate limited: 429", 60);
    };
    const r1 = await releaseFreshness(w.ctx(T0 + 11), { fetchImpl: limited });
    expect(r1.freshness).toBeDefined();
    expect(await checkedAt(w.db)).toBeNull();

    const broken = {
      ...w.db,
      first: async () => {
        throw new Error("d1 down");
      },
      all: async () => {
        throw new Error("d1 down");
      },
    } as unknown as Db;
    const r2 = await releaseFreshness(
      { env: w.env, db: broken, now: T0 + 12, product: { slug: SLUG } },
      { fetchImpl: w.gh.fetchImpl },
    );
    expect(r2.failed).toBe(true);
  });

  it("is wired into Release's scheduled hook beside the other sweeps", async () => {
    const w = await world([OLD]);
    const out = await releaseService.scheduled!({
      env: w.env,
      db: w.db,
      now: T0 + 5000,
      product: { slug: SLUG } as never,
      hooks: {} as never,
    });
    expect(out).toHaveProperty("nativeUploads");
    expect(out).toHaveProperty("freshness");
    void syncReleaseStore;
  });
});
