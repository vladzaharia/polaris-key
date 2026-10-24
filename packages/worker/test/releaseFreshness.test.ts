/**
 * P2-12.9 (plans/P2-12.md §6.7): the freshness pass on Release's `scheduled` hook. A product is
 * due when its newest release is under 24 h old or its newest `release_health.checked_at` is
 * over 1 h old or missing; at most 25 syncs run per tick; it never throws.
 */

import { describe, expect, it, vi } from "vitest";
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
  dueBy,
  FRESHNESS_SYNCS_PER_INSTALLATION,
  FRESHNESS_SYNCS_PER_TICK,
  releaseFreshness,
} from "../src/services/release/freshness.js";
import { UpstreamRateLimitedError } from "../src/services/release/github.js";
import { releaseService } from "../src/services/release/index.js";
import type { Db } from "../src/db/types.js";
import { rateLimitOk } from "../src/core/rateLimit.js";
import { recordLimiterChecks } from "./rlMock.js";

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

/** Many products in one database, one GitHub stub; `inst(i)` picks each one's installation. */
async function fleet(n: number, inst: (i: number) => number) {
  const db = makeTestDb();
  const slugs: string[] = [];
  for (let i = 0; i < n; i++) {
    const slug = `p${String(i).padStart(2, "0")}`;
    slugs.push(slug);
    await seedReleaseProduct(db, { gh_installation_id: inst(i) }, slug);
  }
  const env = envFor({ kv: new KvMock() });
  const gh = github({ releases: [OLD] });
  const tick = async (now: number, fetchImpl = gh.fetchImpl) => {
    const out: Record<
      string,
      Awaited<ReturnType<typeof releaseFreshness>>
    > = {};
    for (const slug of slugs)
      out[slug] = await releaseFreshness(
        { env, db, now, product: { slug } },
        { fetchImpl },
      );
    return out;
  };
  return { db, env, slugs, gh, tick };
}

const count = (
  r: Record<string, { freshness: string }>,
  what: string,
): number => Object.values(r).filter((x) => x.freshness === what).length;

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

  it("does not let a published_at in the future keep a product due", async () => {
    expect(dueBy(T0 + 10 * DAY, T0 - 10, T0)).toBe(false);
    expect(dueBy(T0 + 10 * DAY, T0 - HOUR - 1, T0)).toBe(true);
    expect(dueBy(T0 - 100, T0 - 10, T0)).toBe(true);
    expect(dueBy(T0 - DAY, T0 - 10, T0)).toBe(false);
    expect(dueBy(null, null, T0)).toBe(true);
    const future = release("v9.0.0", [], {
      published_at: "2026-03-01T00:00:00Z",
    });
    const w = await world([future]);
    await releaseFreshness(w.ctx(T0), { fetchImpl: w.gh.fetchImpl });
    const next = await releaseFreshness(w.ctx(T0 + 900), {
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

  it("runs at most 25 syncs per tick across products; the rest are deferred and stay due", async () => {
    const f = await fleet(30, (i) => 100 + i);
    const first = await f.tick(T0);
    expect(count(first, "synced")).toBe(FRESHNESS_SYNCS_PER_TICK);
    expect(count(first, "deferred")).toBe(30 - FRESHNESS_SYNCS_PER_TICK);
    // The five deferred products are the ones never checked: the next tick takes them first.
    const second = await f.tick(T0 + 900);
    const synced = f.slugs.filter((s) => second[s]!.freshness === "synced");
    expect(synced).toEqual(
      f.slugs.filter((s) => first[s]!.freshness === "deferred"),
    );
  });

  it("gives one installation at most 8 syncs a tick, inside the global cap", async () => {
    const f = await fleet(12, () => 7);
    const r = await f.tick(T0);
    expect(count(r, "synced")).toBe(FRESHNESS_SYNCS_PER_INSTALLATION);
    expect(count(r, "deferred")).toBe(4);
  });

  it("serves the due product with the oldest check first", async () => {
    const f = await fleet(10, () => 7);
    for (const [i, slug] of f.slugs.entries())
      await f.db.run(
        `INSERT INTO release_health (product, subject_kind, subject_id, status, checked_at)
         VALUES (?, 'channel', 'stable', 'unknown', ?)`,
        slug,
        T0 - 2 * HOUR - i * 100,
      );
    const r = await f.tick(T0);
    // p00 and p01 were checked most recently: they wait.
    expect(f.slugs.filter((s) => r[s]!.freshness === "deferred")).toEqual([
      "p00",
      "p01",
    ]);
  });

  it("backs a failing product off so it cannot hold a slot, and tries it again", async () => {
    const f = await fleet(1, () => 7);
    const failing: FetchImpl = async () =>
      new Response("boom", { status: 500 });
    const first = await f.tick(T0, failing);
    expect(first.p00).toMatchObject({ freshness: "synced", failed: true });
    const second = await f.tick(T0 + 900);
    expect(second.p00).toMatchObject({ freshness: "deferred", backoff: true });
    const third = await f.tick(T0 + 1800);
    expect(third.p00!.freshness).toBe("synced");
    expect(third.p00!.failed).toBeUndefined();
    // A success clears the back-off.
    const fourth = await f.tick(T0 + 1800 + HOUR + 1);
    expect(fourth.p00!.freshness).toBe("synced");
  });

  it("isolates products: one product's failing sync does not stop another", async () => {
    const f = await fleet(2, (i) => 100 + i);
    const mixed: FetchImpl = async (input, init) =>
      String(input).includes("/installations/100/")
        ? new Response("boom", { status: 500 })
        : f.gh.fetchImpl(input, init);
    const r = await f.tick(T0, mixed);
    expect(r.p00!.failed).toBe(true);
    expect(r.p01!.failed).toBeUndefined();
    expect(r.p01!.statements).toBeGreaterThan(0);
  });

  it("reports a GitHub quota refusal as rateLimited, thrown or answered, and never throws", async () => {
    const thrown = await world([OLD]);
    const r1 = await releaseFreshness(thrown.ctx(T0), {
      fetchImpl: async (input) => {
        if (String(input).includes("/access_tokens"))
          return new Response(JSON.stringify({ token: "t" }), { status: 200 });
        throw new UpstreamRateLimitedError("github rate limited: 429", 60);
      },
    });
    expect(r1).toMatchObject({ rateLimited: true, failed: true });
    expect(await checkedAt(thrown.db)).toBeNull();

    const answered = await world([OLD]);
    const r2 = await releaseFreshness(answered.ctx(T0), {
      fetchImpl: async (input) =>
        String(input).includes("/access_tokens")
          ? new Response(JSON.stringify({ token: "t" }), { status: 200 })
          : new Response("slow down", {
              status: 429,
              headers: { "retry-after": "60" },
            }),
    });
    expect(r2).toMatchObject({ rateLimited: true, failed: true });
  });

  it("charges its GitHub calls to the product's upstream budget and stops when it is spent", async () => {
    const w = await world([OLD]);
    const checks = recordLimiterChecks(w.env);
    const ok = await releaseFreshness(w.ctx(T0), { fetchImpl: w.gh.fetchImpl });
    expect(ok.freshness).toBe("synced");
    const charges = checks.filter((c) => c.bucket === "releaseUpstream");
    expect(charges.length).toBeGreaterThan(0);
    for (const c of charges)
      expect(c).toMatchObject({ id: SLUG, limit: 4000, windowSec: 3600 });

    const spent = await world([OLD]);
    const bucket = {
      bucket: "releaseUpstream",
      id: SLUG,
      limit: 4000,
      windowSec: 3600,
    };
    for (let i = 0; i < bucket.limit; i++)
      await rateLimitOk(spent.env, SLUG, bucket, T0);
    let asked = 0;
    const counted: FetchImpl = async (input, init) => {
      asked += 1;
      return spent.gh.fetchImpl(input, init);
    };
    const r = await releaseFreshness(spent.ctx(T0), { fetchImpl: counted });
    expect(r).toMatchObject({ rateLimited: true, failed: true });
    expect(asked).toBe(0);
  });

  it("never throws on a broken database", async () => {
    const w = await world([OLD]);
    const broken = Object.assign(Object.create(w.db), {
      first: async () => {
        throw new Error("d1 down");
      },
      all: async () => {
        throw new Error("d1 down");
      },
    }) as Db;
    const r2 = await releaseFreshness(
      { env: w.env, db: broken, now: T0 + 12, product: { slug: SLUG } },
      { fetchImpl: w.gh.fetchImpl },
    );
    expect(r2.failed).toBe(true);
  });

  it("is wired into Release's scheduled hook, and a throwing sweep does not skip it", async () => {
    const w = await world([OLD]);
    vi.stubGlobal("fetch", w.gh.fetchImpl);
    try {
      const ctx = {
        env: w.env,
        db: w.db,
        now: T0 + 5000,
        product: { slug: SLUG } as never,
        hooks: {} as never,
      };
      const out = await releaseService.scheduled!(ctx);
      expect(out).toHaveProperty("nativeUploads");
      expect(out).toMatchObject({ freshness: "synced" });
      expect(await checkedAt(w.db)).toBe(T0 + 5000);

      // A sweep that throws fails the hook, but freshness has already run.
      const spy = Object.assign(Object.create(w.db), {
        all: async (sql: string, ...p: never[]) => {
          if (/native|prune|package/i.test(sql)) throw new Error("sweep");
          return w.db.all(sql, ...p);
        },
      }) as Db;
      await expect(
        releaseService.scheduled!({ ...ctx, db: spy, now: T0 + 9000 }),
      ).rejects.toThrow("sweep");
      expect(await checkedAt(w.db)).toBe(T0 + 9000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
