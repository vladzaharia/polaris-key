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

import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { mkReq, NOW, seedLicenseWithKey } from "./seed.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import {
  ASSET_BYTES,
  bytesOf,
  sha256Hex,
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
import {
  setChannelPolicy,
  yankRelease,
} from "../src/services/release/model.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleAssetQueue } from "../src/assetQueue.js";
import { checkReleaseHealth } from "../src/services/release/health.js";
import { serveDownload } from "../src/services/release/source.js";
import { syncReleaseStoreReport } from "../src/services/release/sync.js";
import { releaseMirrorEnabled } from "../src/services/release/mirrorSwitch.js";
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
  hooks: {
    /** Called on the environment before the first sync (bindings). */
    prepare?: (env: Env) => void;
    /** Called once the first sync has run, with a fetch that reaches the fake GitHub. */
    afterSync?: (env: Env, db: Db, fetchImpl: FetchImpl) => Promise<void>;
  } = {},
): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db, cfg);
  const env = envFor();
  hooks.prepare?.(env);
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
    const assetId = /\/releases\/assets\/(\d+)$/.exec(
      new URL(url).pathname,
    )?.[1];
    if (
      assetId &&
      new URL(url).hostname === "api.github.com" &&
      new Headers(init?.headers).get("accept")?.includes("github+json")
    ) {
      const found = state.releases
        .flatMap((r) => r.assets)
        .find((a) => a.id === Number(assetId));
      return found
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response("nf", { status: 404 });
    }
    if (runs && /\/actions\/workflows\/[^/]+\/runs\?/.test(url))
      return new Response(JSON.stringify(runs()), { status: 200 });
    return gh.fetchImpl(input, init);
  };
  const resync = async (): Promise<void> => {
    await syncReleaseStore(env, db, SLUG, NOW, fetchImpl);
  };
  await resync();
  await hooks.afterSync?.(env, db, fetchImpl);
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

// ══ P2-12.6: the golden matrix (plans/P2-12.md §8) ═══════════════════════════════════════════
//
// Every scenario below is one world; each is swept with the comparator's whole probe list (the
// appcast with no `arch`, `arm64` and `x86_64`; the channel appcast and `/version` on every
// selector; `/release/dl` as cli and dmg, per arch, plain and `?checksum=sha256`), through both
// steps with the job's own `compareProbe`. A row is `identical` or carries one of the named
// expected classes: a `stale-store`, `unexpected` or `upstream-error` row anywhere fails the
// sweep, so a new divergence cannot hide inside a table. The last test reads the matrix back:
// its size, and that every row is in a named class.

beforeAll(() => installDigestStream());

const MATRIX: { scenario: string; row: CompareRow }[] = [];
/**
 * Rows the comparator classifies `unexpected` that this file has examined and pins by name, so a
 * change in either direction fails a test. Each is a finding for the lead (see the report of
 * P2-12.6), not a class: the switch rule still counts it as blocking.
 */
const FINDINGS = new Set<CompareRow>();

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = Buffer.from(
  publicKey.export({ format: "jwk" }).x as string,
  "base64url",
).toString("base64");
const { publicKey: otherPublic } = generateKeyPairSync("ed25519");
const OTHER_PUB = Buffer.from(
  otherPublic.export({ format: "jwk" }).x as string,
  "base64url",
).toString("base64");

const text = (s: string) => new TextEncoder().encode(s);
const POLICY = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ requireSparkleSignature: false, ...over });

/** An asset whose bytes (and so its GitHub digest) are real, registered under its id. */
function realAsset(id: number, name: string, bytes?: Uint8Array): ReleaseAsset {
  const b = bytes ?? bytesOf(900 + (id % 50), id);
  ASSET_BYTES[id] = b;
  return {
    id,
    name,
    size: b.length,
    content_type: "text/html",
    browser_download_url: `https://github.com/acme/djdl/releases/download/x/${name}`,
    digest: `sha256:${sha256Hex(b)}`,
  };
}

type SigState = "valid" | "missing" | "wrong-bytes" | "malformed";
interface MatrixOpts {
  sig?: SigState;
  /** Add a `<cli>.sha256` sidecar: `ok` matches the CLI, `bad` is not a digest line. */
  sidecar?: "ok" | "bad";
  body?: string;
  prerelease?: boolean;
}

/** A release with a CLI and a DMG per architecture, with the sidecars `o` asks for. */
function mrel(tag: string, n: number, o: MatrixOpts = {}): Release {
  const v = tag.replace(/^v/, "");
  const base = 6000 + n * 20;
  const assets: ReleaseAsset[] = [];
  const cli = realAsset(base + 1, "djdl-arm64");
  assets.push(cli);
  ["arm64", "x86_64"].forEach((arch, i) => {
    const dmg = realAsset(base + 2 + i * 3, `djdl-${v}-${arch}.dmg`);
    assets.push(dmg);
    if (o.sig && o.sig !== "missing") {
      const bytes = ASSET_BYTES[dmg.id]!;
      const sigText =
        o.sig === "valid"
          ? sign(null, bytes, privateKey).toString("base64")
          : o.sig === "wrong-bytes"
            ? sign(null, text("something else"), privateKey).toString("base64")
            : "not*base64!";
      assets.push(
        realAsset(base + 3 + i * 3, `${dmg.name}.sig`, text(sigText)),
      );
    }
  });
  if (o.sidecar)
    assets.push(
      realAsset(
        base + 12,
        "djdl-arm64.sha256",
        text(
          o.sidecar === "ok"
            ? `${sha256Hex(ASSET_BYTES[cli.id]!)}  djdl-arm64\n`
            : "this is not a digest\n",
        ),
      ),
    );
  return release(tag, assets, {
    published_at: `2026-02-${String(n).padStart(2, "0")}T03:04:05Z`,
    prerelease: o.prerelease ?? false,
    ...(o.body !== undefined ? { body: o.body } : {}),
  });
}

/** Sweep a world with the full probe list; every row must classify into a named class. */
async function sweep(
  scenario: string,
  w: World,
  extra: string[] = [],
): Promise<CompareRow[]> {
  const c = (await getReleaseConfig(w.db, SLUG))!;
  const set = {
    channels: await probeChannels(w.db, c, extra),
    stableVersion:
      w.state.releases
        .filter((r) => !r.prerelease && /^v?\d+\.\d+\.\d+$/.test(r.tag_name))
        .map((r) => r.tag_name.replace(/^v/, ""))
        .sort()
        .pop() ?? null,
  };
  const rows = await w.run([...buildProbes(set), ...buildDownloadProbes(set)]);
  for (const r of rows) MATRIX.push({ scenario, row: r });
  const blocked = rows.filter(
    (r) =>
      (BLOCKING_CLASSES as readonly string[]).includes(r.class) ||
      r.class === "upstream-error",
  );
  expect(
    blocked.map((r) => `${r.surface} ${r.probe}: ${r.class}`),
    `${scenario}: rows outside the named classes`,
  ).toEqual([]);
  return rows;
}

const row = (
  rows: CompareRow[],
  surface: string,
  probe: string,
): CompareRow => {
  const r = rows.find((x) => x.surface === surface && x.probe === probe);
  if (!r) throw new Error(`no ${surface} ${probe} row`);
  return r;
};
const ver = (rows: CompareRow[], probe: string) => row(rows, "version", probe);
/** What the live route and the store answered for `/version <probe>`. */
const answered = (rows: CompareRow[], probe: string) => [
  ver(rows, probe).old.version ?? ver(rows, probe).old.status,
  ver(rows, probe).new.version ?? ver(rows, probe).new.status,
];

const BASE = () => [
  mrel("v1.3.0-beta.1", 4, { prerelease: true }),
  mrel("v1.2.0", 3),
  mrel("v1.1.0", 2),
  mrel("v1.0.0", 1),
];

const WRITER = { source: "admin", by: "admin:t", now: NOW } as const;
const policy = (channel: string) => ({
  product: SLUG,
  deliverableId: "app",
  channel,
});

describe("matrix: yank, pin and promote", () => {
  it("a yanked current stable falls back, in both steps", async () => {
    const w = await world(BASE());
    await yankRelease(w.db, SLUG, "v1.2.0", "bad", "t", NOW);
    const rows = await sweep("yank", w);
    expect(answered(rows, "stable")).toEqual(["1.1.0", "1.1.0"]);
  });

  it("a pinned stable pointer holds the channel on an older release", async () => {
    const w = await world(BASE());
    await setChannelPolicy(
      w.db,
      policy("stable"),
      { pointerReleaseId: "v1.1.0", pinned: true },
      WRITER,
    );
    const rows = await sweep("pin", w);
    expect(answered(rows, "stable")).toEqual(["1.1.0", "1.1.0"]);
    expect(answered(rows, "latest")).toEqual(answered(rows, "stable"));
  });

  it("an unpinned promote on beta", async () => {
    const w = await world([
      mrel("v1.4.0-beta.2", 6, { prerelease: true }),
      mrel("v1.4.0-beta.1", 5, { prerelease: true }),
      ...BASE(),
    ]);
    await setChannelPolicy(
      w.db,
      policy("beta"),
      { pointerReleaseId: "v1.4.0-beta.1", pinned: false },
      WRITER,
    );
    const rows = await sweep("promote", w);
    expect(answered(rows, "beta")[0]).toBe(answered(rows, "beta")[1]);
  });

  it("an absent unpinned pointer is passed over; an absent pinned one answers 404", async () => {
    const w = await world(BASE());
    await setChannelPolicy(
      w.db,
      policy("stable"),
      { pointerReleaseId: "v1.1.0", pinned: false },
      WRITER,
    );
    // v1.1.0 disappears upstream: the sync sees it gone.
    w.state.releases = w.state.releases.filter((r) => r.tag_name !== "v1.1.0");
    await w.resync();
    const unpinned = await sweep("promote-absent-unpinned", w);
    expect(answered(unpinned, "stable")[0]).toBe(
      answered(unpinned, "stable")[1],
    );
  });

  it("an absent pinned pointer is a 404, never a silent fallback", async () => {
    // A fresh world: the live step's resolution cache would otherwise hold the answer the
    // unpinned scenario read before the pin existed.
    const w = await world(BASE());
    await setChannelPolicy(
      w.db,
      policy("stable"),
      { pointerReleaseId: "v1.1.0", pinned: true },
      WRITER,
    );
    w.state.releases = w.state.releases.filter((r) => r.tag_name !== "v1.1.0");
    await w.resync();
    const pinned = await sweep("pin-absent", w);
    expect(answered(pinned, "stable")).toEqual([404, 404]);
    expect(row(pinned, "appcast", "stable").new.status).toBe(404);
  });
});

describe("matrix: the channel floors", () => {
  it("a floor release deleted upstream", async () => {
    const w = await world(BASE());
    w.state.releases = w.state.releases.filter((r) => r.tag_name !== "v1.2.0");
    await w.resync();
    const rows = await sweep("floor-deleted", w);
    expect(answered(rows, "stable")[0]).toBe(answered(rows, "stable")[1]);
  });

  it("a floor release re-flagged as a prerelease", async () => {
    const w = await world(BASE());
    w.state.releases = w.state.releases.map((r) =>
      r.tag_name === "v1.2.0" ? { ...r, prerelease: true } : r,
    );
    await w.resync();
    const rows = await sweep("floor-reflagged", w);
    expect(answered(rows, "stable")[0]).toBe(answered(rows, "stable")[1]);
  });

  it("a floor release named by ignoreTags", async () => {
    const w = await world(BASE());
    await w.db.run(
      "UPDATE release_config SET ignore_tags_json = ? WHERE product = ?",
      JSON.stringify(["v1.2.0"]),
      SLUG,
    );
    const rows = await sweep("floor-ignored", w);
    expect(answered(rows, "stable")[0]).toBe(answered(rows, "stable")[1]);
  });

  it("a yanked floor release", async () => {
    const w = await world(BASE());
    await yankRelease(w.db, SLUG, "v1.2.0", "bad", "t", NOW);
    const rows = await sweep("floor-yanked", w);
    expect(answered(rows, "stable")).toEqual(["1.1.0", "1.1.0"]);
  });

  it("a promote below a regressed floor", async () => {
    const w = await world(BASE());
    w.state.releases = w.state.releases.filter((r) => r.tag_name !== "v1.2.0");
    await w.resync();
    await setChannelPolicy(
      w.db,
      policy("stable"),
      { pointerReleaseId: "v1.1.0", pinned: false },
      WRITER,
    );
    const rows = await sweep("promote-below-floor", w);
    expect(answered(rows, "stable")[0]).toBe(answered(rows, "stable")[1]);
  });

  it("a recorded beta floor over a beta that moved on", async () => {
    const w = await world(BASE());
    w.state.releases = [
      mrel("v1.3.0-beta.0", 5, { prerelease: true }),
      ...BASE().slice(1),
    ];
    await w.resync();
    await sweep("floor-beta", w);
  });
});

describe("matrix: absent rows, stableTagPattern and manual channels", () => {
  it("rows seen gone upstream are hidden from every selector", async () => {
    const w = await world(BASE());
    w.state.releases = w.state.releases.filter(
      (r) => r.tag_name !== "v1.3.0-beta.1",
    );
    await w.resync();
    const rows = await sweep("absent-row", w);
    expect(answered(rows, "beta")[0]).toBe(answered(rows, "beta")[1]);
  });

  it("stableTagPattern keeps a tag out of stable", async () => {
    const w = await world(
      [mrel("v1.2.0", 3), mrel("legacy-9.9.9", 5), mrel("v1.1.0", 2)],
      { stable_tag_pattern: "^v[0-9]+\\.[0-9]+\\.[0-9]+$" },
    );
    const rows = await sweep("stable-tag-pattern", w);
    expect(answered(rows, "stable")).toEqual(["1.2.0", "1.2.0"]);
  });

  it("manual channels, with a promote and a yank on one", async () => {
    const w = await world(
      [
        mrel("nightly-0003", 6, { prerelease: true }),
        mrel("nightly-0002", 5, { prerelease: true }),
        ...BASE().slice(1),
      ],
      {
        manual_channels_json: JSON.stringify([
          { name: "nightly", regex: "^nightly-[0-9]+$" },
        ]),
      },
    );
    const plain = await sweep("manual-channel", w);
    expect(ver(plain, "nightly").old.status).toBe(200);
  });

  it("a manual channel with a yank and a promote", async () => {
    const w = await world(
      [
        mrel("nightly-0003", 6, { prerelease: true }),
        mrel("nightly-0002", 5, { prerelease: true }),
        ...BASE().slice(1),
      ],
      {
        manual_channels_json: JSON.stringify([
          { name: "nightly", regex: "^nightly-[0-9]+$" },
        ]),
      },
    );
    await yankRelease(w.db, SLUG, "nightly-0003", "bad", "t", NOW);
    await setChannelPolicy(
      w.db,
      policy("nightly"),
      { pointerReleaseId: "nightly-0002", pinned: false },
      WRITER,
    );
    const rows = await sweep("manual-channel-yank-promote", w);
    expect(answered(rows, "nightly")).toEqual(["nightly-0002", "nightly-0002"]);
  });
});

describe("matrix: described releases the store holds without a GitHub listing", () => {
  const insertRow = (
    w: World,
    id: string,
    version: string,
    metadata: Record<string, unknown>,
    channel: string | null,
    published: number,
  ) =>
    w.db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url, metadata_access,
          artifacts_access, published_at, metadata_json, created_at, modified_at, deliverable_id, channel)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'public', 'public', ?, ?, ?, ?, 'app', ?)`,
      SLUG,
      id,
      version,
      id,
      published,
      JSON.stringify(metadata),
      NOW,
      NOW,
      channel,
    );

  it("a tagless descriptor release is never offered by the legacy view", async () => {
    const w = await world(BASE());
    await insertRow(
      w,
      "app@9.0.0",
      "9.0.0",
      { descriptor: { status: "ingested" } },
      "stable",
      NOW + 100,
    );
    const rows = await sweep("tagless-described", w);
    expect(answered(rows, "stable")[0]).toBe(answered(rows, "stable")[1]);
  });

  it("a GitHub-less release (a tag-shaped id GitHub never listed)", async () => {
    const w = await world(BASE());
    await insertRow(
      w,
      "v9.1.0",
      "9.1.0",
      { descriptor: { status: "ingested" } },
      "stable",
      NOW + 100,
    );
    const rows = await sweep("github-less-described", w);
    expect(answered(rows, "stable")[0]).toBe(answered(rows, "stable")[1]);
  });

  it("an R2-only file of a described release", async () => {
    const w = await world(BASE());
    await w.db.run(
      `UPDATE release_metadata
          SET metadata_json = json_set(metadata_json, '$.descriptor.status', 'ingested')
        WHERE product = ? AND release_id = 'v1.2.0'`,
      SLUG,
    );
    await w.db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, access, created_at, build_id, size_bytes)
       VALUES (?, 'v1.2.0', 'file:app.zip', 'app.zip', 'public', ?, 'zip', 5)`,
      SLUG,
      NOW,
    );
    // The descriptor holds a file GitHub does not list; it is no DMG or CLI, so the answers
    // a client can ask for agree.
    const rows = await sweep("descriptor-r2-only", w);
    expect(answered(rows, "stable")[0]).toBe(answered(rows, "stable")[1]);
  });
});

describe("matrix: the Sparkle appcast", () => {
  const withSig = (sig: SigState) => [
    mrel("v1.2.0", 3, { sig }),
    mrel("v1.1.0", 2, { sig }),
  ];
  const arm = (rows: CompareRow[], p = "stable?arch=arm64") =>
    row(rows, "appcast", p);

  it("no key, no signature required: an unsigned item", async () => {
    const w = await world(withSig("missing"));
    const rows = await sweep("sparkle-no-key", w);
    expect(arm(rows).old.status).toBe(200);
  });

  it("a key and a valid signature", async () => {
    const w = await world(withSig("valid"), { sparkle_ed25519_pub: PUB });
    const rows = await sweep("sparkle-key-valid-sig", w);
    expect(arm(rows).old.status).toBe(200);
    expect(arm(rows, "stable").old.status).toBe(200);
    expect(arm(rows, "stable?arch=x86_64").old.status).toBe(200);
  });

  it("a key and no signature asset fails closed", async () => {
    const w = await world(withSig("missing"), { sparkle_ed25519_pub: PUB });
    const rows = await sweep("sparkle-key-sig-missing", w);
    expect(arm(rows).old.status).toBe(404);
    expect(arm(rows).new.status).toBe(404);
  });

  it("a signature over other bytes fails closed", async () => {
    const w = await world(withSig("wrong-bytes"), {
      sparkle_ed25519_pub: PUB,
    });
    const rows = await sweep("sparkle-key-sig-wrong", w);
    expect(arm(rows).new.status).toBe(404);
  });

  it("a malformed signature fails closed", async () => {
    const w = await world(withSig("malformed"), { sparkle_ed25519_pub: PUB });
    const rows = await sweep("sparkle-key-sig-malformed", w);
    expect(arm(rows).new.status).toBe(404);
  });

  it("a signature made under another key fails closed", async () => {
    const w = await world(withSig("valid"), { sparkle_ed25519_pub: OTHER_PUB });
    const rows = await sweep("sparkle-other-key", w);
    expect(arm(rows).new.status).toBe(404);
  });

  it("a signature and no configured key is not shipped", async () => {
    const w = await world(withSig("valid"));
    const rows = await sweep("sparkle-sig-no-key", w);
    expect(arm(rows).new.status).toBe(404);
  });

  it("the operator requires a signature and no key is set", async () => {
    const w = await world(withSig("valid"), {
      operator_policy_json: POLICY({ requireSparkleSignature: true }),
    });
    const rows = await sweep("sparkle-required-no-key", w);
    expect(arm(rows).new.status).toBe(404);
  });

  it("minimumSystemVersion and the summary marker reach the item", async () => {
    const w = await world(
      [
        mrel("v1.2.0", 3, {
          body: "Intro.\n<!-- team:notes -->\nFaster **sync** & fewer crashes.\n<!-- /team:notes -->\n\n## Details\nmore",
        }),
        mrel("v1.1.0", 2),
      ],
      {
        summary_marker: "team:notes",
        operator_policy_json: POLICY({ minimumSystemVersion: "13.0" }),
      },
    );
    const rows = await sweep("sparkle-minsys-summary", w);
    expect(arm(rows).old.status).toBe(200);
    expect(arm(rows).new.bodySha256).toBe(arm(rows).old.bodySha256);
  });

  it("the default marker and the fallback paragraph", async () => {
    const w = await world([
      mrel("v1.2.0", 3, {
        body: "<!-- pkey:summary -->Default marker text.<!-- /pkey:summary -->",
      }),
      mrel("v1.1.0", 2, { body: "First paragraph only.\n\n## Heading\nrest" }),
    ]);
    await sweep("sparkle-summary-default", w);
    await w.db.run(
      "UPDATE release_config SET summary_marker = 'other' WHERE product = ?",
      SLUG,
    );
    await sweep("sparkle-summary-fallback", w);
  });
});

describe("matrix: sidecars", () => {
  const rels = (sidecar?: "ok" | "bad") => [
    mrel("v1.2.0", 3, sidecar ? { sidecar } : {}),
    mrel("v1.1.0", 2, sidecar ? { sidecar } : {}),
  ];
  const dl = (rows: CompareRow[], p: string) => row(rows, "download", p);

  it("present: the checksum is served", async () => {
    const w = await world(rels("ok"));
    const rows = await sweep("sidecar-present", w);
    expect(dl(rows, "latest/cli-arm64?checksum=sha256").new.status).toBe(200);
  });

  it("missing: the checksum is 404", async () => {
    const w = await world(rels());
    const rows = await sweep("sidecar-missing", w);
    expect(dl(rows, "latest/cli-arm64?checksum=sha256").new.status).toBe(404);
  });

  it("malformed: served as the legacy step serves it", async () => {
    const w = await world(rels("bad"));
    const rows = await sweep("sidecar-malformed", w);
    expect(dl(rows, "latest/cli-arm64?checksum=sha256").new.status).toBe(
      dl(rows, "latest/cli-arm64?checksum=sha256").old.status,
    );
  });
});

describe("matrix: R2-mirrored and GitHub-streamed files", () => {
  it("GitHub-streamed: no mirror, every download probe agrees", async () => {
    const w = await world(BASE());
    const rows = await sweep("streamed", w);
    expect(row(rows, "download", "latest/cli-arm64").new.status).toBe(200);
  });

  it("R2-mirrored: the store step reads the copy, the answers agree", async () => {
    const r2 = new R2Mock();
    const sent: unknown[] = [];
    const w = await world(
      [mrel("v1.2.0", 3, { sig: "valid", sidecar: "ok" }), mrel("v1.1.0", 2)],
      { sparkle_ed25519_pub: PUB },
      undefined,
      {
        prepare: (env) => {
          env.BLOBS = asR2(r2);
          env.HOSTED_ASSET_QUEUE = {
            async sendBatch(msgs: Iterable<{ body: unknown }>) {
              for (const m of msgs) sent.push(m.body);
            },
            async send(body: unknown) {
              sent.push(body);
            },
          } as unknown as Queue<unknown>;
        },
        afterSync: async (env, db, fetchImpl) => {
          await handleAssetQueue(
            {
              queue: "pkey-assets-test",
              messages: sent.map((body) => ({
                body,
                ack: () => undefined,
                retry: () => undefined,
              })),
            } as unknown as MessageBatch<unknown>,
            env,
            db,
            (i, init) => fetchImpl(typeof i === "string" ? i : i.url, init),
            () => NOW + 10,
          );
          expect(await releaseMirrorEnabled(env, db, SLUG)).toBe(true);
        },
      },
    );
    expect(r2.has(`blobs/sha256/${sha256Hex(ASSET_BYTES[6061]!)}`)).toBe(true);
    const rows = await sweep("mirrored", w);
    expect(row(rows, "download", "latest/cli-arm64").new.status).toBe(200);
    expect(row(rows, "appcast", "stable?arch=arm64").new.status).toBe(200);
  });
});

describe("matrix: entitled and licensed refusals", () => {
  async function entitled(maxVersion: string, access: "entitled" | "licensed") {
    const w = await world(
      [mrel("v1.2.0", 3), mrel("v1.1.0", 2), mrel("v1.0.0", 1)],
      { artifacts_access: access },
    );
    const { key } = await seedLicenseWithKey(w.db, SLUG, { maxVersion });
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    const act = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      w.env,
      w.db,
      product,
      NOW,
    );
    expect(act.status).toBe(200);
    const token = ((await act.json()) as { token: string }).token;
    return { w, product, token };
  }

  /** Identical, or the one difference a beta selector carries in a world with no prerelease. */
  const sameOrBeta = (r: CompareRow) =>
    r.class === "identical" ||
    (r.class === "beta-includes-stable" && /\b(beta|staging)$/.test(r.probe));

  /** The appcast probes with the caller's grant on the request and the mode on the options. */
  async function appcastRows(
    w: World,
    token: string | null,
    mode: "entitled" | "licensed",
  ) {
    const c = (await getReleaseConfig(w.db, SLUG))!;
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    const headers: Record<string, string> = token
      ? { authorization: `Bearer ${token}` }
      : {};
    const ctx = {
      req: new Request(`https://key.example.test/${SLUG}/update/appcast.xml`, {
        headers,
      }),
      env: w.env,
      db: w.db,
      product,
      cfg: c,
      origin: "https://key.example.test",
      now: NOW,
      fetchImpl: w.fetchImpl,
    };
    const out: CompareRow[] = [];
    for (const p of buildProbes({
      channels: ["beta"],
      stableVersion: "1.2.0",
    }).filter((x) => x.surface !== "version")) {
      const r = await compareProbe(w.db, c, p, ctx, { artifactsAccess: mode });
      MATRIX.push({ scenario: `${mode}-appcast`, row: r });
      if (r.class === "unexpected") FINDINGS.add(r);
      out.push(r);
    }
    return out;
  }

  /** `/release/dl` with the mode on the ref: the probe itself always runs public. */
  async function downloadPair(
    w: World,
    token: string | null,
    selector: string,
    access: "entitled" | "licensed",
  ) {
    const c = (await getReleaseConfig(w.db, SLUG))!;
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    const run = async (step: "legacy" | "store") => {
      const res = await serveDownload(
        { env: w.env, db: w.db, product, now: NOW },
        c as never,
        {
          kind: "dl",
          selector,
          arch: "arm64",
          format: "cli",
          checksum: false,
          access,
        },
        new Request(
          `https://key.example.test/${SLUG}/release/dl/${selector}/cli`,
          { headers: token ? { authorization: `Bearer ${token}` } : {} },
        ),
        w.fetchImpl,
        step,
      );
      const body = await res.text().catch(() => "");
      return { status: res.status, body: body.slice(0, 200) };
    };
    return { old: await run("legacy"), new: await run("store") };
  }

  it("a grant capped below the resolved release is refused on the appcast, identically", async () => {
    const { w, token } = await entitled("1.0.0", "entitled");
    const rows = await appcastRows(w, token, "entitled");
    const stableRow = rows.find((r) => r.probe === "stable")!;
    expect(stableRow.old.status).toBeGreaterThanOrEqual(400);
    expect(stableRow.new.status).toBe(stableRow.old.status);
    // FINDING (P2-12.6): on a stable-only product the legacy `beta` has no prerelease to offer
    // (404), while the store's beta includes stable (D6) and so reaches the same out-of-window
    // release the grant refuses (403). That is the beta-includes-stable difference, but
    // `classifyDifference` names it only when the store answers 200, so it reads `unexpected`.
    const odd = rows.filter((r) => r.class === "unexpected");
    expect(odd.map((r) => `${r.surface} ${r.probe}`)).toEqual([
      "channelAppcast beta",
    ]);
    expect([odd[0]!.old.status, odd[0]!.new.status]).toEqual([404, 403]);
    // The version the 403 stands for is the one the stable probe was refused on.
    expect(stableRow.new.status).toBe(403);
  });

  it("a grant that covers the release is served identically", async () => {
    const { w, token } = await entitled("9.9.9", "entitled");
    const rows = await appcastRows(w, token, "entitled");
    expect(rows.find((r) => r.probe === "stable")!.new.status).toBe(200);
    for (const r of rows) expect(sameOrBeta(r)).toBe(true);
  });

  it("no token at all is refused identically", async () => {
    const { w } = await entitled("9.9.9", "entitled");
    const rows = await appcastRows(w, null, "entitled");
    const r = rows.find((x) => x.probe === "stable")!;
    expect(r.old.status).toBeGreaterThanOrEqual(400);
    expect(r.new.status).toBe(r.old.status);
    // The same finding as above, from the other refusal: beta is 404 live, refused by the store.
    const odd = rows.filter((x) => x.class === "unexpected");
    expect(odd.map((x) => `${x.surface} ${x.probe}`)).toEqual([
      "channelAppcast beta",
    ]);
    expect(odd[0]!.old.status).toBe(404);
    expect(odd[0]!.new.status).toBeGreaterThanOrEqual(401);
  });

  it("downloads: refused beyond the window, served inside it, the same in both steps", async () => {
    const capped = await entitled("1.0.0", "entitled");
    for (const sel of ["latest", "stable"]) {
      const p = await downloadPair(capped.w, capped.token, sel, "entitled");
      expect(p.new).toEqual(p.old);
      expect(p.old.status).toBeGreaterThanOrEqual(400);
    }
    const open = await entitled("9.9.9", "entitled");
    const ok = await downloadPair(open.w, open.token, "latest", "entitled");
    expect(ok.new.status).toBe(ok.old.status);
    expect(ok.old.status).toBe(200);
    const anon = await downloadPair(open.w, null, "latest", "entitled");
    expect(anon.new).toEqual(anon.old);
    expect(anon.old.status).toBeGreaterThanOrEqual(400);
  });

  it("licensed is decided at the gateway: the compute answers the same as public", async () => {
    const { w, token } = await entitled("1.0.0", "licensed");
    const rows = await appcastRows(w, token, "licensed");
    for (const r of rows) expect(sameOrBeta(r)).toBe(true);
    const p = await downloadPair(w, token, "latest", "licensed");
    expect(p.new).toEqual(p.old);
  });
});

describe("matrix: the store-step health floor on a non-stable channel", () => {
  it("names the beta floor and its offered release, as the legacy step does", async () => {
    const w = await world([
      mrel("v1.3.0-beta.2", 5, { prerelease: true }),
      mrel("v1.3.0-beta.1", 4, { prerelease: true }),
      mrel("v1.2.0", 3),
    ]);
    // The sync recorded the beta floor at the highest beta; that release disappears upstream.
    const floors = await w.db.all<{ channel: string; version: string }>(
      "SELECT channel, version FROM release_channel_floors WHERE product = ?",
      SLUG,
    );
    expect(floors.map((f) => f.channel)).toContain("beta");
    w.state.releases = w.state.releases.filter(
      (r) => r.tag_name !== "v1.3.0-beta.2",
    );
    await syncReleaseStoreReport(w.env, w.db, SLUG, NOW + 5, w.fetchImpl);

    const legacy = await checkReleaseHealth(
      w.env,
      w.db,
      SLUG,
      NOW + 5,
      w.fetchImpl,
    );
    const seen: string[] = [];
    const guarded: FetchImpl = async (input, init) => {
      seen.push(input);
      const u = new URL(input);
      const ok =
        u.hostname !== "api.github.com" ||
        /\/access_tokens$/.test(u.pathname) ||
        /^\/repos\/[^/]+\/[^/]+\/releases$/.test(u.pathname) ||
        /\/releases\/assets\/\d+$/.test(u.pathname);
      if (!ok) throw new Error(`GitHub call while serving: ${input}`);
      return w.fetchImpl(input, init);
    };
    const store = await checkReleaseHealth(
      w.env,
      w.db,
      SLUG,
      NOW + 5,
      guarded,
      "store",
    );

    const beta = (h: typeof store) =>
      h.checks.find((c) => c.id === "channel-regressed-beta");
    expect(beta(store)?.status).toBe("error");
    expect(beta(store)?.message).toContain("1.3.0-beta.2 (v1.3.0-beta.2)");
    expect(beta(store)?.message).toBe(beta(legacy)?.message);
    expect(store.checks.map((c) => `${c.id}:${c.status}`)).toEqual(
      legacy.checks.map((c) => `${c.id}:${c.status}`),
    );
    expect(store.status).toBe(legacy.status);
    expect(seen.filter((u) => /\/releases\/tags|\/actions\//.test(u))).toEqual(
      [],
    );
  });
});

describe("the matrix as a whole", () => {
  afterAll(() => {
    const dist: Record<string, number> = {};
    for (const m of MATRIX) dist[m.row.class] = (dist[m.row.class] ?? 0) + 1;
    console.log(
      `P2-12.6 matrix: ${MATRIX.length} rows over ${new Set(MATRIX.map((m) => m.scenario)).size} scenarios; ${JSON.stringify(dist)}`,
    );
  });

  it("holds no blocking row, and every difference is a named expected class", () => {
    expect(MATRIX.length).toBeGreaterThan(400);
    for (const { scenario, row: r } of MATRIX) {
      if (FINDINGS.has(r)) continue; // pinned above, reported to the lead
      expect(
        [...EXPECTED_CLASSES, "identical"],
        `${scenario}: ${r.surface} ${r.probe}`,
      ).toContain(r.class);
    }
    expect(FINDINGS.size).toBe(2);
    expect(new Set(MATRIX.map((m) => m.row.surface))).toEqual(
      new Set(["appcast", "channelAppcast", "version", "download"]),
    );
  });
});
