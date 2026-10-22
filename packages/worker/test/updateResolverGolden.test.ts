/**
 * P2-12.4 (plans/P2-12.md §6.3, §6.5): the golden test for the two Update compute steps.
 *
 * The legacy step (GitHub, per request) and the store step (the truth store in GitHub's shape)
 * are run on the same synthetic probe against one world: a product synced from the fake GitHub
 * through the real sync (`syncReleaseStore`), the fixtures of `releaseRoutesFixture.ts`. The
 * probes are the comparator's own (`buildProbes`). For every case here the two answers are byte
 * equal (status, content-type, cache-control, body SHA-256), or the comparator names the class
 * the plan lists for the difference. Nothing is routed.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW } from "./seed.js";
import {
  envFor,
  github,
  release,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { loadProduct } from "../src/core/products.js";
import { syncReleaseStore } from "../src/services/release/sync.js";
import { storeReleaseByTag } from "../src/services/release/storeRelease.js";
import { yankRelease } from "../src/services/release/model.js";
import { getReleaseConfig } from "../src/services/release/config.js";
import type { Release, ReleaseAsset } from "../src/services/release/github.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import {
  buildDownloadProbes,
  buildProbes,
  compareProbe,
  probeChannels,
  RESOLVER_CLASSES,
  EXPECTED_CLASSES,
  BLOCKING_CLASSES,
  type CompareRow,
  type Probe,
  type ResolverClass,
} from "../src/services/update/resolverCompare.js";

function asset(id: number, name: string): ReleaseAsset {
  return {
    id,
    name,
    size: 1000 + id,
    content_type: "application/octet-stream",
    browser_download_url: `https://github.com/acme/djdl/releases/download/x/${name}`,
  };
}

/** A release with a DMG per architecture (ids derived from `n`). */
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

interface World {
  db: Db;
  env: Env;
  state: { releases: Release[] };
  fetchImpl: FetchImpl;
  resync: () => Promise<void>;
  probes: (extra?: string[]) => Promise<Probe[]>;
  run: (probes: Probe[]) => Promise<CompareRow[]>;
  /** GitHub answers 429 to a list read while set (the sync is unaffected once it has run). */
  flags: { limited: boolean };
}

async function world(
  releases: Release[],
  cfg: Record<string, unknown> = {},
  runs?: () => unknown,
): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db, cfg);
  const env = envFor();
  const state = { releases };
  const gh = github(state);
  const flags = { limited: false };
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    if (/\/releases\?per_page=\d+(&page=\d+)?$/.test(url)) {
      if (flags.limited) return new Response("slow down", { status: 429 });
      // Paged like GitHub: 100 a page with `Link: rel="next"`.
      const page = Number(/&page=(\d+)/.exec(url)?.[1] ?? 1);
      const slice = state.releases.slice((page - 1) * 100, page * 100);
      const more = page * 100 < state.releases.length;
      return new Response(JSON.stringify(slice), {
        status: 200,
        headers: more
          ? {
              Link: `<https://api.github.com/repos/acme/djdl/releases?per_page=100&page=${page + 1}>; rel="next"`,
            }
          : {},
      });
    }
    if (runs && /\/actions\/workflows\/[^/]+\/runs\?/.test(url))
      return new Response(JSON.stringify(runs()), { status: 200 });
    return gh.fetchImpl(input, init);
  };
  const resync = async (): Promise<void> => {
    await syncReleaseStore(env, db, SLUG, NOW, fetchImpl);
  };
  await resync();
  const stable = () =>
    state.releases
      .filter((r) => !r.prerelease)
      .map((r) => r.tag_name.replace(/^v/, ""))
      .sort()
      .pop();
  return {
    db,
    env,
    state,
    fetchImpl,
    flags,
    resync,
    probes: async (extra = []) => {
      const c = (await getReleaseConfig(db, SLUG))!;
      return buildProbes({
        channels: await probeChannels(db, c, extra),
        stableVersion: stable() ?? null,
      });
    },
    run: async (probes) => {
      const c = (await getReleaseConfig(db, SLUG))!;
      const product = (await loadProduct(env, db, SLUG))!;
      const ctx = {
        req: new Request(`https://key.example.test/${SLUG}/update/version`),
        env,
        db,
        product,
        cfg: c,
        origin: "https://key.example.test",
        now: NOW,
        fetchImpl,
      };
      const rows: CompareRow[] = [];
      for (const p of probes) rows.push(await compareProbe(db, c, p, ctx));
      return rows;
    },
  };
}

const classes = (rows: CompareRow[]): Record<string, ResolverClass> =>
  Object.fromEntries(rows.map((r) => [`${r.surface} ${r.probe}`, r.class]));

/** The only difference a stable-only world has: the store's beta includes stable (D6). */
const onlyBetaIncludesStable = (rows: CompareRow[]): void => {
  const diff = nonIdentical(rows);
  expect(Object.keys(diff).sort()).toEqual(
    Object.keys(diff)
      .filter((k) => /\b(beta|staging)$/.test(k))
      .sort(),
  );
  expect(new Set(Object.values(diff))).toEqual(
    new Set(Object.keys(diff).length ? ["beta-includes-stable"] : []),
  );
};

const nonIdentical = (rows: CompareRow[]) =>
  Object.fromEntries(
    Object.entries(classes(rows)).filter(([, c]) => c !== "identical"),
  );

describe("the class registry", () => {
  it("names the plan's classes and partitions them", () => {
    for (const c of [...EXPECTED_CLASSES, ...BLOCKING_CLASSES])
      expect(RESOLVER_CLASSES).toContain(c);
    expect(RESOLVER_CLASSES).toEqual(
      expect.arrayContaining([
        "identical",
        "beta-includes-stable",
        "workflow-channel",
        "beyond-page-cap",
        "duplicate-version",
        "descriptor-channel",
        "descriptor-files",
        "stale-store",
        "unexpected",
        "upstream-error",
        "beta-workflow-floor",
        "beta-yanked-floor-fallback",
      ]),
    );
  });
});

describe("the probe list", () => {
  it("covers the appcast arches, every selector and the pinned stable bare and as v", () => {
    const probes = buildProbes({
      channels: ["beta", "staging", "nightly"],
      stableVersion: "1.2.0",
    });
    const names = probes.map((p) => `${p.surface} ${p.probe}`);
    expect(names).toEqual([
      "appcast stable",
      "appcast stable?arch=arm64",
      "appcast stable?arch=x86_64",
      "channelAppcast beta",
      "channelAppcast staging",
      "channelAppcast nightly",
      "version (omitted)",
      "version latest",
      "version stable",
      "version beta",
      "version staging",
      "version nightly",
      "version 1.2.0",
      "version v1.2.0",
    ]);
  });
});

describe("the /release/dl probes (P2-12.5)", () => {
  it("compare identical, or as beta-includes-stable on the beta selectors", async () => {
    const w = await world([
      rel("v1.3.0-beta.1", 4, { prerelease: true }),
      rel("v1.2.0", 3),
      rel("v1.1.0", 2),
    ]);
    const c = (await getReleaseConfig(w.db, SLUG))!;
    const rows = await w.run(
      buildDownloadProbes({
        channels: await probeChannels(w.db, c),
        stableVersion: "1.2.0",
      }),
    );
    expect(rows.length).toBe(4 * 8);
    // A real release id, asset name and size on both sides, or a matching refusal.
    for (const r of rows) {
      expect(r.surface).toBe("download");
      if (r.class === "identical") expect(r.new).toEqual(r.old);
    }
    const diff = nonIdentical(rows);
    for (const [k, cls] of Object.entries(diff)) {
      expect(k).toMatch(/^download (beta|staging)\//);
      expect(cls).toBe("beta-includes-stable");
    }
  });
});

describe("store step equals legacy step", () => {
  it("is byte-identical for every probe of a plain product", async () => {
    const w = await world([
      rel("v1.3.0-beta.1", 4, { prerelease: true }),
      rel("v1.2.0", 3),
      rel("v1.1.0", 2),
      rel("v1.0.0", 1),
    ]);
    const rows = await w.run(await w.probes());
    expect(nonIdentical(rows)).toEqual({});
    // The probes are real answers, not a pair of 404s.
    const ok = rows.filter((r) => r.old.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(9);
    for (const r of rows) {
      expect(r.new).toEqual(r.old);
    }
    const byName = Object.fromEntries(
      rows.map((r) => [`${r.surface} ${r.probe}`, r]),
    );
    expect(byName["version beta"]!.old.version).toBe("1.3.0-beta.1");
    expect(byName["appcast stable?arch=x86_64"]!.old.status).toBe(200);
    // `staging` is the legacy spelling of beta.
    expect(byName["version staging"]!.old.version).toBe("1.3.0-beta.1");
    // A `v`-prefixed pin is no selector on either step.
    expect(byName["version v1.2.0"]!.old.status).toBe(404);
  });

  it("is identical with manual channels, a yank and a pinned promote", async () => {
    const w = await world(
      [
        rel("v2.0.0", 5),
        rel("v1.2.0", 3),
        rel("v1.1.0", 2),
        rel("nightly-0001", 4, { prerelease: true }),
      ],
      {
        manual_channels_json: JSON.stringify([
          { name: "nightly", regex: "^nightly-[0-9]+$" },
        ]),
      },
    );
    await yankRelease(w.db, SLUG, "v2.0.0", "bad", "t", NOW);
    const rows = await w.run(await w.probes());
    // The legacy beta wants a prerelease; the store's beta also takes the newest stable.
    onlyBetaIncludesStable(rows);
    const stable = rows.find(
      (r) => r.surface === "version" && r.probe === "stable",
    )!;
    expect(stable.old.version).toBe("1.2.0");
    const nightly = rows.find(
      (r) => r.surface === "version" && r.probe === "nightly",
    )!;
    expect(nightly.old.status).toBe(200);
  });
});

describe("a difference is classified", () => {
  it("beta-includes-stable: the legacy beta wants a prerelease, the store's beta includes stable", async () => {
    const w = await world([
      rel("v1.3.0", 4),
      rel("v1.3.0-beta.1", 3, { prerelease: true }),
      rel("v1.2.0", 2),
    ]);
    const rows = await w.run(await w.probes());
    expect(classes(rows)["version beta"]).toBe("beta-includes-stable");
    expect(classes(rows)["channelAppcast beta"]).toBe("beta-includes-stable");
    // Nothing else differs.
    expect(Object.keys(nonIdentical(rows)).sort()).toEqual([
      "channelAppcast beta",
      "channelAppcast staging",
      "version beta",
      "version staging",
    ]);
  });

  it("stale-store: GitHub published a release the store has not synced", async () => {
    const w = await world([rel("v1.0.0", 1)]);
    w.state.releases = [rel("v1.1.0", 2), rel("v1.0.0", 1)];
    const rows = await w.run(await w.probes());
    expect(classes(rows)["version stable"]).toBe("stale-store");
    expect(classes(rows)["appcast stable"]).toBe("stale-store");
    await w.resync();
    onlyBetaIncludesStable(await w.run(await w.probes()));
  });

  it("descriptor-channel: the descriptor's channel wins over GitHub's prerelease flag", async () => {
    const w = await world([
      rel("v1.2.0", 3),
      rel("v1.3.0-rc.1", 4, { prerelease: true }),
    ]);
    // A described release that GitHub flags as a prerelease but whose descriptor says stable.
    await w.db.run(
      `UPDATE release_metadata
          SET channel = 'stable',
              metadata_json = json_set(metadata_json, '$.descriptor.status', 'ingested')
        WHERE product = ? AND release_id = 'v1.3.0-rc.1'`,
      SLUG,
    );
    const rows = await w.run(await w.probes());
    expect(classes(rows)["version stable"]).toBe("descriptor-channel");
  });

  it("descriptor-files: a described release holds a file GitHub does not list", async () => {
    const w = await world([rel("v1.2.0", 3), rel("v1.3.0", 4)]);
    await w.db.run(
      `UPDATE release_metadata
          SET metadata_json = json_set(metadata_json, '$.descriptor.status', 'ingested')
        WHERE product = ? AND release_id = 'v1.3.0'`,
      SLUG,
    );
    await w.db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, access, created_at, build_id, size_bytes)
       VALUES (?, 'v1.3.0', 'file:app.zip', 'app.zip', 'public', ?, 'zip', 5)`,
      SLUG,
      NOW,
    );
    // The DMG is removed from the legacy side only, so the two answers differ.
    w.state.releases = [
      rel("v1.2.0", 3),
      rel("v1.3.0", 4, { assets: [asset(43, "djdl-arm64")] }),
    ];
    const rows = await w.run(await w.probes());
    expect(classes(rows)["appcast stable"]).toBe("descriptor-files");
  });

  it("workflow-channel: a channel-workflow product's beta is the workflow's tags", async () => {
    const w = await world(
      [rel("abc1234", 4, { prerelease: true }), rel("v1.2.0", 3)],
      { channel_workflow: "beta.yml" },
      () => ({
        workflow_runs: [{ head_branch: null, head_sha: "abc1234ffffffff" }],
      }),
    );
    const rows = await w.run(await w.probes());
    expect(classes(rows)["version beta"]).toBe("workflow-channel");
  });

  it("beta-workflow-floor: the store floors a workflow product's beta, the live route never does", async () => {
    const w = await world(
      [rel("abc1234", 4, { prerelease: true }), rel("v1.2.0", 3)],
      { channel_workflow: "beta.yml" },
      () => ({
        workflow_runs: [{ head_branch: null, head_sha: "abc1234ffffffff" }],
      }),
    );
    // A recorded beta floor above everything the store would offer on beta.
    await w.db.run(
      `INSERT OR REPLACE INTO release_channel_floors (product, channel, version, release_id, raised_at)
       VALUES (?, 'beta', '9.0.0', 'v9.0.0', ?)`,
      SLUG,
      NOW,
    );
    const rows = await w.run(await w.probes());
    expect(classes(rows)["version beta"]).toBe("beta-workflow-floor");
  });

  it("beta-yanked-floor-fallback: a yanked beta floor falls back by store membership", async () => {
    const w = await world([
      rel("v1.3.0-beta.2", 5, { prerelease: true }),
      rel("v1.2.0", 4),
      rel("v1.1.0-beta.1", 3, { prerelease: true }),
    ]);
    await w.db.run(
      `INSERT OR REPLACE INTO release_channel_floors (product, channel, version, release_id, raised_at)
       VALUES (?, 'beta', '1.3.0-beta.2', 'v1.3.0-beta.2', ?)`,
      SLUG,
      NOW,
    );
    await yankRelease(w.db, SLUG, "v1.3.0-beta.2", "bad", "t", NOW);
    const rows = await w.run(await w.probes());
    // The live fallback ranks the prereleases at or below the floor (1.1.0-beta.1); the store's
    // candidates include stable (1.2.0).
    const row = rows.find(
      (r) => r.surface === "version" && r.probe === "beta",
    )!;
    expect([row.old.version, row.new.version]).toEqual([
      "1.1.0-beta.1",
      "1.2.0",
    ]);
    expect(row.class).toBe("beta-yanked-floor-fallback");
  });

  it("duplicate-version: v1.2.0 and 1.2.0 both exist", async () => {
    const w = await world([
      rel("v1.2.0", 3),
      rel("1.2.0", 4),
      rel("v1.1.0", 2),
    ]);
    const rows = await w.run(await w.probes());
    const c = classes(rows);
    // The pin names two tags: the live path prefers `v1.2.0`, the store takes the later publication.
    expect(c["version 1.2.0"]).toBe("duplicate-version");
    expect(Object.values(nonIdentical(rows))).not.toContain("unexpected");
  });

  it("beyond-page-cap: the legacy read stopped at three pages", async () => {
    // 300 prereleases newer than the only stable release: the live read never reaches it.
    const many: Release[] = [];
    for (let i = 1; i <= 300; i++)
      many.push(
        rel(`v2.0.0-beta.${i}`, i, {
          prerelease: true,
          published_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 400 - i))
            .toISOString()
            .replace(/\.000Z$/, "Z"),
        }),
      );
    many.push(rel("v1.0.0", 301, { published_at: "2025-01-01T00:00:00Z" }));
    const w = await world(many);
    // The sync recorded the stable floor, which would hold the live route up (R6-10): an operator
    // who cleared it leaves the live read with the three pages alone.
    await w.db.run(
      "DELETE FROM release_channel_floors WHERE product = ?",
      SLUG,
    );
    const rows = await w.run(
      buildProbes({ channels: ["beta"], stableVersion: null }).filter(
        (p) => p.surface === "version",
      ),
    );
    const stable = rows.find((r) => r.probe === "stable")!;
    expect([stable.old.status, stable.new.status]).toEqual([404, 200]);
    expect(stable.class).toBe("beyond-page-cap");
  });

  it("unexpected: a store row that disagrees with GitHub for no listed reason", async () => {
    const w = await world([rel("v1.1.0", 2), rel("v1.0.0", 1)]);
    await w.db.run(
      "UPDATE release_metadata SET published_at = published_at + 86400 WHERE product = ? AND release_id = 'v1.1.0'",
      SLUG,
    );
    const rows = await w.run(await w.probes());
    expect(classes(rows)["appcast stable"]).toBe("unexpected");
    expect(classes(rows)["version stable"]).toBe("identical");
  });

  it("upstream-error: GitHub refuses the legacy read with a quota answer", async () => {
    const w = await world([rel("v1.1.0", 2), rel("v1.0.0", 1)]);
    w.flags.limited = true;
    const rows = await w.run(await w.probes());
    const stable = rows.find(
      (r) => r.surface === "version" && r.probe === "stable",
    )!;
    expect(stable.old.status).toBe(503);
    expect(stable.new.status).toBe(200);
    expect(stable.class).toBe("upstream-error");
  });

  it("the v<version> twin read answers only what GitHub would list", async () => {
    const w = await world([rel("v1.1.0", 2), rel("v1.0.0", 1)]);
    const cfg = (await getReleaseConfig(w.db, SLUG))!;
    expect((await storeReleaseByTag(w.db, cfg, "v1.1.0"))?.tag_name).toBe(
      "v1.1.0",
    );
    expect(await storeReleaseByTag(w.db, cfg, "v9.9.9")).toBeNull();
    // Seen gone upstream: GitHub's tag lookup would 404.
    await w.db.run(
      `INSERT OR REPLACE INTO release_health (product, subject_kind, subject_id, status, details_json, checked_at)
       VALUES (?, 'release', 'v1.0.0', 'degraded', '{"absentUpstream":1}', ?)`,
      SLUG,
      NOW,
    );
    expect(await storeReleaseByTag(w.db, cfg, "v1.0.0")).toBeNull();
  });
});
