// `@polaris-key/node/local` — the transportless profile (offline depth 3).
//
// The suite has three offline depths: online-with-grace, bundle-activated, and LOCAL-ONLY — a
// build that must never open a socket. What this suite pins is that "never" is STRUCTURAL and
// not merely a habit:
//
//   * the refusal happens in `CoreContext.fetcher()`, BEFORE a URL is built or a header is
//     assembled, so a local-only build cannot dial even by accident;
//   * there is still exactly ONE client type — `client.license.activateWithKey(...)` exists and
//     answers, rather than being absent and forcing the host to branch on which client it got;
//   * everything offline keeps working: the gate, config resolution, bundle import, and
//     `deactivate()`, whose network leg was always best-effort and whose local wipe was always
//     the part that mattered.
//
// ── HOW THE REFUSAL SURFACES, AND WHY IT DIFFERS BY CALL ───────────────────────────────────
//
// Two shapes, and the split is the pre-existing contract of each call rather than anything the
// local profile invents:
//
//   THROWS `PolarisError("local-only")`  every call that would DIAL: `sync()`, `discover()`,
//                                        `devices.{register,list,rename,deauthorize}`,
//                                        `license.{activateWithKey,enroll}`, `release.*`,
//                                        `update.*`. The refusal is a CONFIGURATION error — the
//                                        host asked a transportless client to reach the network
//                                        — not a transport outcome, so it must not be
//                                        indistinguishable from a dropped connection. That is
//                                        why `fetcher()` is called OUTSIDE the try in
//                                        `license/endpoints.ts` and `devices/client.ts`.
//   SWALLOWS the refusal                 the two calls that were ALREADY best-effort against a
//                                        dead network: `license.deactivate()`'s deauthorize leg
//                                        (the local wipe is what the caller depends on) and
//                                        `devices.report()` (telemetry may never fail a caller).
//
// Both are asserted below by NAME, so that if either ever changes the test says which one and why.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signJws } from "@polaris-key/jws";
import type { BundleDoc } from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { TrustManifestDoc } from "@polaris-key/protocol/trust";
import {
  PolarisError,
  type CacheRecordV3,
  type Store,
} from "@polaris-key/client-core";
import { CACHE_VERSION } from "../src/core/store.js";
import { createBundleClient, createLocalClient } from "../src/local/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));

interface CorpusKey {
  kid: string;
  publicKeyRaw: string;
  privateKeyPkcs8Pem: string;
}

const corpus = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "conformance", "corpus", "v2", "cases.json"),
    "utf8",
  ),
) as { keys: CorpusKey[] };

const KID = "pkey-test-prod-2026";
const KEY = corpus.keys.find((k) => k.kid === KID);
if (!KEY) throw new Error(`corpus is missing key ${KID}`);
const PEM = KEY.privateKeyPkcs8Pem;
const PUB = KEY.publicKeyRaw;
const PINNED = { [KID]: PUB };

const PRODUCT = "djdl";
const DEVICE = "dev_air_gapped";
const TOKEN = `pkeyt_${"C".repeat(43)}`;
/** The pre-seeded cache is minted against the WALL clock so the gate can be read with no
 *  explicit `now` — an offline install's whole point is that it answers as it is. */
const NOW = Math.floor(Date.now() / 1000);

class FakeStore implements Store {
  token: string | null = null;
  cache: CacheRecordV3 | null = null;

  constructor(private readonly id: string = DEVICE) {}
  async getToken() {
    return this.token;
  }
  async setToken(t: string) {
    this.token = t;
  }
  async clearToken() {
    this.token = null;
  }
  async getDeviceId() {
    return this.id;
  }
  async readCache() {
    return this.cache;
  }
  async writeCache(rec: CacheRecordV3) {
    this.cache = rec;
  }
  async clearCache() {
    this.cache = null;
  }
}

const manifestJws = (issuedAt = NOW): Promise<string> =>
  signJws(
    {
      schemaVersion: 1,
      aud: PRODUCT,
      iss: "key.plrs.im",
      issuedAt,
      expiresAt: issuedAt + 300,
      jwksUrl: `https://k.test/${PRODUCT}/.well-known/jwks.json`,
      cacheSeconds: 300,
      keys: [
        {
          kid: KID,
          alg: "EdDSA",
          kty: "OKP",
          crv: "Ed25519",
          publicKey: PUB,
          status: "active",
        },
      ],
    } satisfies TrustManifestDoc,
    PEM,
    KID,
    "pkey-trust+jws",
  );

const licenseJws = (over: Partial<LicenseDoc> = {}): Promise<string> =>
  signJws(
    {
      iss: "key.plrs.im",
      aud: PRODUCT,
      deviceId: DEVICE,
      issuedAt: NOW,
      expiresAt: NOW + 3600,
      graceUntil: NOW + 90 * 86_400,
      licenseId: "lic-local",
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
      },
      ...over,
    } satisfies LicenseDoc,
    PEM,
    KID,
    "pkey-license+jws",
  );

const configJws = (over: Partial<ConfigDoc> = {}): Promise<string> =>
  signJws(
    {
      iss: "key.plrs.im",
      aud: PRODUCT,
      deviceId: DEVICE,
      issuedAt: NOW,
      expiresAt: NOW + 3600,
      graceUntil: NOW + 90 * 86_400,
      schemaVersion: 9,
      config: {
        "run.mode": { state: "enforced", value: "offline", updatedAt: NOW },
      },
      secrets: {
        "proxy.url": { state: "hidden", value: "https://p/1", updatedAt: NOW },
      },
      ...over,
    } satisfies ConfigDoc,
    PEM,
    KID,
    "pkey-config+jws",
  );

/** A store that already holds a verified, signed install: manifest + both documents. */
async function provisionedStore(withToken = true): Promise<FakeStore> {
  const store = new FakeStore();
  if (withToken) store.token = TOKEN;
  store.cache = {
    v: CACHE_VERSION,
    trustJws: await manifestJws(),
    docs: { license: await licenseJws(), config: await configJws() },
  };
  return store;
}

const localOpts = (store: Store) => ({
  productSlug: PRODUCT,
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: PINNED },
  store,
});

/** Mint an offline bundle for this device with the corpus product key. */
async function mintBundle(
  over: Partial<BundleDoc> = {},
  docs?: BundleDoc["docs"],
): Promise<string> {
  return signJws(
    {
      bundleId: "01JBUNDLELOCALPROFILE000",
      aud: PRODUCT,
      deviceId: DEVICE,
      issuedAt: NOW,
      expiresAt: NOW + 30 * 86_400,
      docs: docs ?? { license: await licenseJws(), config: await configJws() },
      trust: await manifestJws(),
      ...over,
    } satisfies BundleDoc,
    PEM,
    KID,
    "pkey-bundle+jws",
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════

describe("createLocalClient — everything offline still works", () => {
  it("gates, resolves config and reports sync state over a pre-seeded signed cache", async () => {
    // There is no `fetchImpl` in `LocalOptions` at all, so "zero network" is not an assertion
    // about call counts here — it is a property of the type. Nothing below could dial if it
    // wanted to.
    const store = await provisionedStore();
    const client = await createLocalClient(localOpts(store));

    expect(client.status().status).toBe("ok");
    expect(client.isLicensed()).toBe(true);
    expect(client.license.isEntitled("polarisVpn")).toBe(true);
    expect(client.license.getLicenseId()).toBe("lic-local");
    expect(client.config.getConfig("run.mode", "??")).toBe("offline");
    expect(client.config.getSecret("proxy.url")).toBe("https://p/1");
    expect(client.config.schemaVersion()).toBe(9);

    const state = client.getSyncState();
    expect(state.activation).toBe("token");
    expect(state.doc?.licenseId).toBe("lic-local");
    expect(state.blocked).toBeNull();
    expect(state.lastSyncUnauthorized).toBe(false);
    // §4.2 — the floor is recomputed from the re-verified artifacts at load, offline included.
    expect(state.highWaterMark).toBe(NOW);
  });

  it("`LocalOptions` omits `fetchImpl` and `refreshIntervalSeconds` by construction", () => {
    // A transportless client that accepted a transport would be a contradiction, and a local
    // profile that accepted a poll interval would be advertising a timer it refuses to run.
    // Both are removed from the TYPE, which is what makes this a compile-time guarantee; the
    // `@ts-expect-error`s fail the typecheck if either ever comes back.
    const store = new FakeStore();
    const base = localOpts(store);
    // @ts-expect-error `fetchImpl` is not part of LocalOptions.
    void (() => createLocalClient({ ...base, fetchImpl: fetch }));
    // @ts-expect-error `refreshIntervalSeconds` is not part of LocalOptions.
    void (() => createLocalClient({ ...base, refreshIntervalSeconds: 60 }));
    expect(true).toBe(true);
  });
});

describe("createLocalClient — the refusal is at the DIAL (§4/§5)", () => {
  it("sync() rejects with PolarisError `local-only`", async () => {
    const store = await provisionedStore();
    const client = await createLocalClient(localOpts(store));
    // The trust refresh swallows its own failure by design, so the refusal that escapes is the
    // DOCUMENT fetch's — thrown by `fetcher()` before a URL exists.
    await expect(client.sync()).rejects.toBeInstanceOf(PolarisError);
    await expect(client.sync()).rejects.toMatchObject({ code: "local-only" });
  });

  it("sync() without a credential is an ordinary no-op — there was nothing to fetch", async () => {
    // §5's first rule fires before the transport is ever consulted, so an unactivated local
    // client returns idle rather than a refusal. The distinction matters: a host polling on a
    // timer must not see errors simply for being unactivated.
    const store = await provisionedStore(false);
    const client = await createLocalClient(localOpts(store));
    await expect(client.sync()).resolves.toEqual({
      applied: false,
      documents: {},
    });
  });

  it("devices.list/rename/deauthorize reject with `local-only` once a token is held", async () => {
    const store = await provisionedStore();
    const client = await createLocalClient(localOpts(store));
    for (const call of [
      () => client.devices.list(),
      () => client.devices.rename(DEVICE, "Studio"),
      () => client.devices.deauthorize("someone-else"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "local-only" });
    }
  });

  it("release.changelog() refuses with `service-unavailable` FIRST — the D-21 gate precedes the dial", async () => {
    // Release is OFF in the suite default, so a client that has named no expectation never
    // gets as far as the transport. Naming it flips the answer to the local-only refusal,
    // which is what proves the capability check is the earlier of the two.
    const store = await provisionedStore();
    const unaware = await createLocalClient(localOpts(store));
    await expect(unaware.release.changelog()).rejects.toMatchObject({
      code: "service-unavailable",
    });

    const aware = await createLocalClient({
      ...localOpts(store),
      expectedServices: ["license", "config", "release"],
    });
    await expect(aware.release.changelog()).rejects.toMatchObject({
      code: "local-only",
    });
  });

  it("activate/enroll/register THROW the refusal rather than reporting it as a transport error", async () => {
    // These three DO have `{kind:"error", message}` in their result unions — but that variant
    // means "the network let us down", and a host renders it as "try again later". A local-only
    // refusal is not that: it is "this build was compiled never to dial", which retrying can
    // never fix. Collapsing the two would leave the code the host can actually act on carried
    // only in a message string. So `fetcher()` is called outside the try and the throw escapes.
    const store = await provisionedStore();
    // Fingerprinting off: these three collect one before dialling, and shelling out to the
    // platform probes would make a test about a REFUSAL depend on this host's hardware.
    const client = await createLocalClient({
      ...localOpts(store),
      devices: { fingerprint: false },
      license: { fingerprint: false },
    });

    await expect(client.license.activateWithKey("k")).rejects.toMatchObject({
      code: "local-only",
    });
    await expect(client.license.enroll()).rejects.toMatchObject({
      code: "local-only",
    });
    await expect(client.devices.register()).rejects.toMatchObject({
      code: "local-only",
    });
    // …and none of them minted anything: the stored credential is untouched.
    expect(await store.getToken()).toBe(TOKEN);
  });

  it("devices.report() answers false — telemetry may never fail a caller", async () => {
    const store = await provisionedStore();
    const client = await createLocalClient(localOpts(store));
    await expect(client.devices.report()).resolves.toBe(false);
  });

  it("discover() refuses instead of falling through to the GLOBAL fetch", async () => {
    // The sharpest edge in this whole profile. `discoverProduct` falls back to the module-global
    // `fetch` when it is given no `fetchImpl`, so a `discover()` that passed `undefined` for a
    // local-only client would open a real socket to the control plane — the one thing this entry
    // point exists to make impossible. `PolarisKeyClient.discover` therefore calls `fetcher()`
    // EAGERLY and lets the refusal propagate. The global is intercepted here so that a
    // regression shows up as "global fetch reached" rather than as a silent DNS lookup.
    const store = await provisionedStore();
    const client = await createLocalClient(localOpts(store));
    const original = globalThis.fetch;
    const global = vi.fn(async () => {
      throw new Error("global fetch reached");
    });
    globalThis.fetch = global as unknown as typeof fetch;
    try {
      await expect(client.discover()).rejects.toMatchObject({
        code: "local-only",
      });
      expect(global).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("createLocalClient — deactivate() still works", () => {
  it("wipes the credential and the cache even though the network leg refused", async () => {
    // The `POST /license/deauthorize` leg is best-effort and swallows the local-only refusal
    // exactly as it swallows being on a plane. The LOCAL wipe is what the caller depends on.
    const store = await provisionedStore();
    const client = await createLocalClient(localOpts(store));
    expect(client.status().status).toBe("ok");

    await expect(client.license.deactivate()).resolves.toBeUndefined();

    expect(await store.getToken()).toBeNull();
    expect(await store.readCache()).toBeNull();
    expect(client.status().status).toBe("needs-activation");
    expect(client.getSyncState().activation).toBeNull();
    // The §4.2 floor goes with its sources — a floor without them is a bare counter.
    expect(client.getSyncState().highWaterMark).toBe(0);
  });
});

describe("createBundleClient — provision from a bundle in one step (§7, D-12)", () => {
  it("returns a client already gated `ok` and the import result together", async () => {
    const store = new FakeStore();
    const { client, imported } = await createBundleClient({
      ...localOpts(store),
      bundle: await mintBundle(),
      now: NOW,
    });

    expect(imported).toEqual({
      bundleId: "01JBUNDLELOCALPROFILE000",
      imported: ["license", "config"],
    });
    expect(client.status().status).toBe("ok");
    expect(client.isLicensed()).toBe(true);
    expect(client.getSyncState().activation).toBe("bundle");
    expect(client.config.getConfig("run.mode", "??")).toBe("offline");
    // §7 — no credential is minted for a bundle-activated install.
    expect(await store.getToken()).toBeNull();
  });

  it("a config-only bundle provisions settings and grants nothing (D-08)", async () => {
    const store = new FakeStore();
    const { client, imported } = await createBundleClient({
      ...localOpts(store),
      bundle: await mintBundle({}, { config: await configJws() }),
      now: NOW,
    });
    expect(imported.imported).toEqual(["config"]);
    expect(client.getSyncState().activation).toBeNull();
    expect(client.status().status).toBe("needs-activation");
    expect(client.config.getConfig("run.mode", "??")).toBe("offline");
  });

  it("a refused bundle throws the §7 step code and leaves the store untouched", async () => {
    const store = new FakeStore();
    // Minted for another machine — step 2, the classic operator error the request-code flow
    // exists to catch.
    const foreign = await mintBundle({ deviceId: "dev_not_this_machine" });
    await expect(
      createBundleClient({ ...localOpts(store), bundle: foreign, now: NOW }),
    ).rejects.toMatchObject({
      name: "PolarisError",
      code: "bundle-claims-rejected",
    });
    expect(await store.readCache()).toBeNull();
    expect(await store.getToken()).toBeNull();
  });

  it("a bundle whose import window has closed is refused with nothing written", async () => {
    const store = new FakeStore();
    const bundle = await mintBundle({
      issuedAt: NOW - 40 * 86_400,
      expiresAt: NOW - 10 * 86_400,
    });
    await expect(
      createBundleClient({ ...localOpts(store), bundle, now: NOW }),
    ).rejects.toMatchObject({ code: "bundle-claims-rejected" });
    expect(await store.readCache()).toBeNull();
  });
});

describe("createLocalClient — no timer is ever armed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms nothing at construction, survives a long clock advance, and close() is a no-op", async () => {
    // `refreshIntervalSeconds` is not in `LocalOptions`, so there is no interval to pass — but
    // `startTimer()` ALSO short-circuits on `localOnly`, which is the belt to that braces: a
    // transportless build must not wake the process up to make a request it would refuse.
    const store = await provisionedStore();
    const client = await createLocalClient(localOpts(store));

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(vi.getTimerCount()).toBe(0);
    // Idempotent, and safe on a client that never started one.
    expect(client.close()).toBeUndefined();
    expect(client.close()).toBeUndefined();
    // Read at the clock the fixture was minted against, the gate is exactly where it was:
    // nothing ran in the background to change it.
    expect(client.status(NOW).status).toBe("ok");
    // Read at the ADVANCED clock it has slid into grace — which is the signed document's own
    // window elapsing, not a refresh that fired. An offline client degrades on its own.
    expect(client.status().status).toBe("grace");
  });
});
