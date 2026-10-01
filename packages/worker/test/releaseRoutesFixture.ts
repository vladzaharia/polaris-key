/**
 * Shared fixtures for the P2-05 route suites (`releasePolicy.test.ts`, `releaseBytes.test.ts`):
 * a product with Release and Update on, a linked repo, a GitHub stub that counts what it is
 * asked (API calls apart from storage fetches), and helpers that drive the real dispatcher and
 * the real admin API.
 */

import { createHash } from "node:crypto";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import type { Release, ReleaseAsset } from "../src/services/release/github.js";
import { dispatch } from "../src/dispatch.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import { syncReleaseStore } from "../src/services/release/sync.js";
import {
  stmtSetArtifactModel,
  stmtUpsertBuild,
} from "../src/services/release/model.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";

export const SLUG = "djdl";
export const CONSOLE = "https://key.example.test";
export const BYTES = "https://dl.example.test";
const API = "https://api.github.com/repos/acme/djdl";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 7) & 0xff;
  return out;
}

/** The payload bytes of each fixture asset, by GitHub asset id. */
export const ASSET_BYTES: Record<number, Uint8Array> = {
  101: bytesOf(5000, 1),
  102: bytesOf(3000, 2),
  201: bytesOf(6000, 3),
  202: bytesOf(3500, 4),
  301: bytesOf(7000, 5),
};

function asset(id: number, name: string): ReleaseAsset {
  return {
    id,
    name,
    size: ASSET_BYTES[id]?.length ?? 10,
    content_type: "text/html", // repo-chosen; never relayed (R6-04)
    browser_download_url: `https://github.com/acme/djdl/releases/download/x/${name}`,
  };
}

export function release(
  tag: string,
  assets: ReleaseAsset[],
  over: Partial<Release> = {},
): Release {
  return {
    tag_name: tag,
    name: tag,
    body: `Notes for ${tag}`,
    published_at: "2026-01-02T03:04:05Z",
    html_url: `https://github.com/acme/djdl/releases/tag/${tag}`,
    prerelease: false,
    draft: false,
    assets,
    ...over,
  };
}

/** v1.0.0 and v1.1.0, each with a CLI binary and a DMG (and v1.1.0 a checksum sidecar). */
export const RELEASES: Release[] = [
  release("v1.1.0", [
    asset(201, "djdl-arm64"),
    asset(202, "djdl-1.1.0-arm64.dmg"),
  ]),
  release("v1.0.0", [
    asset(101, "djdl-arm64"),
    asset(102, "djdl-1.0.0-arm64.dmg"),
  ]),
];

export interface GitHubCalls {
  /** api.github.com requests, minus the installation-token exchange. */
  api: string[];
  /** Signed storage-host requests. */
  storage: string[];
}

function amzNow(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** A GitHub stub over mutable state. */
export function github(state: { releases: Release[]; repoPrivate?: boolean }): {
  fetchImpl: FetchImpl;
  calls: GitHubCalls;
} {
  const calls: GitHubCalls = { api: [], storage: [] };
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_stub" }), {
        status: 200,
      });
    const u = new URL(url);
    if (u.hostname === "objects.githubusercontent.com") {
      calls.storage.push(url);
      const id = Number(u.pathname.split("/").pop());
      const bytes = ASSET_BYTES[id];
      if (!bytes) return new Response("nf", { status: 404 });
      const range = new Headers(init?.headers).get("Range");
      const m = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
      if (m) {
        const start = Number(m[1]);
        const end = m[2]
          ? Math.min(Number(m[2]), bytes.length - 1)
          : bytes.length - 1;
        return new Response(bytes.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            "Content-Type": "text/html",
          },
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Length": String(bytes.length),
          "Accept-Ranges": "bytes",
          "Content-Type": "text/html",
        },
      });
    }
    calls.api.push(url);
    if (url === API)
      return new Response(
        JSON.stringify({
          private: !!state.repoPrivate,
          visibility: state.repoPrivate ? "private" : "public",
        }),
        { status: 200 },
      );
    if (/\/releases\?per_page=\d+$/.test(url))
      return new Response(JSON.stringify(state.releases), { status: 200 });
    const tag = /\/releases\/tags\/([^/?]+)$/.exec(url)?.[1];
    if (tag) {
      const hit = state.releases.find(
        (r) => r.tag_name === decodeURIComponent(tag),
      );
      return hit
        ? new Response(JSON.stringify(hit), { status: 200 })
        : new Response("nf", { status: 404 });
    }
    const assetId = /\/releases\/assets\/(\d+)$/.exec(url)?.[1];
    if (assetId) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://objects.githubusercontent.com/github-production-release-asset/${assetId}?X-Amz-Date=${amzNow()}&X-Amz-Expires=300&X-Amz-Signature=sig`,
        },
      });
    }
    return new Response("nf", { status: 404 });
  };
  return { fetchImpl, calls };
}

export function envFor(opts: { blobOrigin?: string; kv?: KvMock } = {}): Env {
  const env = makeEnv(opts.kv ?? new KvMock(), [SLUG]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "platform-admins";
  if (opts.blobOrigin !== undefined) env.BLOB_ORIGIN = opts.blobOrigin;
  return env;
}

export async function enableServices(
  db: Db,
  release: boolean,
  slug = SLUG,
): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: release },
        distribution: { enabled: release },
        update: { enabled: release },
        identity: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
}

/** A product with Release and Update on and a linked repo. */
export async function seedReleaseProduct(
  db: Db,
  over: Record<string, unknown> = {},
  slug = SLUG,
): Promise<void> {
  await seedProduct(db, slug);
  await enableServices(db, true, slug);
  const row: Record<string, unknown> = {
    product: slug,
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

/**
 * Sync the truth store from the stub, then attach a descriptor-style build to each release:
 * build `cli-arm64` (macOS arm64) whose payload is the CLI asset, with its SHA-256.
 */
export async function syncAndDescribe(
  env: Env,
  db: Db,
  fetchImpl: FetchImpl,
): Promise<void> {
  await syncReleaseStore(env, db, SLUG, NOW, fetchImpl);
  for (const [tag, cli] of [
    ["v1.0.0", 101],
    ["v1.1.0", 201],
  ] as const) {
    const b = stmtUpsertBuild(
      {
        product: SLUG,
        releaseId: tag,
        buildId: "cli-arm64",
        platform: "macos",
        arch: "arm64",
        format: "binary",
      },
      NOW,
    );
    await db.run(b.sql, ...b.params);
    const a = stmtSetArtifactModel({
      product: SLUG,
      releaseId: tag,
      artifactId: String(cli),
      buildId: "cli-arm64",
      role: "payload",
      sha256: sha256Hex(ASSET_BYTES[cli]!),
    });
    await db.run(a.sql, ...a.params);
  }
}

/** Drive the real dispatcher (console or bytes host) with `fetchImpl` as the global fetch. */
export async function call(
  env: Env,
  db: Db,
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const saved = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    return await dispatch(new Request(url, init), env, db);
  } finally {
    globalThis.fetch = saved;
  }
}

/** Drive the real admin API as a platform admin. */
export async function admin(
  env: Env,
  db: Db,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/release${path}`;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    full,
    { now: NOW },
  );
}

export async function auditRows(
  db: Db,
): Promise<Array<{ action: string; actor_sub: string; target_id: string }>> {
  return db.all(
    "SELECT action, actor_sub, target_id FROM audit WHERE product = ? ORDER BY rowid",
    SLUG,
  );
}
