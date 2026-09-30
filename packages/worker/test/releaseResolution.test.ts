/**
 * P0-02 — release resolution: the candidate filter, version ordering, pagination, the pinned
 * unprefixed-tag fallback, the version-index conflict, and the R6-10 channel floor.
 *
 * Every case drives a real route (or the real sync) against a stubbed GitHub, because each of
 * these defects was invisible to a unit test of `resolveChannel` alone: the list came in API
 * order, one page at a time, and the store's unique index only bit inside a resync batch.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { Product } from "../src/core/products.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
} from "../src/fingerprint.js";
import { DEFAULT_SERVICES } from "../src/core/services.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import {
  classifyChannel,
  resolutionPolicy,
  resolveChannel,
} from "../src/services/release/channels.js";
import {
  listReleases,
  nextPageUrl,
  type Release,
  type ReleaseAsset,
} from "../src/services/release/github.js";
import { syncReleaseStore } from "../src/services/release/sync.js";
import { checkReleaseHealth } from "../src/services/release/health.js";
import {
  getChannelFloor,
  listReleaseChannels,
  listReleaseHealth,
  listReleaseMetadata,
} from "../src/services/release/store.js";
import { handleReleaseSurface } from "./releaseSurface.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";

const SLUG = "djdl";
const API = "https://api.github.com/repos/acme/djdl";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function asset(name: string, id: number): ReleaseAsset {
  return {
    id,
    name,
    size: 1024,
    content_type: "application/octet-stream",
    browser_download_url: `https://github.com/acme/djdl/releases/download/x/${name}`,
  };
}

function release(tag: string, over: Partial<Release> = {}): Release {
  return {
    tag_name: tag,
    name: tag,
    body: null,
    published_at: "2026-01-02T03:04:05Z",
    html_url: `https://github.com/acme/djdl/releases/tag/${tag}`,
    prerelease: false,
    draft: false,
    assets: [],
    ...over,
  };
}

async function seed(db: Db, over: Record<string, unknown> = {}) {
  await seedProduct(db, SLUG);
  const row: Record<string, unknown> = {
    product: SLUG,
    gh_owner: "acme",
    gh_repo: "djdl",
    gh_installation_id: 42,
    channel_workflow: null,
    beta_branch: "main",
    manual_channels_json: null,
    binary_name: "djdl",
    install_template: null,
    sparkle_ed25519_pub: null,
    summary_marker: "pkey:summary",
    artifact_policy_json: null,
    // The signature opt-out is operator policy (P0-01), not manifest policy.
    operator_policy_json: JSON.stringify({ requireSparkleSignature: false }),
    metadata_access: "public",
    artifacts_access: "public",
    stable_tag_pattern: null,
    ignore_tags_json: null,
    ...over,
  };
  const cols = Object.keys(row);
  await db.run(
    `INSERT INTO release_config (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...(Object.values(row) as never[]),
  );
}

function product(): Product {
  return {
    slug: SLUG,
    name: SLUG,
    signingKid: "kid",
    signingKeyPem: "pem",
    signingPub: null,
    compatMin: "0.0.0",
    compatMax: "99.0.0",
    defaultMaxOfflineDays: 30,
    defaultDeviceLimit: 5,
    adminGroup: null,
    schemaVersion: 1,
    fingerprintPolicy: DEFAULT_FINGERPRINT_POLICY,
    autoIssue: DEFAULT_AUTO_ISSUE,
    services: DEFAULT_SERVICES,
    registration: "requires-license",
    webOrigins: [],
  };
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return env;
}

interface GitHubState {
  /** The release list, served as pages of `perPage` with `Link: rel="next"` between them. */
  releases: Release[];
  perPage?: number;
  /** Tags `tags/<tag>` answers for (default: every tag in `releases`). */
  byTag?: Record<string, Release>;
  /** Asset bodies by asset id. */
  assets?: Record<number, string>;
  /** Once this many list calls have been served, every further GitHub call answers `fail`. */
  failAfterListCalls?: number;
  fail?: { status: number; headers?: Record<string, string> };
}

/** A GitHub stub over mutable state; `calls` records every URL requested (minus the token). */
function github(state: GitHubState): { fetchImpl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
    calls.push(url);
    const listCalls = calls.filter((c) => /\/releases\?per_page=/.test(c));
    if (
      state.failAfterListCalls !== undefined &&
      listCalls.length > state.failAfterListCalls
    )
      return new Response("upstream", {
        status: state.fail?.status ?? 500,
        headers: state.fail?.headers ?? {},
      });
    const list = url.match(/\/releases\?per_page=\d+(?:&page=(\d+))?$/);
    if (list) {
      const per = state.perPage ?? 100;
      const page = Number(list[1] ?? "1");
      const body = state.releases.slice((page - 1) * per, page * per);
      const headers: Record<string, string> = {};
      if (page * per < state.releases.length)
        headers.Link = `<${API}/releases?per_page=${per}&page=${page + 1}>; rel="next", <${API}/releases?per_page=${per}&page=99>; rel="last"`;
      return new Response(JSON.stringify(body), { status: 200, headers });
    }
    const tag = url.match(/\/releases\/tags\/([^/?]+)$/);
    if (tag && tag[1]) {
      const name = decodeURIComponent(tag[1]);
      const hit =
        state.byTag?.[name] ?? state.releases.find((r) => r.tag_name === name);
      return hit
        ? new Response(JSON.stringify(hit), { status: 200 })
        : new Response("nf", { status: 404 });
    }
    const a = url.match(/\/releases\/assets\/(\d+)$/);
    if (a && state.assets?.[Number(a[1])] !== undefined)
      return new Response(state.assets[Number(a[1])], {
        status: 200,
        headers: {
          "Content-Length": String(state.assets[Number(a[1])]!.length),
        },
      });
    return new Response("nf", { status: 404 });
  };
  return { fetchImpl, calls };
}

const req = (url = `https://key.plrs.im/${SLUG}/update/version`): Request =>
  new Request(url) as unknown as Request;

async function latestVersion(
  env: Env,
  db: Db,
  fetchImpl: FetchImpl,
): Promise<{ status: number; version?: string; cache: string | null }> {
  const res = await handleReleaseSurface(
    req(),
    env,
    db,
    product(),
    "version",
    { version: "latest" },
    fetchImpl,
  );
  const cache = res.headers.get("cache-control");
  if (res.status !== 200) return { status: res.status, cache };
  const body = (await res.json()) as { version: string };
  return { status: 200, version: body.version, cache };
}

// ── Candidate filter + ordering ──────────────────────────────────────────────

describe("candidate filter and version ordering", () => {
  // API order is creation order: `channels` (a rolling non-prerelease release) was touched
  // last, and `v1.4.0` was cut after `v1.10.0` as a backport.
  const RELEASES = [release("channels"), release("v1.4.0"), release("v1.10.0")];

  it("latest is the highest semver candidate, not the newest by API order", async () => {
    const db = makeTestDb();
    await seed(db);
    const gh = github({ releases: RELEASES });
    expect(await latestVersion(envFor(), db, gh.fetchImpl)).toMatchObject({
      status: 200,
      version: "1.10.0",
    });
  });

  it("ignoreTags removes a tag from every moving channel", async () => {
    const db = makeTestDb();
    await seed(db, { ignore_tags_json: JSON.stringify(["v1.10.0"]) });
    const gh = github({ releases: RELEASES });
    expect(await latestVersion(envFor(), db, gh.fetchImpl)).toMatchObject({
      status: 200,
      version: "1.4.0",
    });
  });

  it("a declared stableTagPattern narrows the candidates", async () => {
    const db = makeTestDb();
    await seed(db, { stable_tag_pattern: "v1\\.4\\.\\d+" });
    const gh = github({ releases: RELEASES });
    expect(await latestVersion(envFor(), db, gh.fetchImpl)).toMatchObject({
      version: "1.4.0",
    });
  });

  it("an unsafe stored pattern falls back to the default, never to match-everything", () => {
    const policy = resolutionPolicy({ stable_tag_pattern: "(" });
    const sel = classifyChannel("latest")!;
    expect(resolveChannel(sel, RELEASES, undefined, policy)?.tag_name).toBe(
      "v1.10.0",
    );
  });

  it("ties between tags stripping to one version go to the later published_at", () => {
    const sel = classifyChannel("latest")!;
    const older = release("v1.2.0", { published_at: "2026-01-01T00:00:00Z" });
    const newer = release("1.2.0", { published_at: "2026-02-01T00:00:00Z" });
    expect(resolveChannel(sel, [older, newer])?.tag_name).toBe("1.2.0");
    expect(resolveChannel(sel, [newer, older])?.tag_name).toBe("1.2.0");
  });

  it("the beta prerelease fallback also only considers candidates", () => {
    const sel = classifyChannel("beta")!;
    const releases = [
      release("packs", { prerelease: true }),
      release("v2.0.0-beta.2", { prerelease: true }),
      release("v2.0.0-beta.10", { prerelease: true }),
    ];
    expect(resolveChannel(sel, releases)?.tag_name).toBe("v2.0.0-beta.10");
  });

  it("manual channels keep their own regex but skip ignoreTags", () => {
    const manual = [{ name: "nightly", regex: "nightly-.*" }];
    const sel = classifyChannel("nightly", manual)!;
    const policy = resolutionPolicy({
      ignore_tags_json: JSON.stringify(["nightly-2026-03-01"]),
    });
    const releases = [
      release("nightly-2026-03-01", { published_at: "2026-03-01T00:00:00Z" }),
      release("nightly-2026-02-01", { published_at: "2026-02-01T00:00:00Z" }),
    ];
    // Not semver, so `published_at` orders them; the ignored newest one is skipped.
    expect(resolveChannel(sel, releases)?.tag_name).toBe("nightly-2026-03-01");
    expect(resolveChannel(sel, releases, undefined, policy)?.tag_name).toBe(
      "nightly-2026-02-01",
    );
  });
});

// ── Pagination ───────────────────────────────────────────────────────────────

describe("pagination", () => {
  // 149 prereleases on the newer pages, the one stable release last (page 2).
  const RELEASES = [
    ...Array.from({ length: 149 }, (_, i) =>
      release(`v2.0.0-rc.${149 - i}`, { prerelease: true }),
    ),
    release("v1.0.0"),
  ];

  it("latest resolves when the only stable release is on page 2", async () => {
    const db = makeTestDb();
    await seed(db);
    const gh = github({ releases: RELEASES });
    expect(await latestVersion(envFor(), db, gh.fetchImpl)).toMatchObject({
      status: 200,
      version: "1.0.0",
    });
    // Two list pages, and nothing more: live resolution stops once it has a candidate.
    expect(gh.calls.filter((u) => u.includes("/releases?per_page"))).toEqual([
      `${API}/releases?per_page=100`,
      `${API}/releases?per_page=100&page=2`,
    ]);
  });

  it("a repo whose first page holds a candidate still costs ONE list call", async () => {
    const db = makeTestDb();
    await seed(db);
    const gh = github({ releases: [...RELEASES].reverse() });
    await latestVersion(envFor(), db, gh.fetchImpl);
    expect(
      gh.calls.filter((u) => u.includes("/releases?per_page")),
    ).toHaveLength(1);
  });

  it("live resolution reads at most three pages", async () => {
    const db = makeTestDb();
    await seed(db);
    const gh = github({
      releases: Array.from({ length: 500 }, (_, i) =>
        release(`v3.0.0-rc.${i}`, { prerelease: true }),
      ),
    });
    expect((await latestVersion(envFor(), db, gh.fetchImpl)).status).toBe(404);
    expect(
      gh.calls.filter((u) => u.includes("/releases?per_page")),
    ).toHaveLength(3);
  });

  it("the sync ingests all 150 releases", async () => {
    const db = makeTestDb();
    await seed(db);
    const gh = github({ releases: RELEASES });
    expect(
      await syncReleaseStore(envFor(), db, SLUG, NOW, gh.fetchImpl),
    ).toBeGreaterThan(0);
    expect(await listReleaseMetadata(db, SLUG, 1000)).toHaveLength(150);
    const stable = (await listReleaseChannels(db, SLUG)).find(
      (c) => c.channel === "stable",
    );
    expect(stable?.release_id).toBe("v1.0.0");
  });

  it("stopWhen sees each new page on its own, so live resolution looks at a release once while paging (R10-09)", async () => {
    const gh = github({ releases: RELEASES });
    const seen: Array<[number, number]> = [];
    await listReleases("t", "acme", "djdl", 100, gh.fetchImpl, {
      maxPages: 3,
      stopWhen: (soFar, page) => {
        seen.push([soFar.length, page.length]);
        return false;
      },
    });
    expect(seen).toEqual([
      [100, 100],
      [150, 50],
    ]);
  });

  it("never follows a Link that leaves the GitHub API origin with the token", async () => {
    expect(
      nextPageUrl('<https://evil.example/releases?page=2>; rel="next"'),
    ).toBeNull();
    expect(
      nextPageUrl(
        `<${API}/releases?page=3>; rel="prev", <${API}/releases?page=2>; rel="next"`,
      ),
    ).toBe(`${API}/releases?page=2`);
    const calls: string[] = [];
    const fetchImpl: FetchImpl = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify([release("v1.0.0")]), {
        status: 200,
        headers: { Link: '<https://evil.example/next>; rel="next"' },
      });
    };
    await listReleases("t", "acme", "djdl", 100, fetchImpl, { maxPages: 10 });
    expect(calls).toEqual([`${API}/releases?per_page=100`]);
  });
});

// ── Pinned lookups ───────────────────────────────────────────────────────────

describe("pinned lookups of unprefixed tags", () => {
  const TAG = release("1.2.3", {
    assets: [asset("djdl-arm64.dmg", 501), asset("djdl-arm64", 502)],
  });

  it("serves /release/dl/1.2.3/… for a repo tagging 1.2.3 (no v)", async () => {
    const db = makeTestDb();
    await seed(db);
    const gh = github({ releases: [TAG], assets: { 502: "BINARY" } });
    const res = await handleReleaseSurface(
      req(`https://key.plrs.im/${SLUG}/release/dl/1.2.3/djdl-arm64`),
      envFor(),
      db,
      product(),
      "cli",
      { version: "1.2.3", arch: "arm64" },
      gh.fetchImpl,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("BINARY");
    // `tags/v1.2.3` first, then — only on its 404 — the bare tag.
    expect(gh.calls.filter((u) => u.includes("/releases/tags/"))).toEqual([
      `${API}/releases/tags/v1.2.3`,
      `${API}/releases/tags/1.2.3`,
    ]);
  });

  it("the stable appcast's pinned enclosure resolves", async () => {
    const db = makeTestDb();
    await seed(db);
    const env = envFor();
    const gh = github({ releases: [TAG], assets: { 501: "DMG-BYTES" } });
    const feed = await handleReleaseSurface(
      req(`https://key.plrs.im/${SLUG}/update/appcast.xml`),
      env,
      db,
      product(),
      "appcast",
      { arch: "arm64" },
      gh.fetchImpl,
    );
    expect(feed.status).toBe(200);
    const xml = await feed.text();
    const url = xml.match(/<enclosure url="([^"]+)"/)?.[1];
    expect(url).toBe(
      `https://key.plrs.im/${SLUG}/release/dl/1.2.3/djdl-arm64.dmg`,
    );

    const dmg = await handleReleaseSurface(
      req(url),
      env,
      db,
      product(),
      "dmg",
      { version: "1.2.3", arch: "arm64" },
      gh.fetchImpl,
    );
    expect(dmg.status).toBe(200);
    expect(await dmg.text()).toBe("DMG-BYTES");
  });
});

describe("the appcast refuses a bare-tag / v-tag ambiguity (P2-03)", () => {
  const appcast = (gh: ReturnType<typeof github>, db: Db) =>
    handleReleaseSurface(
      req(`https://key.plrs.im/${SLUG}/update/appcast.xml`),
      envFor(),
      db,
      product(),
      "appcast",
      { arch: "arm64" },
      gh.fetchImpl,
    );

  it("404s when latest picks bare 1.2.0 but the enclosure would resolve v1.2.0", async () => {
    const db = makeTestDb();
    await seed(db);
    // `v1.2.0` was cut first; `1.2.0` re-tagged later and is what `latest` picks.
    const gh = github({
      releases: [
        release("1.2.0", {
          published_at: "2026-01-03T00:00:00Z",
          assets: [asset("djdl-arm64.dmg", 601)],
        }),
        release("v1.2.0", {
          published_at: "2026-01-02T00:00:00Z",
          assets: [asset("djdl-arm64.dmg", 602)],
        }),
      ],
    });
    const res = await appcast(gh, db);
    expect(res.status).toBe(404);
    expect(gh.calls).toContain(`${API}/releases/tags/v1.2.0`);
  });

  it("serves a v-tagged item without the extra lookup", async () => {
    const db = makeTestDb();
    await seed(db);
    const gh = github({
      releases: [
        release("v1.2.0", { assets: [asset("djdl-arm64.dmg", 603)] }),
        release("1.2.0", {
          published_at: "2026-01-01T00:00:00Z",
          assets: [asset("djdl-arm64.dmg", 604)],
        }),
      ],
    });
    const res = await appcast(gh, db);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/release/dl/1.2.0/djdl-arm64.dmg");
    expect(gh.calls.filter((u) => u.includes("/releases/tags/"))).toEqual([]);
  });
});

// ── Upsert conflict ──────────────────────────────────────────────────────────

describe("two tags that strip to the same version", () => {
  it("v1.2.0 and 1.2.0 in one sync both land", async () => {
    const db = makeTestDb();
    await seed(db);
    const gh = github({
      releases: [
        release("v1.2.0", { published_at: "2026-01-02T00:00:00Z" }),
        release("1.2.0", { published_at: "2026-01-01T00:00:00Z" }),
      ],
    });
    expect(
      await syncReleaseStore(envFor(), db, SLUG, NOW, gh.fetchImpl),
    ).toBeGreaterThan(0);
    const rows = await listReleaseMetadata(db, SLUG);
    expect(rows.map((r) => r.release_id).sort()).toEqual(["1.2.0", "v1.2.0"]);
    expect(new Set(rows.map((r) => r.version))).toEqual(new Set(["1.2.0"]));
  });

  it("a stored 1.2.0 row followed by a new v1.2.0 tag resyncs", async () => {
    const db = makeTestDb();
    await seed(db);
    const state: GitHubState = { releases: [release("1.2.0")] };
    const gh = github(state);
    await syncReleaseStore(envFor(), db, SLUG, NOW, gh.fetchImpl);
    // The tag is deleted and re-created with the prefix.
    state.releases = [
      release("v1.2.0", { published_at: "2026-03-01T00:00:00Z" }),
    ];
    await expect(
      syncReleaseStore(envFor(), db, SLUG, NOW + 60, gh.fetchImpl),
    ).resolves.toBeGreaterThan(0);
    const stable = (await listReleaseChannels(db, SLUG)).find(
      (c) => c.channel === "stable",
    );
    expect(stable?.release_id).toBe("v1.2.0");
  });
});

// ── Floors ───────────────────────────────────────────────────────────────────

describe("channel floors (R6-10)", () => {
  it("a sync raises the floor, and never lowers it", async () => {
    const db = makeTestDb();
    await seed(db);
    const state: GitHubState = {
      releases: [release("v2.0.0"), release("v1.0.0")],
    };
    const gh = github(state);
    await syncReleaseStore(envFor(), db, SLUG, NOW, gh.fetchImpl);
    expect(await getChannelFloor(db, SLUG, "stable")).toMatchObject({
      version: "2.0.0",
      release_id: "v2.0.0",
      raised_at: NOW,
    });

    state.releases = [release("v1.0.0")];
    await syncReleaseStore(envFor(), db, SLUG, NOW + 60, gh.fetchImpl);
    expect((await getChannelFloor(db, SLUG, "stable"))?.version).toBe("2.0.0");
    // The truth-store row refuses the downgrade too, and says why.
    const stable = (await listReleaseChannels(db, SLUG)).find(
      (c) => c.channel === "stable",
    );
    expect(stable?.release_id).toBeNull();
    const health = (await listReleaseHealth(db, SLUG)).find(
      (h) => h.subject_kind === "channel" && h.subject_id === "stable",
    );
    expect(health?.status).toBe("blocked");
    expect(JSON.parse(health?.details_json ?? "{}")).toMatchObject({
      regressed: true,
      floor: { version: "2.0.0", releaseId: "v2.0.0" },
      offered: "v1.0.0",
    });

    state.releases = [release("v2.1.0"), release("v1.0.0")];
    await syncReleaseStore(envFor(), db, SLUG, NOW + 120, gh.fetchImpl);
    expect((await getChannelFloor(db, SLUG, "stable"))?.version).toBe("2.1.0");
  });

  it("a page of newer prereleases plus a backport still serves the floor release", async () => {
    const db = makeTestDb();
    await seed(db);
    const env = envFor();
    const state: GitHubState = {
      releases: [release("v2.0.0"), release("v1.9.0")],
    };
    const gh = github(state);
    await syncReleaseStore(env, db, SLUG, NOW, gh.fetchImpl);

    // Page 1 now holds 100 newer prereleases and a v1.9.9 backport; v2.0.0 sits further down.
    state.releases = [
      ...Array.from({ length: 100 }, (_, i) =>
        release(`v2.1.0-rc.${100 - i}`, { prerelease: true }),
      ),
      release("v1.9.9"),
      release("v2.0.0"),
    ];
    state.perPage = 101;
    gh.calls.length = 0;
    expect(await latestVersion(env, db, gh.fetchImpl)).toMatchObject({
      status: 200,
      version: "2.0.0",
    });
    // One list page, then ONE tag lookup for the floor — never the next page.
    expect(gh.calls).toEqual([
      `${API}/releases?per_page=100`,
      `${API}/releases/tags/v2.0.0`,
    ]);
  });

  it("pinned selectors and pr-<n> are never floored", async () => {
    const db = makeTestDb();
    await seed(db);
    const state: GitHubState = {
      releases: [release("v2.0.0"), release("v1.0.0")],
    };
    const gh = github(state);
    await syncReleaseStore(envFor(), db, SLUG, NOW, gh.fetchImpl);
    state.releases = [release("v1.0.0")];
    const pinned = await handleReleaseSurface(
      req(),
      envFor(),
      db,
      product(),
      "version",
      { version: "1.0.0" },
      gh.fetchImpl,
    );
    expect(pinned.status).toBe(200);
    expect(((await pinned.json()) as { version: string }).version).toBe(
      "1.0.0",
    );
  });

  it("health reports channel-regressed only when the floor release is gone", async () => {
    const db = makeTestDb();
    await seed(db);
    const env = envFor();
    const state: GitHubState = {
      releases: [release("v2.0.0"), release("v1.0.0")],
    };
    const gh = github(state);
    await syncReleaseStore(env, db, SLUG, NOW, gh.fetchImpl);

    // Still there (just off the page health read): no regression.
    state.releases = [release("v1.0.0")];
    state.byTag = { "v2.0.0": release("v2.0.0") };
    let health = await checkReleaseHealth(env, db, SLUG, NOW, gh.fetchImpl);
    expect(health.checks.map((c) => c.id)).not.toContain("channel-regressed");
    expect(health.release?.tag).toBe("v2.0.0");

    // Gone: an error naming the floor and what the list now offers.
    state.byTag = {};
    health = await checkReleaseHealth(env, db, SLUG, NOW, gh.fetchImpl);
    const regressed = health.checks.find((c) => c.id === "channel-regressed");
    expect(regressed?.status).toBe("error");
    expect(regressed?.message).toContain("2.0.0 (v2.0.0)");
    expect(regressed?.message).toContain("offers v1.0.0");
    expect(health.status).toBe("error");
  });

  it.each([
    ["quota exhaustion", 403, { "X-RateLimit-Remaining": "0" }],
    ["an upstream 500", 500, {}],
  ] as const)(
    "health survives %s while verifying a non-stable floor",
    async (_label, status, headers) => {
      const db = makeTestDb();
      await seed(db);
      const env = envFor();
      const state: GitHubState = {
        releases: [
          release("v2.1.0-rc.1", { prerelease: true }),
          release("v2.0.0"),
        ],
      };
      const gh = github(state);
      await syncReleaseStore(env, db, SLUG, NOW, gh.fetchImpl);
      expect((await getChannelFloor(db, SLUG, "beta"))?.version).toBe(
        "2.1.0-rc.1",
      );

      // The rc was promoted: page 1 holds no prerelease, so beta LOOKS below its floor and
      // health pays for a second resolution, whose first GitHub call fails.
      state.releases = [release("v2.1.0"), release("v2.0.0")];
      state.failAfterListCalls =
        gh.calls.filter((c) => c.includes("/releases?per_page=")).length + 1;
      state.fail = { status, headers };
      const health = await checkReleaseHealth(env, db, SLUG, NOW, gh.fetchImpl);
      expect(health.release?.tag).toBe("v2.1.0");
      expect(health.checks.map((c) => c.id)).not.toContain("channel-regressed");
      const unverified = health.checks.find(
        (c) => c.id === "channel-floor-unverified-beta",
      );
      expect(unverified?.status).toBe("warning");
      expect(unverified?.message).toContain("2.1.0-rc.1");
      expect(
        health.checks.find((c) => c.id === "channel-regressed-beta"),
      ).toBeUndefined();
    },
  );

  it("the admin floor endpoint lowers but never raises, clears, and refuses unfloored channels", async () => {
    const db = makeTestDb();
    await seed(db);
    const env = envFor();
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "platform-admins";
    const gh = github({ releases: [release("v2.0.0"), release("v1.0.0")] });
    await syncReleaseStore(env, db, SLUG, NOW, gh.fetchImpl);
    const { token, session } = await issueSession(
      env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const post = (channel: string, body: unknown) => {
      const path = `/api/products/${SLUG}/release/channels/${channel}/floor`;
      return handleAdmin(
        new Request(`https://key.plrs.im/manage${path}`, {
          method: "POST",
          headers: {
            cookie: `${ADMIN_COOKIE}=${token}`,
            [CSRF_HEADER]: session.csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }) as unknown as Request,
        env,
        db,
        path,
        { now: NOW },
      );
    };

    expect((await post("stable", { version: "3.0.0" })).status).toBe(422);
    expect(
      (await post("stable", { version: "1.0.0", clear: true })).status,
    ).toBe(422);
    expect((await post("stable", { version: "not-semver" })).status).toBe(422);
    expect((await post("nope", { clear: true })).status).toBe(404);
    expect((await getChannelFloor(db, SLUG, "stable"))?.version).toBe("2.0.0");

    const lowered = await post("stable", { version: "1.0.0" });
    expect(lowered.status).toBe(200);
    expect(await getChannelFloor(db, SLUG, "stable")).toMatchObject({
      version: "1.0.0",
      release_id: "v1.0.0",
      lowered_by: "ada@x.io",
      lowered_at: NOW,
    });

    expect((await post("stable", { clear: true })).status).toBe(200);
    expect(await getChannelFloor(db, SLUG, "stable")).toBeNull();
    const audit = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ? AND action = ?",
      SLUG,
      "release.channel.floor",
    );
    expect(audit).toHaveLength(2);
  });

  it("a stranded floor (channel removed, or no longer floored) can be cleared but not lowered", async () => {
    const db = makeTestDb();
    await seed(db);
    const env = envFor();
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "platform-admins";
    const { token, session } = await issueSession(
      env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const post = (channel: string, body: unknown) => {
      const path = `/api/products/${SLUG}/release/channels/${channel}/floor`;
      return handleAdmin(
        new Request(`https://key.plrs.im/manage${path}`, {
          method: "POST",
          headers: {
            cookie: `${ADMIN_COOKIE}=${token}`,
            [CSRF_HEADER]: session.csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }) as unknown as Request,
        env,
        db,
        path,
        { now: NOW },
      );
    };
    // `nightly` was a manual channel once; `beta` was floored before a channel workflow existed.
    for (const channel of ["nightly", "beta"])
      await db.run(
        `INSERT INTO release_channel_floors (product, channel, version, release_id, raised_at)
         VALUES (?, ?, '2.0.0', NULL, ?)`,
        SLUG,
        channel,
        NOW,
      );
    await db.run(
      "UPDATE release_config SET channel_workflow = 'release.yml' WHERE product = ?",
      SLUG,
    );

    expect((await post("nightly", { version: "1.0.0" })).status).toBe(422);
    expect((await post("beta", { version: "1.0.0" })).status).toBe(422);
    expect((await getChannelFloor(db, SLUG, "beta"))?.version).toBe("2.0.0");

    expect((await post("nightly", { clear: true })).status).toBe(200);
    expect((await post("beta", { clear: true })).status).toBe(200);
    expect(await getChannelFloor(db, SLUG, "nightly")).toBeNull();
    expect(await getChannelFloor(db, SLUG, "beta")).toBeNull();
    // Once cleared, an unknown channel is unknown again, and an unfloored one is refused.
    expect((await post("nightly", { clear: true })).status).toBe(404);
    expect((await post("beta", { clear: true })).status).toBe(422);
  });
});
