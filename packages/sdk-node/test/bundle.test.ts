// @pkey-feature core.bundle
// Offline bundle import THROUGH THE SDK — WIRE-CONTRACT-V4 §7, step 5.
//
// Steps 1–4 belong to `@polaris-key/client-core`'s `inspectBundle` and are pinned there (and by the
// conformance runner). What this suite pins is the half that only a HOST can have: the cache.
// `conformance/corpus/v2`'s nine `bundleCases` are driven through `client.importBundle` here
// rather than through the verifier, because the questions worth asking at this layer are not
// "did it verify" but:
//
//   * did a PASSING vector leave a v3 record with exactly the slices it claimed — and NO
//     credential, since a bundle-activated install has none and never talks to the server (§7);
//   * did a REFUSING vector leave the disk byte-for-byte as it found it — tested from an empty
//     cache AND from a populated one, because "all-or-nothing" is only interesting when there
//     was something to clobber;
//   * does the imported install reach the gate with ZERO network, survive a restart through the
//     ordinary reload path, and raise the §4.2 clock floor from what it imported.
//
// Two things this file deliberately does NOT re-test: the step attribution itself (the corpus
// owns that; here it is only asserted as the `PolarisError.code` the SDK re-raises) and the
// verifier's internal ordering.
//
// Every client here is built over a tiny fake `Store` so the DEVICE ID can be pinned to the
// vector's — a bundle is device-bound, and `InMemoryStore` derives a real machine id.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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
import { PolarisKeyClient } from "../src/client.js";
import { CACHE_VERSION } from "../src/core/store.js";

// ── The corpus ────────────────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));

interface BundleCase {
  id: string;
  description: string;
  pinned: Record<string, string>;
  pinRevocations?: Record<string, string>;
  expectedAud: string;
  deviceId: string;
  now: number;
  floors?: { license: number | null; config: number | null };
  profile?: "import" | "reload";
  bundleJws: string;
  expect:
    | { imports: true; docs: ("license" | "config")[] }
    | { imports: false; reason: string };
}

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
) as { keys: CorpusKey[]; bundleCases: BundleCase[] };

const CASES = corpus.bundleCases;
const caseFor = (id: string): BundleCase => {
  const found = CASES.find((c) => c.id === id);
  if (!found) throw new Error(`corpus is missing bundle case ${id}`);
  return found;
};

/** The corpus's product signing key — the same one every `bundleCases` vector is pinned to, so
 *  bundles minted locally in this file and vectors minted by the generator share a trust set. */
const KID = "pkey-test-prod-2026";
const KEY = corpus.keys.find((k) => k.kid === KID);
if (!KEY) throw new Error(`corpus is missing key ${KID}`);
const PEM = KEY.privateKeyPkcs8Pem;
const PUB = KEY.publicKeyRaw;

const FULL = caseFor("bundle-valid-full");
const PRODUCT = FULL.expectedAud;
const DEVICE = FULL.deviceId;
const PINNED = FULL.pinned;
/** The vectors are dated 2023. Every gate read below is evaluated at the vector's OWN clock —
 *  reading them at the wall clock would only ever say `expired`. */
const NOW = FULL.now;
const MINTED = 1_700_000_000;

const decode = <T>(jws: string): T =>
  JSON.parse(
    Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as T;

// ── Test doubles ──────────────────────────────────────────────────────────────────────────

/** The `Store` contract, in memory, with the device id under the test's control. */
class FakeStore implements Store {
  token: string | null = null;
  cache: CacheRecordV3 | null = null;

  constructor(private readonly id: string) {}
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

/** A transport that fails the test if it is ever reached. Importing a bundle is the air-gapped
 *  path; a single call here would mean the offline install phoned home. */
function explodingFetch() {
  return vi.fn(async () => {
    throw new Error("importBundle must never touch the network");
  }) as unknown as typeof fetch & { mock: { calls: unknown[] } };
}

function clientOver(
  store: Store,
  over: { pinned?: Record<string, string>; product?: string } = {},
  fetchImpl: typeof fetch = explodingFetch(),
): PolarisKeyClient {
  return new PolarisKeyClient({
    productSlug: over.product ?? PRODUCT,
    baseUrl: "https://k.test",
    version: "1.2.3",
    trust: { pinnedKeys: over.pinned ?? PINNED },
    store,
    fetchImpl,
  });
}

// ── Local minting, with the corpus key ────────────────────────────────────────────────────
// The generator has no reason to mint the shapes below (a config-only bundle; a bundle whose
// manifest is newer than its documents), so they are minted here against the same pinned key.

function manifest(over: Partial<TrustManifestDoc> = {}): TrustManifestDoc {
  return {
    schemaVersion: 1,
    aud: PRODUCT,
    iss: "key.plrs.im",
    issuedAt: MINTED,
    expiresAt: MINTED + 300,
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
    ...over,
  };
}

function licenseDoc(over: Partial<LicenseDoc> = {}): LicenseDoc {
  return {
    iss: "key.plrs.im",
    aud: PRODUCT,
    deviceId: DEVICE,
    issuedAt: MINTED,
    expiresAt: MINTED + 3600,
    graceUntil: MINTED + 90 * 86_400,
    licenseId: "lic-air-gapped",
    entitlements: {},
    ...over,
  };
}

function configDoc(over: Partial<ConfigDoc> = {}): ConfigDoc {
  return {
    iss: "key.plrs.im",
    aud: PRODUCT,
    deviceId: DEVICE,
    issuedAt: MINTED,
    expiresAt: MINTED + 3600,
    graceUntil: MINTED + 90 * 86_400,
    schemaVersion: 4,
    config: {
      "run.mode": { state: "enforced", value: "air-gapped", updatedAt: MINTED },
    },
    secrets: {},
    ...over,
  };
}

async function mint(
  docs: BundleDoc["docs"],
  over: Partial<BundleDoc> = {},
): Promise<string> {
  const payload: BundleDoc = {
    bundleId: "01JBUNDLELOCAL0000000000",
    aud: PRODUCT,
    deviceId: DEVICE,
    issuedAt: MINTED,
    expiresAt: MINTED + 30 * 86_400,
    docs,
    trust: await signJws(manifest(), PEM, KID, "pkey-trust+jws"),
    ...over,
  };
  return signJws(payload, PEM, KID, "pkey-bundle+jws");
}

/** A config-only bundle — `bundle-valid-license-only`'s sibling (D-08: a config-only product
 *  air-gaps with settings and no grant). */
const configOnlyBundle = async (): Promise<string> =>
  mint(
    { config: await signJws(configDoc(), PEM, KID, "pkey-config+jws") },
    { bundleId: "01JBUNDLECONFIGONLY00000" },
  );

// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The cache a vector presupposes, built the way a real install would hold it: the evidence it
 * names (`pinRevocations`), and for each non-null floor a verified document of that type issued
 * at exactly the floor (signed with the corpus key, bound to the vector's device).
 */
async function seedFor(c: BundleCase): Promise<CacheRecordV3 | null> {
  const rec: CacheRecordV3 = { v: CACHE_VERSION };
  if (c.pinRevocations) rec.pinRevocations = { ...c.pinRevocations };
  const docs: NonNullable<CacheRecordV3["docs"]> = {};
  const at = (t: number) => ({
    deviceId: c.deviceId,
    issuedAt: t,
    expiresAt: t + 3600,
    graceUntil: t + 30 * 86_400,
  });
  if (c.floors?.license != null)
    docs.license = await signJws(
      licenseDoc(at(c.floors.license)),
      PEM,
      KID,
      "pkey-license+jws",
    );
  if (c.floors?.config != null)
    docs.config = await signJws(
      configDoc(at(c.floors.config)),
      PEM,
      KID,
      "pkey-config+jws",
    );
  if (Object.keys(docs).length > 0) rec.docs = docs;
  return Object.keys(rec).length > 1 ? rec : null;
}

describe("importBundle — the corpus vectors, driven through the SDK", () => {
  // The reload-profile vectors are not imports: they are the cached bundle at start (below).
  const IMPORTS = CASES.filter((v) => v.profile !== "reload");
  for (const c of IMPORTS.filter((v) => v.expect.imports)) {
    it(`${c.id} imports exactly its documents and mints NO credential`, async () => {
      const expected = c.expect as {
        imports: true;
        docs: ("license" | "config")[];
      };
      const store = new FakeStore(c.deviceId);
      store.cache = await seedFor(c);
      const client = clientOver(store, {
        pinned: c.pinned,
        product: c.expectedAud,
      });
      await client.init();

      const result = await client.importBundle(c.bundleJws, c.now);
      expect(result.imported).toEqual(expected.docs);
      expect(result.bundleId).toBe(decode<BundleDoc>(c.bundleJws).bundleId);

      // §7 step 5 — the atomic write: cache v3, the manifest artifact, the signed bundle.
      const record = await store.readCache();
      expect(record?.v).toBe(CACHE_VERSION);
      expect(record?.trustJws).toBe(decode<BundleDoc>(c.bundleJws).trust);
      expect(record?.bundle).toBe(c.bundleJws);
      expect(record).not.toHaveProperty("importedBundle");
      // EXACTLY the expected slices — an implementation that wrote an empty `config` key would
      // pass a `toMatchObject` and fail here.
      expect(Object.keys(record?.docs ?? {}).sort()).toEqual(
        [...expected.docs].sort(),
      );
      for (const slice of expected.docs) {
        expect(record?.docs?.[slice]?.split(".")).toHaveLength(3);
      }
      // §7 — "No token is created." A bundle-activated install has no credential at all.
      expect(await store.getToken()).toBeNull();
    });
  }

  for (const c of IMPORTS.filter((v) => !v.expect.imports)) {
    const reason = (c.expect as { imports: false; reason: string }).reason;

    it(`${c.id} throws ${reason} and writes NOTHING to the cache it presupposes`, async () => {
      const store = new FakeStore(c.deviceId);
      const seeded = await seedFor(c);
      store.cache = structuredClone(seeded);
      const client = clientOver(store, {
        pinned: c.pinned,
        product: c.expectedAud,
      });
      await client.init();

      // The §7 step is re-raised as the error CODE, not collapsed to "invalid bundle": the
      // step is the operator's remedy, and the air-gapped path must not be the least
      // diagnosable one.
      await expect(
        client.importBundle(c.bundleJws, c.now),
      ).rejects.toBeInstanceOf(PolarisError);
      await expect(
        client.importBundle(c.bundleJws, c.now),
      ).rejects.toMatchObject({ code: reason });
      expect(await store.readCache()).toEqual(seeded);
      expect(await store.getToken()).toBeNull();
    });

    if (c.floors || c.pinRevocations) continue;
    it(`${c.id} leaves a POPULATED cache untouched — all-or-nothing does not clobber`, async () => {
      // The interesting half of all-or-nothing: a device that is already provisioned must not
      // lose what it has because someone handed it a bad `.pkeybundle`.
      const store = new FakeStore(c.deviceId);
      const incumbent: CacheRecordV3 = {
        v: CACHE_VERSION,
        trustJws: await signJws(manifest(), PEM, KID, "pkey-trust+jws"),
        docs: {
          license: await signJws(
            licenseDoc({ licenseId: "lic-incumbent", deviceId: c.deviceId }),
            PEM,
            KID,
            "pkey-license+jws",
          ),
        },
        etags: { license: '"L-incumbent"' },
      };
      store.cache = structuredClone(incumbent);

      const client = clientOver(store, {
        pinned: c.pinned,
        product: c.expectedAud,
      });
      await client.init();
      // The incumbent really is live state, not inert bytes — otherwise "untouched" proves
      // nothing.
      expect(client.getSyncState().doc?.licenseId).toBe("lic-incumbent");

      await expect(
        client.importBundle(c.bundleJws, c.now),
      ).rejects.toMatchObject({ code: reason });
      expect(await store.readCache()).toEqual(incumbent);
      expect(client.getSyncState().doc?.licenseId).toBe("lic-incumbent");
    });
  }
});

describe("the cached bundle at start — the reload-profile vectors (§7)", () => {
  for (const c of CASES.filter((v) => v.profile === "reload")) {
    const activates = c.expect.imports && c.expect.docs.includes("license");
    it(`${c.id} → activation ${activates ? "bundle" : "null"}`, async () => {
      // The record an import would have written, read back by a new process.
      const payload = decode<BundleDoc>(c.bundleJws);
      const store = new FakeStore(c.deviceId);
      store.cache = {
        v: CACHE_VERSION,
        trustJws: payload.trust,
        docs: { ...payload.docs },
        bundle: c.bundleJws,
      };
      const client = clientOver(store, {
        pinned: c.pinned,
        product: c.expectedAud,
      });
      await client.init();
      expect(client.license.activation()).toBe(activates ? "bundle" : null);
    });
  }
});

describe("the cached bundle — a signed fact, not a marker (§4.1)", () => {
  async function imported() {
    const store = new FakeStore(DEVICE);
    const client = clientOver(store);
    await client.init();
    await client.importBundle(FULL.bundleJws, NOW);
    expect(client.license.activation()).toBe("bundle");
    return store;
  }

  it("the retired `importedBundle` marker activates nothing", async () => {
    const store = await imported();
    const { bundle: _dropped, ...rest } = (await store.readCache())!;
    store.cache = {
      ...rest,
      importedBundle: {
        bundleId: "01JBUNDLE0000000000000001",
        importedAt: NOW,
      },
    } as CacheRecordV3;
    const client = clientOver(store);
    await client.init();
    expect(client.license.activation()).toBeNull();
    expect(client.license.status(NOW).status).toBe("needs-activation");
  });

  it("a bundle whose license is not the cached one, byte for byte, activates nothing", async () => {
    const store = await imported();
    const other = await signJws(
      licenseDoc({ licenseId: "lic-swapped" }),
      PEM,
      KID,
      "pkey-license+jws",
    );
    store.cache = {
      ...(await store.readCache())!,
      docs: { license: other },
    };
    const client = clientOver(store);
    await client.init();
    expect(client.getSyncState().doc?.licenseId).toBe("lic-swapped");
    expect(client.license.activation()).toBeNull();
  });

  it("a tampered cached bundle activates nothing", async () => {
    const store = await imported();
    const [h, p, sig] = FULL.bundleJws.split(".") as [string, string, string];
    store.cache = {
      ...(await store.readCache())!,
      bundle: `${h}.${p}.${sig.slice(0, -2)}AA`,
    };
    const client = clientOver(store);
    await client.init();
    expect(client.license.activation()).toBeNull();
  });

  it("a byte-identical re-import succeeds without a write", async () => {
    const store = await imported();
    const before = structuredClone(await store.readCache());
    const writes = vi.spyOn(store, "writeCache");
    const client = clientOver(store);
    await client.init();
    const again = await client.importBundle(FULL.bundleJws, NOW + 400 * 86_400);
    expect(again.imported).toEqual(["license", "config"]);
    expect(writes).not.toHaveBeenCalled();
    expect(await store.readCache()).toEqual(before);
  });

  it("a byte-identical re-import of a config-only bundle succeeds without a write", async () => {
    const store = new FakeStore(DEVICE);
    const client = clientOver(store);
    await client.init();
    const jws = await configOnlyBundle();
    await client.importBundle(jws, NOW);
    const writes = vi.spyOn(store, "writeCache");
    const again = clientOver(store);
    await again.init();
    await expect(again.importBundle(jws, NOW)).resolves.toEqual({
      bundleId: "01JBUNDLECONFIGONLY00000",
      imported: ["config"],
    });
    expect(writes).not.toHaveBeenCalled();
    expect(again.license.activation()).toBeNull();
  });

  it("the held trust manifest wins when it is newer than the bundle's (§7 step 5)", async () => {
    const store = new FakeStore(DEVICE);
    const newer = await signJws(
      manifest({ issuedAt: MINTED + 9_000, expiresAt: MINTED + 9_300 }),
      PEM,
      KID,
      "pkey-trust+jws",
    );
    store.cache = { v: CACHE_VERSION, trustJws: newer };
    const client = clientOver(store);
    await client.init();
    await client.importBundle(
      await mint({
        license: await signJws(licenseDoc(), PEM, KID, "pkey-license+jws"),
      }),
      NOW,
    );
    expect((await store.readCache())?.trustJws).toBe(newer);
    expect(client.license.activation()).toBe("bundle");
  });
});

describe("importBundle — the imported install is gated, offline", () => {
  it('bundle-valid-full reaches gate `ok` with `activation: "bundle"` and zero fetches', async () => {
    const store = new FakeStore(DEVICE);
    const net = explodingFetch();
    const client = clientOver(store, {}, net);
    await client.init();

    await client.importBundle(FULL.bundleJws, NOW);

    // §5 — `activation: "bundle"` is what the gate reads instead of a credential.
    expect(client.license.status(NOW).status).toBe("ok");
    expect(client.license.isLicensed(NOW)).toBe(true);
    expect(client.getSyncState().activation).toBe("bundle");
    // …and the whole thing happened without a socket. The bundle path is the offline path.
    expect(net.mock.calls).toHaveLength(0);
  });

  it("exposes the imported document's entitlements and settings without a sync", async () => {
    const store = new FakeStore(DEVICE);
    const client = clientOver(store);
    await client.init();
    await client.importBundle(FULL.bundleJws, NOW);

    expect(client.license.isEntitled("polarisVpn", NOW)).toBe(true);
    expect(client.license.getLicenseId()).toBe(
      decode<LicenseDoc>(decode<BundleDoc>(FULL.bundleJws).docs.license!)
        .licenseId,
    );
    expect(client.config.getConfig("run.concurrency", 0)).toBe(4);
    expect(client.config.getSecret("proxy.subscriptionUrl")).toBe(
      "https://vpn.example.com/sub/abc",
    );
  });
});

describe("importBundle — a config-only bundle grants nothing (D-08, §7)", () => {
  it("imports settings, leaves `activation` null and the gate on needs-activation", async () => {
    const store = new FakeStore(DEVICE);
    const client = clientOver(store);
    await client.init();

    const result = await client.importBundle(await configOnlyBundle(), NOW);
    expect(result.imported).toEqual(["config"]);

    // §7: "`activation: \"bundle\"` arises only from a bundle whose license document verified."
    // A cached bundle without a license document is NOT activation.
    expect(client.license.activation()).toBeNull();
    expect(client.getSyncState().activation).toBeNull();
    expect(client.license.status(NOW).status).toBe("needs-activation");
    expect(client.license.isLicensed(NOW)).toBe(false);
    // …while the settings it carried are live.
    expect(client.config.getConfig("run.mode", "??")).toBe("air-gapped");
    expect(decode<BundleDoc>((await store.readCache())!.bundle!).bundleId).toBe(
      "01JBUNDLECONFIGONLY00000",
    );
  });
});

describe("importBundle — a token supersedes a bundle (§7)", () => {
  it('reports `activation: "token"` when a credential is held alongside an import', async () => {
    const store = new FakeStore(DEVICE);
    const client = clientOver(store);
    await client.init();
    await client.importBundle(FULL.bundleJws, NOW);
    expect(client.getSyncState().activation).toBe("bundle");

    // The device later activates online. §7: "the token path supersedes."
    store.token = `pkeyt_${"B".repeat(43)}`;
    const online = clientOver(store);
    await online.init();
    expect(online.getSyncState().activation).toBe("token");
    // The bundle is still on disk — superseded, not erased.
    expect((await store.readCache())?.bundle).toBe(FULL.bundleJws);
  });
});

describe("importBundle — restart equivalence (§4.1)", () => {
  it("a second client over the same store reaches an identical gate state", async () => {
    // `importBundle` re-runs the ordinary load path over what it just wrote precisely so this
    // holds. If it trusted its in-memory objects instead, the first process would be gated and
    // the next launch would not.
    const store = new FakeStore(DEVICE);
    const first = clientOver(store);
    await first.init();
    await first.importBundle(FULL.bundleJws, NOW);

    const restarted = clientOver(store);
    await restarted.init();

    expect(restarted.license.status(NOW)).toEqual(first.license.status(NOW));
    expect(restarted.getSyncState()).toEqual(first.getSyncState());
    expect(restarted.config.getConfig("run.concurrency", 0)).toBe(
      first.config.getConfig("run.concurrency", 0),
    );
  });
});

describe("importBundle — the write REPLACES, it does not merge (§7 step 5)", () => {
  it("drops a stale license slice and invents no ETags for a config-only re-import", async () => {
    const store = new FakeStore(DEVICE);
    store.cache = {
      v: CACHE_VERSION,
      trustJws: await signJws(manifest(), PEM, KID, "pkey-trust+jws"),
      docs: {
        license: await signJws(
          licenseDoc({ licenseId: "lic-superseded" }),
          PEM,
          KID,
          "pkey-license+jws",
        ),
      },
      etags: { license: '"L1"', config: '"C1"' },
    };
    const client = clientOver(store);
    await client.init();
    expect(client.getSyncState().doc?.licenseId).toBe("lic-superseded");

    await client.importBundle(await configOnlyBundle(), NOW);

    const record = await store.readCache();
    // A re-import is a RE-PROVISIONING. A license the operator deliberately replaced must not
    // survive it, so the record is written wholesale rather than patched.
    expect(record?.docs).toEqual({ config: expect.any(String) });
    expect(record?.docs?.license).toBeUndefined();
    expect(client.getSyncState().doc).toBeNull();
    expect(client.license.status(NOW).status).toBe("needs-activation");
    // These documents did not arrive from a conditional GET. Carrying the old validators
    // forward would make the next online sync send an `If-None-Match` the server never issued.
    expect(record?.etags).toBeUndefined();
  });
});

describe("importBundle — the §4.2 clock floor rises from what was imported", () => {
  it("takes max(issuedAt) over the imported documents and the inner trust manifest", async () => {
    const store = new FakeStore(DEVICE);
    const client = clientOver(store);
    await client.init();
    expect(client.getSyncState().highWaterMark).toBe(0);

    await client.importBundle(FULL.bundleJws, NOW);

    const payload = decode<BundleDoc>(FULL.bundleJws);
    const sources = [
      decode<LicenseDoc>(payload.docs.license!).issuedAt,
      decode<ConfigDoc>(payload.docs.config!).issuedAt,
      decode<TrustManifestDoc>(payload.trust).issuedAt,
    ];
    expect(client.getSyncState().highWaterMark).toBe(Math.max(...sources));
  });

  it("counts the MANIFEST as a floor source, not just the documents (R4-04)", async () => {
    // Derived from a license alone the floor is provably inert — `issuedAt < graceUntil`
    // always holds, so it can never reach the end of grace. The manifest is what makes it
    // bite, so a bundle whose manifest is newer than its documents must lift the floor to the
    // manifest's own `issuedAt`.
    const store = new FakeStore(DEVICE);
    const client = clientOver(store);
    await client.init();

    const later = MINTED + 5_000;
    const jws = await mint(
      { license: await signJws(licenseDoc(), PEM, KID, "pkey-license+jws") },
      {
        trust: await signJws(
          manifest({ issuedAt: later, expiresAt: later + 300 }),
          PEM,
          KID,
          "pkey-trust+jws",
        ),
      },
    );
    await client.importBundle(jws, NOW);

    expect(licenseDoc().issuedAt).toBeLessThan(later);
    expect(client.getSyncState().highWaterMark).toBe(later);
    // …and the floor is what the gate evaluates at, so winding the clock back is inert. The
    // manifest is dated PAST the license's `expiresAt` (MINTED + 3600 < MINTED + 5000), so the
    // honest answer at a wound-back clock is `grace` — the state the floor forces — rather
    // than the `ok` the rolled-back clock alone would have produced.
    expect(licenseDoc().expiresAt).toBeLessThan(later);
    expect(client.license.status(MINTED - 100_000).status).toBe("grace");
  });
});
