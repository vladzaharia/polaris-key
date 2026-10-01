// The URL vectors the Godot SDK is held to (P1-08): sdks/godot/tests/fixtures/release-urls.json
// records what this SDK's downloadUrl / installUrl / appcastUrlFrom return, and the Godot update
// suite asserts PolarisKey.release and PolarisKey.update return the same bytes. This side keeps
// the fixture honest: if Node's output moves, this fails, and the fixture (and Godot) follow.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import { appcastUrlFrom, discoverProduct } from "../src/discovery.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(
  here,
  "../../../sdks/godot/tests/fixtures/release-urls.json",
);

interface Vectors {
  baseUrl: string;
  product: string;
  installUrl: string;
  download: {
    version: string;
    binary: string;
    arch: string;
    checksum: boolean;
    dmg: boolean;
    expect: string;
  }[];
  discovery: Record<string, unknown> & { services: Record<string, unknown> };
  appcast: { channel: string; arch: string; expect: string | null }[];
  appcastOff: { update: unknown; expect: string | null }[];
}

const V = JSON.parse(readFileSync(FIXTURE, "utf8")) as Vectors;

async function manifestOf(doc: unknown) {
  const res = await discoverProduct({
    baseUrl: V.baseUrl,
    product: V.product,
    fetchImpl: (async () =>
      new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
  if (res.kind !== "ok") throw new Error(`fixture did not parse: ${res.kind}`);
  return res.manifest;
}

const opts = (channel: string, arch: string) => ({
  ...(channel ? { channel } : {}),
  ...(arch ? { arch } : {}),
});

// @pkey-feature release.download update.check
describe("the Godot URL vectors match sdk-node", () => {
  it("downloadUrl and installUrl", async () => {
    const c = await PolarisKeyClient.create({
      productSlug: V.product,
      baseUrl: V.baseUrl,
      version: "1.2.3",
      trust: {
        pinnedKeys: {
          "pkey-test-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI",
        },
      },
      trustRefresh: false,
      store: new InMemoryStore(V.product),
      fetchImpl: (async () =>
        new Response("", { status: 404 })) as unknown as typeof fetch,
      expectedServices: ["release", "update"],
      license: { fingerprint: false },
      devices: { fingerprint: false },
    });
    expect(V.download.length).toBeGreaterThanOrEqual(8);
    for (const d of V.download)
      expect(
        c.release.downloadUrl(d.version, d.binary, d.arch, {
          checksum: d.checksum,
          dmg: d.dmg,
        }),
      ).toBe(d.expect);
    expect(c.release.installUrl()).toBe(V.installUrl);
    c.close();
  });

  it("appcastUrlFrom", async () => {
    const doc = await manifestOf(V.discovery);
    expect(V.appcast.length).toBeGreaterThanOrEqual(8);
    for (const a of V.appcast)
      expect(appcastUrlFrom(doc, opts(a.channel, a.arch))).toBe(a.expect);
    for (const off of V.appcastOff) {
      const m = await manifestOf({
        ...V.discovery,
        services: { ...V.discovery.services, update: off.update },
      });
      expect(appcastUrlFrom(m, opts("beta", "arm64"))).toBe(off.expect);
    }
  });
});
