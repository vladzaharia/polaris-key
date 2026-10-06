/// <reference types="@cloudflare/workers-types" />
// ── Release-file mirroring on miniflare's R2 and D1 (HA-08) ──────────────────────────────
//
// The Node lane (`test/releaseMirror.test.ts`) covers the rules against `test/r2Mock.ts`. This
// file runs one mirror end to end against the real bindings, which is what proves the parts the
// fake could get wrong: a GitHub asset streamed through `safeFetch`'s redirect hop into R2 under
// workerd's `FixedLengthStream` lands byte for byte with R2's own SHA-256 checksum, the guarded
// append (the `release-artifact` ref, the audit row, the job row and the new `locations_json`)
// commits as one real D1 batch whose last statement's change count decides the outcome, the
// `release_mirrors` foreign key holds, and R2 itself refuses corrupted bytes so nothing is
// promoted.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blobKey, checksumHex } from "../src/core/blobs.js";
import type { FetchImpl } from "../src/core/safeFetch.js";
import { D1Db } from "../src/db/d1.js";
import type { Env } from "../src/env.js";
import {
  processReleaseMirror,
  RELEASE_ARTIFACT_REF,
  type ReleaseMirrorMessage,
} from "../src/services/release/mirror.js";
import { NOW, seedProduct } from "./seed.js";

const LANE = { timeout: 60_000 };

function bucket(): R2Bucket {
  if (!env.BLOBS) throw new Error("BLOBS is not bound in the workerd lane");
  return env.BLOBS;
}

function bytesOf(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536)
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65_536, n)));
  out.set([0x50, 0x4b, 3, 4], 0);
  return out;
}

async function hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function streamOf(bytes: Uint8Array, chunk = 8191): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (pos >= bytes.length) return c.close();
      c.enqueue(bytes.slice(pos, pos + chunk));
      pos += chunk;
    },
  });
}

/** A product running Release, with one GitHub release `v1.0.0` holding asset `assetId`. */
async function seed(slug: string, assetId: number, size: number) {
  const db = new D1Db(env.DB);
  await seedProduct(env as Env, db, slug, { schemaVersion: 1, entries: [] });
  await db.run(
    "UPDATE products SET services_json = ? WHERE slug = ?",
    JSON.stringify({ release: { enabled: true } }),
    slug,
  );
  await db.run(
    `INSERT INTO release_config (product, gh_owner, gh_repo, gh_installation_id, beta_branch,
       summary_marker, metadata_access, artifacts_access)
     VALUES (?, 'acme', 'app', 42, 'main', 'pkey:summary', 'public', 'public')`,
    slug,
  );
  await db.run(
    `INSERT INTO release_metadata (product, release_id, version, metadata_access, artifacts_access,
       created_at, modified_at)
     VALUES (?, 'v1.0.0', '1.0.0', 'public', 'public', ?, ?)`,
    slug,
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO release_artifacts (product, release_id, artifact_id, name, kind, size_bytes,
       source_url, access, created_at)
     VALUES (?, 'v1.0.0', ?, 'app-arm64.zip', 'zip', ?, ?, 'public', ?)`,
    slug,
    String(assetId),
    size,
    `https://github.com/acme/app/releases/download/v1.0.0/app-arm64.zip`,
    NOW,
  );
  return db;
}

/** GitHub: the asset's metadata (JSON), its 302 to the storage host, and the storage bytes. */
function github(
  assetId: number,
  bytes: Uint8Array,
  digest: string,
  served: Uint8Array = bytes,
): FetchImpl {
  return (async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const accept = new Headers(init?.headers).get("accept") ?? "";
    if (url === `https://api.github.com/repos/acme/app/releases/assets/${assetId}`) {
      if (accept.includes("application/vnd.github+json"))
        return Response.json({
          id: assetId,
          name: "app-arm64.zip",
          size: bytes.length,
          digest: `sha256:${digest}`,
        });
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://objects.githubusercontent.com/github-production-release-asset/${assetId}?sig=x`,
        },
      });
    }
    if (url.startsWith("https://objects.githubusercontent.com/")) {
      if (new Headers(init?.headers).has("authorization"))
        return new Response("the token must not follow the redirect", {
          status: 400,
        });
      return new Response(streamOf(served), {
        headers: { "content-length": String(served.length) },
      });
    }
    return new Response("nf", { status: 404 });
  }) as FetchImpl;
}

const message = (product: string, artifactId: string): ReleaseMirrorMessage => ({
  v: 1,
  kind: "release-mirror",
  product,
  releaseId: "v1.0.0",
  artifactId,
  reason: "sync",
});

describe("release-file mirroring on R2 and D1", LANE, () => {
  it("copies a GitHub asset into R2 and appends its r2 location in one batch", async () => {
    const bytes = bytesOf(3 * 1024 * 1024 + 17);
    const digest = await hex(bytes);
    const db = await seed("ha-mirror", 9001, bytes.length);
    const outcome = await processReleaseMirror(
      {
        env: { ...(env as Env), BLOBS: bucket() },
        db,
        now: NOW,
        fetchImpl: github(9001, bytes, digest),
      },
      message("ha-mirror", "9001"),
      { token: async () => "ghs_test" },
    );
    expect(outcome).toBe("mirrored");

    const head = await bucket().head(blobKey(digest));
    expect(head?.size).toBe(bytes.length);
    expect(head && checksumHex(head)).toBe(digest);

    const row = await db.first<{ sha256: string; locations_json: string }>(
      "SELECT sha256, locations_json FROM release_artifacts WHERE product = ? AND artifact_id = '9001'",
      "ha-mirror",
    );
    expect(row?.sha256).toBe(digest);
    expect(JSON.parse(row!.locations_json)).toEqual([
      { provider: "github" },
      { provider: "r2", key: blobKey(digest) },
    ]);
    expect(
      await db.first(
        "SELECT ref_id FROM blob_refs WHERE product = ? AND ref_kind = ?",
        "ha-mirror",
        RELEASE_ARTIFACT_REF,
      ),
    ).toEqual({ ref_id: "v1.0.0/9001" });
    expect(
      await db.first(
        "SELECT status, sha256, attempts FROM release_mirrors WHERE product = ?",
        "ha-mirror",
      ),
    ).toEqual({ status: "ready", sha256: digest, attempts: 0 });
  });

  it("R2 refuses corrupted bytes: no object, no ref, no location", async () => {
    const bytes = bytesOf(2 * 1024 * 1024);
    const digest = await hex(bytes);
    const bad = bytes.slice();
    bad[4096] = bad[4096]! ^ 0xff;
    const db = await seed("ha-mirror-bad", 9002, bytes.length);
    const outcome = await processReleaseMirror(
      {
        env: { ...(env as Env), BLOBS: bucket() },
        db,
        now: NOW,
        fetchImpl: github(9002, bytes, digest, bad),
      },
      message("ha-mirror-bad", "9002"),
      { token: async () => "ghs_test" },
    );
    expect(outcome).toBe("failed");
    expect(await bucket().head(blobKey(digest))).toBeNull();
    expect(
      await db.first(
        "SELECT locations_json FROM release_artifacts WHERE product = ? AND artifact_id = '9002'",
        "ha-mirror-bad",
      ),
    ).toEqual({ locations_json: null });
    expect(
      await db.first(
        "SELECT COUNT(*) AS n FROM blob_refs WHERE product = ?",
        "ha-mirror-bad",
      ),
    ).toEqual({ n: 0 });
    expect(
      await db.first(
        "SELECT status, error FROM release_mirrors WHERE product = ?",
        "ha-mirror-bad",
      ),
    ).toEqual({ status: "failed", error: "sha256-mismatch" });
  });
});
