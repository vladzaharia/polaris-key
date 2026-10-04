/// <reference types="@cloudflare/workers-types" />
// ── The OCI feed on workerd (F-08, plans/F-01.md §6.7 and §6.8) ──────────────────────────────
//
// What Node cannot prove about OCI pull: that the real R2 binding answers ranged blob reads with
// the right bytes and a 206, that a HEAD keeps its `Content-Length` and `Docker-Content-Digest`
// through workerd's own Response handling, and that the whole route (D1 catalog reads, the
// render write-back into R2, the host's hardening) runs under the production `wrangler.toml`.
// The repository is published through the real package ingest into the real D1 and R2.

import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { D1Db } from "../src/db/d1.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import type { Env } from "../src/env.js";
import {
  OCI_INDEX,
  OCI_REPO,
  publishOciFixture,
  type OciFixtureVersion,
} from "../test/ociFixture.js";
import { NOW, seedProduct } from "./seed.js";

const HOST = "https://pkg.workerd.test";
const OWNER = "ociwd";
const NAME = `${OWNER}/${OCI_REPO}`;

let fixture: OciFixtureVersion[];

beforeAll(async () => {
  const e = env as unknown as Env;
  const db = new D1Db(env.DB);
  await seedProduct(e, db, OWNER, { schemaVersion: 1, entries: [] });
  await setServices(
    db,
    OWNER,
    serializeServices({
      services: {
        license: { enabled: false },
        config: { enabled: false },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: false },
        identity: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
    OWNER,
    NOW,
  );
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json, max_package_bytes, updated_at)
     VALUES (?, 'oci', 1, '{}', 5368709120, ?)`,
    OWNER,
    NOW,
  );
  if (!e.BLOBS) throw new Error("BLOBS is not bound in the workerd lane");
  fixture = await publishOciFixture(db, e, e.BLOBS, OWNER, NOW);
});

const ver = (v: string) => fixture.find((x) => x.version === v)!;

describe("OCI pull on workerd", () => {
  it("a ranged blob read answers 206 with the right bytes; HEAD keeps the size", async () => {
    const layer = ver("1.0.0").objects.find((o) => o.type === "oci-blob")!;
    const url = `${HOST}/v2/${NAME}/blobs/sha256:${layer.sha256}`;
    const part = await SELF.fetch(url, { headers: { range: "bytes=2-6" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(
      `bytes 2-6/${layer.bytes.length}`,
    );
    expect(part.headers.get("docker-content-digest")).toBe(
      `sha256:${layer.sha256}`,
    );
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(
      layer.bytes.slice(2, 7),
    );

    const suffix = await SELF.fetch(url, { headers: { range: "bytes=-3" } });
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(
      layer.bytes.slice(-3),
    );

    const over = await SELF.fetch(url, {
      headers: { range: `bytes=${layer.bytes.length}-` },
    });
    expect(over.status).toBe(416);
    await over.arrayBuffer();

    const head = await SELF.fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(layer.bytes.length));
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
    expect(head.headers.get("docker-distribution-api-version")).toBe(
      "registry/2.0",
    );
  });

  it("a manifest by tag and its HEAD carry the digest, type and length", async () => {
    const root = ver("1.0.0").root;
    const res = await SELF.fetch(`${HOST}/v2/${NAME}/manifests/latest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(OCI_INDEX);
    expect(res.headers.get("docker-content-digest")).toBe(
      `sha256:${root.sha256}`,
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(root.bytes);

    const head = await SELF.fetch(`${HOST}/v2/${NAME}/manifests/latest`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(OCI_INDEX);
    expect(head.headers.get("content-length")).toBe(String(root.bytes.length));
    expect(head.headers.get("docker-content-digest")).toBe(
      `sha256:${root.sha256}`,
    );
  });

  it("tags/list renders from D1 and writes the document back to R2", async () => {
    const res = await SELF.fetch(`${HOST}/v2/${NAME}/tags/list`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: NAME,
      tags: ["0.8.0", "1.0.0", "1.1.0-beta.1", "beta", "latest"],
    });
    const e = env as unknown as Env;
    // The write-back runs in waitUntil; give it a moment, then the object is there.
    let stored: R2Object | null = null;
    for (let i = 0; i < 50 && !stored; i++) {
      stored = await e.BLOBS!.head(`registry/oci/${NAME}/_tags.json`);
      if (!stored) await new Promise((r) => setTimeout(r, 20));
    }
    expect(stored?.customMetadata?.["x-pkey-render-stamp"]).toMatch(
      /^[0-9a-f]{32}$/,
    );
  });
});
