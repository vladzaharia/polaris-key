// Layered config resolution through the Config sub-client — `client.config.*`.
//
// The resolution RULES live in `@polaris-key/client-core` (`resolveValue`/`resolveSource`/
// `listUserEntries`) and are pinned there; what this file protects is the wiring on the Node
// side, which is where every one of these values actually comes from in a shipped product:
//
//   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
//
// ── WHY THE FIXTURE IS A SIGNED CACHE RECORD AND NOT A STUBBED DOC ──────────────────────────
//
// §4.1: the cache stores compact JWSs and nothing else, and every load re-verifies them against
// the pins before a single value is readable. Seeding a decoded document would test a code path
// that does not exist — an unsigned fixture simply would not load. So each client here is built
// from a genuinely signed `pkey-config+jws` in a `v: 3` record, with an EXPLODING `fetchImpl`:
// if any of these reads were to reach the network the test fails loudly rather than passing for
// the wrong reason.
//
// ── WHAT MOVED IN v3 ────────────────────────────────────────────────────────────────────────
//
//   * the accessors are `client.config.*`, not the god-object's `client.getConfig` — config
//     resolution is the config SERVICE's job, and a product that disabled it never has to think
//     about `envPrefix`/`env`/`localOverrides` at all (they ride `ConfigClientOptions`);
//   * the document is `pkey-config+jws` with `config`/`secrets` at the TOP LEVEL — v2's
//     `payload: {config, secrets, entitlements}` is gone, and entitlements moved to the licence
//     document (D-20);
//   * the env prefix stays `PKEY_CONFIG_` (§8) — the interim `PLRS_CONFIG_` spelling was
//     withdrawn by Amendment A1 and is NOT read, which is the kind of thing that fails
//     silently (a stale var simply stops being honored), so it gets its own pin below;
//   * the cache record is `{v:3, docs:{config}, etags:{config}}`: per-service slices, because
//     licence and config are now independently fetched and independently ETagged.

import { describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import { ISSUER, type ManagedEntry } from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import {
  PolarisKeyClient,
  type PolarisKeyClientOptions,
} from "../src/client.js";
import {
  CACHE_VERSION,
  InMemoryStore,
  type CacheRecordV3,
} from "../src/core/store.js";
import type { ConfigClientOptions } from "../src/config/client.js";

// The project's deterministic test key (see client.test.ts).
const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const base = {
  productSlug: "djdl",
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
  // Hardware probes shell out; nothing here activates, so keep the suite deterministic.
  devices: { fingerprint: false },
} as const satisfies Partial<PolarisKeyClientOptions>;

const NOW = 1_700_000_000;

/** A transport that must never be reached — every read below is served from the cache. */
const exploding = (async () => {
  throw new Error("network must not be used");
}) as unknown as typeof fetch;

function entry(
  state: ManagedEntry["state"],
  value: ManagedEntry["value"],
): ManagedEntry {
  return { state, value, updatedAt: NOW };
}

/** Build a client with a pre-seeded, SIGNED v3 cache record (no network) + the given maps. */
async function clientWith(
  config: Record<string, ManagedEntry>,
  configOpts: ConfigClientOptions = {},
  over: {
    secrets?: Record<string, ManagedEntry>;
    extra?: Partial<PolarisKeyClientOptions>;
  } = {},
): Promise<PolarisKeyClient> {
  const store = new InMemoryStore("djdl");
  const deviceId = await store.getDeviceId();
  const doc: ConfigDoc = {
    // v3 is host-NEUTRAL: `key.plrs.im`, not the serving hostname (D-09). A `key.plrs.im` issuer
    // is a v2 artifact and would fail verification outright.
    iss: ISSUER,
    aud: "djdl",
    deviceId,
    issuedAt: NOW,
    expiresAt: NOW + 3600,
    graceUntil: NOW + 30 * 86400,
    schemaVersion: 2,
    config,
    secrets: over.secrets ?? {},
  };
  await store.setToken("pkeyt_cached");
  const rec: CacheRecordV3 = {
    v: CACHE_VERSION,
    docs: { config: await signJws(doc, TEST_PEM, TEST_KID, "pkey-config+jws") },
    etags: { config: '"v1"' },
  };
  await store.writeCache(rec);
  return PolarisKeyClient.create({
    ...base,
    store,
    fetchImpl: exploding,
    config: configOpts,
    ...over.extra,
  });
}

describe("layered config — enforced/hidden are locked", () => {
  it("enforced beats both local override and env", async () => {
    // The whole point of the management state: an admin-locked key is not negotiable on the
    // client, and no local file or env var may quietly unlock it.
    const c = await clientWith(
      { "quality.floor": entry("enforced", "flac") },
      {
        localOverrides: { "quality.floor": "mp3" },
        env: { PKEY_CONFIG_quality__floor: "wav" },
      },
    );
    expect(c.config.getConfig("quality.floor", "x")).toBe("flac");
    expect(c.config.getConfigSource("quality.floor")).toBe("enforced");
  });

  it("hidden is still applied by getConfig and also wins over overrides", async () => {
    // `hidden` is `enforced` PLUS withheld from enumeration. Withheld is not inert.
    const c = await clientWith(
      { "secret.knob": entry("hidden", "locked") },
      {
        localOverrides: { "secret.knob": "nope" },
        env: { PKEY_CONFIG_secret__knob: "nope2" },
      },
    );
    expect(c.config.getConfig("secret.knob", "x")).toBe("locked");
    expect(c.config.getConfigSource("secret.knob")).toBe("hidden");
  });
});

describe("layered config — default precedence (local > env > remote > fallback)", () => {
  const cfg = { "run.concurrency": entry("default", 4) };

  it("local override wins over env and remote-default", async () => {
    const c = await clientWith(cfg, {
      localOverrides: { "run.concurrency": 8 },
      env: { PKEY_CONFIG_run__concurrency: "16" },
    });
    expect(c.config.getConfig("run.concurrency", 1)).toBe(8);
    expect(c.config.getConfigSource("run.concurrency")).toBe("local");
  });

  it("env wins over remote-default when no local override (JSON-parsed)", async () => {
    const c = await clientWith(cfg, {
      env: { PKEY_CONFIG_run__concurrency: "16" },
    });
    expect(c.config.getConfig("run.concurrency", 1)).toBe(16);
    expect(c.config.getConfigSource("run.concurrency")).toBe("env");
  });

  it("env raw string is kept when it is not JSON-shaped", async () => {
    const c = await clientWith(
      { "log.level": entry("default", "info") },
      {
        env: { PKEY_CONFIG_log__level: "debug" },
      },
    );
    expect(c.config.getConfig("log.level", "x")).toBe("debug");
    expect(c.config.getConfigSource("log.level")).toBe("env");
  });

  it("remote-default wins when no local/env present", async () => {
    const c = await clientWith(cfg);
    expect(c.config.getConfig("run.concurrency", 1)).toBe(4);
    expect(c.config.getConfigSource("run.concurrency")).toBe("remote-default");
  });

  it("fallback wins when the key is absent everywhere", async () => {
    const c = await clientWith({});
    expect(c.config.getConfig("missing.key", 99)).toBe(99);
    expect(c.config.getConfigSource("missing.key")).toBe("fallback");
  });

  it("a custom envPrefix is honored", async () => {
    const c = await clientWith(cfg, {
      envPrefix: "DJDL_",
      env: { DJDL_run__concurrency: "32" },
    });
    expect(c.config.getConfig("run.concurrency", 1)).toBe(32);
    expect(c.config.getConfigSource("run.concurrency")).toBe("env");
  });
});

describe("env var naming — PKEY_CONFIG_ + dotted-key mapping (§8)", () => {
  const cfg = { "run.concurrency": entry("default", 4) };

  it("a dotted key maps to PKEY_CONFIG_run__concurrency (dots → double underscore)", async () => {
    // Dots are not legal in env var names on every shell, so `.` becomes `__`. The mapping is
    // the contract an operator reads from the docs; getting it wrong is silent.
    const c = await clientWith(cfg, {
      env: { PKEY_CONFIG_run__concurrency: "16" },
    });
    expect(c.config.getConfig("run.concurrency", 1)).toBe(16);
    expect(c.config.getConfigSource("run.concurrency")).toBe("env");
  });

  it("the withdrawn PLRS_CONFIG_ prefix is NOT read", async () => {
    // A prefix change fails quietly — a stale var simply stops being honored and the remote
    // default reappears — so the spelling A1 withdrew gets an explicit negative pin.
    const c = await clientWith(cfg, {
      env: { PLRS_CONFIG_run__concurrency: "16" },
    });
    expect(c.config.getConfig("run.concurrency", 1)).toBe(4);
    expect(c.config.getConfigSource("run.concurrency")).toBe("remote-default");
  });

  it("a single underscore in the var name does not match a dotted key", async () => {
    const c = await clientWith(cfg, {
      env: { PKEY_CONFIG_run_concurrency: "16" },
    });
    expect(c.config.getConfig("run.concurrency", 1)).toBe(4);
  });
});

describe("env value coercion", () => {
  // The environment is a string channel, so a config value's TYPE has to survive it: a number
  // that arrives as `"16"` and stays a string would break every numeric consumer downstream.
  const cases: Array<[string, string, unknown]> = [
    ["a number", "16", 16],
    ["a negative float", "-2.5", -2.5],
    ["true", "true", true],
    ["false", "false", false],
    ["null", "null", null],
    ["an object", '{"a":1}', { a: 1 }],
    ["an array", "[1,2,3]", [1, 2, 3]],
    ["a quoted string", '"quoted"', "quoted"],
  ];

  it.each(cases)("parses %s", async (_name, raw, expected) => {
    const c = await clientWith(
      { "run.knob": entry("default", "remote") },
      {
        env: { PKEY_CONFIG_run__knob: raw },
      },
    );
    expect(c.config.getConfig("run.knob", "fb")).toEqual(expected);
  });

  it("keeps a malformed JSON-LOOKING value as the raw string", async () => {
    // `{"a":` looks like JSON and does not parse. Throwing would take down a client over a
    // typo in someone's shell profile; substituting the remote default would hide it. The
    // raw string is the honest answer.
    const c = await clientWith(
      { "run.knob": entry("default", "remote") },
      {
        env: { PKEY_CONFIG_run__knob: '{"a":' },
      },
    );
    expect(c.config.getConfig("run.knob", "fb")).toBe('{"a":');
    expect(c.config.getConfigSource("run.knob")).toBe("env");
  });

  it("keeps a plain word as a string rather than reading it as JSON", async () => {
    const c = await clientWith(
      { "run.knob": entry("default", "remote") },
      {
        env: { PKEY_CONFIG_run__knob: "debug" },
      },
    );
    expect(c.config.getConfig("run.knob", "fb")).toBe("debug");
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
      { localOverrides: { "run.concurrency": 9 } },
    );
    const list = c.config.listUserConfig();
    expect(list.map((e) => e.key).sort()).toEqual([
      "quality.floor",
      "run.concurrency",
    ]);
    // An enforced key is listed READ-ONLY, at its remote value.
    expect(list.find((e) => e.key === "quality.floor")).toEqual({
      key: "quality.floor",
      value: "flac",
      enforced: true,
    });
    // An overridable key is listed at its EFFECTIVE value, so a settings UI shows what the
    // app is actually running with rather than what the server last suggested.
    expect(list.find((e) => e.key === "run.concurrency")).toEqual({
      key: "run.concurrency",
      value: 9,
      enforced: false,
    });
    // hidden is withheld from the list yet still applied.
    expect(list.some((e) => e.key === "secret.knob")).toBe(false);
    expect(c.config.getConfig("secret.knob", "x")).toBe("locked");
  });
});

describe("secrets are a separate map", () => {
  it("getSecret reads only from `secrets`, never from `config`", async () => {
    // Secrets are never enumerated and never resolved through the override layers — a local
    // override that could shadow a managed secret would be a credential-substitution hole.
    const c = await clientWith(
      { "api.token": entry("default", "not-a-secret") },
      { localOverrides: { "api.key": "local-attempt" } },
      { secrets: { "api.key": entry("enforced", "sk_live_123") } },
    );
    expect(c.config.getSecret("api.key")).toBe("sk_live_123");
    // A config key is not reachable through the secret accessor...
    expect(c.config.getSecret("api.token")).toBeNull();
    // ...and an absent secret is null, not undefined and not a throw.
    expect(c.config.getSecret("nope")).toBeNull();
  });

  it("a non-string secret value reads as null", async () => {
    const c = await clientWith(
      {},
      {},
      {
        secrets: { "api.key": entry("enforced", 12345) },
      },
    );
    expect(c.config.getSecret("api.key")).toBeNull();
  });

  it("reports the document's catalog schemaVersion", async () => {
    const c = await clientWith({});
    expect(c.config.schemaVersion()).toBe(2);
  });
});

describe("D-08 — a product with the config service DISABLED", () => {
  /** No cached document at all: a product that does not run Config never fetches one, and
   *  `sync()` skips the route entirely (`wantConfig`). */
  async function configDisabledClient(): Promise<PolarisKeyClient> {
    const store = new InMemoryStore("djdl");
    await store.setToken("pkeyt_cached");
    return PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: exploding,
      // The D-21 offline capability fallback: this build knows it runs licence only.
      expectedServices: ["license"],
      config: { localOverrides: {}, env: {} },
    });
  }

  it("reports config.enabled === false so a host can branch on it", async () => {
    const c = await configDisabledClient();
    expect(c.config.enabled).toBe(false);
    expect(c.capabilities().config.enabled).toBe(false);
  });

  it("every read falls back instead of throwing or inventing a value", async () => {
    const c = await configDisabledClient();
    expect(c.config.getConfig("run.concurrency", 1)).toBe(1);
    expect(c.config.getConfigSource("run.concurrency")).toBe("fallback");
    expect(c.config.listUserConfig()).toEqual([]);
    expect(c.config.getSecret("api.key")).toBeNull();
    expect(c.config.schemaVersion()).toBeNull();
  });

  it("local/env overrides still resolve — they are inputs, not a substitute document", async () => {
    // A config-DISABLED product has no remote catalog, but its host may still ship defaults
    // and honor env vars. `enabled` is the signal about the SERVICE, not a mute switch on the
    // resolution layers.
    const store = new InMemoryStore("djdl");
    const c = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: exploding,
      expectedServices: ["license"],
      config: {
        localOverrides: { "run.concurrency": 8 },
        env: { PKEY_CONFIG_log__level: "debug" },
      },
    });
    expect(c.config.getConfig("run.concurrency", 1)).toBe(8);
    expect(c.config.getConfigSource("run.concurrency")).toBe("local");
    expect(c.config.getConfig("log.level", "info")).toBe("debug");
  });
});

describe("D4 — doc-less getters return fallbacks without throwing", () => {
  it("a blocked first sync leaves a doc-less cache; every getter is safe", async () => {
    // The latent crash this pins: activation succeeds, the licence document comes back 403
    // BLOCKED and the config document errors, so the cache carries a block and no documents at
    // all. Every accessor has to survive that state — a gate that renders "version-too-old"
    // and then throws on the first `getConfig` is a worse outcome than no gate.
    const store = new InMemoryStore("djdl");
    let activated = false;
    const impl = (async (input: string | URL | Request): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === "/djdl/license/activate") {
        activated = true;
        return new Response(
          JSON.stringify({ token: "pkeyt_e", schemaVersion: 3 }),
          { status: 200 },
        );
      }
      if (path === "/djdl/license/document" && activated) {
        // The build gate answers on the LICENCE route (D-20).
        return new Response(
          JSON.stringify({
            error: { code: "version_blocked", reason: "version-too-old" },
            allowedRange: { min: "2.0.0" },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/djdl/config/document")
        return new Response("boom", { status: 500 });
      if (path === "/djdl/devices/report")
        return new Response("{}", { status: 200 });
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: impl,
    });
    await client.license.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");

    expect(client.status().status).toBe("version-too-old");
    expect(client.status().allowedRange).toEqual({ min: "2.0.0" });

    expect(() => client.config.getConfig("any.key", "fb")).not.toThrow();
    expect(client.config.getConfig("any.key", "fb")).toBe("fb");
    expect(client.config.getConfigSource("any.key")).toBe("fallback");
    expect(client.config.listUserConfig()).toEqual([]);
    expect(client.config.getSecret("any")).toBeNull();
    expect(client.config.schemaVersion()).toBeNull();
    // The licence-side reads are doc-less too — entitlements ride that document (D-20).
    expect(client.license.isEntitled("any")).toBe(false);
    expect(client.license.getEntitlements()).toEqual({});
    expect(client.license.getProfile()).toBeNull();
    expect(client.license.getLicenseId()).toBeNull();
  });
});
