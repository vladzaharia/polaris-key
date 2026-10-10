/**
 * P2b-05 — storefront feeds (`services/distribution/feeds/`), driven through the real dispatcher
 * against a Diceroll-shaped product: an AltStore source, an AltStore PAL source, an Obtainium
 * outlet, an F-Droid repository, a direct outlet covering Windows (Scoop) and a Flathub outlet.
 *
 * The releases, all ingested through the real descriptor ingest (so `builds[].metadata` is the
 * stored, validated shape):
 *
 *     1.0.0        stable
 *     1.1.0        stable
 *     1.1.1        stable   YANKED
 *     1.2.0-beta.1 beta
 *     1.2.0        stable   halted on altstore, 5000 bp on fdroid-repo, paused on direct;
 *                           never reported live on altstore-pal (a store outlet)
 *
 * so every feed shows the previous release where 1.2.0 is held back, beta includes stable, and
 * 1.1.1 never appears. The rendered documents are compared against golden files under
 * `test/fixtures/feeds/` (`UPDATE_FEED_GOLDENS=1` rewrites them).
 *
 * The `pkeyci_` lookup (`lookupCiToken` in `core/publisher.ts`) is mocked, as in the other CI-route suites.
 *
 * HA-07: with an image host and hosted copies, the AltStore sources name the copies
 * (`altstore-stable-hosted.json`); the golden files above have no image host, so they hold the
 * developer's URLs exactly as before.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(
  () =>
    new Map<
      string,
      {
        product: string;
        subject: string;
        scopes: readonly string[];
        tokenHash: string;
        expiresAt: number;
      }
    >(),
);
vi.mock("../src/core/publisher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/publisher.js")>()),
  lookupCiToken: async (_env: unknown, _db: unknown, token: string) =>
    tokens.get(token) ?? null,
}));

import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { seedDeliveryAccess } from "./releaseSurface.js";
import { enableServices } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { dispatch } from "../src/dispatch.js";
import { ingestReleaseDescriptor } from "../src/services/release/descriptor.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import {
  upsertDeliverable,
  yankRelease,
} from "../src/services/release/model.js";
import {
  blobKey,
  putVerified,
  recordObject,
  recordRef,
  stagingKey,
} from "../src/core/assets/blobs.js";
import { issueUploadTicket } from "../src/core/publisher.js";
import { feedFileType } from "../src/services/distribution/feeds/fdroid.js";
import {
  buildMatchesOutlet,
  MAX_FEED_SCAN,
  MAX_FEED_VERSIONS,
  pickOutlet,
  selectFeed,
  type FeedSpec,
} from "../src/services/distribution/feeds/select.js";
import { buildHooks } from "../src/core/hooks.js";
import { feedStateStamp } from "../src/services/distribution/feeds/cache.js";
import { hostedArtStamp } from "../src/services/distribution/feeds/art.js";
import { seedHosted, setAssetHosting } from "./hostedFixture.js";
import { loadProduct } from "../src/core/products.js";
import { SERVICES } from "../src/mount.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, "fixtures", "feeds");
const SLUG = "diceroll";
const CONSOLE = "https://key.example.test";
const BYTES = "https://dl.example.test";
const FEEDER = "pkeyci_feeder";
const PUBLISHER = "pkeyci_publisher";
const SIGNER = "c".repeat(64);

const sha = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  tokens.clear();
  tokens.set(FEEDER, {
    product: SLUG,
    subject: "static:tok_feeds",
    scopes: ["distribution:feeds"],
    tokenHash: "hash-feeder",
    expiresAt: NOW + 3600,
  });
  tokens.set(PUBLISHER, {
    product: SLUG,
    subject: "static:tok_pub",
    scopes: ["release:publish"],
    tokenHash: "hash-publisher",
    expiresAt: NOW + 3600,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

// ── The product ──────────────────────────────────────────────────────────────────────────────

const ARTIFACTS = [
  ["ipa-sideload", "ios", "arm64", "ipa", "Diceroll-*-ios-sideload.ipa"],
  ["apk", "android", "universal", "apk", "Diceroll-*-android.apk"],
  ["win-x64", "windows", "x86_64", "zip", "Diceroll-*-windows-x86_64.zip"],
  ["win-arm64", "windows", "arm64", "zip", "Diceroll-*-windows-arm64.zip"],
  ["linux-x64", "linux", "x86_64", "tar.gz", "Diceroll-*-linux-x86_64.tar.gz"],
  ["linux-arm64", "linux", "arm64", "tar.gz", "Diceroll-*-linux-arm64.tar.gz"],
].map(([id, platform, arch, format, match]) => ({
  id: id!,
  platform: platform!,
  arch: arch!,
  format: format!,
  match: match!,
}));

const PRODUCT_DOC = {
  slug: SLUG,
  name: "Diceroll",
  modules: {
    license: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
  },
};

function appDeclaration() {
  const res = parseManifest({
    product: JSON.stringify(PRODUCT_DOC),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify({
      release: {
        provider: { type: "github", owner: "vladzaharia", repo: "diceroll" },
        binaryName: "diceroll",
        deliverables: {
          app: {
            kind: "app",
            versioning: { scheme: "semver", buildNumber: "descriptor" },
            channels: { beta: { includes: ["stable"] } },
            artifacts: ARTIFACTS,
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!.app!;
}

const LISTING = {
  name: "Diceroll",
  subtitle: "A cozy dice-rolling roguelite",
  description: "Roll, reroll, repeat.",
  iconUrl: "https://cdn.example.test/diceroll/icon.png",
  tintColor: "#3b1f1f",
  category: "games",
  website: "https://diceroll.example.test",
  developerName: "Vlad",
};

const OUTLETS: Array<[string, string, Record<string, unknown>]> = [
  [
    "altstore",
    "altstore",
    { artifact: "ipa-sideload", bundleId: "gg.vlad.diceroll" },
  ],
  [
    "altstore-pal",
    "altstore-pal",
    { bundleId: "gg.vlad.diceroll", marketplaceId: "6740000001" },
  ],
  [
    "obtainium",
    "obtainium",
    { artifact: "apk", packageName: "gg.vlad.diceroll" },
  ],
  [
    "fdroid-repo",
    "fdroid-repo",
    { artifact: "apk", packageName: "gg.vlad.diceroll" },
  ],
  [
    "direct",
    "direct",
    {
      platforms: ["macos", "windows", "linux"],
      scoop: {
        bin: "Diceroll/diceroll.exe",
        shortcuts: [["Diceroll/diceroll.exe", "Diceroll"]],
      },
    },
  ],
  ["flathub", "flathub", { appId: "gg.vlad.Diceroll" }],
];

interface World {
  env: Env;
  db: Db;
  r2: R2Mock;
}

async function addOutlets(db: Db): Promise<void> {
  for (const [id, kind, identity] of OUTLETS)
    await db.run(
      `INSERT INTO dist_outlets
         (product, outlet_id, kind, identity_json, listing_json, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      SLUG,
      id,
      kind,
      JSON.stringify(identity),
      JSON.stringify(LISTING),
      NOW,
      NOW,
    );
}

/** One file's fixture bytes, deterministic per name. */
function bytesFor(name: string): Uint8Array {
  return new TextEncoder().encode(`bytes of ${name}\n`);
}

/** The seeded releases' version codes; any other `a.b.c` is a*10000 + b*100 + c. */
const VERSION_CODES: Record<string, number> = {
  "1.0.0": 10000,
  "1.1.0": 10100,
  "1.1.1": 10101,
  "1.2.0-beta.1": 10199,
  "1.2.0": 10200,
};

function versionCode(version: string): number {
  const [a, b, c] = version.split(".").map((n) => parseInt(n, 10));
  return VERSION_CODES[version] ?? a! * 10000 + b! * 100 + c!;
}

function metadataFor(
  buildId: string,
  version: string,
): Record<string, unknown> | undefined {
  if (buildId === "ipa-sideload")
    return {
      bundleIdentifier: "gg.vlad.diceroll",
      version,
      buildVersion: String(versionCode(version)),
      minOSVersion: "16.0",
      appPermissions: {
        entitlements: ["get-task-allow", "com.apple.developer.game-center"],
        privacy: { NSCameraUsageDescription: "Scan a friend's dice code." },
      },
    };
  if (buildId === "apk")
    return {
      packageName: "gg.vlad.diceroll",
      versionCode: versionCode(version),
      versionName: version,
      minSdk: 24,
      targetSdk: 35,
      nativecode: ["arm64-v8a", "armeabi-v7a"],
      signerSha256: SIGNER,
    };
  return undefined;
}

const DAY = 86400;
const RELEASES: Array<[string, "stable" | "beta", number]> = [
  ["1.0.0", "stable", NOW - 40 * DAY],
  ["1.1.0", "stable", NOW - 30 * DAY],
  ["1.1.1", "stable", NOW - 25 * DAY],
  ["1.2.0-beta.1", "beta", NOW - 20 * DAY],
  ["1.2.0", "stable", NOW - 10 * DAY],
];

async function publish(
  w: World,
  version: string,
  channel: string,
  at: number,
  only?: readonly string[],
) {
  const builds = ARTIFACTS.filter((a) => !only || only.includes(a.id)).map(
    (a) => {
      const name = a.match.replace("*", version);
      const bytes = bytesFor(name);
      const meta = metadataFor(a.id, version);
      return {
        id: a.id,
        platform: a.platform,
        arch: a.arch,
        format: a.format,
        ...(meta ? { metadata: meta } : {}),
        artifacts: [
          {
            name,
            role: "payload",
            sha256: sha(bytes),
            size: bytes.length,
            locations: [{ provider: "r2", key: blobKey(sha(bytes)) }],
          },
        ],
      };
    },
  );
  const promoted: string[] = [];
  for (const b of builds) {
    const a = b.artifacts[0]!;
    await recordObject(
      w.db,
      {
        storageKey: a.locations[0]!.key,
        sha256: a.sha256,
        size: a.size,
        kind: "blob",
        gated: false,
      },
      NOW,
    );
    promoted.push(a.locations[0]!.key);
  }
  const res = await ingestReleaseDescriptor(
    w.db,
    w.env,
    SLUG,
    {
      descriptorVersion: 1,
      product: SLUG,
      deliverable: "app",
      kind: "app",
      version,
      channel,
      title: `Diceroll ${version}`,
      notes: `What's new in ${version}.`,
      publishedAt: new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      builds,
    },
    { source: "ci", now: NOW, promoted },
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
}

async function rollout(
  w: World,
  outlet: string,
  releaseId: string,
  bp: number,
  state: string,
): Promise<void> {
  await w.db.run(
    `INSERT INTO dist_rollouts
       (product, deliverable_id, outlet_id, channel, release_id, rollout_bp, rollout_salt, state,
        mirrored, source, started_at, updated_at, updated_by)
     VALUES (?, 'app', ?, 'stable', ?, ?, ?, ?, 0, 'admin', ?, ?, 'admin:u1')`,
    SLUG,
    outlet,
    releaseId,
    bp,
    "0".repeat(32),
    state,
    NOW,
    NOW,
  );
}

async function reportLive(
  w: World,
  releaseId: string,
  outlet: string,
): Promise<void> {
  await w.db.run(
    `INSERT INTO dist_availability
       (product, release_id, build_id, outlet_id, transport, state, since, source, updated_at)
     VALUES (?, ?, '', ?, 'pkey-cdn', 'live', ?, 'ci', ?)`,
    SLUG,
    releaseId,
    outlet,
    NOW,
    NOW,
  );
}

async function setup(opts: { blobOrigin?: string } = {}): Promise<World> {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  await enableServices(db, true, SLUG);
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, beta_branch, binary_name, summary_marker,
        metadata_access, artifacts_access)
     VALUES (?, 'vladzaharia', 'diceroll', 42, 'main', 'diceroll', 'pkey:summary', 'public', 'public')`,
    SLUG,
  );
  await seedDeliveryAccess(db, SLUG, "public");
  await db.batch(manifestDeliverableStatements(SLUG, appDeclaration(), NOW));
  await addOutlets(db);
  const env = makeEnv(new KvMock(), [SLUG]);
  if (opts.blobOrigin !== undefined) env.BLOB_ORIGIN = opts.blobOrigin;
  const r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  const w = { env, db, r2 };
  for (const [version, channel, at] of RELEASES)
    await publish(w, version, channel, at);
  await yankRelease(db, SLUG, "app@1.1.1", "bad build", "admin:u1", NOW);
  await rollout(w, "altstore", "app@1.2.0", 10000, "halted");
  await rollout(w, "fdroid-repo", "app@1.2.0", 5000, "active");
  await rollout(w, "direct", "app@1.2.0", 2500, "paused");
  for (const id of ["app@1.0.0", "app@1.1.0"])
    await reportLive(w, id, "altstore-pal");
  return w;
}

function get(
  w: World,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return dispatch(
    new Request(`${CONSOLE}/${SLUG}/distribution/${path}`, init),
    w.env,
    w.db,
  );
}

/** Wrap a Db and tally its reads, so a route's per-request D1 cost is measurable (cf. R10). */
function countingDb(inner: Db): { db: Db; reads: () => number } {
  let reads = 0;
  const db: Db = {
    all: (sql, ...p) => {
      reads++;
      return inner.all(sql, ...p);
    },
    first: (sql, ...p) => {
      reads++;
      return inner.first(sql, ...p);
    },
    runChanges: (sql, ...p) => inner.runChanges(sql, ...p),
    run: (sql, ...p) => inner.run(sql, ...p),
    batch: (st) => inner.batch(st),
  };
  return { db, reads: () => reads };
}

/** GET a feed path through the real dispatcher, counting the D1 reads it took. */
async function counted(
  w: World,
  path: string,
): Promise<{ status: number; reads: number; body: string }> {
  const c = countingDb(w.db);
  const res = await dispatch(
    new Request(`${CONSOLE}/${SLUG}/distribution/${path}`, {
      redirect: "manual",
    }),
    w.env,
    c.db,
  );
  return { status: res.status, reads: c.reads(), body: await res.text() };
}

async function golden(name: string, body: string): Promise<void> {
  const file = join(GOLDEN_DIR, name);
  if (process.env.UPDATE_FEED_GOLDENS === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, body);
  }
  expect(body).toBe(readFileSync(file, "utf8"));
}

async function feed(
  w: World,
  path: string,
): Promise<{ res: Response; body: string; doc: any }> {
  const res = await get(w, path);
  const body = await res.text();
  return { res, body, doc: res.status === 200 ? JSON.parse(body) : null };
}

// ── Golden files ─────────────────────────────────────────────────────────────────────────────

describe("storefront feeds: golden files", () => {
  const cases: Array<[string, string]> = [
    ["altstore/stable/source.json", "altstore-stable.json"],
    ["altstore/beta/source.json", "altstore-beta.json"],
    ["altstore-pal/stable/source.json", "altstore-pal-stable.json"],
    ["altstore-pal/beta/source.json", "altstore-pal-beta.json"],
    ["obtainium/stable.json", "obtainium-stable.json"],
    ["obtainium/beta.json", "obtainium-beta.json"],
    ["scoop/stable.json", "scoop-stable.json"],
    ["scoop/beta.json", "scoop-beta.json"],
    ["flathub/stable.json", "flathub-stable.json"],
    ["flathub/beta.json", "flathub-beta.json"],
  ];
  for (const [path, file] of cases) {
    it(`${path} matches ${file}`, async () => {
      const w = await setup({ blobOrigin: BYTES });
      const { res, body } = await feed(w, path);
      expect(res.status, body).toBe(200);
      await golden(file, body);
    });
  }

  for (const channel of ["stable", "beta"])
    it(`the F-Droid generator inputs match fdroid-inputs-${channel}.json`, async () => {
      const w = await setup({ blobOrigin: BYTES });
      const res = await get(w, `feeds/fdroid/${channel}`, {
        headers: { authorization: `Bearer ${FEEDER}` },
      });
      const body = await res.text();
      expect(res.status, body).toBe(200);
      await golden(
        `fdroid-inputs-${channel}.json`,
        `${JSON.stringify(JSON.parse(body), null, 2)}\n`,
      );
    });
});

// ── Selection ────────────────────────────────────────────────────────────────────────────────

describe("storefront feeds: which releases appear", () => {
  it("AltStore Classic: no marketplaceID, legacy top-level fields, newest first, unique", async () => {
    const w = await setup();
    const { doc } = await feed(w, "altstore/beta/source.json");
    const app = doc.apps[0];
    expect(app).not.toHaveProperty("marketplaceID");
    expect(app.versions.map((v: any) => v.version)).toEqual([
      "1.2.0-beta.1",
      "1.1.0",
      "1.0.0",
    ]);
    const keys = app.versions.map((v: any) => `${v.version}/${v.buildVersion}`);
    expect(new Set(keys).size).toBe(keys.length);
    // SideStore #735: the newest version copied to the app level.
    expect(app.version).toBe("1.2.0-beta.1");
    expect(app.downloadURL).toBe(app.versions[0].downloadURL);
    expect(app.size).toBe(app.versions[0].size);
    expect(app.versionDate).toBe(app.versions[0].date);
    expect(app.versionDescription).toBe(app.versions[0].localizedDescription);
    expect(app.appPermissions.entitlements).toEqual([
      "com.apple.developer.game-center",
      "get-task-allow",
    ]);
    // URLs are absolute (no bytes host here: the console origin).
    expect(app.downloadURL).toMatch(
      /^https:\/\/key\.example\.test\/diceroll\/distribution\/files\//,
    );
  });

  it("AltStore PAL: marketplaceID, and only releases reported live on the PAL outlet", async () => {
    const w = await setup();
    const { doc } = await feed(w, "altstore-pal/stable/source.json");
    expect(doc.apps[0].marketplaceID).toBe("6740000001");
    expect(doc.apps[0].versions.map((v: any) => v.version)).toEqual([
      "1.1.0",
      "1.0.0",
    ]);
  });

  it("a halted, a partial and a paused rollout each leave the release out; the yanked one never appears", async () => {
    const w = await setup();
    const alt = (await feed(w, "altstore/stable/source.json")).doc;
    expect(alt.apps[0].versions.map((v: any) => v.version)).toEqual([
      "1.1.0",
      "1.0.0",
    ]);
    const fd = await get(w, "feeds/fdroid/stable", {
      headers: { authorization: `Bearer ${FEEDER}` },
    });
    expect(
      ((await fd.json()) as any).versions.map((v: any) => v.version),
    ).toEqual(["1.1.0", "1.0.0"]);
    expect((await feed(w, "scoop/stable.json")).doc.version).toBe("1.1.0");
    // Flathub: nothing holds 1.2.0 back there.
    expect((await feed(w, "flathub/stable.json")).doc.version).toBe("1.2.0");
  });

  it("Flathub: a hold on the flathub outlet lists the previous release", async () => {
    const w = await setup();
    await rollout(w, "flathub", "app@1.2.0", 10000, "halted");
    expect((await feed(w, "flathub/stable.json")).doc.version).toBe("1.1.0");
    // Beta includes stable: with 1.2.0 held, its newest is the beta.
    expect((await feed(w, "flathub/beta.json")).doc.version).toBe(
      "1.2.0-beta.1",
    );
    await w.db.run(
      "UPDATE dist_rollouts SET state = 'complete' WHERE outlet_id = 'flathub'",
    );
    expect((await feed(w, "flathub/stable.json")).doc.version).toBe("1.2.0");
  });

  it("completing the rollout lists the release", async () => {
    const w = await setup();
    await w.db.run(
      "UPDATE dist_rollouts SET state = 'complete', rollout_bp = 10000 WHERE outlet_id = 'altstore'",
    );
    const { doc } = await feed(w, "altstore/stable/source.json");
    expect(doc.apps[0].versions[0].version).toBe("1.2.0");
  });

  it("an AltStore release whose IPA metadata is missing is skipped (its permissions are unknown)", async () => {
    const w = await setup();
    await w.db.run(
      "UPDATE release_builds SET metadata_json = NULL WHERE release_id = 'app@1.1.0' AND build_id = 'ipa-sideload'",
    );
    const { doc } = await feed(w, "altstore/stable/source.json");
    expect(doc.apps[0].versions.map((v: any) => v.version)).toEqual(["1.0.0"]);
  });

  it("Obtainium points at the F-Droid repository, or at the builds route without one", async () => {
    const w = await setup({ blobOrigin: BYTES });
    const withRepo = (await feed(w, "obtainium/stable.json")).doc;
    expect(withRepo.overrideSource).toBe("FDroidRepo");
    expect(withRepo.url).toBe(
      `${CONSOLE}/${SLUG}/distribution/fdroid/stable/repo`,
    );
    expect(typeof withRepo.additionalSettings).toBe("string");
    expect(JSON.parse(withRepo.additionalSettings)).toEqual({
      appIdOrName: "gg.vlad.diceroll",
      pickHighestVersionCode: false,
      trySelectingSuggestedVersionCode: true,
    });
    await w.db.run(
      "UPDATE dist_outlets SET removed_at = ? WHERE outlet_id = 'fdroid-repo'",
      NOW,
    );
    const direct = (await feed(w, "obtainium/stable.json")).doc;
    expect(direct.overrideSource).toBe("DirectAPKLink");
    expect(direct.url).toBe(`${BYTES}/${SLUG}/distribution/builds/stable/apk`);
    expect(JSON.parse(direct.additionalSettings)).toEqual({
      defaultPseudoVersioningMethod: "ETag",
    });
  });

  it("Scoop: both architectures, bin and shortcuts, checkver and autoupdate pointing at itself", async () => {
    const w = await setup({ blobOrigin: BYTES });
    const { doc } = await feed(w, "scoop/stable.json");
    expect(Object.keys(doc.architecture)).toEqual(["64bit", "arm64"]);
    expect(doc.architecture["64bit"].url).toMatch(
      /^https:\/\/dl\.example\.test\//,
    );
    expect(doc.checkver).toEqual({
      url: `${CONSOLE}/${SLUG}/distribution/scoop/stable.json`,
      jsonpath: "$.version",
    });
    expect(doc.autoupdate.architecture["64bit"].url).toContain("$version");
    expect(doc.bin).toBe("Diceroll/diceroll.exe");
  });

  it("an unknown channel, an unknown area shape, and an absent outlet are not-found", async () => {
    const w = await setup();
    expect((await get(w, "altstore/NOPE!/source.json")).status).toBe(404);
    expect((await get(w, "altstore/stable/other.json")).status).toBe(404);
    await w.db.run(
      "UPDATE dist_outlets SET removed_at = ? WHERE outlet_id = 'flathub'",
      NOW,
    );
    expect((await get(w, "flathub/stable.json")).status).toBe(404);
  });

  it("?outlet= picks one of several outlets of a kind", async () => {
    const w = await setup();
    await w.db.run(
      `INSERT INTO dist_outlets
         (product, outlet_id, kind, identity_json, listing_json, created_at, modified_at)
       VALUES (?, 'altstore-beta', 'altstore', ?, NULL, ?, ?)`,
      SLUG,
      JSON.stringify({ artifact: "ipa-sideload" }),
      NOW,
      NOW,
    );
    // The halt is on `altstore`, not on `altstore-beta`.
    const { doc } = await feed(
      w,
      "altstore/stable/source.json?outlet=altstore-beta",
    );
    expect(doc.apps[0].versions[0].version).toBe("1.2.0");
    expect(doc.sourceURL).toBe(
      `${CONSOLE}/${SLUG}/distribution/altstore/stable/source.json?outlet=altstore-beta`,
    );
    expect(
      (await get(w, "altstore/stable/source.json?outlet=play")).status,
    ).toBe(404);
  });

  it("responses carry JSON, a strong ETag of the body, a short cache, and revalidate", async () => {
    const w = await setup();
    const { res, body } = await feed(w, "altstore/stable/source.json");
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("etag")).toBe(`"${sha(body)}"`);
    const again = await get(w, "altstore/stable/source.json", {
      headers: { "if-none-match": res.headers.get("etag")! },
    });
    expect(again.status).toBe(304);
  });
});

// ── Agreement with the hooks, cost, and the answer cache ────────────────────────────────────

/** The specs the routes select with (`feeds/index.ts`, `fdroid.ts`), plus a Linux direct feed. */
const SPECS: Record<string, FeedSpec> = {
  altstore: { kinds: ["altstore"], platform: "ios", liveness: "availability" },
  "altstore-pal": {
    kinds: ["altstore-pal"],
    platform: "ios",
    liveness: "availability",
  },
  obtainium: {
    kinds: ["obtainium"],
    platform: "android",
    liveness: "availability",
    limit: 1,
  },
  fdroid: {
    kinds: ["fdroid-repo"],
    platform: "android",
    liveness: "availability",
  },
  scoop: {
    kinds: ["direct"],
    platform: "windows",
    liveness: "availability",
    limit: 1,
    allBuilds: true,
  },
  linux: {
    kinds: ["direct"],
    platform: "linux",
    liveness: "availability",
    allBuilds: true,
  },
  flathub: {
    kinds: ["flathub"],
    platform: "linux",
    liveness: "bytes",
    limit: 1,
    allBuilds: true,
  },
};

async function hooksFor(w: World) {
  const product = (await loadProduct(w.env, w.db, SLUG))!;
  return buildHooks(SERVICES, product.services, {
    env: w.env,
    db: w.db,
    product,
    now: NOW,
  });
}

/**
 * The selection as the hooks define it, release by release: `delivery.availability()` for step
 * 3 and `delivery.deliveryUrl()` for step 5 — the per-release reads the bulk selection replaces.
 */
async function hookSelection(
  w: World,
  channel: string,
  spec: FeedSpec,
): Promise<string[] | null> {
  const hooks = await hooksFor(w);
  const catalog = hooks.releaseCatalog()!;
  const delivery = hooks.delivery()!;
  const outlet = await pickOutlet(w.db, SLUG, spec);
  if (!outlet) return null;
  const history = await catalog.channelReleases("app", channel);
  if (!history) return null;
  const held = new Set(
    (
      await w.db.all<{ release_id: string; rollout_bp: number; state: string }>(
        `SELECT release_id, rollout_bp, state FROM dist_rollouts
          WHERE product = ? AND deliverable_id = 'app' AND outlet_id = ?`,
        SLUG,
        outlet.id,
      )
    )
      .filter(
        (r) =>
          !(
            r.state === "complete" ||
            (r.state === "active" && r.rollout_bp >= 10000)
          ),
      )
      .map((r) => r.release_id),
  );
  const out: string[] = [];
  let listed = 0;
  for (const release of history.releases.slice(0, MAX_FEED_SCAN)) {
    if (listed >= (spec.limit ?? MAX_FEED_VERSIONS)) break;
    if (release.yanked || held.has(release.releaseId)) continue;
    const builds = (await catalog.builds(release.releaseId)).filter((b) =>
      buildMatchesOutlet(outlet, b, spec.platform),
    );
    if (!builds.length) continue;
    const live =
      spec.liveness === "availability"
        ? (await delivery.availability(release.releaseId)).filter(
            (a) => a.outletId === outlet.id && a.state === "live",
          )
        : null;
    let any = false;
    for (const build of builds) {
      if (
        live &&
        !live.some((a) => a.buildId === "" || a.buildId === build.buildId)
      )
        continue;
      const payload = (
        await catalog.artifacts(release.releaseId, build.buildId)
      ).find((a) => a.role === "payload");
      if (!payload) continue;
      const url = await delivery.deliveryUrl({
        releaseId: release.releaseId,
        buildId: build.buildId,
        outlet: outlet.id,
      });
      if (!url) continue;
      out.push(
        `${release.releaseId} ${build.buildId} ${new URL(url, CONSOLE)}`,
      );
      any = true;
      if (!spec.allBuilds) break;
    }
    if (any) listed++;
  }
  return out;
}

async function bulkSelection(
  w: World,
  channel: string,
  spec: FeedSpec,
): Promise<string[] | null> {
  const sel = await selectFeed(
    {
      db: w.db,
      product: { slug: SLUG, name: "Diceroll" },
      hooks: await hooksFor(w),
      origin: CONSOLE,
      env: w.env,
    },
    channel,
    spec,
  );
  return sel
    ? sel.entries.map((e) => `${e.releaseId} ${e.buildId} ${e.url}`)
    : null;
}

async function report(
  w: World,
  releaseId: string,
  buildId: string,
  outlet: string,
  state: string,
): Promise<void> {
  await w.db.run(
    `INSERT INTO dist_availability
       (product, release_id, build_id, outlet_id, transport, state, since, source, updated_at)
     VALUES (?, ?, ?, ?, 'pkey-cdn', ?, ?, 'ci', ?)`,
    SLUG,
    releaseId,
    buildId,
    outlet,
    state,
    NOW,
    NOW,
  );
}

describe("storefront feeds: the bulk selection agrees with the delivery hook", () => {
  const scenarios: Array<[string, (w: World) => Promise<void>]> = [
    ["as seeded", async () => {}],
    [
      "stored reports win over derived ones, live or not",
      async (w) => {
        await report(w, "app@1.1.0", "ipa-sideload", "altstore", "in-review");
        await report(w, "app@1.0.0", "apk", "fdroid-repo", "live");
        await report(w, "app@1.1.0", "", "obtainium", "rejected");
        await report(w, "app@1.2.0-beta.1", "", "altstore-pal", "live");
        await report(w, "app@1.1.0", "win-arm64", "direct", "removed");
        // A per-build report that is not live beside a live per-release one: still live.
        await report(w, "app@1.1.0", "ipa-sideload", "altstore-pal", "bogus");
      },
    ],
    [
      "a payload without its bytes is not derived live; a reported one still is",
      async (w) => {
        await w.db.run(
          `UPDATE release_artifacts SET locations_json = ?
            WHERE product = ? AND release_id IN ('app@1.1.0', 'app@1.2.0')`,
          JSON.stringify([{ provider: "external", url: "https://x.test/a" }]),
          SLUG,
        );
        await reportLive(w, "app@1.2.0", "altstore-pal");
      },
    ],
    [
      "a payload whose name another artifact serves has no delivery URL",
      async (w) => {
        await w.db.run(
          `INSERT INTO release_artifacts
             (product, release_id, artifact_id, name, kind, platform, arch, content_type,
              size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
              metadata_json, created_at, build_id, role)
           SELECT product, release_id, '!' || artifact_id, name, kind, platform, arch, content_type,
                  size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
                  metadata_json, created_at, NULL, 'source'
             FROM release_artifacts
            WHERE product = ? AND release_id = 'app@1.0.0' AND build_id IN ('win-x64', 'apk')`,
          SLUG,
        );
      },
    ],
    [
      "an outlet that delivers by another transport lists nothing",
      async (w) => {
        for (const outlet of ["direct", "altstore", "flathub"])
          await w.db.run(
            `INSERT INTO dist_transports (product, deliverable_id, outlet_id, transport)
             VALUES (?, 'app', ?, 'store')`,
            SLUG,
            outlet,
          );
      },
    ],
    [
      "rollouts complete",
      async (w) => {
        await w.db.run(
          "UPDATE dist_rollouts SET state = 'complete', rollout_bp = 10000 WHERE product = ?",
          SLUG,
        );
      },
    ],
  ];
  for (const [name, mutate] of scenarios)
    it(name, async () => {
      for (const blobOrigin of [undefined, BYTES]) {
        const w = await setup(blobOrigin ? { blobOrigin } : {});
        await mutate(w);
        for (const [feedName, spec] of Object.entries(SPECS))
          for (const channel of ["stable", "beta", "nope"]) {
            const expected = await hookSelection(w, channel, spec);
            expect(
              await bulkSelection(w, channel, spec),
              `${feedName}/${channel}`,
            ).toEqual(expected);
          }
      }
    });
});

describe("storefront feeds: cost", () => {
  /** A long history: `n` more stable releases after the seeded ones. */
  async function longHistory(n: number): Promise<World> {
    const w = await setup({ blobOrigin: BYTES });
    for (let i = 0; i < n; i++)
      await publish(w, `2.${i}.0`, "stable", NOW - 9 * DAY + i * 60, [
        "ipa-sideload",
        "apk",
        "win-x64",
        "linux-x64",
      ]);
    return w;
  }

  /** The most D1 reads one public feed request may take, whatever the history. */
  const CEILING = 2 * MAX_FEED_SCAN + 40;
  const PATHS = [
    "altstore/stable/source.json",
    "altstore-pal/stable/source.json",
    "obtainium/stable.json",
    "scoop/stable.json",
    "flathub/stable.json",
    "fdroid/stable/repo/Diceroll-2.119.0-android.apk",
    "fdroid/stable/repo/not-listed.apk",
  ];

  it(`a history of 120 releases stays under ${CEILING} D1 reads per request`, async () => {
    const w = await longHistory(120);
    await registerRepo(w, "stable", {
      ...REPO_FILES,
      "index-v2.json": indexListing(["Diceroll-2.119.0-android.apk"]),
    });
    for (const path of PATHS) {
      const r = await counted(w, path);
      expect(r.reads, `${path}: ${r.reads} reads`).toBeLessThanOrEqual(CEILING);
    }
    expect(
      (await counted(w, "fdroid/stable/repo/Diceroll-2.119.0-android.apk"))
        .status,
    ).toBe(302);
    // A store outlet reads nothing for a release with no live report: the PAL source, with two
    // old releases reported live, costs no more than a short feed.
    const pal = await counted(w, "altstore-pal/stable/source.json");
    expect(pal.status).toBe(200);
    expect(pal.reads).toBeLessThanOrEqual(40);
  });

  it("the worst case (nothing listable, every release scanned) is bounded too", async () => {
    const w = await longHistory(120);
    // No payload has its bytes: the derived outlets list nothing and scan MAX_FEED_SCAN releases.
    await w.db.run(
      "UPDATE release_artifacts SET locations_json = ? WHERE product = ?",
      JSON.stringify([{ provider: "external", url: "https://x.test/a" }]),
      SLUG,
    );
    for (const path of PATHS.slice(0, 5)) {
      const r = await counted(w, path);
      expect(r.reads, `${path}: ${r.reads} reads`).toBeLessThanOrEqual(CEILING);
    }
  });
});

/** A `caches.default` that keeps what is put, by URL, as the Workers Cache API does. */
class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(req: Request): Promise<Response | undefined> {
    return this.entries.get(req.url)?.clone();
  }
  async put(req: Request, res: Response): Promise<void> {
    this.entries.set(req.url, res.clone());
  }
}

describe("storefront feeds: the answer cache", () => {
  let cache: FakeCache;
  beforeEach(() => {
    cache = new FakeCache();
    vi.stubGlobal("caches", { default: cache });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves a rendered feed from the cache until the state it follows changes", async () => {
    const w = await setup();
    const first = await counted(w, "altstore/stable/source.json");
    expect(first.status).toBe(200);
    const again = await counted(w, "altstore/stable/source.json");
    expect(again.body).toBe(first.body);
    // The access check and the state stamp only.
    expect(again.reads).toBeLessThanOrEqual(12);
    expect(again.reads).toBeLessThan(first.reads);
    // Other query parameters do not miss the cache; `?outlet=` is part of the key.
    const junk = await counted(w, "altstore/stable/source.json?x=1&y=2");
    expect(junk.reads).toBe(again.reads);
    expect(cache.entries.size).toBe(1);
    // Completing the halted rollout is a new key: 1.2.0 is listed at once.
    await w.db.run(
      "UPDATE dist_rollouts SET state = 'complete', rollout_bp = 10000, updated_at = ? WHERE outlet_id = 'altstore'",
      NOW + 1,
    );
    const after = JSON.parse(
      (await counted(w, "altstore/stable/source.json")).body,
    );
    expect(after.apps[0].versions[0].version).toBe("1.2.0");
    // And halting it again withdraws it at once.
    await w.db.run(
      "UPDATE dist_rollouts SET state = 'halted', updated_at = ? WHERE outlet_id = 'altstore'",
      NOW + 2,
    );
    const halted = JSON.parse(
      (await counted(w, "altstore/stable/source.json")).body,
    );
    expect(halted.apps[0].versions[0].version).toBe("1.1.0");
  });

  it("never caches the access decision or a not-found", async () => {
    const w = await setup();
    expect((await get(w, "altstore/stable/source.json")).status).toBe(200);
    await w.db.run(
      "UPDATE dist_access SET mode = 'licensed' WHERE product = ? AND deliverable_id = 'app'",
      SLUG,
    );
    expect((await get(w, "altstore/stable/source.json")).status).toBe(404);
    const size = cache.entries.size;
    expect((await get(w, "flathub/nope.json")).status).toBe(404);
    expect(cache.entries.size).toBe(size);
  });

  it("caches the relay's redirect for an APK the index names", async () => {
    const w = await setup({ blobOrigin: BYTES });
    await registerRepo(w, "stable", {
      ...REPO_FILES,
      "index-v2.json": indexListing(["Diceroll-1.1.0-android.apk"]),
    });
    const path = "fdroid/stable/repo/Diceroll-1.1.0-android.apk";
    const first = await counted(w, path);
    const again = await counted(w, path);
    expect([first.status, again.status]).toEqual([302, 302]);
    expect(again.reads).toBeLessThan(first.reads);
  });
});

// ── Access ───────────────────────────────────────────────────────────────────────────────────

describe("storefront feeds: a non-public deliverable has no feed", () => {
  const paths = [
    "altstore/stable/source.json",
    "altstore-pal/stable/source.json",
    "obtainium/stable.json",
    "scoop/stable.json",
    "flathub/stable.json",
    "fdroid/stable/repo/entry.jar",
    "fdroid/stable/repo/index-v2.json",
    "fdroid/stable/repo/Diceroll-1.1.0-android.apk",
  ];
  for (const mode of ["authenticated", "licensed", "entitled"]) {
    it(`${mode}: every feed route is not-found`, async () => {
      const w = await setup();
      await registerRepo(w, "stable");
      // Sanity: public serves.
      expect((await get(w, "fdroid/stable/repo/entry.jar")).status).toBe(200);
      await seedDeliveryAccess(w.db, SLUG, mode);
      for (const p of paths) expect((await get(w, p)).status, p).toBe(404);
    });
  }

  it("with Distribution off, every feed route is the registry's not-found", async () => {
    const w = await setup();
    await w.db.run(
      `UPDATE products SET services_json = json_set(services_json, '$.services.distribution.enabled', json('false'))
        WHERE slug = ?`,
      SLUG,
    );
    for (const p of [
      "altstore/stable/source.json",
      "fdroid/stable/repo/entry.jar",
    ])
      expect((await get(w, p)).status, p).toBe(404);
  });
});

// ── The F-Droid repository ───────────────────────────────────────────────────────────────────

const REPO_FILES: Record<string, Uint8Array> = {
  "entry.jar": new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
  "entry.json": new TextEncoder().encode('{"timestamp":1}\n'),
  "index-v2.json": new TextEncoder().encode('{"repo":{}}\n'),
  "diff/1.json": new TextEncoder().encode("{}\n"),
  "icons/icon.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

/** An `index-v2.json` whose versions name these APK files (the relay reads only that). */
function indexListing(names: string[]): Uint8Array {
  const versions: Record<string, unknown> = {};
  names.forEach((name, i) => {
    versions[`h${i}`] = { file: { name: `/${name}`, sha256: "0".repeat(64) } };
  });
  return new TextEncoder().encode(
    `${JSON.stringify({ repo: {}, packages: { "gg.vlad.diceroll": { versions } } })}\n`,
  );
}

/**
 * A pack deliverable `dice.dlc` under `mode`, with one release whose payload is `bytes`: stored
 * in the blob store and referenced as a release artifact, the way a pack publish leaves it.
 */
async function seedPackPayload(
  w: World,
  bytes: Uint8Array,
  mode: string,
): Promise<void> {
  const digest = sha(bytes);
  const key = blobKey(digest);
  await upsertDeliverable(
    w.db,
    {
      product: SLUG,
      deliverableId: "dice.dlc",
      kind: "pack",
      packType: "godot.pck",
    },
    NOW,
  );
  await w.db.run(
    `INSERT INTO release_metadata
       (product, release_id, version, metadata_access, artifacts_access, published_at,
        created_at, modified_at, deliverable_id, seq, channel)
     VALUES (?, 'dlc-1', '1', 'public', 'public', ?, ?, ?, 'dice.dlc', 1, 'stable')`,
    SLUG,
    NOW,
    NOW,
    NOW,
  );
  await w.db.run(
    `INSERT INTO release_artifacts
       (product, release_id, artifact_id, name, kind, platform, arch, content_type,
        size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
        metadata_json, created_at, build_id, role)
     VALUES (?, 'dlc-1', '1', 'dice.pck', NULL, NULL, NULL, 'application/octet-stream',
             ?, ?, NULL, ?, NULL, 'public', NULL, ?, NULL, 'payload')`,
    SLUG,
    bytes.length,
    digest,
    key,
    NOW,
  );
  if (!(await w.r2.get(key)))
    await putVerified(asR2(w.r2), key, bytes, {
      sha256: digest,
      size: bytes.length,
    });
  await recordObject(
    w.db,
    {
      storageKey: key,
      sha256: digest,
      size: bytes.length,
      kind: "blob",
      gated: false,
    },
    NOW,
  );
  await recordRef(
    w.db,
    { product: SLUG, storageKey: key, refKind: "artifact", refId: "dlc-1/1" },
    NOW,
  );
  await w.db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
     VALUES (?, 'dice.dlc', ?, NULL, 'admin', ?)
     ON CONFLICT (product, deliverable_id) DO UPDATE SET mode = excluded.mode`,
    SLUG,
    mode,
    NOW,
  );
}

/** Stage the files under a ticket, as `pkey feeds fdroid` uploads them, and register them. */
async function registerRepo(
  w: World,
  channel: string,
  files: Record<string, Uint8Array> = REPO_FILES,
  token = FEEDER,
): Promise<Response> {
  const holder = tokens.get(token)!;
  const objects = Object.values(files).map((b) => ({
    sha256: sha(b),
    size: b.length,
    gated: false,
  }));
  const ticket = await issueUploadTicket(w.env, w.db, {
    product: SLUG,
    holder: { tokenHash: holder.tokenHash, expiresAt: holder.expiresAt },
    objects,
    now: NOW,
  });
  for (const b of Object.values(files)) {
    const key = stagingKey(SLUG, ticket.ticketId, sha(b));
    await putVerified(asR2(w.r2), key, b, { sha256: sha(b), size: b.length });
  }
  return get(w, `feeds/fdroid/${channel}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ticket: ticket.ticket,
      files: Object.entries(files).map(([path, b]) => ({
        path,
        sha256: sha(b),
        size: b.length,
      })),
    }),
  });
}

describe("F-Droid: register and relay", () => {
  it("registers the uploaded set, then serves exactly those files with their types", async () => {
    const w = await setup();
    const res = await registerRepo(w, "stable");
    expect(res.status, await res.clone().text()).toBe(200);
    const types: Record<string, string> = {
      "entry.jar": "application/java-archive",
      "entry.json": "application/json",
      "index-v2.json": "application/json",
      "diff/1.json": "application/json",
      "icons/icon.png": "image/png",
    };
    for (const [path, bytes] of Object.entries(REPO_FILES)) {
      const r = await get(w, `fdroid/stable/repo/${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type")).toBe(types[path]);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("sandbox");
      expect(r.headers.get("cache-control")).toBe(
        "public, max-age=300, no-transform",
      );
      expect(r.headers.get("etag")).toBe(`"${sha(bytes)}"`);
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
    }
    // The other channel has no repository registered.
    expect((await get(w, "fdroid/beta/repo/entry.jar")).status).toBe(404);
    const audit = await w.db.first<{ action: string; actor_sub: string }>(
      "SELECT action, actor_sub FROM audit WHERE product = ? AND action = 'distribution.feeds.register'",
      SLUG,
    );
    expect(audit).toEqual({
      action: "distribution.feeds.register",
      actor_sub: "ci:static:tok_feeds",
    });
  });

  it("never registers a path that climbs or is not a repository file type", () => {
    // A literal `..` never reaches the Worker (the URL parser collapses it first); encoded forms
    // fail the safe-path check below, and registration refuses both.
    for (const p of [
      "../entry.json",
      "diff/../entry.json",
      "a//b.json",
      "%2e%2e/x.json",
      "index.html",
      "x.svg",
      "x.xml",
    ])
      expect(feedFileType(p), p).toBeNull();
    expect(feedFileType("diff/1700000000.json")).toBe("application/json");
  });

  it("refuses traversal and unregistered paths", async () => {
    const w = await setup();
    await registerRepo(w, "stable");
    for (const p of [
      "fdroid/stable/repo/%2e%2e/entry.jar",
      "fdroid/stable/repo/diff/..%2fentry.jar",
      "fdroid/stable/repo/index.xml",
      "fdroid/stable/repo/icons/other.png",
    ])
      expect((await get(w, p)).status, p).toBe(404);
  });

  it("an APK the index names is a 302 to its immutable delivery URL; one held back is not", async () => {
    const w = await setup({ blobOrigin: BYTES });
    await registerRepo(w, "stable", {
      ...REPO_FILES,
      "index-v2.json": indexListing(
        ["1.0.0", "1.1.0", "1.1.1", "1.2.0"].map(
          (v) => `Diceroll-${v}-android.apk`,
        ),
      ),
    });
    const r = await get(w, "fdroid/stable/repo/Diceroll-1.1.0-android.apk", {
      redirect: "manual",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      `${BYTES}/${SLUG}/distribution/files/app%401.1.0/Diceroll-1.1.0-android.apk`,
    );
    // 1.2.0 is at 5000 bp on the repo outlet; 1.1.1 is yanked.
    expect(
      (await get(w, "fdroid/stable/repo/Diceroll-1.2.0-android.apk")).status,
    ).toBe(404);
    expect(
      (await get(w, "fdroid/stable/repo/Diceroll-1.1.1-android.apk")).status,
    ).toBe(404);
  });

  it("an APK the registered index does not name is not-found, without a selection", async () => {
    const w = await setup({ blobOrigin: BYTES });
    // The release's APK is selectable, but this index names only 1.0.0.
    await registerRepo(w, "stable", {
      ...REPO_FILES,
      "index-v2.json": indexListing(["Diceroll-1.0.0-android.apk"]),
    });
    const listed = await counted(
      w,
      "fdroid/stable/repo/Diceroll-1.0.0-android.apk",
    );
    expect(listed.status).toBe(302);
    const unlisted = await counted(
      w,
      "fdroid/stable/repo/Diceroll-1.1.0-android.apk",
    );
    expect(unlisted.status).toBe(404);
    const guessed = await counted(w, "fdroid/stable/repo/anything-at-all.apk");
    expect(guessed.status).toBe(404);
    // A selection reads every scanned release; refusing a name reads none of them.
    expect(unlisted.reads).toBeLessThan(listed.reads);
    expect(guessed.reads).toBe(unlisted.reads);
    // No repository registered: no APK either.
    expect(
      (await get(w, "fdroid/beta/repo/Diceroll-1.0.0-android.apk")).status,
    ).toBe(404);
  });

  it("a second register replaces the set wholesale", async () => {
    const w = await setup();
    await registerRepo(w, "stable");
    const next = {
      "entry.jar": new Uint8Array([0x50, 0x4b, 9]),
      "entry.json": new TextEncoder().encode('{"timestamp":2}\n'),
      "index-v2.json": new TextEncoder().encode('{"repo":{"timestamp":2}}\n'),
    };
    expect((await registerRepo(w, "stable", next)).status).toBe(200);
    expect((await get(w, "fdroid/stable/repo/diff/1.json")).status).toBe(404);
    expect(
      new Uint8Array(
        await (await get(w, "fdroid/stable/repo/entry.jar")).arrayBuffer(),
      ),
    ).toEqual(next["entry.jar"]);
    const refs = await w.db.all<{ ref_id: string }>(
      "SELECT ref_id FROM blob_refs WHERE product = ? AND ref_kind = 'feed' ORDER BY ref_id",
      SLUG,
    );
    expect(refs.map((r) => r.ref_id)).toEqual([
      "fdroid/stable/entry.jar",
      "fdroid/stable/entry.json",
      "fdroid/stable/index-v2.json",
    ]);
  });

  it("refuses an incomplete set, a bad path, an object outside the ticket, and a wrong scope", async () => {
    const w = await setup();
    const noEntry = { "index-v2.json": REPO_FILES["index-v2.json"]! };
    const r1 = await registerRepo(w, "stable", noEntry);
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as any).reason).toBe("incomplete_repository");

    const evil = {
      ...REPO_FILES,
      "index.html": new TextEncoder().encode("<script>"),
    };
    const r2 = await registerRepo(w, "stable", evil);
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as any).reason).toBe("bad_feed_path");

    const r3 = await get(w, "feeds/fdroid/stable", {
      method: "POST",
      headers: {
        authorization: `Bearer ${FEEDER}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        files: Object.entries(REPO_FILES).map(([path, b]) => ({
          path,
          sha256: sha(b),
          size: b.length,
        })),
      }),
    });
    expect(r3.status).toBe(403);
    expect(((await r3.json()) as any).reason).toBe("invalid_ticket");

    const r4 = await get(w, "feeds/fdroid/stable", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PUBLISHER}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(r4.status).toBe(403);
    expect(((await r4.json()) as any).reason).toBe("missing_scope");
    expect((await get(w, "feeds/fdroid/stable")).status).toBe(401);
  });

  it("a release's object is no feed file without the caller's own upload; a registered feed file is", async () => {
    const w = await setup();
    // The product references this public APK for a release, and its digest is published in
    // every feed. Naming it is not holding it: register still wants it from a ticket.
    const apk = bytesFor("Diceroll-1.1.0-android.apk");
    const files = (set: Record<string, Uint8Array>) =>
      JSON.stringify({
        files: Object.entries(set).map(([path, b]) => ({
          path,
          sha256: sha(b),
          size: b.length,
        })),
      });
    const post = (body: string) =>
      get(w, "feeds/fdroid/stable", {
        method: "POST",
        headers: {
          authorization: `Bearer ${FEEDER}`,
          "content-type": "application/json",
        },
        body,
      });
    const r1 = await post(
      files({ "entry.jar": apk, "entry.json": apk, "index-v2.json": apk }),
    );
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as any).reason).toBe("invalid_ticket");
    // Once registered from a ticket, the same files re-register without one.
    expect((await registerRepo(w, "stable")).status).toBe(200);
    const r2 = await post(files(REPO_FILES));
    expect(r2.status, await r2.clone().text()).toBe(200);
  });

  it("never registers or relays an object a non-public deliverable's release carries", async () => {
    const w = await setup();
    const paid = new TextEncoder().encode("the paid expansion's bytes\n");
    await seedPackPayload(w, paid, "entitled");
    // The blob route refuses it anonymously…
    expect((await get(w, `blobs/sha256/${sha(paid)}`)).status).toBe(401);
    // …so registering it as a repository file is refused, with or without a ticket.
    const bare = await get(w, "feeds/fdroid/stable", {
      method: "POST",
      headers: {
        authorization: `Bearer ${FEEDER}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        files: ["entry.jar", "entry.json", "index-v2.json"].map((path) => ({
          path,
          sha256: sha(paid),
          size: paid.length,
        })),
      }),
    });
    expect(bare.status).toBe(403);
    expect(((await bare.json()) as any).reason).toBe("not_public");
    const ticketed = await registerRepo(w, "stable", {
      ...REPO_FILES,
      "entry.jar": paid,
    });
    expect(ticketed.status).toBe(403);
    expect(((await ticketed.json()) as any).reason).toBe("not_public");
    expect((await get(w, "fdroid/stable/repo/entry.jar")).status).toBe(404);
  });

  it("the relay re-checks: a registered file a non-public deliverable later carries is not served", async () => {
    const w = await setup();
    expect((await registerRepo(w, "stable")).status).toBe(200);
    // A pack release later carries the same bytes as the registered entry.jar.
    await seedPackPayload(w, REPO_FILES["entry.jar"]!, "entitled");
    expect((await get(w, "fdroid/stable/repo/entry.jar")).status).toBe(404);
    expect((await get(w, "fdroid/stable/repo/index-v2.json")).status).toBe(200);
    await w.db.run(
      "UPDATE dist_access SET mode = 'public' WHERE product = ? AND deliverable_id = 'dice.dlc'",
      SLUG,
    );
    expect((await get(w, "fdroid/stable/repo/entry.jar")).status).toBe(200);
  });

  it("refuses without a live fdroid-repo outlet", async () => {
    const w = await setup();
    await w.db.run(
      "UPDATE dist_outlets SET removed_at = ? WHERE outlet_id = 'fdroid-repo'",
      NOW,
    );
    const res = await registerRepo(w, "stable");
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).reason).toBe("unknown_outlet");
  });

  it("P2-02's uploads route accepts distribution:feeds for a ticket", async () => {
    const w = await setup();
    w.env.R2_ACCOUNT_ID = "0".repeat(32);
    w.env.R2_PARENT_ACCESS_KEY_ID = "AKID";
    w.env.R2_PARENT_SECRET_ACCESS_KEY = "secret";
    w.env.BLOBS_BUCKET_NAME = "pkey-blobs";
    const b = REPO_FILES["entry.jar"]!;
    const res = await dispatch(
      new Request(`${CONSOLE}/${SLUG}/release/publish/uploads`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${FEEDER}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ objects: [{ sha256: sha(b), size: b.length }] }),
      }),
      w.env,
      w.db,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as any).ticket).toMatch(/^pkeyup_/);
  });
});

// ── The descriptor ingest keeps the metadata ─────────────────────────────────────────────────

// ── Undeclared channels ──────────────────────────────────────────────────────────────────────

describe("storefront feeds: a well-formed channel the product never declared", () => {
  let cache: FakeCache;
  beforeEach(() => {
    cache = new FakeCache();
    vi.stubGlobal("caches", { default: cache });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const publicPaths = [
    "altstore/nope/source.json",
    "altstore-pal/nope/source.json",
    "obtainium/nope.json",
    "scoop/nope.json",
    "flathub/nope.json",
    "fdroid/nope/repo/entry.jar",
    "fdroid/nope/repo/index-v2.json",
    "fdroid/nope/repo/Diceroll-1.1.0-android.apk",
  ];

  it("every public feed route is not-found, and nothing is cached for it", async () => {
    const w = await setup();
    for (const p of publicPaths) expect((await get(w, p)).status, p).toBe(404);
    expect(cache.entries.size).toBe(0);
  });

  it("the CI routes refuse it: GET and POST feeds/fdroid/nope are unknown_channel", async () => {
    const w = await setup();
    const inputs = await get(w, "feeds/fdroid/nope", {
      headers: { authorization: `Bearer ${FEEDER}` },
    });
    expect(inputs.status).toBe(404);
    const res = await registerRepo(w, "nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).reason).toBe("unknown_channel");
    expect(
      await w.db.first(
        "SELECT 1 FROM dist_feed_files WHERE product = ? AND channel = 'nope'",
        SLUG,
      ),
    ).toBeNull();
    expect((await get(w, "fdroid/nope/repo/entry.jar")).status).toBe(404);
  });

  it("the relay serves nothing for it even where rows exist", async () => {
    const w = await setup();
    expect((await registerRepo(w, "stable")).status).toBe(200);
    // Rows keyed by an undeclared channel (as a pre-fix register would have left them).
    await w.db.run(
      `INSERT INTO dist_feed_files
         (product, feed, channel, path, sha256, size, content_type, updated_at)
       SELECT product, feed, 'nope', path, sha256, size, content_type, updated_at
         FROM dist_feed_files WHERE product = ? AND channel = 'stable'`,
      SLUG,
    );
    expect((await get(w, "fdroid/stable/repo/entry.jar")).status).toBe(200);
    for (const path of Object.keys(REPO_FILES))
      expect((await get(w, `fdroid/nope/repo/${path}`)).status, path).toBe(404);
  });

  it("a declared manual channel with no releases is an empty feed, not a not-found", async () => {
    const w = await setup();
    await w.db.run(
      "UPDATE release_config SET manual_channels_json = ? WHERE product = ?",
      JSON.stringify([{ name: "nightly", regex: "^v.*-nightly$" }]),
      SLUG,
    );
    expect((await get(w, "altstore/nightly/source.json")).status).toBe(200);
    expect((await get(w, "altstore/nope/source.json")).status).toBe(404);
  });
});

describe("build metadata", () => {
  it("is stored as the descriptor carried it and read back through the catalog", async () => {
    const w = await setup();
    const row = await w.db.first<{ metadata_json: string }>(
      "SELECT metadata_json FROM release_builds WHERE product = ? AND release_id = 'app@1.0.0' AND build_id = 'apk'",
      SLUG,
    );
    expect(JSON.parse(row!.metadata_json)).toEqual(metadataFor("apk", "1.0.0"));
    const none = await w.db.first<{ metadata_json: string | null }>(
      "SELECT metadata_json FROM release_builds WHERE product = ? AND release_id = 'app@1.0.0' AND build_id = 'win-x64'",
      SLUG,
    );
    expect(none!.metadata_json).toBeNull();
  });
});

// ── A-18b: the shared listing model ──────────────────────────────────────────────────────────

describe("storefront feeds: AltStore and Obtainium read the shared listing model (A-18b)", () => {
  /** A model over the manifest listing: some fields set, others left to the manifest. */
  async function seedModel(w: World): Promise<void> {
    await w.db.run(
      `INSERT INTO dist_listings
         (product, default_locale, name, developer_name, urls_json, tint, source, created_at, modified_at, modified_by)
       VALUES (?, 'en-US', 'Diceroll Deluxe', 'Ada', ?, '#112233', 'admin', ?, ?, 'u1')`,
      SLUG,
      JSON.stringify({ website: "https://deluxe.example.test" }),
      NOW,
      NOW,
    );
    await w.db.run(
      `INSERT INTO dist_listing_locales
         (product, locale, subtitle, source, modified_at, modified_by)
       VALUES (?, 'en-US', 'From the model', 'admin', ?, 'u1')`,
      SLUG,
      NOW,
    );
  }

  it("a product with only a manifest listing has no model, so the golden files hold its bytes", async () => {
    const w = await setup({ blobOrigin: BYTES });
    expect(await w.db.all("SELECT * FROM dist_listings")).toEqual([]);
    const { body } = await feed(w, "altstore/stable/source.json");
    expect(body).toBe(
      readFileSync(join(GOLDEN_DIR, "altstore-stable.json"), "utf8"),
    );
  });

  it("AltStore: the model's fields win, field by field; the rest (icon, description) stay the manifest's", async () => {
    const w = await setup({ blobOrigin: BYTES });
    await seedModel(w);
    const { doc } = await feed(w, "altstore/stable/source.json");
    expect(doc).toMatchObject({
      name: "Diceroll Deluxe",
      subtitle: "From the model",
      description: "Roll, reroll, repeat.",
      iconURL: "https://cdn.example.test/diceroll/icon.png",
      website: "https://deluxe.example.test",
      tintColor: "112233",
    });
    expect(doc.apps[0]).toMatchObject({
      name: "Diceroll Deluxe",
      developerName: "Ada",
      category: "games",
    });
    // A feed override beats the model (the PAL source shares AltStore's).
    await w.db.run(
      `INSERT INTO dist_listing_overrides
         (product, store, locale, field, value_json, source, modified_at, modified_by)
       VALUES (?, 'altstore', 'en-US', 'subtitle', '"Only on AltStore"', 'admin', ?, 'u1')`,
      SLUG,
      NOW,
    );
    expect((await feed(w, "altstore/stable/source.json")).doc.subtitle).toBe(
      "Only on AltStore",
    );
    expect(
      (await feed(w, "altstore-pal/stable/source.json")).doc.subtitle,
    ).toBe("Only on AltStore");
  });

  it("Obtainium: the name and author come from the model", async () => {
    const w = await setup({ blobOrigin: BYTES });
    await seedModel(w);
    const { doc } = await feed(w, "obtainium/stable.json");
    expect(doc).toMatchObject({ name: "Diceroll Deluxe", author: "Ada" });
  });

  it("Scoop and Flathub do not read the model (out of A-18b's scope): their bytes are unchanged", async () => {
    const w = await setup({ blobOrigin: BYTES });
    await seedModel(w);
    for (const [path, file] of [
      ["scoop/stable.json", "scoop-stable.json"],
      ["flathub/stable.json", "flathub-stable.json"],
    ] as const)
      expect((await feed(w, path)).body).toBe(
        readFileSync(join(GOLDEN_DIR, file), "utf8"),
      );
  });

  it("the cache stamp follows the model, so an edit takes effect at once", async () => {
    const w = await setup();
    const catalog = (await hooksFor(w)).releaseCatalog()!;
    const stamp = () => feedStateStamp(w.db, SLUG, catalog, true);
    const before = await stamp();
    await seedModel(w);
    const withModel = await stamp();
    expect(withModel).not.toBe(before);
    await w.db.run(
      `INSERT INTO dist_listing_overrides
         (product, store, locale, field, value_json, source, modified_at, modified_by)
       VALUES (?, 'obtainium', '', 'name', '"Dice"', 'admin', ?, 'u1')`,
      SLUG,
      NOW,
    );
    expect(await stamp()).not.toBe(withModel);
  });
});

// ── Hosted art (HA-07) ───────────────────────────────────────────────────────────────────────

describe("storefront feeds: the AltStore sources name hosted copies (HA-07)", () => {
  const IMG = "https://img.example.test";
  const ICON = "https://cdn.example.test/diceroll/icon.png";
  const HEADER_NEW = "https://cdn.example.test/diceroll/header-v2.png";
  const HEADER_OLD = "https://cdn.example.test/diceroll/header.png";
  const SHOT_1 = "https://cdn.example.test/diceroll/shot-1.png";
  const SHOT_3 = "https://cdn.example.test/diceroll/shot-3.png";
  const I = "1".repeat(64);
  const S1 = "2".repeat(64);
  const S2 = "3".repeat(64);
  const H = "4".repeat(64);
  const ref = (kind: string, src: string) => JSON.stringify({ kind, src });

  /** The world, with an image host and an AltStore listing in HA-04's normalised form. */
  async function hostedWorld(): Promise<World> {
    const w = await setup({ blobOrigin: BYTES });
    w.env.IMG_ORIGIN = IMG;
    await w.db.run(
      "UPDATE dist_outlets SET listing_json = ? WHERE product = ? AND outlet_id IN ('altstore', 'altstore-pal')",
      JSON.stringify({
        ...LISTING,
        iconUrl: undefined,
        icon: { kind: "url", src: ICON },
        header: { kind: "url", src: HEADER_NEW },
        screenshots: [
          { kind: "url", src: SHOT_1 },
          { kind: "repo", src: "art/shot-2.png" },
          { kind: "url", src: SHOT_3 },
        ],
      }),
      SLUG,
    );
    // The icon and the first two screenshots were pulled for exactly these refs.
    await seedHosted(w.db, SLUG, "listing.icon", {
      sha256: I,
      pulledRef: ref("url", ICON),
      widths: [64, 128],
    });
    await seedHosted(w.db, SLUG, "listing.screenshot:1", {
      sha256: S1,
      pulledRef: ref("url", SHOT_1),
    });
    await seedHosted(w.db, SLUG, "listing.screenshot:2", {
      sha256: S2,
      pulledRef: ref("repo", "art/shot-2.png"),
    });
    // The header's ref changed and the new pull has not succeeded: the copy is the OLD art.
    await seedHosted(w.db, SLUG, "listing.header", {
      sha256: H,
      status: "failed",
      pulledRef: ref("url", HEADER_OLD),
    });
    return w;
  }

  it("altstore/stable/source.json matches altstore-stable-hosted.json", async () => {
    const w = await hostedWorld();
    const { res, body, doc } = await feed(w, "altstore/stable/source.json");
    expect(res.status, body).toBe(200);
    await golden("altstore-stable-hosted.json", body);
    // The originals on the image host, never a WebP variant.
    expect(doc.iconURL).toBe(`${IMG}/${SLUG}/a/${I}`);
    expect(doc.apps[0].iconURL).toBe(`${IMG}/${SLUG}/a/${I}`);
    expect(doc.apps[0].screenshots).toEqual([
      `${IMG}/${SLUG}/a/${S1}`,
      // A repo path has no URL of its own: the hosted copy is its only one.
      `${IMG}/${SLUG}/a/${S2}`,
      // No copy yet: the declared URL, as before HA-07.
      SHOT_3,
    ]);
    // A copy pulled for another ref never stands in: the declared URL stays.
    expect(doc.headerURL).toBe(HEADER_NEW);
    // The PAL source names the same copies.
    const pal = (await feed(w, "altstore-pal/stable/source.json")).doc;
    expect(pal.iconURL).toBe(`${IMG}/${SLUG}/a/${I}`);
  });

  it("an outlet that clears its screenshots names none, though manifest copies exist", async () => {
    const w = await hostedWorld();
    const row = await w.db.first<{ listing_json: string }>(
      "SELECT listing_json FROM dist_outlets WHERE product = ? AND outlet_id = 'altstore'",
      SLUG,
    );
    await w.db.run(
      "UPDATE dist_outlets SET listing_json = ? WHERE product = ? AND outlet_id = 'altstore'",
      JSON.stringify({ ...JSON.parse(row!.listing_json), screenshots: [] }),
      SLUG,
    );
    const { doc } = await feed(w, "altstore/stable/source.json");
    expect(doc.apps[0].screenshots ?? []).toEqual([]);
    // A console claim still stands in when nothing is declared.
    await w.db.run(
      "UPDATE hosted_assets SET origin = 'console' WHERE product = ? AND slot = 'listing.screenshot:2'",
      SLUG,
    );
    const claimed = (await feed(w, "altstore/stable/source.json")).doc;
    expect(claimed.apps[0].screenshots).toEqual([`${IMG}/${SLUG}/a/${S2}`]);
  });

  it("a console claim wins over the declared ref; a copy without its ref is never named", async () => {
    const w = await hostedWorld();
    await w.db.run(
      "UPDATE hosted_assets SET origin = 'console' WHERE product = ? AND slot = 'listing.header'",
      SLUG,
    );
    await w.db.run(
      "DELETE FROM blob_refs WHERE product = ? AND ref_id = 'listing.icon@'",
      SLUG,
    );
    const { doc } = await feed(w, "altstore/stable/source.json");
    expect(doc.headerURL).toBe(`${IMG}/${SLUG}/a/${H}`);
    expect(doc.iconURL).toBe(ICON);
  });

  it("a pre-HA-04 row's iconUrl string matches its copy too; an undeclared icon takes the product's", async () => {
    const w = await setup({ blobOrigin: BYTES });
    w.env.IMG_ORIGIN = IMG;
    await seedHosted(w.db, SLUG, "listing.icon", {
      sha256: I,
      pulledRef: ref("url", ICON),
    });
    expect((await feed(w, "altstore/stable/source.json")).doc.iconURL).toBe(
      `${IMG}/${SLUG}/a/${I}`,
    );
    // A listing with no icon: listing.icon is presentation.icon's fallback (HA-05).
    await w.db.run(
      "UPDATE dist_outlets SET listing_json = ? WHERE product = ? AND outlet_id = 'altstore'",
      JSON.stringify({ ...LISTING, iconUrl: undefined }),
      SLUG,
    );
    await w.db.run(
      "UPDATE hosted_assets SET pulled_ref = ? WHERE product = ? AND slot = 'listing.icon'",
      ref("url", "https://cdn.example.test/product-icon.png"),
      SLUG,
    );
    expect((await feed(w, "altstore/stable/source.json")).doc.iconURL).toBe(
      `${IMG}/${SLUG}/a/${I}`,
    );
  });

  for (const [label, off] of [
    [
      "the kill switch off (HA-10's assets.hosting.enabled)",
      (w: World) => setAssetHosting(w.env, w.db, "off"),
    ],
    ["no image host", async (w: World) => void delete w.env.IMG_ORIGIN],
  ] as const)
    it(`rollback, ${label}: the developer's URLs, exactly as before HA-07`, async () => {
      const w = await hostedWorld();
      await off(w);
      const { doc } = await feed(w, "altstore/stable/source.json");
      expect(doc.iconURL).toBe(ICON);
      expect(doc.headerURL).toBe(HEADER_NEW);
      expect(doc.apps[0].screenshots).toEqual([SHOT_1, SHOT_3]);
      expect(JSON.stringify(doc)).not.toContain(IMG);
    });

  it("the feed cache key follows the hosted art", async () => {
    const w = await hostedWorld();
    const before = await hostedArtStamp(w.env, w.db, SLUG);
    await w.db.run(
      "UPDATE hosted_assets SET pulled_ref = ?, status = 'ready' WHERE product = ? AND slot = 'listing.header'",
      ref("url", HEADER_NEW),
      SLUG,
    );
    const after = await hostedArtStamp(w.env, w.db, SLUG);
    expect(after).not.toBe(before);
    // A copy whose hosted-asset ref went is no longer served (the image host's tenancy check):
    // a new key too, so the source stops naming it on its next read.
    await w.db.run(
      "DELETE FROM blob_refs WHERE product = ? AND ref_kind = 'hosted-asset' AND ref_id = 'listing.icon@'",
      SLUG,
    );
    expect(await hostedArtStamp(w.env, w.db, SLUG)).not.toBe(after);
    await setAssetHosting(w.env, w.db, "off");
    expect(await hostedArtStamp(w.env, w.db, SLUG)).toBe("-");
  });
});
