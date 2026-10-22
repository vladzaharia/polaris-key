/**
 * P2-12.5 (plans/P2-12.md §6.3, §6.1): the `/release/dl` store step, `?checksum=sha256`, the
 * Sparkle sidecar and DMG reads, and the health store step.
 *
 * The legacy and store steps run the same synthetic probes against one synced world. Where the
 * bytes come from is the point of this file: the store step makes no GitHub call while serving
 * beyond the installation token and a read of one asset by id, and none at all once Polaris Key
 * holds a copy of the file. `noGitHub` is the proof: a fetch that throws on any other GitHub
 * request.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW } from "./seed.js";
import { setAssetHosting } from "./hostedFixture.js";
import {
  ASSET_BYTES,
  envFor,
  github,
  release,
  seedReleaseProduct,
  sha256Hex,
  SLUG,
} from "./releaseRoutesFixture.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { loadProduct } from "../src/core/products.js";
import { handleAssetQueue } from "../src/assetQueue.js";
import { syncReleaseStoreReport } from "../src/services/release/sync.js";
import { checkReleaseHealth } from "../src/services/release/health.js";
import { getReleaseConfig } from "../src/services/release/config.js";
import { releaseMirrorEnabled } from "../src/services/release/mirrorSwitch.js";
import type { Release, ReleaseAsset } from "../src/services/release/github.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import {
  buildDownloadProbes,
  buildProbes,
  classifyDifference,
  probeChannels,
  runProbe,
  sameOutcome,
  type Probe,
  type ProbeOutcome,
  type ResolverClass,
} from "../src/services/update/resolverCompare.js";
import type { SurfaceContext } from "../src/services/release/surface.js";

beforeAll(() => installDigestStream());

// ── Fixture: a release with a CLI, a DMG, a Sparkle signature and checksum sidecars ──────────

const text = (s: string) => new TextEncoder().encode(s);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = Buffer.from(
  publicKey.export({ format: "jwk" }).x as string,
  "base64url",
).toString("base64");

ASSET_BYTES[211] = text(`${sha256Hex(ASSET_BYTES[201]!)}  djdl-arm64\n`);
ASSET_BYTES[212] = text(
  `${sha256Hex(ASSET_BYTES[202]!)}  djdl-1.1.0-arm64.dmg\n`,
);
ASSET_BYTES[213] = text(
  sign(null, ASSET_BYTES[202]!, privateKey).toString("base64"),
);

function asset(id: number, name: string): ReleaseAsset {
  const bytes = ASSET_BYTES[id]!;
  return {
    id,
    name,
    size: bytes.length,
    content_type: "text/html",
    browser_download_url: `https://github.com/acme/djdl/releases/download/x/${name}`,
    digest: `sha256:${sha256Hex(bytes)}`,
  };
}

const RELEASES = (): Release[] => [
  release(
    "v1.1.0",
    [
      asset(201, "djdl-arm64"),
      asset(202, "djdl-1.1.0-arm64.dmg"),
      asset(211, "djdl-arm64.sha256"),
      asset(212, "djdl-1.1.0-arm64.dmg.sha256"),
      asset(213, "djdl-1.1.0-arm64.dmg.sig"),
    ],
    { published_at: "2026-01-03T03:04:05Z" },
  ),
  release(
    "v1.0.0",
    [asset(101, "djdl-arm64"), asset(102, "djdl-1.0.0-arm64.dmg")],
    { published_at: "2026-01-02T03:04:05Z" },
  ),
];

const ALLOWED_GITHUB = [
  /^\/app\/installations\/\d+\/access_tokens$/,
  /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/,
];

/** A fetch that throws on any GitHub request but a token exchange or one asset read by id. */
function noGitHub(
  inner: FetchImpl,
  seen: string[],
  allowListPage = false,
): FetchImpl {
  return async (input, init) => {
    const url = input;
    const u = new URL(url);
    seen.push(url);
    if (u.hostname === "github.com" || u.hostname.endsWith(".github.com")) {
      const listPage =
        allowListPage && /^\/repos\/[^/]+\/[^/]+\/releases$/.test(u.pathname);
      if (!listPage && !ALLOWED_GITHUB.some((re) => re.test(u.pathname)))
        throw new Error(`GitHub call while serving: ${url}`);
    }
    return inner(input, init);
  };
}

interface World {
  db: Db;
  env: Env;
  r2: R2Mock;
  state: { releases: Release[] };
  fetchImpl: FetchImpl;
  ctx: (fetchImpl?: FetchImpl) => Promise<Omit<SurfaceContext, "params">>;
  probes: Probe[];
  dlProbes: Probe[];
}

async function world(
  opts: { mirror?: boolean; sparkle?: boolean; releases?: Release[] } = {},
): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db, {
    ...(opts.sparkle ? { sparkle_ed25519_pub: PUB } : {}),
  });
  const r2 = new R2Mock();
  const env = envFor();
  env.BLOBS = asR2(r2);
  const sent: unknown[] = [];
  env.HOSTED_ASSET_QUEUE = {
    async sendBatch(msgs: Iterable<{ body: unknown }>) {
      for (const m of msgs) sent.push(m.body);
    },
    async send(body: unknown) {
      sent.push(body);
    },
  } as unknown as Queue<unknown>;
  const state = { releases: opts.releases ?? RELEASES() };
  const gh = github(state);
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = input;
    const u = new URL(url);
    const headers = new Headers(init?.headers);
    const id = /\/releases\/assets\/(\d+)$/.exec(u.pathname)?.[1];
    if (
      id &&
      u.hostname === "api.github.com" &&
      (headers.get("accept") ?? "").includes("application/vnd.github+json")
    ) {
      const found = state.releases
        .flatMap((r) => r.assets)
        .find((a) => a.id === Number(id));
      return found
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response("nf", { status: 404 });
    }
    return gh.fetchImpl(url, {
      ...init,
      headers: Object.fromEntries(headers.entries()),
    });
  };
  await syncReleaseStoreReport(env, db, SLUG, NOW, fetchImpl);
  if (opts.mirror) {
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
    expect(r2.has(`blobs/sha256/${sha256Hex(ASSET_BYTES[201]!)}`)).toBe(true);
  }
  const cfg = (await getReleaseConfig(db, SLUG))!;
  const channels = await probeChannels(db, cfg);
  const set = { channels, stableVersion: "1.1.0" };
  return {
    db,
    env,
    r2,
    state,
    fetchImpl,
    probes: buildProbes(set),
    dlProbes: buildDownloadProbes(set),
    ctx: async (f = fetchImpl) => ({
      req: new Request(`https://key.example.test/${SLUG}/release/dl/latest`),
      env,
      db,
      product: (await loadProduct(env, db, SLUG))!,
      cfg,
      origin: "https://key.example.test",
      now: NOW,
      fetchImpl: f,
    }),
  };
}

interface Pair {
  probe: Probe;
  old: ProbeOutcome;
  new: ProbeOutcome;
  class: ResolverClass;
}

/** The legacy step on the plain GitHub stub; the store step on `storeFetch`. */
async function pairs(
  w: World,
  probes: Probe[],
  storeFetch: FetchImpl,
): Promise<Pair[]> {
  const out: Pair[] = [];
  for (const probe of probes) {
    const o = await runProbe("legacy", probe, await w.ctx());
    const n = await runProbe("store", probe, await w.ctx(storeFetch));
    out.push({
      probe,
      old: o,
      new: n,
      class: await classifyDifference(
        w.db,
        (await getReleaseConfig(w.db, SLUG))!,
        probe,
        o,
        n,
      ),
    });
  }
  return out;
}

const label = (p: Pair) => `${p.probe.surface} ${p.probe.probe}`;
const differing = (rows: Pair[]) =>
  Object.fromEntries(
    rows.filter((r) => r.class !== "identical").map((r) => [label(r), r.class]),
  );

const githubCalls = (seen: string[]) =>
  seen.filter((u) => /(^|\.)github\.com$/.test(new URL(u).hostname));

describe("the /dl probe list", () => {
  it("is cli and dmg x arm64 and x86_64 x plain and checksum, per selector", () => {
    const names = buildDownloadProbes({
      channels: ["beta"],
      stableVersion: "1.2.0",
    }).map((p) => p.probe);
    expect(names).toHaveLength(3 * 8);
    expect(names.slice(0, 8)).toEqual([
      "latest/cli-arm64",
      "latest/cli-arm64?checksum=sha256",
      "latest/cli-x86_64",
      "latest/cli-x86_64?checksum=sha256",
      "latest/dmg-arm64",
      "latest/dmg-arm64?checksum=sha256",
      "latest/dmg-x86_64",
      "latest/dmg-x86_64?checksum=sha256",
    ]);
    expect(names.some((n) => n.startsWith("1.2.0/"))).toBe(true);
  });
});

describe("/release/dl: the store step equals the legacy step", () => {
  it("is identical, GitHub-streamed, with only token and asset reads from GitHub", async () => {
    const w = await world();
    const seen: string[] = [];
    const rows = await pairs(w, w.dlProbes, noGitHub(w.fetchImpl, seen));
    // The beta and staging selectors differ only by D6's convergence (the store's beta includes
    // stable); nothing else differs.
    const diff = differing(rows);
    for (const [k, c] of Object.entries(diff)) {
      expect(k).toMatch(/^download (beta|staging)\//);
      expect(c).toBe("beta-includes-stable");
    }
    const by = Object.fromEntries(rows.map((r) => [label(r), r]));
    // Real answers: the CLI and the DMG, plain and as a checksum, on `latest` and pinned.
    for (const sel of ["latest", "1.1.0"]) {
      expect(by[`download ${sel}/cli-arm64`]!.new.status).toBe(200);
      expect(by[`download ${sel}/dmg-arm64`]!.new.status).toBe(200);
      expect(by[`download ${sel}/cli-arm64?checksum=sha256`]!.new.status).toBe(
        200,
      );
      expect(by[`download ${sel}/cli-x86_64`]!.new.status).toBe(404);
    }
    expect(by["download latest/cli-arm64"]!.new.version).toBe("1.1.0");
    expect(by["download latest/cli-arm64"]!.new).toEqual(
      by["download latest/cli-arm64"]!.old,
    );
    // The mirror is off in this world: every GitHub call the store step made was a token or an
    // asset by id (noGitHub would have thrown on a list, a tag or a run).
    expect(githubCalls(seen).length).toBeGreaterThan(0);
  });

  it("serves a file Polaris Key holds from R2 with no GitHub call at all", async () => {
    const w = await world({ mirror: true });
    const seen: string[] = [];
    const rows = await pairs(w, w.dlProbes, noGitHub(w.fetchImpl, seen));
    for (const [k] of Object.entries(differing(rows)))
      expect(k).toMatch(/^download (beta|staging)\//);
    const ok = rows.filter((r) => r.new.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(8);
    for (const r of ok)
      expect(
        sameOutcome(r.old, r.new) || /beta|staging/.test(r.probe.probe),
      ).toBe(true);
    // The store step touched no GitHub host: not even a token.
    expect(githubCalls(seen)).toEqual([]);
  });

  it("serves the checksum sidecar's digest, and 404s a release with none", async () => {
    const w = await world({ mirror: true });
    const ctx = await w.ctx();
    const get = async (selector: string, name: string) => {
      const probe: Probe = {
        surface: "download",
        probe: `${selector}/${name}`,
        selector,
        params: {},
        download: { format: "cli", arch: "arm64", checksum: true },
      };
      return runProbe("store", probe, ctx);
    };
    const hit = await get("1.1.0", "cli");
    expect(hit.status).toBe(200);
    // The body is the bare lower-case digest of the CLI, from the sidecar's R2 copy.
    expect(hit.bodySha256).toBe(
      sha256Hex(text(`${sha256Hex(ASSET_BYTES[201]!)}\n`)),
    );
    // 1.0.0 published no `.sha256`.
    expect((await get("1.0.0", "cli")).status).toBe(404);
  });

  it("falls back to GitHub by asset id when mirroring is off", async () => {
    const w = await world({ mirror: true });
    await setAssetHosting(w.env, w.db, "off");
    const seen: string[] = [];
    const probe = w.dlProbes.find((p) => p.probe === "latest/cli-arm64")!;
    const out = await runProbe(
      "store",
      probe,
      await w.ctx(noGitHub(w.fetchImpl, seen)),
    );
    expect(out.status).toBe(200);
    expect(
      githubCalls(seen).some((u) => /\/releases\/assets\/201$/.test(u)),
    ).toBe(true);
  });
});

describe("the Sparkle appcast reads its sidecar and DMG from the store", () => {
  it("verifies from R2 with no GitHub call", async () => {
    const w = await world({ mirror: true, sparkle: true });
    const seen: string[] = [];
    const rows = await pairs(
      w,
      w.probes.filter((p) => p.surface === "appcast"),
      noGitHub(w.fetchImpl, seen),
    );
    expect(differing(rows)).toEqual({});
    const stable = rows.find((r) => r.probe.probe === "stable?arch=arm64")!;
    expect(stable.new.status).toBe(200);
    expect(githubCalls(seen)).toEqual([]);
  });

  it("falls back to the asset by id, with nothing else from GitHub", async () => {
    const w = await world({ sparkle: true });
    const seen: string[] = [];
    const rows = await pairs(
      w,
      w.probes.filter((p) => p.surface === "appcast"),
      noGitHub(w.fetchImpl, seen),
    );
    expect(differing(rows)).toEqual({});
    expect(
      rows.find((r) => r.probe.probe === "stable?arch=arm64")!.new.status,
    ).toBe(200);
    expect(githubCalls(seen).length).toBeGreaterThan(0);
  });

  it("refuses a signature that does not cover the DMG, as the legacy step does", async () => {
    const releases = RELEASES();
    ASSET_BYTES[214] = text(
      sign(null, text("something else"), privateKey).toString("base64"),
    );
    releases[0]!.assets = releases[0]!.assets.map((a) =>
      a.id === 213 ? asset(214, a.name) : a,
    );
    const w = await world({ mirror: true, sparkle: true, releases });
    const rows = await pairs(
      w,
      w.probes.filter((p) => p.surface === "appcast"),
      w.fetchImpl,
    );
    expect(differing(rows)).toEqual({});
    expect(
      rows.find((r) => r.probe.probe === "stable?arch=arm64")!.new.status,
    ).toBe(404);
  });
});

describe("health: the store step", () => {
  const ids = (h: { checks: { id: string; status: string }[] }) =>
    h.checks.map((c) => `${c.id}:${c.status}`);

  it("answers as the legacy step does, reading one list page and nothing else", async () => {
    const w = await world({ sparkle: true });
    const legacy = await checkReleaseHealth(
      w.env,
      w.db,
      SLUG,
      NOW,
      w.fetchImpl,
    );
    const seen: string[] = [];
    const store = await checkReleaseHealth(
      w.env,
      w.db,
      SLUG,
      NOW,
      noGitHub(w.fetchImpl, seen, true),
      "store",
    );
    expect(ids(store)).toEqual(ids(legacy));
    expect(store.release).toEqual(legacy.release);
    expect(store.checks.find((c) => c.id === "latest-release")?.message).toBe(
      legacy.checks.find((c) => c.id === "latest-release")?.message,
    );
    const lists = githubCalls(seen).filter((u) => /\/releases\?/.test(u));
    expect(lists).toHaveLength(1);
    expect(
      githubCalls(seen).filter((u) => /\/releases\/tags|\/actions\//.test(u)),
    ).toEqual([]);
  });

  it("reports a regressed floor from the store, naming both sides", async () => {
    const w = await world();
    // v1.1.0 disappears upstream; the sync sees it gone.
    w.state.releases = w.state.releases.filter((r) => r.tag_name !== "v1.1.0");
    await syncReleaseStoreReport(w.env, w.db, SLUG, NOW + 5, w.fetchImpl);
    const seen: string[] = [];
    const store = await checkReleaseHealth(
      w.env,
      w.db,
      SLUG,
      NOW + 5,
      noGitHub(w.fetchImpl, seen, true),
      "store",
    );
    const regressed = store.checks.find((c) => c.id === "channel-regressed");
    expect(regressed?.status).toBe("error");
    expect(regressed?.message).toContain("1.1.0 (v1.1.0)");
    expect(regressed?.message).toContain("offers v1.0.0");
    expect(store.status).toBe("error");
  });
});

describe("beta-includes-stable is only a widening", () => {
  const outcome = (status: number, version: string | null): ProbeOutcome => ({
    status,
    contentType: "application/json",
    cacheControl: null,
    bodySha256: version ? sha256Hex(text(version)) : null,
    version,
  });

  async function classify(old: ProbeOutcome, next: ProbeOutcome) {
    const w = await world({
      releases: [
        release("v2.0.0", [asset(101, "djdl-arm64")], {
          published_at: "2026-01-02T03:04:05Z",
        }),
        release("v2.0.0-rc1", [asset(102, "djdl-arm64")], {
          published_at: "2026-01-01T03:04:05Z",
          prerelease: true,
        }),
        release("v2.1.0-rc1", [asset(201, "djdl-arm64")], {
          published_at: "2026-01-03T03:04:05Z",
          prerelease: true,
        }),
      ],
    });
    const probe = w.probes.find(
      (p) => p.surface === "version" && p.selector === "beta",
    )!;
    return classifyDifference(
      w.db,
      (await getReleaseConfig(w.db, SLUG))!,
      probe,
      old,
      next,
    );
  }

  it("is unexpected when the legacy beta has the newer prerelease and the store an older stable", async () => {
    expect(
      await classify(outcome(200, "2.1.0-rc1"), outcome(200, "2.0.0")),
    ).toBe("unexpected");
  });

  it("stays expected when the legacy beta found nothing and the store has a stable", async () => {
    expect(await classify(outcome(404, null), outcome(200, "2.0.0"))).toBe(
      "beta-includes-stable",
    );
  });

  it("stays expected when the store's stable is newer than the legacy beta's prerelease", async () => {
    expect(
      await classify(outcome(200, "2.0.0-rc1"), outcome(200, "2.0.0")),
    ).toBe("beta-includes-stable");
  });
});
