/**
 * Fixtures for the P2-06 publish tests: a product repository shaped like Diceroll's release job
 * (a `.pkey/` with a six-build artifact map, and a `dist/` of exported files and sidecars), and
 * a fake Polaris Key + Actions OIDC + R2 that records every request.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = "https://key.example.test";
export const SLUG = "diceroll";
export const OIDC_URL = "https://oidc.actions.example/token?api-version=2.0";
export const R2_ENDPOINT =
  "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com";
export const BUCKET = "polaris-key-blobs";
export const CI_TOKEN = `pkeyci_${"A".repeat(43)}`;
export const TICKET = `pkeyup_${"B".repeat(43)}`;
export const SECRET_KEY = "temporary-secret-access-key-0123456789";
export const SESSION_TOKEN = "dGVtcG9yYXJ5LXNlc3Npb24tdG9rZW4=";
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

/** The Actions environment a release job with `id-token: write` has. */
export function actionsEnv(over: Record<string, string> = {}) {
  return {
    GITHUB_ACTIONS: "true",
    ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "actions-request-bearer",
    GITHUB_SHA: COMMIT,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "vladzaharia/diceroll",
    GITHUB_RUN_ID: "4242",
    ...over,
  } as Record<string, string | undefined>;
}

const PRODUCT_YAML = `apiVersion: pkey.dev/v1
product:
  slug: ${SLUG}
  name: Diceroll
modules:
  license:
    enabled: false
  config:
    enabled: false
  release:
    enabled: true
  distribution:
    enabled: true
  update:
    enabled: true
  identity:
    enabled: false
`;

const SCHEMA_YAML = `apiVersion: pkey.dev/v1
schemaVersion: 1
entries: []
`;

/** Six builds, like Diceroll's exports: macOS, Windows, Linux, Android, iOS and the web. */
export const RELEASE_YAML = `apiVersion: pkey.dev/v1
release:
  provider:
    type: github
    owner: vladzaharia
    repo: diceroll
  binaryName: diceroll
  publishing:
    trustedPublisher:
      workflow: .github/workflows/release.yml
  deliverables:
    app:
      kind: app
      versioning:
        scheme: semver
        buildNumber: descriptor
      channels:
        nightly:
          includes: [beta]
      artifacts:
        - { id: macos, platform: macos, arch: universal, format: zip, match: "Diceroll-*-macos.zip" }
        - { id: windows, platform: windows, arch: x86_64, format: zip, match: "Diceroll-*-windows.zip" }
        - { id: linux, platform: linux, arch: x86_64, format: tar.gz, match: "Diceroll-*-linux.x86_64.tar.gz" }
        - { id: android, platform: android, arch: arm64, format: apk, match: "Diceroll-*.apk" }
        - { id: ios, platform: ios, arch: arm64, format: ipa, match: "Diceroll-*.ipa" }
        - { id: web, platform: web, arch: wasm32, format: zip, match: "Diceroll-*-web.zip" }
`;

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "build-metadata",
);
/** P2b-05's tiny signed APK and IPA (`fixtures/build-metadata/make.sh`). */
export const FIXTURE_APK = new Uint8Array(
  readFileSync(path.join(FIXTURES, "tiny.apk")),
);
export const FIXTURE_IPA = new Uint8Array(
  readFileSync(path.join(FIXTURES, "tiny.ipa")),
);
/** The corpus's CI-held release test key (tools/sign-corpus.ts `KEYS`): never a product key. */
export const RELEASE_KID = "djdl-release-test-2026";
export const RELEASE_PUB = "U9d9Ix2jwC1-l_GJgrInN5zMPJgjPkgZC8Ekg7nKlEE";
export const RELEASE_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIMPC/pYWRN17C6MFlFHhktg/TQgXNUydx+PQtkD9KTBs\n-----END PRIVATE KEY-----\n";
/** The base64 body of the private key: it must never appear in a log or a request. */
export const RELEASE_PEM_BODY =
  "MC4CAQAwBQYDK2VwBCIEIMPC/pYWRN17C6MFlFHhktg/TQgXNUydx+PQtkD9KTBs";

/** `RELEASE_YAML` with the release key declared. */
export const RELEASE_YAML_KEYED = RELEASE_YAML.replace(
  "  binaryName: diceroll\n",
  `  binaryName: diceroll\n  releaseKeys:\n    - kid: ${RELEASE_KID}\n      publicKey: ${RELEASE_PUB}\n`,
);

/** Deterministic bytes of length n. */
export function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xff;
  return out;
}

/** The exported files of v0.3.0, by name. The macOS zip spans several read chunks. */
export function exportFiles(version = "0.3.0"): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {
    [`macos/Diceroll-${version}-macos.zip`]: bytesOf(200_000, 1),
    [`windows/Diceroll-${version}-windows.zip`]: bytesOf(5_000, 2),
    [`linux/Diceroll-${version}-linux.x86_64.tar.gz`]: bytesOf(6_000, 3),
    // Real (tiny) archives, so the build-metadata read (P2b-05) has something to read.
    [`android/Diceroll-${version}.apk`]: FIXTURE_APK,
    [`ios/Diceroll-${version}.ipa`]: FIXTURE_IPA,
    [`web/Diceroll-${version}-web.zip`]: bytesOf(9_000, 6),
  };
  // Diceroll's GDScript updater verifies an RSA sidecar and a checksum next to each payload.
  const mac = files[`macos/Diceroll-${version}-macos.zip`]!;
  files[`macos/Diceroll-${version}-macos.zip.sig`] = bytesOf(256, 7);
  files[`macos/Diceroll-${version}-macos.zip.sha256`] =
    new TextEncoder().encode(`${sha(mac)}  Diceroll-${version}-macos.zip\n`);
  return files;
}

const dirs: string[] = [];

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-publish-"));
  dirs.push(dir);
  return dir;
}

export async function cleanup(): Promise<void> {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
}

/** A repo: `.pkey/` + `dist/` with `files` (default `exportFiles()`). */
export async function repo(
  files: Record<string, Uint8Array> = exportFiles(),
  releaseYaml = RELEASE_YAML,
): Promise<string> {
  const cwd = await tempDir();
  await mkdir(path.join(cwd, ".pkey"), { recursive: true });
  await writeFile(path.join(cwd, ".pkey/product.yaml"), PRODUCT_YAML);
  await writeFile(path.join(cwd, ".pkey/schema.yaml"), SCHEMA_YAML);
  await writeFile(path.join(cwd, ".pkey/release.yaml"), releaseYaml);
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(cwd, "dist", rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  return cwd;
}

// ── The fake server ──────────────────────────────────────────────────────────────────────────

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  bytes?: Uint8Array;
}

type Scripted = () => Response;

export interface FakeServer {
  fetchImpl: typeof fetch;
  calls: Recorded[];
  /** Objects R2 holds after the PUTs, by key. */
  r2: Map<string, Uint8Array>;
  /** Shas the uploads call reports as already `present`. */
  present: Set<string>;
  /** Queue responses for a path (`/token`, `/uploads`, `/submit`, `put`, …), used FIFO. */
  script(route: string, ...responses: Scripted[]): void;
  /** Requests whose URL contains `fragment`. */
  to(fragment: string): Recorded[];
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  const chunks: Uint8Array[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(c);
  return new Uint8Array(Buffer.concat(chunks));
}

export function fakeServer(): FakeServer {
  const calls: Recorded[] = [];
  const r2 = new Map<string, Uint8Array>();
  const present = new Set<string>();
  const queues = new Map<string, Scripted[]>();
  let oidcCount = 0;
  const next = (route: string): Response | null => {
    const q = queues.get(route);
    return q && q.length ? q.shift()!() : null;
  };

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    const rec: Recorded = { method, url, headers };
    calls.push(rec);

    if (url.startsWith(OIDC_URL.split("?")[0]!)) {
      oidcCount += 1;
      return json({ value: `h.oidc-${oidcCount}.s` });
    }
    if (url.startsWith(R2_ENDPOINT)) {
      const bytes = await readBytes(init?.body);
      rec.bytes = bytes;
      const scripted = next("put");
      if (scripted) return scripted;
      const expected = headers["x-amz-checksum-sha256"];
      if (Buffer.from(sha(bytes), "hex").toString("base64") !== expected)
        return new Response("<Error><Code>BadDigest</Code></Error>", {
          status: 400,
        });
      r2.set(new URL(url).pathname.slice(`/${BUCKET}/`.length), bytes);
      return new Response(null, { status: 200 });
    }
    rec.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = url.slice(`${BASE}/${SLUG}`.length);
    const short = route.replace("/release/publish", "");
    const scripted = next(short) ?? next(route);
    if (scripted) return scripted;
    switch (route) {
      case "/release/publish/token":
        return json({
          token: CI_TOKEN,
          expiresAt: 1_900_000_000,
          scopes: ["distribution:report", "release:promote", "release:publish"],
        });
      case "/release/publish/uploads": {
        const objects = (
          rec.body as { objects: { sha256: string; size: number }[] }
        ).objects;
        return json({
          ticket: TICKET,
          expiresAt: 1_900_000_000,
          credentials: {
            endpoint: R2_ENDPOINT,
            bucket: BUCKET,
            accessKeyId: "parent-akid",
            secretAccessKey: SECRET_KEY,
            sessionToken: SESSION_TOKEN,
          },
          prefix: `staging/${SLUG}/t1/`,
          objects: objects.map((o) => ({
            ...o,
            gated: false,
            key: `staging/${SLUG}/t1/${o.sha256}`,
            target: `blobs/sha256/${o.sha256}`,
            present: present.has(o.sha256),
          })),
          nextSeq: { app: 7 },
          // P3-03: each named release's seq (a fixed 7 here, like nextSeq).
          seqs: (
            (
              rec.body as {
                releases?: { deliverable: string; version: string }[];
              }
            ).releases ?? []
          ).map((r) => ({ ...r, seq: 7 })),
        });
      }
      case "/release/publish/submit": {
        const b = rec.body as {
          dryRun?: boolean;
          descriptor: { tag?: string };
          record?: string;
        };
        return json({
          ok: true,
          dryRun: b.dryRun === true,
          releaseId: b.descriptor.tag ?? "app@0.3.0",
          outcome: "created",
          descriptorSha256: "f".repeat(64),
          ...(b.dryRun ? { planned: {}, unverified: [] } : {}),
          ...(b.record
            ? {
                record: {
                  sha256: sha(b.record),
                  stored: true,
                },
              }
            : {}),
        });
      }
      default:
        if (/^\/release\/(channels|releases)\//.test(route))
          return json({ ok: true });
        return json({ error: "not_found" }, 404);
    }
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    r2,
    present,
    script(route, ...responses) {
      queues.set(route, [...(queues.get(route) ?? []), ...responses]);
    },
    to(fragment) {
      return calls.filter((c) => c.url.includes(fragment));
    },
  };
}

/** A stdout/stderr pair that records what was written. */
export function capture() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
    out: () => out,
    err: () => err,
  };
}

export const instant = async () => undefined;
