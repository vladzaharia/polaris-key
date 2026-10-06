/**
 * A-18i — the PR plane through the real dispatcher: the generators' CI read
 * (`GET /<p>/distribution/pr/<store>`, `services/distribution/prInputs.ts`) and the report-back of
 * PR steps (`POST /<p>/distribution/report`, `type: "store-step"` with a PR-plane store), which
 * writes a `store_operations` row with `plane = 'pr'`, natural key `pr:<package>:<version>`, the
 * files the PR wrote and the verifier's verdict. The Worker re-checks the repository against the
 * outlet identity and every file against the store's path templates.
 *
 * The `pkeyci_` lookup seam (`core/ciTokens.ts`) is mocked, as in the other CI-route suites.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(
  () =>
    new Map<
      string,
      { product: string; subject: string; scopes: readonly string[] }
    >(),
);
vi.mock("../../src/core/ciTokens.js", () => ({
  lookupCiToken: async (_env: unknown, _db: unknown, token: string) =>
    tokens.get(token) ?? null,
}));

import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { R2Mock, asR2 } from "../r2Mock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import { seedDeliveryAccess } from "../releaseSurface.js";
import { enableServices } from "../releaseRoutesFixture.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/env.js";
import { dispatch } from "../../src/dispatch.js";
import { ingestReleaseDescriptor } from "../../src/services/release/descriptor.js";
import { manifestDeliverableStatements } from "../../src/services/release/deliverables.js";
import { blobKey, recordObject } from "../../src/core/blobs.js";
import { listStoreOperations } from "../../src/core/storefront/ledger.js";
import {
  stmtUpsertListing,
  stmtUpsertLocale,
  upsertReleaseNotes,
} from "../../src/services/distribution/listing/store.js";
import { prStepOp } from "../../src/services/distribution/storeSteps.js";

const SLUG = "diceroll";
const CONSOLE = "https://key.example.test";
const REPORTER = "pkeyci_reporter";
const FEEDER = "pkeyci_feeder";

const sha = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  tokens.clear();
  tokens.set(REPORTER, {
    product: SLUG,
    subject: "repo:vlad/diceroll:environment:release",
    scopes: ["release:publish", "distribution:report"],
  });
  tokens.set(FEEDER, {
    product: SLUG,
    subject: "static:tok_feeds",
    scopes: ["distribution:feeds"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

const ARTIFACTS = [
  ["win-x64", "windows", "x86_64", "zip", "Diceroll-*-windows-x86_64.zip"],
  ["win-arm64", "windows", "arm64", "zip", "Diceroll-*-windows-arm64.zip"],
  ["mac", "macos", "universal", "dmg", "Diceroll-*-macos.dmg"],
  ["linux-x64", "linux", "x86_64", "tar.gz", "Diceroll-*-linux-x86_64.tar.gz"],
].map(([id, platform, arch, format, match]) => ({
  id: id!,
  platform: platform!,
  arch: arch!,
  format: format!,
  match: match!,
}));

function appDeclaration() {
  const res = parseManifest({
    product: JSON.stringify({
      slug: SLUG,
      name: "Diceroll",
      modules: {
        release: { enabled: true },
        distribution: { enabled: true },
      },
    }),
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

const OUTLETS: Array<[string, string, Record<string, unknown>]> = [
  [
    "direct",
    "direct",
    {
      platforms: ["macos", "windows", "linux"],
      homebrewCask: "diceroll",
      homebrewTap: "vlad/homebrew-games",
      scoop: { bin: "Diceroll/diceroll.exe" },
      scoopBucket: "vlad/scoop-games",
    },
  ],
  ["winget", "winget", { packageIdentifier: "Vlad.Diceroll" }],
  ["flathub", "flathub", { appId: "gg.vlad.Diceroll" }],
];

const MANIFEST_LISTING = {
  iconUrl: "https://cdn.example.test/diceroll/icon.png",
  screenshots: [
    "https://cdn.example.test/diceroll/1.png",
    "http://insecure.example.test/2.png",
  ],
};

interface World {
  env: Env;
  db: Db;
}

async function publish(w: World, version: string, at: number): Promise<void> {
  const builds = ARTIFACTS.map((a) => {
    const name = a.match.replace("*", version);
    const bytes = new TextEncoder().encode(`bytes of ${name}\n`);
    return {
      id: a.id,
      platform: a.platform,
      arch: a.arch,
      format: a.format,
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
  });
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
      channel: "stable",
      title: `Diceroll ${version}`,
      notes: `What's new in ${version}.`,
      publishedAt: new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      builds,
    },
    { source: "ci", now: NOW, promoted },
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
}

async function setup(
  opts: { access?: string; listing?: boolean } = {},
): Promise<World> {
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
  await seedDeliveryAccess(db, SLUG, opts.access ?? "public");
  await db.batch(manifestDeliverableStatements(SLUG, appDeclaration(), NOW));
  for (const [id, kind, identity] of OUTLETS)
    await db.run(
      `INSERT INTO dist_outlets
         (product, outlet_id, kind, identity_json, listing_json, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      SLUG,
      id,
      kind,
      JSON.stringify(identity),
      JSON.stringify(MANIFEST_LISTING),
      NOW,
      NOW,
    );
  const env = makeEnv(new KvMock(), [SLUG]);
  env.BLOBS = asR2(new R2Mock());
  const w = { env, db };
  await publish(w, "1.1.0", NOW - 20 * 86400);
  await publish(w, "1.2.0", NOW - 10 * 86400);
  if (opts.listing !== false) {
    await db.batch([
      stmtUpsertListing(
        SLUG,
        {
          name: "Diceroll",
          developerName: "Vlad",
          copyright: "© 2026 Vlad",
          urls: {
            website: "https://diceroll.example.test",
            support: "https://diceroll.example.test/help",
            privacy: "https://diceroll.example.test/privacy",
          },
          tint: "#3b1f1f",
          tintDark: "#f0c0c0",
          contentDescriptors: { violenceCartoon: "mild", chat: "none" },
        },
        undefined,
        "admin",
        "admin:u1",
        NOW,
        "en-US",
      ),
      stmtUpsertLocale(
        SLUG,
        "en-US",
        {
          subtitle: "Roll the bones",
          shortDescription: "A cozy dice-rolling roguelite.",
          description: "Roll, reroll, repeat.\n\nNow with more dice.",
          keywords: ["dice", "roguelite"],
        },
        "admin",
        "admin:u1",
        NOW,
      ),
      stmtUpsertLocale(
        SLUG,
        "de",
        {
          name: "Würfelwurf",
          subtitle: "Wirf die Knochen",
          shortDescription: "Ein gemütliches Würfel-Roguelite.",
          description: "Würfeln, neu würfeln, wiederholen.",
        },
        "admin",
        "admin:u1",
        NOW,
      ),
    ]);
    await upsertReleaseNotes(
      db,
      SLUG,
      "app@1.2.0",
      "en-US",
      { text: "Faster rolls.", short: null },
      "admin",
      "admin:u1",
      NOW,
    );
  }
  return w;
}

function get(w: World, path: string, token = REPORTER): Promise<Response> {
  return dispatch(
    new Request(`${CONSOLE}/${SLUG}/distribution/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    w.env,
    w.db,
  );
}

async function inputs(w: World, path: string): Promise<any> {
  const res = await get(w, path);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { inputs: unknown }).inputs;
}

function report(w: World, body: unknown): Promise<Response> {
  return dispatch(
    new Request(`${CONSOLE}/${SLUG}/distribution/report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${REPORTER}`,
      },
      body: JSON.stringify(body),
    }),
    w.env,
    w.db,
  );
}

// ── The CI read ──────────────────────────────────────────────────────────────────────────────

describe("the PR plane's CI read (A-18i)", () => {
  it("winget: the channel's newest release, its Windows builds and the winget projection", async () => {
    const w = await setup();
    const i = await inputs(w, "pr/winget?channel=stable");
    expect(i.store).toBe("winget");
    expect(i.channel).toBe("stable");
    expect(i.outlet).toEqual({
      id: "winget",
      kind: "winget",
      identity: { packageIdentifier: "Vlad.Diceroll" },
    });
    expect(i.release.version).toBe("1.2.0");
    expect(
      i.release.builds.map((b: any) => [b.platform, b.arch, b.name]),
    ).toEqual([
      ["windows", "arm64", "Diceroll-1.2.0-windows-arm64.zip"],
      ["windows", "x86_64", "Diceroll-1.2.0-windows-x86_64.zip"],
    ]);
    for (const b of i.release.builds) {
      expect(b.url).toMatch(/^https:\/\//);
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(i.notes).toEqual({
      "en-US": { text: "Faster rolls.", short: null },
    });
    expect(i.listing.status).not.toBe("red");
    expect(i.listing.payload.app).toMatchObject({
      Publisher: "Vlad",
      PublisherSupportUrl: "https://diceroll.example.test/help",
      Copyright: "© 2026 Vlad",
    });
    expect(i.listing.payload.locales["en-US"]).toMatchObject({
      PackageName: "Diceroll",
      ShortDescription: "A cozy dice-rolling roguelite.",
      ReleaseNotes: "Faster rolls.",
      Tags: ["dice", "roguelite"],
    });
    expect(i.links).toEqual({
      downloadJson: `${CONSOLE}/${SLUG}/distribution/download.json`,
      scoopFeed: `${CONSOLE}/${SLUG}/distribution/scoop/stable.json`,
      flathubFeed: `${CONSOLE}/${SLUG}/distribution/flathub/stable.json`,
    });
    expect(i.selfUpdates).toBe(false);
    expect(i.scoop).toBeUndefined();
  });

  it("homebrew: the direct outlet's macOS build, and auto-updates from the outlet's capabilities", async () => {
    const w = await setup();
    const i = await inputs(w, "pr/homebrew");
    expect(i.outlet.id).toBe("direct");
    expect(i.outlet.identity.homebrewTap).toBe("vlad/homebrew-games");
    expect(i.release.builds.map((b: any) => b.name)).toEqual([
      "Diceroll-1.2.0-macos.dmg",
    ]);
    expect(i.listing).toBeNull();
    expect(i.selfUpdates).toBe(true);
    expect(i.app).toMatchObject({
      name: "Diceroll",
      shortDescription: "A cozy dice-rolling roguelite.",
      website: "https://diceroll.example.test",
      // S-20 §4.2 L6: the manifest listing's raw URLs are never projected.
      screenshots: [],
    });
    expect(i.app).not.toHaveProperty("iconUrl");
    expect(JSON.stringify(i)).not.toContain("cdn.example.test");
  });

  it("scoop: the feed's own manifest, byte-for-byte the public feed's", async () => {
    const w = await setup();
    const i = await inputs(w, "pr/scoop?channel=stable");
    const feed = await dispatch(
      new Request(`${CONSOLE}/${SLUG}/distribution/scoop/stable.json`),
      w.env,
      w.db,
    );
    expect(feed.status).toBe(200);
    expect(i.scoop).toEqual(await feed.json());
    expect(i.scoop.checkver.url).toBe(i.links.scoopFeed);
  });

  it("flathub: the Linux build, branding, descriptors and the localized names", async () => {
    const w = await setup();
    const i = await inputs(w, "pr/flathub");
    expect(i.release.builds.map((b: any) => b.arch)).toEqual(["x86_64"]);
    expect(i.app).toMatchObject({
      tint: "#3b1f1f",
      tintDark: "#f0c0c0",
      contentDescriptors: { violenceCartoon: "mild", chat: "none" },
      developerName: "Vlad",
    });
    expect(i.app.locales.de).toEqual({
      name: "Würfelwurf",
      subtitle: "Wirf die Knochen",
    });
    expect(i.listing.payload.locales["en-US"]).toMatchObject({
      name: "Diceroll",
      summary: "Roll the bones",
    });
  });

  it("a product with no listing still answers, with the projection's missing fields red", async () => {
    const w = await setup({ listing: false });
    const i = await inputs(w, "pr/winget");
    expect(i.listing.exists).toBe(false);
    expect(i.listing.status).toBe("red");
    expect(i.listing.payload).toBeNull();
    expect(i.notes).toEqual({
      "en-US": { text: "What's new in 1.2.0.", short: null },
    });
    // No listing and no manifest name: the product's own name (the seed's is its slug).
    expect(i.app.name).toBe(SLUG);
  });

  it.each([
    ["an unknown store", "pr/itch", REPORTER, 404],
    ["an unknown outlet", "pr/winget?outlet=nope", REPORTER, 404],
    ["an unknown channel", "pr/winget?channel=nightly", REPORTER, 404],
    ["a token without distribution:report", "pr/winget", FEEDER, 403],
    ["no token", "pr/winget", "", 401],
  ])("refuses %s", async (_n, path, token, status) => {
    const w = await setup();
    const res = await get(w, path, token);
    expect(res.status).toBe(status);
  });

  it("is the not-found while the app's delivery access is not public", async () => {
    const w = await setup({ access: "authenticated" });
    expect((await get(w, "pr/winget")).status).toBe(404);
  });
});

// ── The report-back ──────────────────────────────────────────────────────────────────────────

const WINGET_ARGV = [
  "pull-request",
  "--repo",
  "microsoft/winget-pkgs",
  "--package",
  "Vlad.Diceroll",
  "--version",
  "1.2.0",
];
const DIR = "manifests/v/Vlad/Diceroll/1.2.0";
const FILES = [
  `${DIR}/Vlad.Diceroll.yaml`,
  `${DIR}/Vlad.Diceroll.installer.yaml`,
  `${DIR}/Vlad.Diceroll.locale.en-US.yaml`,
  `${DIR}/Vlad.Diceroll.locale.de.yaml`,
].map((path) => ({ path, sha256: sha(path) }));
const PR = {
  number: 123456,
  url: "https://github.com/microsoft/winget-pkgs/pull/123456",
  state: "open",
  merged: false,
  labels: ["Azure-Pipeline-Passed", "Validation-Completed"],
};

const wingetStep = (over: Record<string, unknown> = {}) => ({
  type: "store-step",
  store: "winget",
  op: "release",
  command: "pull-request",
  argv: WINGET_ARGV,
  outlet: "winget",
  runId: "gh-4242-1",
  state: "pending",
  ...over,
});

describe("PR-plane report-back (A-18i)", () => {
  it("a pending then done pull request writes one row with plane = 'pr', its files and verdict", async () => {
    const w = await setup();
    const r1 = await report(w, wingetStep());
    expect(r1.status, await r1.clone().text()).toBe(200);
    expect(((await r1.json()) as any).step).toMatchObject({
      store: "winget",
      command: "pull-request",
      state: "pending",
      plane: "pr",
      replayed: false,
    });
    const r2 = await report(
      w,
      wingetStep({ state: "done", exitCode: 0, files: FILES, pr: PR }),
    );
    expect(r2.status, await r2.clone().text()).toBe(200);
    expect(((await r2.json()) as any).step).toMatchObject({
      state: "done",
      plane: "pr",
      verdict: "in-review",
    });
    const rows = await listStoreOperations(w.db, {
      scope: "product",
      product: SLUG,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      store: "winget",
      plane: "pr",
      state: "done",
      op: prStepOp("pull-request"),
      natural_key: "pr:Vlad.Diceroll:1.2.0",
    });
    expect(JSON.parse(rows[0]!.after_json!)).toEqual({
      type: "pr-step",
      id: "pull-request",
      attributes: {
        tool: "github",
        command: "pull-request",
        argv: WINGET_ARGV,
        repo: "microsoft/winget-pkgs",
        files: FILES,
        pr: { ...PR, labels: [...PR.labels].sort() },
        verdict: "in-review",
        exitCode: 0,
      },
    });
  });

  it("the verifier's status step records the review labels as a verdict", async () => {
    const w = await setup();
    const status = (labels: string[], extra: Record<string, unknown> = {}) =>
      wingetStep({
        op: "status",
        command: "status",
        argv: ["status", ...WINGET_ARGV.slice(1)],
        state: "done",
        runId: `gh-5000-${labels.length}${extra.merged ? "m" : ""}`,
        pr: { ...PR, labels, ...extra },
      });
    const verdicts: string[] = [];
    for (const body of [
      status(["Needs-Author-Feedback"]),
      status(["Validation-Domain", "Azure-Pipeline-Passed"]),
      status([], { state: "closed", merged: true }),
    ]) {
      const r = await report(w, body);
      expect(r.status, await r.clone().text()).toBe(200);
      verdicts.push(((await r.json()) as any).step.verdict);
    }
    expect(verdicts).toEqual([
      "needs-author-feedback",
      "validation-issue",
      "merged",
    ]);
    const rows = await listStoreOperations(w.db, {
      scope: "product",
      product: SLUG,
    });
    expect(rows.every((r) => r.plane === "pr" && r.op === "pr.status")).toBe(
      true,
    );
  });

  it("a PR already open or merged for the version is done with existing: true and no files", async () => {
    const w = await setup();
    const r = await report(
      w,
      wingetStep({
        state: "done",
        existing: true,
        pr: { ...PR, state: "closed", merged: true },
      }),
    );
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as any).step.verdict).toBe("merged");
  });

  it("binds the tap, the bucket and the Flathub app repository to the outlet identity", async () => {
    const w = await setup();
    const ok = await report(w, {
      type: "store-step",
      store: "homebrew",
      op: "release",
      command: "pull-request",
      argv: [
        "pull-request",
        "--repo",
        "vlad/homebrew-games",
        "--cask",
        "diceroll",
        "--version",
        "1.2.0",
      ],
      outlet: "direct",
      runId: "gh-6000-1",
      state: "done",
      files: [{ path: "Casks/diceroll.rb", sha256: sha("cask") }],
      pr: {
        number: 7,
        url: "https://github.com/vlad/homebrew-games/pull/7",
        state: "open",
        merged: false,
        labels: [],
      },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    for (const [store, argv] of [
      [
        "homebrew",
        [
          "pull-request",
          "--repo",
          "evil/homebrew-games",
          "--cask",
          "diceroll",
          "--version",
          "1.2.0",
        ],
      ],
      [
        "homebrew",
        [
          "pull-request",
          "--repo",
          "Homebrew/homebrew-cask",
          "--cask",
          "diceroll",
          "--version",
          "1.2.0",
        ],
      ],
      [
        "scoop",
        [
          "pull-request",
          "--repo",
          "ScoopInstaller/Main",
          "--app",
          "diceroll",
          "--version",
          "1.2.0",
        ],
      ],
      [
        "flathub",
        ["pull-request", "--repo", "flathub/gg.evil.App", "--version", "1.2.0"],
      ],
    ] as const) {
      const r = await report(w, {
        type: "store-step",
        store,
        op: "release",
        command: "pull-request",
        argv,
        outlet: store === "flathub" ? "flathub" : "direct",
        runId: "gh-6000-2",
        state: "pending",
      });
      expect(r.status, argv.join(" ")).toBe(422);
      expect(await r.json()).toMatchObject({ reason: "command_not_allowed" });
    }
  });

  it.each([
    [
      "a file outside the store's paths",
      {
        state: "done",
        pr: PR,
        files: [
          { path: "manifests/v/Vlad/Other/1.2.0/x.yaml", sha256: sha("x") },
        ],
      },
      "files",
    ],
    [
      "a path escape",
      {
        state: "done",
        pr: PR,
        files: [{ path: `${DIR}/../../../evil.yaml`, sha256: sha("x") }],
      },
      "files",
    ],
    [
      "an upper-case digest",
      {
        state: "done",
        pr: PR,
        files: [{ path: FILES[0]!.path, sha256: "A".repeat(64) }],
      },
      "files",
    ],
    [
      "a pull request on another repository",
      {
        state: "done",
        files: FILES,
        pr: { ...PR, url: "https://github.com/evil/winget-pkgs/pull/123456" },
      },
      "pr",
    ],
    ["a done step with no pull request", { state: "done", files: FILES }, "pr"],
    ["a done pull request with no files", { state: "done", pr: PR }, "files"],
    [
      "a merged pull request that is open",
      { state: "done", files: FILES, pr: { ...PR, merged: true } },
      "pr",
    ],
    [
      "files on a status step",
      {
        op: "status",
        command: "status",
        argv: ["status", ...WINGET_ARGV.slice(1)],
        files: FILES,
      },
      "files",
    ],
  ])("refuses %s and writes nothing", async (_n, over, field) => {
    const w = await setup();
    const r = await report(w, wingetStep(over as Record<string, unknown>));
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({
      reason: "invalid_body",
      fields: [field],
    });
    expect(
      await listStoreOperations(w.db, { scope: "product", product: SLUG }),
    ).toEqual([]);
  });

  it("refuses a CI-plane step that carries PR fields, and a PR step for an op it does not perform", async () => {
    const w = await setup();
    const ci = await report(w, {
      type: "store-step",
      store: "epic",
      op: "uploadBuild",
      command: "upload-binary",
      argv: [],
      runId: "gh-7000-1",
      state: "pending",
      pr: PR,
    });
    expect(ci.status).toBe(422);
    const wrongOp = await report(w, wingetStep({ op: "submit" }));
    expect(wrongOp.status).toBe(422);
    expect(await wrongOp.json()).toMatchObject({
      reason: "command_not_allowed",
    });
  });
});
