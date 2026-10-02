/**
 * P3-09 — the app-updater feeds (`services/update/updaterFeeds.ts` + `updaterRender.ts`), driven
 * through the real dispatcher against a product that publishes CI-signed releases through the
 * real upload + submit routes (records signed by the release test key), on every desktop
 * platform:
 *
 *     mac-arm64      macos   arm64      dmg         + .sig
 *     mac-universal  macos   universal  dmg         + .sig (+ a Sparkle delta with deltaFrom, + .sig)
 *     win-x64        windows x86_64     inno  .exe  + .sig
 *     win-arm64      windows arm64      msi   .msi  + .sig
 *     win-velopack   windows x86_64     nupkg       (+ a Velopack delta package)
 *     msix           windows universal  msixbundle
 *     appimage       linux   x86_64     appimage    + .zsync control file
 *
 * and four releases (build numbers differ from the short versions):
 *
 *     1.0.0  (build 100)  stable
 *     1.1.0  (build 110)  stable   universal macOS only
 *     1.1.5  (build 115)  stable   YANKED
 *     1.2.0  (build 120)  stable   an ACTIVE 2500 bp rollout on `direct` and `app-installer`
 *     1.3.0-beta.1 (130)  beta
 *
 * with the stable floor at 1.1.0. So Sparkle phases 1.2.0 (with a floor-critical marker), every
 * feed without a rollout concept serves 1.1.0 on stable, 1.1.5 is in no feed, and a halt takes
 * 1.2.0 out of every feed. Rendered documents are compared against golden files under
 * `test/fixtures/updater-feeds/` (`UPDATE_FEED_GOLDENS=1` rewrites them).
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW } from "./seed.js";
import { asR2, R2Mock } from "./r2Mock.js";
import {
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import {
  recordFor,
  releaseKeysJson,
  signRecord,
} from "./releaseKeysFixture.js";
import { seedDeliveryAccess } from "./releaseSurface.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import {
  setChannelPolicy,
  yankRelease,
} from "../src/services/release/model.js";
import {
  msixVersion,
  phasedSchedule,
  renderAppInstaller,
  rewriteZsync,
  velopackPackageId,
  PHASE_INTERVAL_SECONDS,
} from "../src/services/update/updaterRender.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, "fixtures", "updater-feeds");
const BYTES_ORIGIN = "https://dl.example.test";
const DAY = 86400;

const sha = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");
const sha1 = (b: Uint8Array): string =>
  createHash("sha1").update(b).digest("hex");

const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

// ── The product ──────────────────────────────────────────────────────────────────────────────

const ARTIFACTS = [
  ["mac-arm64", "macos", "arm64", "dmg", "djdl-*-macos-arm64.dmg"],
  ["mac-universal", "macos", "universal", "dmg", "djdl-*-macos-universal.dmg"],
  ["win-x64", "windows", "x86_64", "inno", "djdl-*-windows-x64-setup.exe"],
  ["win-arm64", "windows", "arm64", "msi", "djdl-*-windows-arm64.msi"],
  ["win-velopack", "windows", "x86_64", "nupkg", "Djdl-*-full.nupkg"],
  ["msix", "windows", "universal", "msixbundle", "djdl-*.msixbundle"],
  ["appimage", "linux", "x86_64", "appimage", "djdl-*-x86_64.AppImage"],
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
      name: "djdl",
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
        provider: { type: "github", owner: "acme", repo: "djdl" },
        binaryName: "djdl",
        deliverables: {
          app: {
            kind: "app",
            versioning: { scheme: "semver", buildNumber: "descriptor" },
            artifacts: ARTIFACTS,
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!.app!;
}

const APP_INSTALLER_IDENTITY = {
  packageFamilyName: "Acme.Djdl_1a2b3c4d5e6f7",
  publisher: "CN=Acme Corporation, O=Acme Corporation, C=US",
  updateSettings: {
    hoursBetweenUpdateChecks: 12,
    showPrompt: true,
    automaticBackgroundTask: true,
  },
};

const OUTLETS: Array<[string, string, Record<string, unknown>]> = [
  ["direct", "direct", { platforms: ["macos", "windows", "linux"] }],
  ["app-installer", "app-installer", APP_INSTALLER_IDENTITY],
];

interface World {
  db: Db;
  env: Env;
  r2: R2Mock;
  token: string;
  sparkleKey: KeyObject;
  releases: Record<string, string>;
}

/** A random Ed25519 key (the wrong key, for the refusal test). */
function sparkleKeyPair(): { priv: KeyObject; pubB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { priv: privateKey, pubB64: Buffer.from(raw).toString("base64") };
}
/** The Sparkle test key: a fixed seed, so signatures (and the goldens) are deterministic. */
const SPARKLE = (() => {
  const priv = createPrivateKey({
    key: Buffer.from(
      `302e020100300506032b657004220420${"5a".repeat(32)}`,
      "hex",
    ),
    format: "der",
    type: "pkcs8",
  });
  const raw = createPublicKey(priv)
    .export({ format: "der", type: "spki" })
    .subarray(12);
  return { priv, pubB64: Buffer.from(raw).toString("base64") };
})();

const BUILD_NUMBERS: Record<string, string> = {
  "1.0.0": "100",
  "1.1.0": "110",
  "1.1.5": "115",
  "1.2.0": "120",
  "1.3.0-beta.1": "130",
};

function bytesOf(name: string): Uint8Array {
  return new TextEncoder().encode(`bytes of ${name}\n`);
}

/** A zsync control file whose header describes `target`, with a binary checksum tail. */
function zsyncFor(name: string, target: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(
    [
      "zsync: 0.6.2",
      `Filename: ${name}`,
      "MTime: Thu, 01 Oct 2026 00:00:00 +0000",
      "Blocksize: 2048",
      `Length: ${target.length}`,
      "Hash-Lengths: 1,2,4",
      `URL: ${name}`,
      `SHA-1: ${sha1(target)}`,
      "",
      "",
    ].join("\n"),
  );
  const tail = new Uint8Array([0x00, 0x9f, 0x0a, 0x0a, 0xff, 0x10, 0x20]);
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}

interface FileSpec {
  name: string;
  role: string;
  bytes: Uint8Array;
  deltaFrom?: string;
}

function filesFor(buildId: string, version: string): FileSpec[] {
  const a = ARTIFACTS.find((x) => x.id === buildId)!;
  const name = a.match.replace("*", version);
  const payload = bytesOf(name);
  const files: FileSpec[] = [{ name, role: "payload", bytes: payload }];
  const sig = (target: FileSpec): FileSpec => ({
    name: `${target.name}.sig`,
    role: "signature",
    bytes: new TextEncoder().encode(
      `${edSign(null, target.bytes, SPARKLE.priv).toString("base64")}\n`,
    ),
  });
  if (
    a.platform === "macos" ||
    buildId === "win-x64" ||
    buildId === "win-arm64"
  )
    files.push(sig(files[0]!));
  if (buildId === "mac-universal" && version === "1.2.0") {
    const delta: FileSpec = {
      name: "djdl-1.2.0-from-110.delta",
      role: "delta",
      bytes: bytesOf("djdl-1.2.0-from-110.delta"),
      deltaFrom: "110",
    };
    files.push(delta, sig(delta));
  }
  if (buildId === "win-velopack" && version !== "1.0.0") {
    const n = `Djdl-${version}-delta.nupkg`;
    files.push({ name: n, role: "delta", bytes: bytesOf(n) });
  }
  if (buildId === "appimage")
    files.push({
      name: `${name}.zsync`,
      role: "checksum",
      bytes: zsyncFor(name, payload),
    });
  return files;
}

function post(w: World, path: string, body: unknown) {
  return call(
    w.env,
    w.db,
    noFetch,
    `${CONSOLE}/${SLUG}/release/publish/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${w.token}`,
      },
      body: JSON.stringify(body),
    },
  );
}

async function publish(
  w: World,
  version: string,
  channel: string,
  at: number,
  builds: readonly string[],
): Promise<string> {
  const pre = (await (
    await post(w, "uploads", {
      objects: [{ sha256: "0".repeat(64), size: 1 }],
      releases: [{ deliverable: "app", version }],
    })
  ).json()) as Record<string, any>;
  const seq = pre.seqs[0].seq as number;
  const descBuilds = builds.map((id) => {
    const a = ARTIFACTS.find((x) => x.id === id)!;
    return {
      id,
      platform: a.platform,
      arch: a.arch,
      format: a.format,
      buildNumber: BUILD_NUMBERS[version]!,
      ...(a.platform === "macos" ? { minOS: "13.0" } : {}),
      ...(a.platform === "windows" ? { minOS: "10.0.19041" } : {}),
      files: filesFor(id, version),
    };
  });
  const descriptor = {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version,
    seq,
    channel,
    title: `djdl ${version}`,
    notes: `What's new in ${version} <b>bold</b>.`,
    publishedAt: new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    builds: descBuilds.map(({ files, ...b }) => ({
      ...b,
      artifacts: files.map((f) => ({
        name: f.name,
        role: f.role,
        sha256: sha(f.bytes),
        size: f.bytes.length,
        ...(f.deltaFrom ? { deltaFrom: f.deltaFrom } : {}),
        locations: [{ provider: "r2", key: `blobs/sha256/${sha(f.bytes)}` }],
      })),
    })),
  };
  const all = descBuilds.flatMap((b) => b.files);
  const ticket = (await (
    await post(w, "uploads", {
      objects: all.map((f) => ({ sha256: sha(f.bytes), size: f.bytes.length })),
    })
  ).json()) as Record<string, any>;
  for (const f of all)
    w.r2.seed(`${ticket.prefix}${sha(f.bytes)}`, f.bytes, { withSha256: true });
  const jws = await signRecord(recordFor(descriptor, { seq, issuedAt: NOW }));
  const res = await post(w, "submit", {
    ticket: ticket.ticket,
    descriptor,
    record: jws,
  });
  const body = (await res.json()) as Record<string, any>;
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.releaseId as string;
}

async function setRollout(
  w: World,
  outlet: string,
  releaseId: string,
  bp: number,
  state: string,
  channel = "stable",
): Promise<void> {
  await w.db.run(
    `INSERT INTO dist_rollouts
       (product, deliverable_id, outlet_id, channel, release_id, rollout_bp, rollout_salt,
        state, mirrored, source, started_at, updated_at, updated_by)
     VALUES (?, 'app', ?, ?, ?, ?, ?, ?, 0, 'admin', ?, ?, 'u1')
     ON CONFLICT (product, deliverable_id, outlet_id, channel) DO UPDATE SET
       release_id = excluded.release_id, rollout_bp = excluded.rollout_bp,
       state = excluded.state, updated_at = excluded.updated_at`,
    SLUG,
    outlet,
    channel,
    releaseId,
    bp,
    "0123456789abcdef0123456789abcdef",
    state,
    NOW - 2 * DAY,
    NOW,
  );
}

const ALL_BUILDS = ARTIFACTS.map((a) => a.id);

async function world(
  opts: { sparklePub?: string | null; access?: string } = {},
): Promise<World> {
  const db = makeTestDb();
  const env = envFor({ kv: new KvMock(), blobOrigin: BYTES_ORIGIN });
  env.KEY_HASH_PEPPER = "pepper";
  const r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, {
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_PARENT_ACCESS_KEY_ID: "parent-akid",
    R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
    BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
  });
  await seedReleaseProduct(db, {
    release_keys_json: releaseKeysJson(),
    sparkle_ed25519_pub:
      opts.sparklePub === undefined ? SPARKLE.pubB64 : opts.sparklePub,
    operator_policy_json: JSON.stringify({ requireSparkleSignature: true }),
  });
  await db.batch(manifestDeliverableStatements(SLUG, appDeclaration(), NOW));
  for (const [id, kind, identity] of OUTLETS)
    await db.run(
      `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      SLUG,
      id,
      kind,
      JSON.stringify(identity),
      NOW,
      NOW,
    );
  const token = (
    await issueStaticCiToken(env, db, {
      product: SLUG,
      scopes: ["release:publish"],
      expiresAt: NOW + 30 * DAY,
      label: null,
      createdBy: "u1",
      now: NOW,
    })
  ).token;
  const w: World = {
    db,
    env,
    r2,
    token,
    sparkleKey: SPARKLE.priv,
    releases: {},
  };
  const notUniversalArm = ALL_BUILDS.filter((b) => b !== "mac-arm64");
  w.releases["1.0.0"] = await publish(
    w,
    "1.0.0",
    "stable",
    NOW - 40 * DAY,
    ALL_BUILDS,
  );
  w.releases["1.1.0"] = await publish(
    w,
    "1.1.0",
    "stable",
    NOW - 30 * DAY,
    notUniversalArm,
  );
  w.releases["1.1.5"] = await publish(
    w,
    "1.1.5",
    "stable",
    NOW - 25 * DAY,
    ALL_BUILDS,
  );
  w.releases["1.2.0"] = await publish(
    w,
    "1.2.0",
    "stable",
    NOW - 10 * DAY,
    ALL_BUILDS,
  );
  w.releases["1.3.0-beta.1"] = await publish(
    w,
    "1.3.0-beta.1",
    "beta",
    NOW - 5 * DAY,
    ALL_BUILDS,
  );
  await yankRelease(
    db,
    SLUG,
    w.releases["1.1.5"]!,
    "bad build",
    "admin:u1",
    NOW,
  );
  await setChannelPolicy(
    db,
    { product: SLUG, deliverableId: "app", channel: "stable" },
    { minSupported: "1.1.0" },
    { source: "admin", now: NOW, by: "admin:u1" },
  );
  for (const outlet of ["direct", "app-installer"])
    await setRollout(w, outlet, w.releases["1.2.0"]!, 2500, "active");
  if (opts.access) await seedDeliveryAccess(db, SLUG, opts.access);
  return w;
}

function get(
  w: World,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return call(w.env, w.db, noFetch, `${CONSOLE}/${SLUG}/${path}`, { headers });
}

async function text(
  w: World,
  path: string,
): Promise<{ res: Response; body: string }> {
  const res = await get(w, path);
  return { res, body: await res.text() };
}

function golden(name: string, body: string | Uint8Array): void {
  const file = join(GOLDEN_DIR, name);
  if (process.env.UPDATE_FEED_GOLDENS === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, body);
  }
  if (typeof body === "string") expect(body).toBe(readFileSync(file, "utf8"));
  else expect(Buffer.from(body).equals(readFileSync(file))).toBe(true);
}

const FEEDS: Array<[string, string, string]> = [
  [
    "update/appcast.xml",
    "sparkle-stable-arm64.xml",
    "application/xml; charset=utf-8",
  ],
  [
    "update/stable/appcast.xml?arch=x86_64",
    "sparkle-stable-x86_64.xml",
    "application/xml; charset=utf-8",
  ],
  [
    "update/beta/appcast.xml",
    "sparkle-beta-arm64.xml",
    "application/xml; charset=utf-8",
  ],
  [
    "update/stable/winsparkle.xml",
    "winsparkle-stable.xml",
    "application/xml; charset=utf-8",
  ],
  [
    "update/stable/velopack/releases.win-x64.json",
    "velopack-stable-win-x64.json",
    "application/json; charset=utf-8",
  ],
  [
    "update/beta/velopack/releases.win.json?arch=x64&os=win&rid=win-x64&id=Djdl&localVersion=1.0.0",
    "velopack-beta-win.json",
    "application/json; charset=utf-8",
  ],
  [
    "update/stable/app.appinstaller",
    "appinstaller-stable.appinstaller",
    "application/appinstaller",
  ],
  [
    "update/beta/app.appinstaller?arch=x64",
    "appinstaller-beta-x64.appinstaller",
    "application/appinstaller",
  ],
  [
    "update/version?platform=windows&arch=x86_64&build=win-x64",
    "version-stable-windows.json",
    "application/json; charset=utf-8",
  ],
];

// ── Golden files ─────────────────────────────────────────────────────────────────────────────

describe("updater feeds: golden files and content types", () => {
  for (const [path, file, type] of FEEDS)
    it(`${path} matches ${file}`, async () => {
      const w = await world();
      const { res, body } = await text(w, path);
      expect(res.status, body).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toMatch(/^public, max-age=/);
      expect(res.headers.get("etag")).toBe(`"${sha(body)}"`);
      golden(file, body);
    });

  it("the AppImage .zsync is CI's control file with URL: pointed at the current AppImage", async () => {
    const w = await world();
    const res = await get(w, "update/stable/appimage.AppImage.zsync");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-zsync");
    const bytes = new Uint8Array(await res.arrayBuffer());
    golden("appimage-stable.AppImage.zsync", bytes);
    const head = new TextDecoder("latin1").decode(bytes).split("\n\n")[0]!;
    const urls = head.split("\n").filter((l) => l.startsWith("URL:"));
    expect(urls).toEqual([
      `URL: ${BYTES_ORIGIN}/${SLUG}/distribution/files/${encodeURIComponent(
        w.releases["1.1.0"]!,
      )}/djdl-1.1.0-x86_64.AppImage`,
    ]);
    // The checksum blocks after the header are untouched.
    expect([...bytes.slice(-7)]).toEqual([
      0x00, 0x9f, 0x0a, 0x0a, 0xff, 0x10, 0x20,
    ]);
  });

  it("a 304 answers a matching If-None-Match", async () => {
    const w = await world();
    const first = await get(w, "update/stable/winsparkle.xml");
    const etag = first.headers.get("etag")!;
    const again = await get(w, "update/stable/winsparkle.xml", {
      "if-none-match": etag,
    });
    expect(again.status).toBe(304);
  });
});

// ── What each feed says ──────────────────────────────────────────────────────────────────────

describe("updater feeds: content", () => {
  it("Sparkle: build numbers, floor-critical, phased rollout, delta, arm64 hardware requirement", async () => {
    const w = await world();
    const { body } = await text(w, "update/appcast.xml");
    expect(body).toContain("<sparkle:version>120</sparkle:version>");
    expect(body).toContain(
      "<sparkle:shortVersionString>1.2.0</sparkle:shortVersionString>",
    );
    // The floor is 1.1.0, whose build number is 110: critical only below it.
    expect(body).toContain('<sparkle:criticalUpdate sparkle:version="110" />');
    expect(body).toContain(
      `<sparkle:phasedRolloutInterval>${PHASE_INTERVAL_SECONDS}</sparkle:phasedRolloutInterval>`,
    );
    // 1.2.0 has an arm64 DMG: the arm64 feed lists it with the hardware requirement.
    expect(body).toContain("djdl-1.2.0-macos-arm64.dmg");
    expect(body).toContain(
      "<sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>",
    );
    // 1.1.0 shipped only a universal DMG: the arm64 feed lists it too, with no requirement.
    expect(body).toContain("djdl-1.1.0-macos-universal.dmg");
    expect(body).not.toContain("1.1.5");
    // Release notes are escaped.
    expect(body).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("Sparkle x86_64: the universal DMG, with its delta from build 110", async () => {
    const w = await world();
    const { body } = await text(w, "update/stable/appcast.xml?arch=x86_64");
    expect(body).toContain("djdl-1.2.0-macos-universal.dmg");
    expect(body).not.toContain("macos-arm64");
    expect(body).not.toContain("hardwareRequirements");
    expect(body).toMatch(
      /<sparkle:deltas>\s*<enclosure url="[^"]+djdl-1\.2\.0-from-110\.delta" sparkle:version="120" sparkle:shortVersionString="1\.2\.0" sparkle:deltaFrom="110" type="application\/octet-stream" length="\d+" sparkle:edSignature="[^"]+" \/>/,
    );
  });

  it("Sparkle: a critical pointer release is critical to everyone and never phased", async () => {
    const w = await world();
    await setChannelPolicy(
      w.db,
      { product: SLUG, deliverableId: "app", channel: "stable" },
      { pointerReleaseId: w.releases["1.2.0"]!, critical: true },
      { source: "admin", now: NOW, by: "admin:u1" },
    );
    const { body } = await text(w, "update/appcast.xml");
    golden("sparkle-stable-arm64-critical.xml", body);
    const item = body.split("<item>")[1]!;
    expect(item).toContain("<sparkle:criticalUpdate />");
    expect(item).not.toContain("phasedRolloutInterval");
  });

  it("Sparkle: a halted rollout serves the previous release", async () => {
    const w = await world();
    await setRollout(w, "direct", w.releases["1.2.0"]!, 2500, "halted");
    const { body } = await text(w, "update/appcast.xml");
    golden("sparkle-stable-arm64-halted.xml", body);
    expect(body).not.toContain("1.2.0");
    expect(body).toContain("<sparkle:version>110</sparkle:version>");
  });

  it("Sparkle: only the rendered channel's own rollout phases its appcast", async () => {
    const w = await world();
    const id = w.releases["1.2.0"]!;
    // The world rolls 1.2.0 out at 25% on direct/stable: two of seven groups.
    const baseline = (await text(w, "update/appcast.xml")).body;
    expect(baseline).toContain(
      `<sparkle:phasedRolloutInterval>${PHASE_INTERVAL_SECONDS}</sparkle:phasedRolloutInterval>`,
    );
    // Beta rolling the same release out at 90% (sorting before "stable") changes nothing here.
    await setRollout(w, "direct", id, 9000, "active", "beta");
    expect((await text(w, "update/appcast.xml")).body).toBe(baseline);
    // Complete on stable, still at 5% on beta: the stable appcast lists it unphased.
    await setRollout(w, "direct", id, 10000, "complete");
    await setRollout(w, "direct", id, 500, "active", "beta");
    const done = (await text(w, "update/appcast.xml")).body;
    expect(done).toContain("<sparkle:version>120</sparkle:version>");
    expect(done).not.toContain("phasedRolloutInterval");
    // Another channel's paused or halted rollout still holds the release (the safe side).
    await setRollout(w, "direct", id, 500, "paused", "beta");
    const held = (await text(w, "update/appcast.xml")).body;
    expect(held).not.toContain("<sparkle:version>120</sparkle:version>");
    expect(held).toContain("<sparkle:version>110</sparkle:version>");
  });

  it("Sparkle and WinSparkle drop an enclosure whose sidecar signature does not verify", async () => {
    const w = await world({ sparklePub: sparkleKeyPair().pubB64 });
    expect((await text(w, "update/appcast.xml")).body).not.toContain("<item>");
    expect((await text(w, "update/stable/winsparkle.xml")).body).not.toContain(
      "<item>",
    );
  });

  it("WinSparkle: one item per release, an enclosure per Windows installer with sparkle:os and installer arguments", async () => {
    const w = await world();
    const { body } = await text(w, "update/stable/winsparkle.xml");
    expect(body).toContain('sparkle:os="windows-x64"');
    expect(body).toContain(
      'sparkle:installerArguments="/SILENT /SP- /NOICONS"',
    );
    expect(body).toContain('sparkle:os="windows-arm64"');
    expect(body).toContain('sparkle:installerArguments="/passive"');
    // The rollout of 1.2.0 is not complete: WinSparkle (no rollout concept) serves 1.1.0.
    expect(body).not.toContain("1.2.0");
    expect(body).toContain('sparkle:version="110"');
    // No zip, package or MSIX ever reaches an installer feed.
    expect(body).not.toMatch(/nupkg|msixbundle|AppImage/);
  });

  it("Velopack: a full and delta pair per release, absolute FileNames, verified SHA1/SHA256", async () => {
    const w = await world();
    const { body } = await text(
      w,
      "update/beta/velopack/releases.win-x64.json",
    );
    const doc = JSON.parse(body) as { Assets: Array<Record<string, any>> };
    const v13 = doc.Assets.filter((a) => a.Version === "1.3.0-beta.1");
    expect(v13.map((a) => a.Type)).toEqual(["Full", "Delta"]);
    // Only the newest release's full package: Velopack applies deltas to the one it holds.
    expect(doc.Assets.filter((a) => a.Type === "Full")).toHaveLength(1);
    for (const a of v13) {
      expect(a.PackageId).toBe("Djdl");
      expect(
        a.FileName.startsWith(`${BYTES_ORIGIN}/${SLUG}/distribution/files/`),
      ).toBe(true);
      const name = decodeURIComponent(a.FileName.split("/").pop()!);
      const bytes = bytesOf(name);
      expect(a.SHA1).toBe(sha1(bytes).toUpperCase());
      expect(a.SHA256).toBe(sha(bytes).toUpperCase());
      expect(a.Size).toBe(bytes.length);
    }
    expect(body).not.toContain("1.1.5");
  });

  it("stored bytes that are not the recorded ones never yield a SHA1 or a signature", async () => {
    const w = await world();
    for (const name of [
      "Djdl-1.1.0-full.nupkg",
      "djdl-1.1.0-macos-universal.dmg",
    ]) {
      const real = bytesOf(name);
      w.r2.seed(`blobs/sha256/${sha(real)}`, bytesOf(`${name} (tampered)`), {
        withSha256: true,
      });
    }
    const vp = JSON.parse(
      (await text(w, "update/stable/velopack/releases.win-x64.json")).body,
    ) as { Assets: Array<Record<string, any>> };
    expect(vp.Assets.some((a) => a.Type === "Full")).toBe(false);
    const sparkle = (await text(w, "update/stable/appcast.xml?arch=x86_64"))
      .body;
    expect(sparkle).not.toContain("djdl-1.1.0-macos-universal.dmg");
    expect(sparkle).toContain("djdl-1.2.0-macos-universal.dmg");
  });

  it("Velopack: an unknown OS token or file name is not a feed", async () => {
    const w = await world();
    expect(
      (await get(w, "update/stable/velopack/releases.amiga.json")).status,
    ).toBe(404);
    expect((await get(w, "update/stable/velopack/RELEASES")).status).toBe(404);
  });

  it("App Installer: the Uri is the route, with at most one query pair", async () => {
    const w = await world();
    const { body } = await text(w, "update/beta/app.appinstaller?arch=x64");
    expect(body).toContain(
      `Uri="${CONSOLE}/${SLUG}/update/beta/app.appinstaller?arch=x64"`,
    );
    expect(body).toContain('Name="Acme.Djdl"');
    expect(body).toContain('Version="1.3.0.0"');
    expect(body).toContain("<MainBundle ");
    expect(
      (
        await get(
          w,
          "update/beta/app.appinstaller?arch=x64&outlet=app-installer",
        )
      ).status,
    ).toBe(404);
    expect(
      (await get(w, "update/beta/app.appinstaller?arch=sparc")).status,
    ).toBe(404);
  });

  it("App Installer: an outlet without a publisher has no file", async () => {
    const w = await world();
    await w.db.run(
      "UPDATE dist_outlets SET identity_json = ? WHERE product = ? AND outlet_id = 'app-installer'",
      JSON.stringify({ packageFamilyName: "Acme.Djdl_1a2b3c4d5e6f7" }),
      SLUG,
    );
    expect((await get(w, "update/beta/app.appinstaller")).status).toBe(404);
  });

  it("zsync: only an AppImage build id with a control file, else not found", async () => {
    const w = await world();
    expect((await get(w, "update/stable/win-x64.AppImage.zsync")).status).toBe(
      404,
    );
    expect((await get(w, "update/stable/Bad..Id.AppImage.zsync")).status).toBe(
      404,
    );
  });

  it("zsync: a release-level .zsync the descriptor did not name is never served", async () => {
    // What the GitHub webhook sync writes for an asset a described release's descriptor does
    // not name: build_id NULL, the role its kind implies, GitHub's own digest. Its bytes match
    // that digest, so only the build and role check keeps it off the route.
    const w = await world();
    await w.db.run(
      "UPDATE release_artifacts SET build_id = NULL WHERE product = ? AND name LIKE '%.AppImage.zsync'",
      SLUG,
    );
    expect((await get(w, "update/stable/appimage.AppImage.zsync")).status).toBe(
      404,
    );
  });

  it("zsync: a control file of the build in another role is never served", async () => {
    const w = await world();
    await w.db.run(
      "UPDATE release_artifacts SET role = 'payload' WHERE product = ? AND name LIKE '%.AppImage.zsync'",
      SLUG,
    );
    expect((await get(w, "update/stable/appimage.AppImage.zsync")).status).toBe(
      404,
    );
  });

  it("Velopack and Sparkle list only deltas the descriptor named for the build", async () => {
    const w = await world();
    await w.db.run(
      "UPDATE release_artifacts SET build_id = NULL WHERE product = ? AND role = 'delta'",
      SLUG,
    );
    const vp = JSON.parse(
      (await text(w, "update/beta/velopack/releases.win-x64.json")).body,
    ) as { Assets: Array<Record<string, unknown>> };
    expect(vp.Assets.map((a) => a.Type)).not.toContain("Delta");
    expect(vp.Assets.filter((a) => a.Type === "Full")).toHaveLength(1);
    const { body } = await text(w, "update/stable/appcast.xml?arch=x86_64");
    expect(body).toContain("<item>");
    expect(body).not.toContain("sparkle:deltas");
    expect(body).not.toContain("from-110.delta");
  });

  it("a release-level .sig sidecar is never consulted for an edSignature", async () => {
    const w = await world();
    const before = (await text(w, "update/stable/appcast.xml?arch=x86_64"))
      .body;
    expect(before).toContain("sparkle:edSignature");
    await w.db.run(
      "UPDATE release_artifacts SET build_id = NULL WHERE product = ? AND role = 'signature'",
      SLUG,
    );
    const after = (await text(w, "update/stable/appcast.xml?arch=x86_64")).body;
    expect(after).not.toContain("sparkle:edSignature");
  });

  it("/update/version keeps version, tag and url and adds the extended fields when asked", async () => {
    const w = await world();
    const { res, body } = await text(
      w,
      "update/version?channel=beta&platform=windows&arch=x86_64",
    );
    expect(res.status).toBe(200);
    const doc = JSON.parse(body);
    expect(Object.keys(doc)).toEqual([
      "version",
      "tag",
      "url",
      "build",
      "sha256",
      "size",
      "downloadUrl",
      "minOS",
      "critical",
    ]);
    expect(doc.version).toBe("1.3.0-beta.1");
    expect(doc.build).toBe("130");
    expect(doc.minOS).toBe("10.0.19041");
    expect(doc.critical).toBe(false);
    // `?channel=` spells the channel too, as the legacy check does.
    const viaQuery = await text(
      w,
      "update/version?channel=beta&platform=windows&arch=x86_64",
    );
    expect(JSON.parse(viaQuery.body).version).toBe("1.3.0-beta.1");
    // The exact arch wins over a universal build; `?build=` names one build.
    expect(doc.downloadUrl).toMatch(
      /windows-x64-setup\.exe$|Djdl-1\.3\.0-beta\.1-full\.nupkg$/,
    );
    const msix = JSON.parse(
      (await text(w, "update/version?channel=beta&platform=windows&build=msix"))
        .body,
    );
    expect(msix.downloadUrl).toMatch(/\.msixbundle$/);
    expect(
      (await get(w, "update/version?platform=windows&build=Bad..Id")).status,
    ).toBe(404);
    // A platform outside the vocabulary is not found.
    expect((await get(w, "update/version?platform=amiga")).status).toBe(404);
  });

  it("/update/version without ?platform= keeps the legacy answer: ?arch=, ?outlet=, ?build= are discarded", async () => {
    const w = await world();
    // The legacy check resolves on GitHub (unreachable here, so it throws asking for an
    // installation token): the extended renderer is not used, and nothing answers 404.
    for (const q of ["arch=x86_64", "outlet=direct", "build=win-x64"])
      await expect(get(w, `update/version?${q}`), q).rejects.toThrow(
        /installation token/,
      );
  });
});

// ── Yanks and halts reach every feed at once ─────────────────────────────────────────────────

const EVERY_FEED = [
  "update/appcast.xml",
  "update/stable/appcast.xml?arch=x86_64",
  "update/stable/winsparkle.xml",
  "update/stable/velopack/releases.win-x64.json",
  "update/stable/app.appinstaller",
  "update/stable/appimage.AppImage.zsync",
  "update/version?platform=windows",
];

describe("updater feeds: a yanked or halted release is absent from every feed", () => {
  for (const path of EVERY_FEED) {
    it(`yank: ${path}`, async () => {
      const w = await world();
      // Complete the rollout so 1.2.0 is the head everywhere, then yank it.
      for (const outlet of ["direct", "app-installer"])
        await setRollout(w, outlet, w.releases["1.2.0"]!, 10000, "complete");
      const before = await text(w, path);
      expect(before.res.status).toBe(200);
      expect(before.body).toContain("1.2.0");
      await yankRelease(
        w.db,
        SLUG,
        w.releases["1.2.0"]!,
        "bad",
        "admin:u1",
        NOW,
      );
      const after = await text(w, path);
      expect(after.res.status).toBe(200);
      expect(after.body).not.toContain("1.2.0");
      expect(after.body).not.toContain("1.1.5");
      expect(after.body).toContain("1.1.0");
    });

    it(`halt: ${path}`, async () => {
      const w = await world();
      for (const outlet of ["direct", "app-installer"])
        await setRollout(w, outlet, w.releases["1.2.0"]!, 10000, "complete");
      expect((await text(w, path)).body).toContain("1.2.0");
      for (const outlet of ["direct", "app-installer"])
        await setRollout(w, outlet, w.releases["1.2.0"]!, 10000, "halted");
      const after = await text(w, path);
      expect(after.res.status).toBe(200);
      expect(after.body).not.toContain("1.2.0");
      expect(after.body).toContain("1.1.0");
    });
  }
});

// ── Access ───────────────────────────────────────────────────────────────────────────────────

describe("updater feeds: access", () => {
  it("a licensed deliverable's feeds refuse an anonymous reader and are never public-cacheable", async () => {
    const w = await world({ access: "licensed" });
    for (const path of EVERY_FEED.filter((p) => !p.includes("version"))) {
      const res = await get(w, path);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("cache-control") ?? "").not.toMatch(/^public/);
    }
  });

  it("a product with no release record keeps the legacy appcast (and its 404 without GitHub)", async () => {
    const w = await world();
    await w.db.run("DELETE FROM release_records WHERE product = ?", SLUG);
    // The legacy path resolves on GitHub (unreachable here, so it throws asking for an
    // installation token): the extended renderer is not used.
    await expect(get(w, "update/appcast.xml")).rejects.toThrow(
      /installation token/,
    );
    // The new feeds list only recorded releases: nothing to list.
    const vp = JSON.parse(
      (await text(w, "update/stable/velopack/releases.win-x64.json")).body,
    );
    expect(vp).toEqual({ Assets: [] });
    // The version check asked for a platform falls back to the legacy answer, not a 404.
    await expect(get(w, "update/version?platform=windows")).rejects.toThrow(
      /installation token/,
    );
  });
});

// ── The answer cache ─────────────────────────────────────────────────────────────────────────

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

/** A Db that records every read statement it is handed. */
function recordingDb(inner: Db): { db: Db; reads: string[] } {
  const reads: string[] = [];
  const db: Db = {
    all: (sql, ...p) => {
      reads.push(sql);
      return inner.all(sql, ...p);
    },
    first: (sql, ...p) => {
      reads.push(sql);
      return inner.first(sql, ...p);
    },
    runChanges: (sql, ...p) => inner.runChanges(sql, ...p),
    run: (sql, ...p) => inner.run(sql, ...p),
    batch: (st) => inner.batch(st),
  };
  return { db, reads };
}

describe("updater feeds: the answer cache", () => {
  let cache: FakeCache;
  beforeEach(() => {
    cache = new FakeCache();
    vi.stubGlobal("caches", { default: cache });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("App Installer: each spelling of ?arch= gets its own Uri, even from a warm cache", async () => {
    const w = await world();
    const spellings = ["x64", "X64", "x86_64", "X86_64"];
    // Twice over, so the second pass is served from the cache.
    for (let pass = 0; pass < 2; pass++)
      for (const spelling of spellings) {
        const { res, body } = await text(
          w,
          `update/beta/app.appinstaller?arch=${spelling}`,
        );
        expect(res.status, spelling).toBe(200);
        expect(body, spelling).toContain(
          `Uri="${CONSOLE}/${SLUG}/update/beta/app.appinstaller?arch=${spelling}"`,
        );
      }
    expect(cache.entries.size).toBe(spellings.length);
  });

  it("a warm appcast never reads the records' JWS bytes, and costs a bounded number of reads", async () => {
    const w = await world();
    const path = `${CONSOLE}/${SLUG}/update/appcast.xml`;
    const cold = recordingDb(w.db);
    const first = await call(w.env, cold.db, noFetch, path, {});
    expect(first.status).toBe(200);
    const warm = recordingDb(w.db);
    const again = await call(w.env, warm.db, noFetch, path, {});
    expect(await again.text()).toBe(await first.text());
    expect(warm.reads.length).toBeLessThan(cold.reads.length);
    // The dispatcher's three product reads (every route), then the feed's eight: the release-id
    // read, the release config, the delivery access, and the stamp (the metadata access's
    // release config, rollouts, availability/outlet counters, yanks, channel policies).
    expect(warm.reads.length).toBeLessThanOrEqual(11);
    for (const sql of [...cold.reads, ...warm.reads].filter((q) =>
      /release_records/.test(q),
    )) {
      expect(sql).not.toMatch(/\bjws\b|SELECT \*/);
    }
  });
});

// ── The pure pieces ──────────────────────────────────────────────────────────────────────────

describe("updater renderers", () => {
  it("phasedSchedule: bp → Sparkle groups, held until bp changes", () => {
    const start = NOW;
    expect(phasedSchedule(1, start)).toEqual({
      pubDate: start,
      interval: PHASE_INTERVAL_SECONDS,
      groups: 1,
    });
    expect(phasedSchedule(1428, start).groups).toBe(1);
    expect(phasedSchedule(1429, start).groups).toBe(2);
    expect(phasedSchedule(2500, start)).toEqual({
      pubDate: start - PHASE_INTERVAL_SECONDS,
      interval: PHASE_INTERVAL_SECONDS,
      groups: 2,
    });
    expect(phasedSchedule(9999, start).groups).toBe(7);
  });

  it("msixVersion: a four-part build number, else major.minor.patch.0, within 16 bits", () => {
    expect(msixVersion({ buildNumber: "1.2.3.4", version: "1.2.3" })).toBe(
      "1.2.3.4",
    );
    expect(msixVersion({ buildNumber: "120", version: "1.2.0" })).toBe(
      "1.2.0.0",
    );
    expect(msixVersion({ buildNumber: null, version: "1.3.0-beta.1" })).toBe(
      "1.3.0.0",
    );
    expect(msixVersion({ buildNumber: null, version: "70000.0.0" })).toBeNull();
  });

  it("velopackPackageId reads vpk's file naming", () => {
    expect(velopackPackageId("Djdl-1.2.0-full.nupkg", "1.2.0")).toBe("Djdl");
    expect(velopackPackageId("Acme.App-2.0.0-beta-full.nupkg", "2.0.0")).toBe(
      "Acme.App",
    );
    expect(velopackPackageId("full.nupkg", "1.2.0")).toBeNull();
  });

  it("rewriteZsync refuses a control file for another AppImage", () => {
    const target = bytesOf("x");
    const z = zsyncFor("x", target);
    expect(rewriteZsync(z, "https://dl/x", target.length + 1)).toBeNull();
    expect(
      rewriteZsync(new Uint8Array([1, 2, 3]), "https://dl/x", 3),
    ).toBeNull();
    const ok = rewriteZsync(z, "https://dl/x", target.length)!;
    expect(new TextDecoder().decode(ok)).toContain("URL: https://dl/x\n");
  });

  it("rewriteZsync refuses a control file that names another source or a recompress command", () => {
    const target = bytesOf("x");
    const z = new TextDecoder("latin1").decode(zsyncFor("x", target));
    for (const extra of [
      "Z-URL: https://evil.example/x.gz",
      "Z-Map2: 12",
      "Recompress: gzip --best",
    ]) {
      const forged = new TextEncoder().encode(
        z.replace("URL: x\n", `URL: x\n${extra}\n`),
      );
      expect(new TextDecoder().decode(forged)).toContain(extra);
      expect(rewriteZsync(forged, "https://dl/x", target.length)).toBeNull();
    }
  });

  it("renderAppInstaller escapes identity values", () => {
    const xml = renderAppInstaller({
      uri: "https://k/p/update/stable/app.appinstaller",
      name: "Acme",
      publisher: 'CN="Acme & Co"',
      version: "1.0.0.0",
      packageUri: "https://dl/p.msix",
      bundle: false,
      architecture: "x64",
      updateSettings: null,
    });
    expect(xml).toContain('Publisher="CN=&quot;Acme &amp; Co&quot;"');
    expect(xml).toContain('ProcessorArchitecture="x64"');
    expect(xml).toContain("<OnLaunch />");
  });
});
