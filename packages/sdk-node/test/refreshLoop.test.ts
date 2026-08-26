// The opt-in refresh loop + change callback that make remote re-licensing land without a
// restart. The signal is the ETag: computeETag() excludes issuedAt/expiresAt/graceUntil, so a
// differing tag means the CONTENT changed, not merely that the doc was re-signed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { signJws } from "@plrs/jws";
import type { ManagedConfigDoc } from "@plrs/protocol";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/store.js";
import type { LicenseState } from "../src/gate.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const NOW = Math.floor(Date.now() / 1000);

function docFor(
  deviceId: string,
  tier: string,
  issuedAt: number,
): ManagedConfigDoc {
  return {
    schemaVersion: 1,
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "lic_1",
    deviceId,
    // Anti-replay requires a strictly increasing issuedAt: a re-issued doc that reuses the
    // previous timestamp is rejected by verifyDoc and never applied.
    issuedAt,
    expiresAt: issuedAt + 3600,
    graceUntil: issuedAt + 30 * 86400,
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: NOW,
    },
    payload: {
      config: {},
      secrets: {},
      entitlements: {
        "license.tier": { state: "enforced", value: tier, updatedAt: NOW },
      },
    },
  };
}

interface Scenario {
  client: PolarisKeyClient;
  changes: LicenseState[];
  /** Swap what the next /config returns, as a remote tier change would. */
  setTier: (tier: string, etag: string) => void;
}

async function scenario(
  opts: { refreshIntervalSeconds?: number } = {},
): Promise<Scenario> {
  let tier = "free";
  let etag = '"v1"';
  let issuedAt = NOW;
  const changes: LicenseState[] = [];
  const store = new InMemoryStore("djdl");
  const deviceId = await store.getDeviceId();

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(typeof input === "string" ? input : input.toString())
      .pathname;
    if (path.endsWith("/activate")) {
      return new Response(
        JSON.stringify({ token: "pkeyt_test", schemaVersion: 1 }),
        { status: 200 },
      );
    }
    if (path.endsWith("/config/report")) {
      return new Response("{}", { status: 200 });
    }
    if (path.endsWith("/config")) {
      if (new Headers(init?.headers).get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return new Response(
        await signJws(docFor(deviceId, tier, issuedAt), TEST_PEM, TEST_KID),
        {
          status: 200,
          headers: { etag },
        },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const client = await PolarisKeyClient.create({
    productSlug: "djdl",
    baseUrl: "https://k.test",
    version: "1.2.3",
    trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
    store,
    fetchImpl,
    trustRefresh: false,
    fingerprint: false,
    onChange: (s) => changes.push(s),
    ...opts,
  });
  await client.activateWithKey("pkey_djdl_test");

  return {
    client,
    changes,
    setTier: (nextTier, nextEtag) => {
      tier = nextTier;
      etag = nextEtag;
      issuedAt += 60;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("refresh loop", () => {
  it("is off unless an interval is configured", async () => {
    // Enabling polling by default would silently add network traffic and background wakeups
    // to every already-shipped integration.
    // Fake timers must be installed BEFORE the client is constructed — startTimer() calls
    // setInterval during init(), so a later swap would leave a real timer running.
    vi.useFakeTimers();
    const s = await scenario();
    const spy = vi.spyOn(s.client, "refresh");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy).not.toHaveBeenCalled();
    s.client.close();
  });

  it("polls on the configured interval and stops on close()", async () => {
    vi.useFakeTimers();
    const s = await scenario({ refreshIntervalSeconds: 10 });
    const spy = vi.spyOn(s.client, "refresh");

    await vi.advanceTimersByTimeAsync(25_000);
    const whileRunning = spy.mock.calls.length;
    expect(whileRunning).toBeGreaterThanOrEqual(2);

    s.client.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy.mock.calls.length).toBe(whileRunning);
  });

  it("close() is safe to call twice", async () => {
    const s = await scenario({ refreshIntervalSeconds: 10 });
    s.client.close();
    expect(() => s.client.close()).not.toThrow();
  });
});

describe("onChange", () => {
  it("fires when the entitlements actually change", async () => {
    const s = await scenario();
    s.changes.length = 0;

    s.setTier("pro", '"v2"');
    await s.client.refresh();

    expect(s.changes).toHaveLength(1);
    expect(s.client.getEntitlements()["license.tier"]).toBe("pro");
    s.client.close();
  });

  it("does not fire when the config is unchanged", async () => {
    // A 304 means the content is identical; firing onChange there would make every poll look
    // like a re-licensing event.
    const s = await scenario();
    s.changes.length = 0;

    await s.client.refresh();
    expect(s.changes).toHaveLength(0);
    s.client.close();
  });
});
