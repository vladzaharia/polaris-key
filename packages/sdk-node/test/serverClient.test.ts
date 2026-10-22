// @pkey-feature server.config
// `serverClient()` (framework drop-ins §5.7, SP-63): the normal client for a container. A stable
// device id, the key from PKEY_LICENSE_KEY, a memory store, no device report, a background
// refresh and the usual config read.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signJws, type JwsTyp } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import { serverClient } from "../src/serverClient.js";
import { InMemoryStore } from "../src/core/store.js";
import type { PolarisKeyClient } from "../src/client.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";
const PRODUCT = "djdl";
const DEVICE = "srvDeviceId0123456789abcdefABCDE";
const nowSec = (): number => Math.floor(Date.now() / 1000);

const base = {
  productSlug: PRODUCT,
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
  trustRefresh: false,
  config: { env: {} },
} as const;

interface Seen {
  paths: string[];
  devices: string[];
}

function plane(refuse = false): { fetchImpl: typeof fetch; seen: Seen } {
  const seen: Seen = { paths: [], devices: [] };
  const issuedAt = nowSec();
  let n = 0;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const p = new URL(typeof input === "string" ? input : input.toString())
      .pathname;
    seen.paths.push(p);
    const device = new Headers(init?.headers).get("x-pkey-device");
    if (device) seen.devices.push(device);
    if (p.endsWith("/license/activate"))
      return refuse
        ? new Response(JSON.stringify({ error: "device_limit", limit: 1 }), {
            status: 403,
            headers: { "content-type": "application/json" },
          })
        : new Response(
            JSON.stringify({ token: "pkeyt_srv", schemaVersion: 4 }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
    const doc = (
      typ: JwsTyp,
      extra: Record<string, unknown>,
    ): Promise<string> =>
      signJws(
        {
          iss: ISSUER,
          aud: PRODUCT,
          deviceId: DEVICE,
          issuedAt: issuedAt + n++,
          expiresAt: issuedAt + 86_400,
          graceUntil: issuedAt + 30 * 86_400,
          ...extra,
        },
        TEST_PEM,
        TEST_KID,
        typ,
      );
    const jws = (s: string): Response =>
      new Response(s, {
        status: 200,
        headers: { "content-type": "application/jwt" },
      });
    if (p.endsWith("/config/document"))
      return jws(
        await doc("pkey-config+jws", {
          schemaVersion: 4,
          config: {
            "quality.floor": {
              state: "enforced",
              value: "flac",
              updatedAt: issuedAt,
            },
          },
          secrets: {},
        }),
      );
    if (p.endsWith("/license/document"))
      return jws(
        await doc("pkey-license+jws", {
          licenseId: "lic_srv",
          profile: { name: "Server", activatedAt: issuedAt },
          entitlements: {
            "license.tier": {
              state: "enforced",
              value: "server",
              updatedAt: issuedAt,
            },
          },
        }),
      );
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const open: PolarisKeyClient[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
  vi.useRealTimers();
});
const start = async (
  p: ReturnType<typeof plane>,
  env: Record<string, string>,
  more: Record<string, unknown> = {},
): Promise<PolarisKeyClient> => {
  const c = await serverClient({
    ...base,
    fetchImpl: p.fetchImpl,
    env,
    ...more,
  });
  open.push(c);
  return c;
};

describe("serverClient()", () => {
  it("reads config under the id from PKEY_DEVICE_ID and the key from PKEY_LICENSE_KEY", async () => {
    const p = plane();
    const c = await start(p, {
      PKEY_DEVICE_ID: DEVICE,
      PKEY_LICENSE_KEY: "pkey_djdl_server",
    });
    expect(c.core.deviceId).toBe(DEVICE);
    expect(c.config.getConfig("quality.floor", "none")).toBe("flac");
    expect(new Set(p.seen.devices)).toEqual(new Set([DEVICE]));
    expect(p.seen.paths.some((x) => x.endsWith("/license/activate"))).toBe(
      true,
    );
  });

  it("makes no device report, on sync or on an explicit report()", async () => {
    const p = plane();
    const c = await start(p, {
      PKEY_DEVICE_ID: DEVICE,
      PKEY_LICENSE_KEY: "k",
    });
    await c.sync({ force: true });
    expect(await c.devices.report()).toBe(false);
    expect(p.seen.paths.filter((x) => x.endsWith("/devices/report"))).toEqual(
      [],
    );
  });

  it("keeps its id in a file on a volume across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkey-srv-"));
    const file = join(dir, "state", "device-id");
    const env = { PKEY_DEVICE_ID_FILE: file, PKEY_LICENSE_KEY: "k" };
    const first = await start(plane(), env);
    const id = first.core.deviceId;
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(readFileSync(file, "utf8").trim()).toBe(id);
    first.close();
    const second = await start(plane(), env);
    expect(second.core.deviceId).toBe(id);
  });

  it("holds the token in memory only: a restart activates the same id again", async () => {
    const p = plane();
    const env = { PKEY_DEVICE_ID: DEVICE, PKEY_LICENSE_KEY: "k" };
    const c = await start(p, env);
    expect(c.core.store).toBeInstanceOf(InMemoryStore);
    expect(await c.core.store.status?.()).toEqual({ backend: "memory" });
  });

  it("refreshes in the background", async () => {
    vi.useFakeTimers();
    const p = plane();
    await start(p, { PKEY_DEVICE_ID: DEVICE, PKEY_LICENSE_KEY: "k" });
    const before = p.seen.paths.filter((x) =>
      x.endsWith("/config/document"),
    ).length;
    await vi.advanceTimersByTimeAsync(3_700_000);
    const after = p.seen.paths.filter((x) =>
      x.endsWith("/config/document"),
    ).length;
    expect(after).toBeGreaterThan(before);
  });

  it("refuses to start without a stable id or a key, before any request", async () => {
    const p = plane();
    await expect(
      serverClient({
        ...base,
        fetchImpl: p.fetchImpl,
        env: { PKEY_LICENSE_KEY: "k" },
      }),
    ).rejects.toMatchObject({ code: "invalid-options" });
    await expect(
      serverClient({
        ...base,
        fetchImpl: p.fetchImpl,
        env: { PKEY_DEVICE_ID: DEVICE },
      }),
    ).rejects.toMatchObject({ code: "invalid-options" });
    await expect(
      serverClient({
        ...base,
        fetchImpl: p.fetchImpl,
        env: { PKEY_DEVICE_ID: "short", PKEY_LICENSE_KEY: "k" },
      }),
    ).rejects.toMatchObject({ code: "invalid-options" });
    expect(p.seen.paths).toEqual([]);
  });

  it("rejects a malformed id file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkey-srv-"));
    const file = join(dir, "id");
    writeFileSync(file, "nope\n");
    await expect(
      serverClient({
        ...base,
        fetchImpl: plane().fetchImpl,
        env: { PKEY_DEVICE_ID_FILE: file, PKEY_LICENSE_KEY: "k" },
      }),
    ).rejects.toMatchObject({ code: "invalid-options" });
  });

  it("throws the server's code when the key is refused", async () => {
    await expect(
      serverClient({
        ...base,
        fetchImpl: plane(true).fetchImpl,
        env: { PKEY_DEVICE_ID: DEVICE, PKEY_LICENSE_KEY: "k" },
      }),
    ).rejects.toMatchObject({ code: "device_limit" });
  });
});
