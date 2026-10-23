/**
 * A-20.6 — what end users get when a product's scope is narrow (A-20 criteria 1 and 2). Tests
 * only (plan D10): the download model and the portal's `customerDownloads` are not changed, and
 * `/<p>/distribution/download.json` stays byte-identical (`pnpm gen transcripts --check`).
 *
 *   1. A Windows arm64-only product's download model has no x64 build, anywhere.
 *   2. A Windows-only product has no Apple action or platform, on the download page (model and
 *      HTML) and in the portal's `customerDownloads` (files, picks and stores).
 *
 *   3. Its Scoop feed (what the Scoop manifest is generated from) has no `64bit` key.
 *
 * The CLI's generated Scoop and winget manifests (no `64bit`, no x64 installer) are proved in
 * `packages/cli/test/storefrontsPr.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { seedDeliveryAccess } from "./releaseSurface.js";
import { enableServices } from "./releaseRoutesFixture.js";
import { buildHooks } from "../src/core/hooks.js";
import { loadProductPublic } from "../src/core/products.js";
import { SERVICES } from "../src/mount.js";
import { ingestReleaseDescriptor } from "../src/services/release/descriptor.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import type { DownloadModel } from "../src/services/distribution/page/model.js";
import { blobKey, recordObject } from "../src/core/assets/blobs.js";
import {
  BYTES,
  CONSOLE,
  UA,
  bytesFor,
  onConsole,
  onBytes,
  sha,
  type World,
} from "./downloadWorld.js";

const SLUG = "winonly";
const APPLE_KINDS = ["app-store", "altstore", "sidestore", "altstore-pal"];
const APPLE_PLATFORMS = ["ios", "macos"];

type Art = [id: string, arch: string, name: string];
const ARM64: Art[] = [["win-arm64", "arm64", "Winonly-*-windows-arm64.zip"]];
const BOTH: Art[] = [
  ["win-x64", "x86_64", "Winonly-*-windows-x86_64.zip"],
  ["win-arm64", "arm64", "Winonly-*-windows-arm64.zip"],
];

function declaration(arts: Art[]) {
  const res = parseManifest({
    product: JSON.stringify({
      slug: SLUG,
      name: "Winonly",
      modules: {
        license: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
      },
    }),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify({
      release: {
        provider: { type: "github", owner: "vladzaharia", repo: "winonly" },
        binaryName: "winonly",
        deliverables: {
          app: {
            kind: "app",
            versioning: { scheme: "semver", buildNumber: "descriptor" },
            artifacts: arts.map(([id, arch, match]) => ({
              id,
              platform: "windows",
              arch,
              format: "zip",
              match,
            })),
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!.app!;
}

/** A product with only the given Windows builds, one stable release, and no store outlet. */
async function windowsWorld(arts: Art[]): Promise<World> {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  await enableServices(db, true, SLUG);
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, beta_branch, binary_name, summary_marker,
        metadata_access, artifacts_access)
     VALUES (?, 'vladzaharia', 'winonly', 42, 'main', 'winonly', 'pkey:summary', 'public', 'public')`,
    SLUG,
  );
  await seedDeliveryAccess(db, SLUG, "public");
  await db.batch(manifestDeliverableStatements(SLUG, declaration(arts), NOW));
  // The product's own site: a direct outlet with no `platforms`, i.e. everything a file can install
  // (so the proofs hold even when the outlet does not name the platform).
  await db.run(
    `INSERT INTO dist_outlets
       (product, outlet_id, kind, identity_json, listing_json, created_at, modified_at)
     VALUES (?, 'direct', 'direct', '{}', ?, ?, ?)`,
    SLUG,
    JSON.stringify({ name: "Winonly", developerName: "Vlad" }),
    NOW,
    NOW,
  );
  const env = makeEnv(new KvMock(), [SLUG]);
  env.BLOB_ORIGIN = BYTES;
  env.CONSOLE_ORIGIN = CONSOLE;
  env.BLOBS = asR2(new R2Mock());
  const w = { env, db };
  const version = "1.0.0";
  const builds = arts.map(([id, arch, match]) => {
    const name = match.replace("*", version);
    const bytes = bytesFor(name);
    return {
      id,
      platform: "windows",
      arch,
      format: "zip",
      artifacts: [
        {
          name,
          role: "payload",
          sha256: sha(bytes),
          size: bytes.length * 1000,
          locations: [{ provider: "r2", key: blobKey(sha(bytes)) }],
        },
      ],
    };
  });
  for (const b of builds) {
    const a = b.artifacts[0]!;
    await recordObject(
      db,
      {
        storageKey: a.locations[0]!.key,
        sha256: a.sha256,
        size: a.size,
        kind: "blob",
        gated: false,
      },
      NOW,
    );
  }
  const res = await ingestReleaseDescriptor(
    db,
    env,
    SLUG,
    {
      descriptorVersion: 1,
      product: SLUG,
      deliverable: "app",
      kind: "app",
      version,
      channel: "stable",
      title: `Winonly ${version}`,
      notes: "Notes.",
      publishedAt: new Date((NOW - 86400) * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
      builds,
    },
    {
      source: "ci",
      now: NOW,
      promoted: builds.map((b) => b.artifacts[0]!.locations[0]!.key),
    },
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  return w;
}

async function customerDownloads(w: World) {
  const product = await loadProductPublic(w.db, SLUG);
  const hooks = buildHooks(SERVICES, product!.services, {
    env: w.env,
    db: w.db,
    product: product!,
    now: NOW,
  });
  const d = await hooks.delivery()!.customerDownloads!({
    channel: "stable",
    limit: 5,
    installSources: true,
  });
  expect(d).not.toBeNull();
  return d!;
}

async function getModel(w: World): Promise<DownloadModel> {
  const res = await onConsole(w, `/${SLUG}/distribution/download.json`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as DownloadModel;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a Windows arm64-only product (criterion 2)", () => {
  it("the download model has no x64 build, in any platform group or action", async () => {
    const w = await windowsWorld(ARM64);
    const m = await getModel(w);
    const builds = m.platforms.flatMap((p) => p.builds);
    expect(builds.map((b) => [b.platform, b.arch])).toEqual([
      ["windows", "arm64"],
    ]);
    const actionBuilds = m.actions.flatMap((a) => (a.build ? [a.build] : []));
    for (const b of [...builds, ...actionBuilds]) {
      expect(b.arch).toBe("arm64");
      expect(b.name).not.toMatch(/x86_64|x64|amd64/i);
    }
    expect(JSON.stringify(m)).not.toMatch(/x86_64|x64|amd64/i);
  });

  it("the portal lists no x64 file and recommends only arm64", async () => {
    const d = await customerDownloads(await windowsWorld(ARM64));
    const files = d.releases.flatMap((r) => r.files);
    expect(files.map((f) => [f.platform, f.arch])).toEqual([
      ["windows", "arm64"],
    ]);
  });

  it("the control: a product with both builds does list x64", async () => {
    const m = await getModel(await windowsWorld(BOTH));
    expect(
      m.platforms.flatMap((p) => p.builds.map((b) => b.arch)).sort(),
    ).toEqual(["arm64", "x86_64"]);
  });
});

describe("the Scoop feed of a Windows arm64-only product", () => {
  const scoop = async (w: World) => {
    const res = await onConsole(w, `/${SLUG}/distribution/scoop/stable.json`);
    expect(res.status, await res.clone().text()).toBe(200);
    return res.text();
  };

  it("has an arm64 architecture and no 64bit key anywhere", async () => {
    const text = await scoop(await windowsWorld(ARM64));
    const doc = JSON.parse(text);
    expect(Object.keys(doc.architecture)).toEqual(["arm64"]);
    expect(Object.keys(doc.autoupdate.architecture)).toEqual(["arm64"]);
    expect(text).not.toContain("64bit");
  });

  it("the control: with both builds the feed has 64bit too", async () => {
    const doc = JSON.parse(await scoop(await windowsWorld(BOTH)));
    expect(Object.keys(doc.architecture)).toEqual(["64bit", "arm64"]);
  });
});

describe("a Windows-only product has no Apple action (criterion 1)", () => {
  it("the download model has no Apple platform or action", async () => {
    const w = await windowsWorld(BOTH);
    const m = await getModel(w);
    // Not vacuous: the Windows download is there.
    expect(m.actions.map((a) => a.kind)).toContain("download");
    expect(m.platforms.map((p) => p.platform)).not.toEqual(
      expect.arrayContaining(APPLE_PLATFORMS),
    );
    for (const p of m.platforms)
      expect(APPLE_PLATFORMS).not.toContain(p.platform);
    for (const a of m.actions) {
      expect(APPLE_KINDS).not.toContain(a.kind);
      for (const p of a.platforms) expect(APPLE_PLATFORMS).not.toContain(p);
    }
  });

  it("the download page (HTML) offers no Apple action to any visitor", async () => {
    const w = await windowsWorld(BOTH);
    for (const ua of [UA.windows, UA.iphone, UA.ipad, UA.android, UA.linux]) {
      const res = await onBytes(w, `/${SLUG}`, {
        headers: { "user-agent": ua },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toMatch(
        /App Store|AltStore|SideStore|apps\.apple\.com|itms-apps/i,
      );
      expect(html).not.toMatch(/macOS|iPhone|iPad/);
    }
  });

  it("the portal's customerDownloads has no Apple file, pick or store", async () => {
    const d = await customerDownloads(await windowsWorld(BOTH));
    for (const r of d.releases) {
      for (const f of r.files)
        expect(APPLE_PLATFORMS).not.toContain(f.platform);
      for (const p of Object.keys(r.picks))
        expect(APPLE_PLATFORMS).not.toContain(p);
    }
    expect(d.stores.filter((s) => APPLE_KINDS.includes(s.kind))).toEqual([]);
    expect(
      (d.installSources ?? []).filter((s) =>
        APPLE_KINDS.includes((s as { kind: string }).kind),
      ),
    ).toEqual([]);
  });
});
