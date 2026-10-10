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
import { setServices } from "../src/core/repo.js";
import type { Env } from "../src/platform/env.js";
import { dispatchRegistryHost } from "../src/core/registry/registryHost.js";
import {
  mintRegistryToken,
  signPullToken,
} from "../src/core/registry/registryTokens.js";
import {
  REGISTRY_OWNERLESS_ROUTES,
  REGISTRY_ROUTES,
  SERVICES,
} from "../src/mount.js";
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
        sync: { enabled: false },
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
      tags: ["0.8.0", "1.0.0", "1.1.0-beta.1", "beta", "dev", "latest"],
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

// ── F-23: native push on workerd ─────────────────────────────────────────────────────────────
//
// What Node cannot prove about `docker push`: that the real R2 binding takes the upload's
// multipart parts (streamed through `FixedLengthStream`), refuses a part-size breach the Node
// fake only models, completes the object, and lets Core's `landUpload` copy it under the SHA-256
// R2 itself checks. The push goes through the real dispatcher and routes, with a push token
// signed under a key this test sets (the lane's wrangler config sets none, so `/v2/` stays open
// for the pull tests above).

// An 11 MiB layer crosses the local R2 binding three times (parts, landUpload's copy, the pull),
// which outlasts vitest's 5 s default on a loaded runner; the R2 lanes elsewhere allow 60 s.
const R2_LANE = { timeout: 60_000 };

describe("OCI push on workerd (F-23)", () => {
  it(
    "a chunked layer, its config and a manifest pushed by version tag publish a pullable version",
    R2_LANE,
    async () => {
      const e = {
        ...(env as unknown as Env),
        REGISTRY_TOKEN_KEY: "workerd-push-key",
      } as Env;
      const db = new D1Db(env.DB);
      const minted = await mintRegistryToken(
        e,
        db,
        {
          product: OWNER,
          label: "push",
          binding: "owner",
          scopes: ["read", "publish"],
          ecosystems: ["oci"],
          createdBy: "admin:workerd",
        },
        Math.floor(Date.now() / 1000),
      );
      if (!minted.ok) throw new Error(JSON.stringify(minted));
      const signed = await signPullToken(
        e,
        { sub: minted.view.tokenId, own: OWNER, repos: [NAME], push: [NAME] },
        Math.floor(Date.now() / 1000),
      );
      const auth = `Bearer ${signed!.token}`;
      const send = (
        method: string,
        path: string,
        body?: Uint8Array,
        headers: Record<string, string> = {},
      ) =>
        dispatchRegistryHost(
          new Request(`${HOST}${path}`, {
            method,
            headers: {
              authorization: auth,
              ...(body ? { "content-length": String(body.byteLength) } : {}),
              ...headers,
            },
            ...(body ? { body } : {}),
          }),
          e,
          db,
          REGISTRY_ROUTES,
          SERVICES,
          undefined,
          REGISTRY_OWNERLESS_ROUTES,
        );
      const hex = async (b: Uint8Array) =>
        [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))]
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");

      const MiB = 1024 * 1024;
      const layer = new Uint8Array(11 * MiB + 17);
      for (let i = 0; i < layer.length; i += 65_536)
        crypto.getRandomValues(
          layer.subarray(i, Math.min(i + 65_536, layer.length)),
        );
      const layerHex = await hex(layer);
      const start = await send("POST", `/v2/${NAME}/blobs/uploads/`);
      expect(start.status).toBe(202);
      let location = start.headers.get("location")!;
      // Uneven chunks: 3 MiB (a tail), 6 MiB (fixes a 9 MiB part), the rest (the last part).
      let at = 0;
      for (const n of [3 * MiB, 6 * MiB, layer.length - 9 * MiB]) {
        const res = await send("PATCH", location, layer.slice(at, at + n), {
          "content-range": `${at}-${at + n - 1}`,
        });
        expect(res.status, await res.clone().text()).toBe(202);
        at += n;
        location = res.headers.get("location")!;
      }
      const done = await send("PUT", `${location}?digest=sha256:${layerHex}`);
      expect(done.status, await done.clone().text()).toBe(201);

      const config = new TextEncoder().encode(
        JSON.stringify({
          architecture: "amd64",
          os: "linux",
          rootfs: { type: "layers", diff_ids: [] },
        }),
      );
      const configHex = await hex(config);
      const mono = await send(
        "POST",
        `/v2/${NAME}/blobs/uploads/?digest=sha256:${configHex}`,
        config,
      );
      expect(mono.status, await mono.clone().text()).toBe(201);

      const manifest = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          config: {
            mediaType: "application/vnd.oci.image.config.v1+json",
            digest: `sha256:${configHex}`,
            size: config.length,
          },
          layers: [
            {
              mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
              digest: `sha256:${layerHex}`,
              size: layer.length,
            },
          ],
        }),
      );
      const put = await send("PUT", `/v2/${NAME}/manifests/2.0.0`, manifest, {
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      });
      expect(put.status, await put.clone().text()).toBe(201);

      // Pulled through the public feed, as any client would.
      const pulled = await SELF.fetch(`${HOST}/v2/${NAME}/manifests/2.0.0`);
      expect(pulled.status).toBe(200);
      expect(new Uint8Array(await pulled.arrayBuffer())).toEqual(manifest);
      const blob = await SELF.fetch(
        `${HOST}/v2/${NAME}/blobs/sha256:${layerHex}`,
      );
      expect(blob.status).toBe(200);
      expect(await hex(new Uint8Array(await blob.arrayBuffer()))).toBe(
        layerHex,
      );
      // Nothing of the upload is left in staging.
      const staged = await e.BLOBS!.list({ prefix: `staging/${OWNER}/` });
      expect(staged.objects).toEqual([]);
    },
  );
});
