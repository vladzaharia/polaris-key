// @pkey-feature release.download release.record release.fetch
// SDK parity pass §3.6: release.fetch streams a build from discovery's builds route, resumes with
// Range, verifies size and SHA-256 against the verified record, and never leaves a partial or
// unverified file at `to`. installUrl/downloadUrl follow discovery's distribution endpoints.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordHash } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { tempDir } from "./parityFixtures.js";
import {
  BASE,
  discoveryDoc,
  MemStore,
  PINS,
  PRODUCT,
  RELEASE_KEYS,
  recordPayload,
  signRecord,
  V4_SERVICES,
} from "./updateFixtures.js";

const BYTES = Buffer.from("polaris-key build payload ".repeat(64));
const SHA = createHash("sha256").update(BYTES).digest("hex");

async function setup(o: { corrupt?: boolean; cut?: number } = {}) {
  const payload = recordPayload();
  (
    payload as unknown as { builds: { artifacts: unknown[] }[] }
  ).builds[0]!.artifacts = [
    { name: "app.zip", role: "payload", sha256: SHA, size: BYTES.length },
  ];
  const recordJws = await signRecord(payload);
  const hash = await recordHash(recordJws);
  const requests: {
    path: string;
    range: string | null;
    ifRange: string | null;
    auth: string | null;
  }[] = [];
  let cut = o.cut;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    requests.push({
      path: url.pathname,
      range: h.get("range"),
      ifRange: h.get("if-range"),
      auth: h.get("authorization"),
    });
    if (url.pathname === `/${PRODUCT}/.well-known/polaris.json`)
      return new Response(JSON.stringify(discoveryDoc()), { status: 200 });
    if (url.pathname === `/${PRODUCT}/release/records/${hash}`)
      return new Response(recordJws, { status: 200 });
    if (url.pathname === `/${PRODUCT}/distribution/builds/1.5.0/macos-zip`) {
      let body = o.corrupt ? Buffer.from(BYTES).fill(65, 0, 4) : BYTES;
      const range = h.get("range");
      let status = 200;
      if (range) {
        const from = Number(/bytes=(\d+)-/.exec(range)![1]);
        body = body.subarray(from);
        status = 206;
      }
      if (cut !== undefined) {
        body = body.subarray(0, cut);
        cut = undefined;
      }
      return new Response(body, { status });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const store = new MemStore("dev_fetch");
  store.token = "pkeyt_fetch";
  const dir = tempDir();
  const client = await PolarisKeyClient.create({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.4.0",
    trust: { pinnedKeys: PINS },
    store,
    fetchImpl,
    requestTimeoutMs: 0,
    stateDir: dir,
    expectedServices: [...V4_SERVICES] as never,
    update: {
      pinnedReleaseKeys: RELEASE_KEYS,
      outlet: "direct",
      platform: "macos",
      arch: "arm64",
    },
  });
  return { client, hash, requests, to: join(dir, "out", "app.zip") };
}

describe("release.fetch (§3.6)", () => {
  it("downloads, verifies and moves the file into place, with the bearer", async () => {
    const { client, hash, requests, to } = await setup();
    const progress: number[] = [];
    const r = await client.release.fetch(
      { sha256: hash, buildId: "macos-zip" },
      { to, onProgress: (d) => progress.push(d) },
    );
    expect(r).toMatchObject({
      path: to,
      size: BYTES.length,
      sha256: SHA,
      version: "1.5.0",
    });
    expect(readFileSync(to).equals(BYTES)).toBe(true);
    expect(existsSync(`${to}.part`)).toBe(false);
    expect(progress.at(-1)).toBe(BYTES.length);
    const get = requests.find((q) => q.path.includes("/distribution/builds/"))!;
    expect(get.auth).toBe("Bearer pkeyt_fetch");
    const events = await client.update.journal.all();
    expect(events.map((e) => e.event)).toEqual(["update_downloaded"]);
  });

  it("resumes a cut download with Range and If-Range", async () => {
    const { client, hash, requests, to } = await setup({ cut: 100 });
    await expect(
      client.release.fetch({ sha256: hash, buildId: "macos-zip" }, { to }),
    ).rejects.toMatchObject({ code: "network-error" });
    expect(existsSync(to)).toBe(false);
    await client.release.fetch({ sha256: hash, buildId: "macos-zip" }, { to });
    expect(readFileSync(to).equals(BYTES)).toBe(true);
    expect(requests.filter((q) => q.range).map((q) => q.range)).toEqual([
      "bytes=100-",
    ]);
    // If-Range names the payload's strong ETag, so only the same bytes are appended.
    expect(requests.filter((q) => q.range).map((q) => q.ifRange)).toEqual([
      `"${SHA}"`,
    ]);
  });

  it("refuses bytes that do not match the record and leaves nothing behind", async () => {
    const { client, hash, to } = await setup({ corrupt: true });
    await expect(
      client.release.fetch({ sha256: hash, buildId: "macos-zip" }, { to }),
    ).rejects.toMatchObject({ code: "payload-mismatch" });
    expect(existsSync(to)).toBe(false);
    expect(existsSync(`${to}.part`)).toBe(false);
  });
});

describe("install and download URLs follow discovery", () => {
  it("uses distribution endpoints once discovery is loaded", async () => {
    const doc = {
      product: PRODUCT,
      services: {
        release: {
          enabled: true,
          endpoints: { download: `${BASE}/${PRODUCT}/release/dl` },
        },
        distribution: {
          enabled: true,
          endpoints: {
            download: `${BASE}/${PRODUCT}/distribution/dl`,
            install: `${BASE}/${PRODUCT}/distribution/install.sh`,
          },
        },
      },
    };
    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.0.0",
      trust: { pinnedKeys: PINS },
      store: new MemStore("dev_urls"),
      fetchImpl: (async () =>
        new Response(JSON.stringify(doc))) as typeof fetch,
      expectedServices: ["release"] as never,
    });
    expect(client.release.installUrl()).toBe(
      `${BASE}/${PRODUCT}/release/install.sh`,
    );
    await client.discover();
    expect(client.release.installUrl()).toBe(
      `${BASE}/${PRODUCT}/distribution/install.sh`,
    );
    expect(
      client.release.downloadUrl("1.2.0", "djdl", "arm64", { checksum: true }),
    ).toBe(
      `${BASE}/${PRODUCT}/distribution/dl/1.2.0/djdl-arm64?checksum=sha256`,
    );
  });
});
