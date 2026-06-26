import { describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import type { ManagedConfigDoc, ManagedEntry } from "@polaris-key/protocol";
import { PolarisKeyClient, type PolarisKeyOptions } from "../src/client.js";
import { InMemoryStore, type CacheRecord } from "../src/store.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const base = {
  productSlug: "djdl",
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
} as const satisfies Partial<PolarisKeyOptions>;

const NOW = 1_700_000_000;

function entry(
  state: ManagedEntry["state"],
  value: ManagedEntry["value"],
): ManagedEntry {
  return { state, value, updatedAt: NOW };
}

/** Build a client with a pre-seeded, signed cache (no network) + the given config map. */
async function clientWith(
  config: Record<string, ManagedEntry>,
  opts: Partial<PolarisKeyOptions> = {},
): Promise<PolarisKeyClient> {
  const store = new InMemoryStore("djdl");
  const deviceId = await store.getDeviceId();
  const doc: ManagedConfigDoc = {
    schemaVersion: 2,
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "lic_1",
    deviceId,
    issuedAt: NOW,
    expiresAt: NOW + 3600,
    graceUntil: NOW + 30 * 86400,
    profile: {
      name: "Ada",
      firstName: "Ada",
      email: "a@b.c",
      activatedAt: NOW,
    },
    payload: { config, secrets: {}, entitlements: {} },
  };
  await store.setToken("pkeyt_cached");
  // Sign so writeCache round-trips a real doc shape; the cache itself is what we read.
  await signJws(doc, TEST_PEM, TEST_KID);
  const rec: CacheRecord = {
    doc,
    etag: '"v1"',
    lastAcceptedIssuedAt: NOW,
    lastVerifiedAt: NOW * 1000,
  };
  await store.writeCache(rec);
  const exploding = (async () => {
    throw new Error("network must not be used");
  }) as unknown as typeof fetch;
  return PolarisKeyClient.create({
    ...base,
    store,
    fetchImpl: exploding,
    ...opts,
  });
}

describe("layered config — enforced/hidden are locked", () => {
  it("enforced beats both local override and env", async () => {
    const c = await clientWith(
      { "quality.floor": entry("enforced", "flac") },
      {
        localOverrides: { "quality.floor": "mp3" },
        env: { PKEY_CONFIG_quality__floor: "wav" },
      },
    );
    expect(c.getConfig("quality.floor", "x")).toBe("flac");
    expect(c.getConfigSource("quality.floor")).toBe("enforced");
  });

  it("hidden is still applied by getConfig and also wins over overrides", async () => {
    const c = await clientWith(
      { "secret.knob": entry("hidden", "locked") },
      {
        localOverrides: { "secret.knob": "nope" },
        env: { PKEY_CONFIG_secret__knob: "nope2" },
      },
    );
    expect(c.getConfig("secret.knob", "x")).toBe("locked");
    expect(c.getConfigSource("secret.knob")).toBe("hidden");
  });
});

describe("layered config — default precedence (local > env > remote > fallback)", () => {
  const cfg = { "run.concurrency": entry("default", 4) };

  it("local override wins over env and remote-default", async () => {
    const c = await clientWith(cfg, {
      localOverrides: { "run.concurrency": 8 },
      env: { PKEY_CONFIG_run__concurrency: "16" },
    });
    expect(c.getConfig("run.concurrency", 1)).toBe(8);
    expect(c.getConfigSource("run.concurrency")).toBe("local");
  });

  it("env wins over remote-default when no local override (JSON-parsed)", async () => {
    const c = await clientWith(cfg, {
      env: { PKEY_CONFIG_run__concurrency: "16" },
    });
    expect(c.getConfig("run.concurrency", 1)).toBe(16);
    expect(c.getConfigSource("run.concurrency")).toBe("env");
  });

  it("env raw string is kept when it is not JSON-shaped", async () => {
    const c = await clientWith(
      { "log.level": entry("default", "info") },
      { env: { PKEY_CONFIG_log__level: "debug" } },
    );
    expect(c.getConfig("log.level", "x")).toBe("debug");
    expect(c.getConfigSource("log.level")).toBe("env");
  });

  it("remote-default wins when no local/env present", async () => {
    const c = await clientWith(cfg);
    expect(c.getConfig("run.concurrency", 1)).toBe(4);
    expect(c.getConfigSource("run.concurrency")).toBe("remote-default");
  });

  it("fallback wins when the key is absent everywhere", async () => {
    const c = await clientWith({});
    expect(c.getConfig("missing.key", 99)).toBe(99);
    expect(c.getConfigSource("missing.key")).toBe("fallback");
  });

  it("a custom envPrefix is honored", async () => {
    const c = await clientWith(cfg, {
      envPrefix: "DJDL_",
      env: { DJDL_run__concurrency: "32" },
    });
    expect(c.getConfig("run.concurrency", 1)).toBe(32);
    expect(c.getConfigSource("run.concurrency")).toBe("env");
  });
});

describe("listUserConfig", () => {
  it("excludes hidden entries but getConfig still returns them; marks enforced", async () => {
    const c = await clientWith(
      {
        "run.concurrency": entry("default", 4),
        "quality.floor": entry("enforced", "flac"),
        "secret.knob": entry("hidden", "locked"),
      },
      {
        localOverrides: { "run.concurrency": 9 },
      },
    );
    const list = c.listUserConfig();
    const keys = list.map((e) => e.key).sort();
    expect(keys).toEqual(["quality.floor", "run.concurrency"]);
    expect(list.find((e) => e.key === "quality.floor")).toEqual({
      key: "quality.floor",
      value: "flac",
      enforced: true,
    });
    expect(list.find((e) => e.key === "run.concurrency")).toEqual({
      key: "run.concurrency",
      value: 9,
      enforced: false,
    });
    // hidden is withheld from the list yet still applied.
    expect(list.some((e) => e.key === "secret.knob")).toBe(false);
    expect(c.getConfig("secret.knob", "x")).toBe("locked");
  });
});

describe("D4 — doc-less getters return fallbacks without throwing", () => {
  it("a blocked first sync leaves a doc-less cache; every getter is safe", async () => {
    const store = new InMemoryStore("djdl");
    let activated = false;
    const impl = (async (input: string | URL | Request): Promise<Response> => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      if (u.pathname.endsWith("/activate")) {
        activated = true;
        return new Response(
          JSON.stringify({ token: "pkeyt_e", schemaVersion: 2 }),
          { status: 200 },
        );
      }
      if (u.pathname.endsWith("/config") && activated) {
        return new Response(
          JSON.stringify({
            reason: "version-too-old",
            allowedRange: { min: "2.0.0" },
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (u.pathname.endsWith("/config/report"))
        return new Response("{}", { status: 200 });
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: impl,
    });
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    // The cache exists (it carries the block) but has NO doc — the D4 latent crash.
    expect(client.status().status).toBe("version-too-old");

    expect(() => client.getConfig("any.key", "fb")).not.toThrow();
    expect(client.getConfig("any.key", "fb")).toBe("fb");
    expect(client.getConfigSource("any.key")).toBe("fallback");
    expect(client.listUserConfig()).toEqual([]);
    expect(client.getSecret("any")).toBeNull();
    expect(client.isEntitled("any")).toBe(false);
    expect(client.getEntitlements()).toEqual({});
    expect(client.getProfile()).toBeNull();
  });
});
