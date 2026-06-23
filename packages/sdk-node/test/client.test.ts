import { describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/store.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

function mockFetch(opts: { configStatus?: number; blockedBody?: unknown } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    if (u.pathname.endsWith("/enroll")) {
      return new Response(JSON.stringify({ token: "pkeyt_test", schemaVersion: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.pathname.endsWith("/config/report")) return new Response("{}", { status: 200 });
    if (u.pathname.endsWith("/config")) {
      if (opts.configStatus === 403) {
        return new Response(JSON.stringify(opts.blockedBody), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      const device = headers.get("x-pkey-device") ?? "d";
      const now = Math.floor(Date.now() / 1000);
      const doc = {
        schemaVersion: 1,
        aud: "djdl",
        iss: "key.plrs.im",
        licenseId: "lic_1",
        deviceId: device,
        issuedAt: now,
        expiresAt: now + 3600,
        graceUntil: now + 30 * 86400,
        profile: { name: "Ada Lovelace", firstName: "Ada", email: "ada@example.com", enrolledAt: now },
        payload: {
          config: { "quality.floor": { state: "managed", value: "flac" } },
          secrets: { "soundcloud.oauth": { state: "hidden", value: "tok" } },
          entitlements: { polarisVpn: { state: "managed", value: true } },
        },
      };
      const jws = await signJws(doc, TEST_PEM, TEST_KID);
      return new Response(jws, {
        status: 200,
        headers: { "content-type": "application/jwt", etag: '"abc"' },
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

const base = {
  productSlug: "djdl",
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
};

describe("PolarisKeyClient", () => {
  it("enroll → ok; reads config, entitlement, secret, profile", async () => {
    const client = await PolarisKeyClient.create({ ...base, store: new InMemoryStore("djdl"), fetchImpl: mockFetch() });
    expect(client.status().status).toBe("needs-enroll");

    const r = await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    expect(r.kind).toBe("ok");
    expect(client.status().status).toBe("ok");
    expect(client.isLicensed()).toBe(true);
    expect(client.isEntitled("polarisVpn")).toBe(true);
    expect(client.getConfig("quality.floor", "any")).toBe("flac");
    expect(client.getSecret("soundcloud.oauth")).toBe("tok");
    expect(client.getProfile()?.firstName).toBe("Ada");
  });

  it("403 → version-blocked status with allowedRange", async () => {
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore("djdl"),
      fetchImpl: mockFetch({ configStatus: 403, blockedBody: { reason: "version-too-old", allowedRange: { min: "2.0.0" } } }),
    });
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    const s = client.status();
    expect(s.status).toBe("version-too-old");
    expect(s.allowedRange?.min).toBe("2.0.0");
  });

  it("deactivate clears state back to needs-enroll", async () => {
    const client = await PolarisKeyClient.create({ ...base, store: new InMemoryStore("djdl"), fetchImpl: mockFetch() });
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    expect(client.status().status).toBe("ok");
    await client.deactivate();
    expect(client.status().status).toBe("needs-enroll");
  });
});
