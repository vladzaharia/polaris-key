/**
 * P2b-06 fixtures: a Diceroll-shaped product for the download page and the distribution matrix,
 * every release ingested through the real descriptor ingest:
 *
 *     1.0.0   stable
 *     1.1.0   stable   reported live on app-store, play and steam
 *     1.1.1   stable   YANKED (and reported live on steam: still never shown)
 *     1.2.0-beta.1  beta
 *     1.2.0   stable   halted on altstore, paused on direct; live on play
 */

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { seedDeliveryAccess } from "./releaseSurface.js";
import { enableServices } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { dispatch } from "../src/dispatch.js";
import { ingestReleaseDescriptor } from "../src/services/release/descriptor.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { yankRelease } from "../src/services/release/model.js";
import { blobKey, recordObject } from "../src/core/blobs.js";
import type { DownloadModel } from "../src/services/distribution/page/model.js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const SLUG = "diceroll";
export const CONSOLE = "https://key.example.test";
export const BYTES = "https://dl.example.test";
export const SIGNER = "c".repeat(64);
export const FDROID_FP = "f".repeat(64);
export const APK_SIGNING = "a".repeat(64);
export const UPLOAD_KEY = "b".repeat(64);

export const sha = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");

// ── The product ──────────────────────────────────────────────────────────────────────────────

export const ARTIFACTS = [
  ["ipa-sideload", "ios", "arm64", "ipa", "Diceroll-*-ios-sideload.ipa"],
  ["apk", "android", "universal", "apk", "Diceroll-*-android.apk"],
  ["mac", "macos", "universal", "dmg", "Diceroll-*-macos.dmg"],
  ["win-x64", "windows", "x86_64", "zip", "Diceroll-*-windows-x86_64.zip"],
  ["win-arm64", "windows", "arm64", "zip", "Diceroll-*-windows-arm64.zip"],
  ["linux-x64", "linux", "x86_64", "tar.gz", "Diceroll-*-linux-x86_64.tar.gz"],
  ["linux-appimage", "linux", "arm64", "appimage", "Diceroll-*-arm64.AppImage"],
].map(([id, platform, arch, format, match]) => ({
  id: id!,
  platform: platform!,
  arch: arch!,
  format: format!,
  match: match!,
}));

export function appDeclaration() {
  const res = parseManifest({
    product: JSON.stringify({
      slug: SLUG,
      name: "Diceroll",
      modules: {
        license: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
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

export const LISTING = {
  name: "Diceroll",
  subtitle: "A cozy dice-rolling roguelite",
  description: "Roll, reroll, repeat.",
  website: "https://diceroll.example.test",
  developerName: "Vlad",
};

/** A hostile listing: what a repo writer could push in `.pkey/distribution`, unvalidated. */
export const HOSTILE_LISTING = {
  name: `Dice<script>alert(1)</script>"roll'`,
  subtitle: `"><img src=x onerror=alert(1)>`,
  description: "</p><script>document.cookie</script>",
  website: "javascript:alert(document.domain)",
  developerName: "<b>Vlad</b>",
};

export const OUTLETS: Array<[string, string, Record<string, unknown>]> = [
  [
    "altstore",
    "altstore",
    { artifact: "ipa-sideload", bundleId: "gg.vlad.diceroll" },
  ],
  [
    "altstore-pal",
    "altstore-pal",
    {
      artifact: "ipa-sideload",
      bundleId: "gg.vlad.diceroll",
      marketplaceId: "6740000001",
    },
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
      homebrewCask: "diceroll",
      scoop: { bin: "Diceroll/diceroll.exe" },
    },
  ],
  [
    "app-store",
    "app-store",
    { appleId: "6740000002", bundleId: "gg.vlad.diceroll" },
  ],
  ["play", "play", { packageName: "gg.vlad.diceroll" }],
  ["steam", "steam", { appId: "3100000" }],
  // Declared but never reported live: no link.
  ["ms-store", "ms-store", { productId: "9NBLGGH4R315" }],
  // Entitled-only: never on the page.
  [
    "testflight",
    "testflight",
    { appleId: "6740000002", publicLink: "AbCdEf12" },
  ],
];

export interface World {
  env: Env;
  db: Db;
}

export function bytesFor(name: string): Uint8Array {
  return new TextEncoder().encode(`bytes of ${name}\n`);
}

export function metadataFor(buildId: string, version: string) {
  if (buildId === "ipa-sideload")
    return {
      bundleIdentifier: "gg.vlad.diceroll",
      version,
      buildVersion: "1",
      minOSVersion: "16.0",
      appPermissions: { entitlements: [], privacy: {} },
    };
  if (buildId === "apk")
    return {
      packageName: "gg.vlad.diceroll",
      versionCode: 10000 + version.length,
      versionName: version,
      minSdk: 24,
      targetSdk: 35,
      nativecode: ["arm64-v8a"],
      signerSha256: SIGNER,
    };
  return undefined;
}

export const DAY = 86400;
export const RELEASES: Array<[string, "stable" | "beta", number]> = [
  ["1.0.0", "stable", NOW - 40 * DAY],
  ["1.1.0", "stable", NOW - 30 * DAY],
  ["1.1.1", "stable", NOW - 25 * DAY],
  ["1.2.0-beta.1", "beta", NOW - 20 * DAY],
  ["1.2.0", "stable", NOW - 10 * DAY],
];

export async function publish(
  w: World,
  version: string,
  channel: string,
  at: number,
) {
  const builds = ARTIFACTS.map((a) => {
    const name = a.match.replace("*", version);
    const bytes = bytesFor(name);
    const meta = metadataFor(a.id, version);
    return {
      id: a.id,
      platform: a.platform,
      arch: a.arch,
      format: a.format,
      ...(a.platform === "macos" ? { minOS: "12.0" } : {}),
      ...(meta ? { metadata: meta } : {}),
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
      notes: `<!-- pkey:summary -->What's **new** in ${version}.<!-- /pkey:summary -->\n\n## Details\n\nMore.`,
      publishedAt: new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      builds,
    },
    { source: "ci", now: NOW, promoted },
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
}

export async function rollout(
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

export async function reportLive(w: World, releaseId: string, outlet: string) {
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

export async function addKey(
  w: World,
  purpose: string,
  fp: string,
  source = "admin",
) {
  await w.db.run(
    `INSERT INTO dist_keys (product, purpose, fingerprint_sha256, outlet_id, notes, registered_at,
                            source, observed_json, created_at, modified_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
    SLUG,
    purpose,
    fp,
    source,
    NOW,
    NOW,
  );
}

export async function setup(
  opts: {
    listing?: Record<string, unknown>;
    access?: string;
    consoleOrigin?: string | null;
    blobOrigin?: string;
  } = {},
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
  const listing = opts.listing ?? LISTING;
  for (const [id, kind, identity] of OUTLETS)
    await db.run(
      `INSERT INTO dist_outlets
         (product, outlet_id, kind, identity_json, listing_json, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      SLUG,
      id,
      kind,
      JSON.stringify(identity),
      JSON.stringify(listing),
      NOW,
      NOW,
    );
  const env = makeEnv(new KvMock(), [SLUG]);
  env.BLOB_ORIGIN = opts.blobOrigin ?? BYTES;
  if (opts.consoleOrigin !== null)
    env.CONSOLE_ORIGIN = opts.consoleOrigin ?? CONSOLE;
  env.BLOBS = asR2(new R2Mock());
  // For the console's admin API (the matrix suite).
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "platform-admins";
  const w = { env, db };
  for (const [version, channel, at] of RELEASES)
    await publish(w, version, channel, at);
  await yankRelease(db, SLUG, "app@1.1.1", "bad build", "admin:u1", NOW);
  await rollout(w, "altstore", "app@1.2.0", 10000, "halted");
  await rollout(w, "direct", "app@1.2.0", 2500, "paused");
  for (const outlet of ["app-store", "play", "steam"])
    await reportLive(w, "app@1.1.0", outlet);
  await reportLive(w, "app@1.1.1", "steam");
  await reportLive(w, "app@1.2.0", "play");
  for (const id of ["app@1.0.0", "app@1.1.0"])
    await reportLive(w, id, "altstore-pal");
  // The F-Droid repository CI registered, and the operator's key inventory.
  await db.run(
    `INSERT INTO dist_feed_files (product, feed, channel, path, sha256, size, content_type, updated_at)
     VALUES (?, 'fdroid', 'stable', 'entry.jar', ?, 10, 'application/java-archive', ?)`,
    SLUG,
    "e".repeat(64),
    NOW,
  );
  await addKey(w, "fdroid-repo", FDROID_FP);
  await addKey(w, "android-app-signing", APK_SIGNING);
  await addKey(w, "android-upload", UPLOAD_KEY);
  await addKey(w, "android-sideload", "d".repeat(64), "ci");
  return w;
}

export function onConsole(w: World, path: string, init: RequestInit = {}) {
  return dispatch(new Request(`${CONSOLE}${path}`, init), w.env, w.db);
}

export function onBytes(w: World, path: string, init: RequestInit = {}) {
  return dispatch(new Request(`${BYTES}${path}`, init), w.env, w.db);
}

export async function model(w: World): Promise<DownloadModel> {
  const res = await onConsole(w, `/${SLUG}/distribution/download.json`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as DownloadModel;
}

export const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  linuxArm:
    "Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0",
  cros: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  bot: "curl/8.5.0",
};
