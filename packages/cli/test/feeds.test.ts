/**
 * P2b-05 — `pkey feeds fdroid` (`feeds.ts`): the index it builds validates against F-Droid's
 * index-v2 model, `entry.json`'s index hash matches the index bytes, a diff is written against
 * the index the relay serves now, beta versions are tagged, the two notes/E2 §C2 rules are
 * enforced, and the whole run reads, signs, uploads and registers against a fake Polaris Key.
 *
 * Signing uses the real `apksigner` when the Android SDK and a JDK are present (this machine's
 * case; CI's is the fake), and otherwise a fake that drops in the committed v1-signed jar — the
 * same key either way, so the post-sign fingerprint check runs in both.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFdroidFeed,
  buildFdroidIndex,
  buildRepoFiles,
  dictDiff,
  indexV2Problems,
  runPkey,
  sortedJson,
  type FdroidInputs,
} from "../src/index.js";
import { withZip } from "../src/zip.js";
import { apkSignerSha256 } from "../src/buildMetadata.js";
import {
  BASE,
  capture,
  CI_TOKEN,
  cleanup,
  fakeServer,
  instant,
  json,
  SLUG,
  tempDir,
} from "./publishFixture.js";

afterEach(cleanup);

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "build-metadata",
);
const KEY_SHA256 =
  "f7cdd36513816f0cd9fce4caf4879bdfef2e39086de99f6a0cce603fcfde448a";
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const REPO = `${BASE}/${SLUG}/distribution/fdroid/beta/repo`;
const T = 1_700_000_000_000;

function version(v: string, code: number, stable: boolean, at: number) {
  const name = `Diceroll-${v}-android.apk`;
  return {
    releaseId: `v${v}`,
    version: v,
    stable,
    publishedAt: at,
    notes: `What's new in ${v}.`,
    apk: {
      name,
      sha256: sha(name),
      size: 1000 + code,
      url: `https://dl.example.test/${SLUG}/distribution/files/v${v}/${name}`,
    },
    metadata: {
      packageName: "gg.vlad.diceroll",
      versionCode: code,
      versionName: v,
      minSdk: 24,
      targetSdk: 35,
      nativecode: ["arm64-v8a"],
      signerSha256: "c".repeat(64),
    },
  };
}

function inputs(over: Partial<FdroidInputs> = {}): FdroidInputs {
  return {
    product: SLUG,
    channel: "beta",
    outlet: "fdroid-repo",
    packageName: "gg.vlad.diceroll",
    repo: { address: REPO, fingerprints: [KEY_SHA256] },
    productName: SLUG,
    listing: {
      name: "Diceroll",
      subtitle: "A cozy dice-rolling roguelite",
      website: "https://diceroll.example.test",
      developerName: "Vlad",
    },
    versions: [
      version("1.2.0-beta.1", 10199, false, 1_699_000_000),
      version("1.1.0", 10100, true, 1_698_000_000),
      version("1.0.0", 10000, true, 1_697_000_000),
    ],
    files: [],
    ...over,
  };
}

describe("the index", () => {
  it("validates against index-v2's model, keyed by APK sha256, beta versions tagged", () => {
    const index = buildFdroidIndex(inputs(), T) as any;
    expect(indexV2Problems(index)).toEqual([]);
    expect(index.repo).toMatchObject({
      address: REPO,
      timestamp: T,
      name: { "en-US": "Diceroll (beta)" },
      releaseChannels: { Beta: { name: { "en-US": "Beta" } } },
    });
    const pkg = index.packages["gg.vlad.diceroll"];
    expect(pkg.metadata).toMatchObject({
      added: 1_697_000_000_000,
      lastUpdated: 1_699_000_000_000,
      name: { "en-US": "Diceroll" },
      summary: { "en-US": "A cozy dice-rolling roguelite" },
      preferredSigner: "c".repeat(64),
    });
    const beta = pkg.versions[sha("Diceroll-1.2.0-beta.1-android.apk")];
    expect(beta.releaseChannels).toEqual(["Beta"]);
    expect(beta.file).toEqual({
      name: "/Diceroll-1.2.0-beta.1-android.apk",
      sha256: sha("Diceroll-1.2.0-beta.1-android.apk"),
      size: 11199,
    });
    expect(beta.manifest).toEqual({
      versionName: "1.2.0-beta.1",
      versionCode: 10199,
      usesSdk: { minSdkVersion: 24, targetSdkVersion: 35 },
      nativecode: ["arm64-v8a"],
      signer: { sha256: ["c".repeat(64)] },
    });
    expect(
      pkg.versions[sha("Diceroll-1.1.0-android.apk")].releaseChannels,
    ).toBeUndefined();
  });

  it("entry.json names the index by its exact sha256 and size", () => {
    const repo = buildRepoFiles(inputs(), T);
    const index = repo.files.get("index-v2.json")!;
    const entry = JSON.parse(repo.files.get("entry.json")!.toString());
    expect(entry).toEqual({
      timestamp: T,
      version: 30000,
      index: {
        name: "/index-v2.json",
        sha256: sha(index),
        size: index.length,
        numPackages: 1,
      },
      diffs: {},
    });
    expect(JSON.parse(index.toString())).toEqual(repo.index);
  });

  it("writes a merge-patch diff against the previous index", () => {
    const previous = buildFdroidIndex(
      inputs({ versions: inputs().versions.slice(1) }),
      T - 1000,
    );
    const repo = buildRepoFiles(inputs(), T, { previous });
    const diff = JSON.parse(
      repo.files.get(`diff/${T - 1000}.json`)!.toString(),
    );
    expect(repo.entry.diffs).toEqual({
      [String(T - 1000)]: {
        name: `/diff/${T - 1000}.json`,
        sha256: sha(repo.files.get(`diff/${T - 1000}.json`)!),
        size: repo.files.get(`diff/${T - 1000}.json`)!.length,
        numPackages: 1,
      },
    });
    expect(diff.repo.timestamp).toBe(T);
    expect(Object.keys(diff.packages["gg.vlad.diceroll"].versions)).toEqual([
      sha("Diceroll-1.2.0-beta.1-android.apk"),
    ]);
    // Applying the patch to the old index yields the new one.
    const apply = (base: any, patch: any): any => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        return patch;
      const out = { ...(base && typeof base === "object" ? base : {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete out[k];
        else out[k] = apply(out[k], v);
      }
      return out;
    };
    expect(sortedJson(apply(previous, diff))).toBe(sortedJson(repo.index));
    expect(dictDiff({ a: 1, b: 2 }, { a: 1 })).toEqual({ b: null });
  });

  it("refuses a versionCode that does not increase, another package, and an unsafe file name", () => {
    const v = inputs().versions;
    expect(() =>
      buildFdroidIndex(inputs({ versions: [v[1]!, v[0]!] }), T),
    ).toThrow(/strictly/);
    const other = {
      ...v[0]!,
      metadata: { ...v[0]!.metadata, packageName: "com.evil" },
    };
    expect(() => buildFdroidIndex(inputs({ versions: [other] }), T)).toThrow(
      /is not gg\.vlad\.diceroll/,
    );
    const spaced = { ...v[0]!, apk: { ...v[0]!.apk, name: "Dice roll.apk" } };
    expect(() => buildFdroidIndex(inputs({ versions: [spaced] }), T)).toThrow(
      /relay/,
    );
    const bare = { ...v[0]!, metadata: null };
    expect(() => buildFdroidIndex(inputs({ versions: [bare] }), T)).toThrow(
      /no APK metadata/,
    );
  });

  it("an empty channel is still a valid repository", () => {
    const index = buildFdroidIndex(inputs({ versions: [] }), T);
    expect(indexV2Problems(index)).toEqual([]);
    expect(index.packages).toEqual({});
  });

  it("indexV2Problems catches what F-Droid's parser would", () => {
    expect(indexV2Problems({ repo: { address: "x" } })).toContain(
      "repo.timestamp is not an integer",
    );
    expect(
      indexV2Problems({
        repo: { address: "x", timestamp: 1 },
        packages: {
          p: {
            metadata: { added: 1, lastUpdated: 1 },
            versions: {
              k: { added: 1, file: { name: "a.apk" }, manifest: {} },
            },
          },
        },
      }),
    ).toEqual([
      "packages.p.versions.k.file needs a /name and a sha256",
      "packages.p.versions.k.manifest.versionName is required",
      "packages.p.versions.k.manifest.versionCode is required",
    ]);
  });
});

// ── The whole command ────────────────────────────────────────────────────────────────────────

function findApksigner(): string | null {
  const sdk =
    process.env.ANDROID_HOME ?? path.join(os.homedir(), "Library/Android/sdk");
  const bt = path.join(sdk, "build-tools");
  if (!existsSync(bt)) return null;
  for (const v of readdirSync(bt).sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  )) {
    const p = path.join(bt, v, "apksigner");
    if (existsSync(p)) return p;
  }
  return null;
}

function javaHome(): string | null {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const jbr = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  return existsSync(jbr) ? jbr : null;
}

const APKSIGNER = findApksigner();
const JAVA_HOME = javaHome();
const REAL_SIGNING =
  !!APKSIGNER &&
  !!JAVA_HOME &&
  (() => {
    try {
      execFileSync(APKSIGNER, ["version"], {
        env: { ...process.env, JAVA_HOME },
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  })();

/** A fake `apksigner`: the committed v1-signed jar, signed by the same test key. */
async function fakeSign(jar: string): Promise<void> {
  copyFileSync(path.join(FIXTURES, "signed-entry.jar"), jar);
}

function serverWithInputs(body: FdroidInputs = inputs()) {
  const server = fakeServer();
  const route = `/distribution/feeds/fdroid/${body.channel}`;
  server.script(
    route,
    () => json(body),
    () => json({ ok: true, feed: "fdroid", channel: body.channel, files: [] }),
  );
  return server;
}

describe("pkey feeds fdroid", () => {
  it(`reads, builds, signs${REAL_SIGNING ? " (real apksigner)" : " (fake)"}, uploads and registers`, async () => {
    const cwd = await tempDir();
    const server = serverWithInputs();
    const io = capture();
    const result = await buildFdroidFeed({
      cwd,
      product: SLUG,
      channel: "beta",
      out: "repo",
      baseUrl: BASE,
      keystore: path.join(FIXTURES, "test.keystore"),
      alias: "pkey",
      env: {
        PKEY_CI_TOKEN: CI_TOKEN,
        PKEY_FDROID_KS_PASS: "testpass",
        ...(JAVA_HOME ? { JAVA_HOME } : {}),
      },
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      now: () => T,
      ...(REAL_SIGNING ? { apksigner: APKSIGNER! } : { sign: fakeSign }),
    });
    expect(result.signed && result.registered).toBe(true);
    // The jar is signed by the key the inventory names.
    expect(
      await withZip(path.join(cwd, "repo", "entry.jar"), (z) =>
        apkSignerSha256(z),
      ),
    ).toBe(KEY_SHA256);
    if (REAL_SIGNING) {
      // …and carries the entry.json that was written beside it.
      const inJar = await withZip(
        path.join(cwd, "repo", "entry.jar"),
        async (z) => z.read(z.entry("entry.json")!),
      );
      expect(inJar).toEqual(
        await readFile(path.join(cwd, "repo", "entry.json")),
      );
    }
    // GET inputs with the CI token, then the ticket, the PUTs, and the register.
    const feedCalls = server.to("/distribution/feeds/fdroid/beta");
    expect(feedCalls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(feedCalls[0]!.headers.authorization).toBe(`Bearer ${CI_TOKEN}`);
    const register = feedCalls[1]!.body as {
      ticket: string;
      files: Array<{ path: string; sha256: string; size: number }>;
    };
    expect(register.files.map((f) => f.path)).toEqual([
      "entry.jar",
      "entry.json",
      "index-v2.json",
    ]);
    for (const f of register.files) {
      const bytes = await readFile(path.join(cwd, "repo", f.path));
      expect(f.sha256).toBe(sha(bytes));
      expect(server.r2.get(`staging/${SLUG}/t1/${f.sha256}`)).toEqual(
        new Uint8Array(bytes),
      );
    }
    expect(io.out()).toContain(`${REPO}?fingerprint=${KEY_SHA256}`);
  });

  it("diffs against the index the relay serves now", async () => {
    const cwd = await tempDir();
    const old = Buffer.from(
      sortedJson(
        buildFdroidIndex(
          inputs({ versions: inputs().versions.slice(1) }),
          T - 5000,
        ),
      ),
    );
    const server = serverWithInputs(
      inputs({
        files: [{ path: "index-v2.json", sha256: sha(old), size: old.length }],
      }),
    );
    server.script(
      "/distribution/fdroid/beta/repo/index-v2.json",
      () => new Response(old),
    );
    const io = capture();
    const result = await buildFdroidFeed({
      cwd,
      product: SLUG,
      channel: "beta",
      out: "repo",
      baseUrl: BASE,
      env: { PKEY_CI_TOKEN: CI_TOKEN },
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      now: () => T,
    });
    expect(Object.keys(result.written).sort()).toEqual([
      `diff/${T - 5000}.json`,
      "entry.jar",
      "entry.json",
      "index-v2.json",
    ]);
    // No keystore: written, not signed, not uploaded.
    expect(result.signed).toBe(false);
    expect(server.to("/release/publish/uploads")).toHaveLength(0);
  });

  it("refuses a jar signed by a key the inventory does not name", async () => {
    const cwd = await tempDir();
    const server = serverWithInputs(
      inputs({ repo: { address: REPO, fingerprints: ["d".repeat(64)] } }),
    );
    const io = capture();
    await expect(
      buildFdroidFeed({
        cwd,
        product: SLUG,
        channel: "beta",
        out: "repo",
        baseUrl: BASE,
        keystore: "k",
        alias: "a",
        env: { PKEY_CI_TOKEN: CI_TOKEN },
        stdout: io.stdout,
        stderr: io.stderr,
        fetchImpl: server.fetchImpl,
        sleep: instant,
        now: () => T,
        sign: fakeSign,
      }),
    ).rejects.toThrow(/not an fdroid-repo key/);
    expect(server.to("/release/publish/uploads")).toHaveLength(0);
  });

  it("runs from the CLI, and needs --channel and --out", async () => {
    const cwd = await tempDir();
    const io = capture();
    expect(
      await runPkey(["feeds", "fdroid", "--product", SLUG], {
        cwd,
        stdout: io.stdout,
        stderr: io.stderr,
        env: {},
      }),
    ).toBe(1);
    expect(io.err()).toContain("Usage: pkey feeds fdroid");
    const server = serverWithInputs();
    const io2 = capture();
    const code = await runPkey(
      [
        "feeds",
        "fdroid",
        "--product",
        SLUG,
        "--channel",
        "beta",
        "--out",
        "repo",
        "--base-url",
        BASE,
      ],
      {
        cwd,
        stdout: io2.stdout,
        stderr: io2.stderr,
        env: { PKEY_CI_TOKEN: CI_TOKEN },
        fetchImpl: server.fetchImpl,
        sleep: instant,
      },
    );
    expect(code, io2.err()).toBe(0);
    expect(io2.out()).toContain("Wrote the unsigned repository");
  });
});
