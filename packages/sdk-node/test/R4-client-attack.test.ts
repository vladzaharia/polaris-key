// RED TEAM R4 — on-device / client-side abuse PoCs.
//
// These began life as ATTACK proofs asserting the CURRENT (vulnerable) behaviour. They have
// now been INVERTED: each one asserts that the attack FAILS, so it is the regression test for
// the fix named in its `// FIXED (…)` comment. Each documents a finding in
// docs/security/findings/R4-client.md.
//
// Threat model: the attacker is an ordinary local user with write access to the SDK's own
// config directory (`~/.config/<product>/`) but WITHOUT the ability to patch the shipped
// application binary. That models the realistic cases the product actually cares about:
// a curious licensee, a "crack" script distributed as a JSON file, a low-privilege process
// or a compromised transitive dependency, and a cloud-synced/backed-up home directory.
//
// ── WHAT THE P4 RE-SHAPE CHANGED ────────────────────────────────────────────────────────────
//
// Nothing about the answers. The client is now Core + sub-clients, so the PoCs drive
// `PolarisClient.sync()` rather than `PolarisKeyClient.refresh()`; the record on disk is cache
// v3 with per-service slices; and the fused document is split in two. The last of those adds a
// NEW attack surface — a valid artifact of the WRONG type planted in the wrong slice — which
// gets its own test at the bottom, alongside cache-v2-is-discarded and the §7 bundle's
// all-or-nothing write.
//
// Section references are WIRE-CONTRACT-V3: §1 trust, §3 claims, §4.1 cache, §4.2 clock floor,
// §5 ETag/gate, §7 bundles.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { signJws, type TrustSet } from "@plrs/jws";
import type { ManagedEntry } from "@plrs/protocol/core";
import type { ConfigDoc } from "@plrs/protocol/config";
import type { LicenseDoc } from "@plrs/protocol/license";
import type { CacheRecordV3 } from "@plrs/client-core";
import { PolarisClient } from "../src/client.js";
import { InsecureBaseUrlError } from "../src/core/context.js";
import { CACHE_VERSION, FileStore } from "../src/core/store.js";

// ── The product's real, pinned signing key (the one a shipped app would embed) ──────────
const VENDOR_KID = "pkey-test-prod-2026";
const VENDOR_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const VENDOR_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const PRODUCT = "djdl";
const HOUR = 3600;
const DAY = 86_400;
const DEVICE = "device-under-attack";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), "r4-plrs-"));
  dirs.push(d);
  return d;
}

/** A freshly generated Ed25519 keypair the ATTACKER controls. */
function attackerKeypair(): { pem: string; rawPubB64Url: string; kid: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = (privateKey as KeyObject).export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  // JWK `x` for an OKP key IS the raw 32-byte public key, base64url-encoded — exactly the
  // format a Polaris trust set stores.
  const jwk = (publicKey as KeyObject).export({ format: "jwk" }) as {
    x: string;
  };
  return { pem, rawPubB64Url: jwk.x, kid: "attacker-kid-1" };
}

const entry = (value: ManagedEntry["value"], at = 0): ManagedEntry => ({
  state: "enforced",
  value,
  updatedAt: at,
});

/** The v3 GRANT half. Entitlements are the ONLY carrier of grant data (D-20). */
function makeLicenseDoc(over: Partial<LicenseDoc> = {}): LicenseDoc {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "plrs.im",
    aud: PRODUCT,
    deviceId: DEVICE,
    issuedAt: now,
    expiresAt: now + HOUR,
    graceUntil: now + 30 * DAY,
    licenseId: "lic_free_tier",
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: now,
    },
    entitlements: { pro: entry(false, now) },
    ...over,
  };
}

/** The v3 SETTINGS half. No licence fields at all (§2.2, D-08). */
function makeConfigDoc(over: Partial<ConfigDoc> = {}): ConfigDoc {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "plrs.im",
    aud: PRODUCT,
    deviceId: DEVICE,
    issuedAt: now,
    expiresAt: now + HOUR,
    graceUntil: now + 30 * DAY,
    schemaVersion: 1,
    config: {},
    secrets: {},
    ...over,
  };
}

/** Plant a raw `managed.json` + `token` + `device` on disk, exactly as `FileStore` would. */
function plantCache(
  configDir: string,
  record: unknown,
  deviceId: string = DEVICE,
): void {
  const store = new FileStore(PRODUCT, configDir); // creates <dir>/<product>/ 0700
  void store;
  const productDir = join(configDir, PRODUCT);
  writeFileSync(join(productDir, "managed.json"), JSON.stringify(record));
  writeFileSync(join(productDir, "token"), "plrst_anything_at_all");
  writeFileSync(join(productDir, "device"), deviceId);
}

function readCacheFile(configDir: string): CacheRecordV3 | null {
  try {
    return JSON.parse(
      readFileSync(join(configDir, PRODUCT, "managed.json"), "utf8"),
    ) as CacheRecordV3;
  } catch {
    return null;
  }
}

function clientOn(
  configDir: string,
  extra: Partial<ConstructorParameters<typeof PolarisClient>[0]> = {},
): PolarisClient {
  return new PolarisClient({
    productSlug: PRODUCT,
    baseUrl: "https://k.test",
    version: "1.2.3",
    trust: { pinnedKeys: { [VENDOR_KID]: VENDOR_PUB } as TrustSet },
    store: new FileStore(PRODUCT, configDir),
    trustRefresh: false,
    license: { fingerprint: false },
    devices: { fingerprint: false },
    ...extra,
  });
}

/** Serve one licence artifact on `/license/document`; everything else is inert. */
function serveLicense(jws: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/license/document"))
      return new Response(jws, { status: 200, headers: { etag: '"r4"' } });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-01 — The offline cache is not integrity-protected.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-01: unauthenticated offline cache", () => {
  // FIXED (R4-01 / R2-03) — §4.1. The cache persists the compact JWS and nothing else, and it
  // is re-verified against the PINNED keys on every load. A hand-written document has no
  // signature to re-check, so it never becomes a document; failure to verify is treated as
  // "no cache" and the client falls closed to `needs-activation`.
  it("grants arbitrary entitlements, secrets and a 300-year grace from a hand-written JSON file (no signature at all)", async () => {
    const configDir = tempConfigDir();
    // The attacker never sees a JWS, never touches a key, never runs a debugger. They write
    // ~40 lines of JSON — and in v3 they get to write TWO documents instead of one, which
    // changes nothing at all.
    const forged = {
      doc: makeLicenseDoc({
        licenseId: "lic_ENTERPRISE_UNLIMITED",
        expiresAt: 316_000_000_000, // year 12000
        graceUntil: 316_000_000_000,
        profile: {
          name: "Totally Legit",
          firstName: "Totally",
          email: "pirate@example.invalid",
          activatedAt: 0,
        },
        entitlements: {
          pro: entry(true),
          enterprise: entry(true),
          "stem-separation": entry(true),
        },
      }),
      config: makeConfigDoc({
        config: { "quality.floor": entry("lossless") },
        // Injected secret — this is the value the host app would hand to a third-party API.
        secrets: { "beatport.apiKey": entry("sk_attacker_controlled") },
      }),
      lastAcceptedIssuedAt: 0,
      lastVerifiedAt: Date.now(),
    };
    plantCache(configDir, forged);

    const client = clientOn(configDir);
    await client.init(); // re-verifies; there is nothing to verify.

    expect(client.status().status).toBe("needs-activation");
    expect(client.isLicensed()).toBe(false);
    expect(client.license.isEntitled("pro")).toBe(false);
    expect(client.license.isEntitled("enterprise")).toBe(false);
    expect(client.license.getEntitlements()).toEqual({});
    // No secret injection: the SDK's config-delivery channel now only carries values that
    // arrived inside a signature the pinned key produced.
    expect(client.config.getSecret("beatport.apiKey")).toBeNull();
    expect(client.config.getConfig("quality.floor", "mp3")).toBe("mp3");
    expect(client.license.getProfile()).toBeNull();
    // …and the bridge snapshot agrees, so a UI cannot be told a different story.
    expect(client.getSyncState()).toMatchObject({
      activation: "token",
      doc: null,
      highWaterMark: 0,
    });
    client.close();
  });

  // FIXED (R4-01) — §4.1. The reload path runs the SAME §3 claim set the network path does,
  // `aud` and `deviceId` included, so a genuinely-signed doc lifted from a colleague's machine
  // (or another product on the same control plane) is refused.
  it("accepts a doc bound to a DIFFERENT product and a DIFFERENT device (aud/deviceId are only checked on the network path)", async () => {
    const configDir = tempConfigDir();
    // Note this doc is REALLY signed by the vendor key — the only thing wrong with it is who
    // and what it is bound to.
    const foreign = await signJws(
      makeLicenseDoc({
        aud: "some-other-product",
        deviceId: "not-this-device",
      }),
      VENDOR_PEM,
      VENDOR_KID,
      "plrs-license+jws",
    );
    plantCache(configDir, {
      v: CACHE_VERSION,
      docs: { license: foreign },
    } satisfies CacheRecordV3);
    const client = clientOn(configDir);
    await client.init();
    expect(client.status().status).toBe("needs-activation");
    expect(client.getCurrentDevice().licenseId).toBeUndefined();
    client.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-02 — Cache-planted `trustedKeys` turn one file write into permanent signing authority.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-02: trust-set injection via the cache file", () => {
  // FIXED (R4-02 / R2-01) — §1. `trustedKeys` no longer exists: the cache is not a key source.
  // Keys can only be learned from a trust manifest that verifies against the PINNED set, so a
  // file write can neither add a kid nor swap the bytes behind one.
  it("makes the client verify and APPLY a doc signed by an attacker key served over the network", async () => {
    const configDir = tempConfigDir();
    const attacker = attackerKeypair();

    // Step 1 — plant only the trust key. No forged doc yet.
    plantCache(configDir, {
      doc: null,
      lastAcceptedIssuedAt: 0,
      trustedKeys: { [attacker.kid]: attacker.rawPubB64Url },
    });

    // Step 2 — the attacker serves a doc they signed themselves. (In the wild: an /etc/hosts
    // entry + a locally trusted CA, or NODE_EXTRA_CA_CERTS, or a plain `http://` baseUrl —
    // see R4-06. No vendor key is ever needed.)
    const evilJws = await signJws(
      makeLicenseDoc({
        licenseId: "lic_signed_by_attacker",
        entitlements: { pro: entry(true) },
      }),
      attacker.pem,
      attacker.kid,
      "plrs-license+jws",
    );

    const client = clientOn(configDir, { fetchImpl: serveLicense(evilJws) });
    await client.init();
    const r = await client.sync();

    expect(r.applied).toBe(false); // verification FAILED — `attacker-kid-1` is not trusted
    expect(client.license.isEntitled("pro")).toBe(false);
    expect(client.getCurrentDevice().licenseId).toBeUndefined();
    // The planted file is still sitting there untouched — and completely inert: no document
    // was ever accepted from it, and no v3 record was produced from its contents.
    const onDisk = readCacheFile(configDir);
    expect(onDisk?.docs?.license).toBeUndefined();
    expect(onDisk?.v).not.toBe(CACHE_VERSION);
    client.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-03 — `lastAcceptedIssuedAt` / `lastTrustIssuedAt` were attacker-writable anti-replay
//          counters. Poisoning them PINNED the forged state even while fully online.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-03: anti-replay counters are attacker-controlled in both directions", () => {
  // FIXED (R4-03) — §4.1. Both counters are gone from disk. The per-type replay floor is
  // derived from the `issuedAt` of the re-verified cached document, so writing a far-future
  // integer into the file no longer blocks a genuine revocation: the vendor's control plane
  // can land again.
  it("pins a forged doc forever: a genuine, correctly-signed server doc is rejected because lastAcceptedIssuedAt was set to the far future", async () => {
    const configDir = tempConfigDir();
    plantCache(configDir, {
      doc: makeLicenseDoc({
        licenseId: "lic_FORGED",
        expiresAt: 316_000_000_000,
        graceUntil: 316_000_000_000,
        entitlements: { pro: entry(true) },
      }),
      // Year 12000 — under v1 every real doc's issuedAt was smaller, so all of them were
      // rejected and revocation could never land on this device.
      lastAcceptedIssuedAt: 316_000_000_000,
    });

    const now = Math.floor(Date.now() / 1000);
    // The server does its job: it issues a REVOKED, entitlement-free doc, properly signed.
    const genuineRevocation = await signJws(
      makeLicenseDoc({
        licenseId: "lic_REVOKED",
        issuedAt: now,
        expiresAt: now + HOUR,
        graceUntil: now + HOUR,
        entitlements: { pro: entry(false, now) },
      }),
      VENDOR_PEM,
      VENDOR_KID,
      "plrs-license+jws",
    );

    const client = clientOn(configDir, {
      fetchImpl: serveLicense(genuineRevocation),
    });
    await client.init();
    const r = await client.sync();

    expect(r.applied).toBe(true); // the legitimate update LANDS
    expect(client.license.isEntitled("pro")).toBe(false); // …and revokes the entitlement
    expect(client.getCurrentDevice().licenseId).toBe("lic_REVOKED");
    client.close();
  });

  // FIXED (R4-03) — §4.1. `lastTrustIssuedAt` is likewise derived from the re-verified
  // manifest, so key rotation — the vendor's mechanism for retiring a compromised signing
  // key — can no longer be disabled by editing a JSON file.
  it("permanently disables trust-key rotation (the key-revocation mechanism) by poisoning lastTrustIssuedAt", async () => {
    const configDir = tempConfigDir();
    plantCache(configDir, {
      doc: null,
      lastAcceptedIssuedAt: 0,
      lastTrustIssuedAt: 316_000_000_000,
    });

    const now = Math.floor(Date.now() / 1000);
    const rotation = await signJws(
      {
        schemaVersion: 1,
        aud: PRODUCT,
        iss: "plrs.im",
        issuedAt: now,
        expiresAt: now + 300,
        jwksUrl: "https://k.test/djdl/.well-known/jwks.json",
        cacheSeconds: 300,
        keys: [
          {
            kid: "plrs-rotated-2027",
            kty: "OKP",
            crv: "Ed25519",
            alg: "EdDSA",
            publicKey: VENDOR_PUB,
            status: "active",
          },
        ],
      },
      VENDOR_PEM,
      VENDOR_KID,
      "plrs-trust+jws",
    );
    let trustFetches = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("polaris-trust.jws")) {
        trustFetches += 1;
        return new Response(rotation, { status: 200 });
      }
      if (u.pathname.endsWith("/document"))
        return new Response("", { status: 500 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = clientOn(configDir, { fetchImpl, trustRefresh: true });
    await client.init();
    await client.sync();

    expect(trustFetches).toBe(1); // the manifest WAS fetched and cryptographically valid
    const onDisk = readCacheFile(configDir);
    // …and it was INSTALLED: the signed artifact is on disk, and the poisoned counter is not
    // a field any more.
    expect(onDisk?.trustJws).toBe(rotation);
    expect(onDisk).not.toHaveProperty("lastTrustIssuedAt");
    expect(onDisk).not.toHaveProperty("trustedKeys");
    client.close();
  });

  // FIXED (R4-03c / R2-08) — §3. Deleting the cache does clear the derived replay floor —
  // there is nothing signed left to derive it from, and that is inherent. What closes the
  // capture-and-replay path instead is the `expiresAt` claim: an already-expired document is
  // refused outright, floor or no floor.
  it("resets replay protection to zero when the cache file is simply DELETED — a captured old doc is accepted again", async () => {
    const configDir = tempConfigDir();
    const now = Math.floor(Date.now() / 1000);

    // A current doc, and the same user's year-old captured doc from when they had a licence.
    const current = await signJws(
      makeLicenseDoc({ entitlements: { pro: entry(true) } }),
      VENDOR_PEM,
      VENDOR_KID,
      "plrs-license+jws",
    );
    const captured = await signJws(
      makeLicenseDoc({
        licenseId: "lic_last_year",
        issuedAt: now - 365 * DAY,
        expiresAt: now - 365 * DAY + HOUR,
        graceUntil: now - 65 * DAY,
        entitlements: { pro: entry(true) },
      }),
      VENDOR_PEM,
      VENDOR_KID,
      "plrs-license+jws",
    );

    let serve = current;
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/license/document"))
        return new Response(serve, { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // Round 1: accept the current doc, which sets the derived floor.
    plantCache(configDir, { v: CACHE_VERSION } satisfies CacheRecordV3);
    const c1 = clientOn(configDir, { fetchImpl });
    await c1.init();
    expect((await c1.sync()).applied).toBe(true);
    // Round 2: same doc, correctly rejected as a replay against the derived floor.
    expect((await c1.sync()).applied).toBe(false);
    c1.close();

    // Round 3: `rm ~/.config/djdl/managed.json` wipes the floor — and the captured doc is
    // STILL refused, because §3 will not accept a document that expired a year ago.
    rmSync(join(configDir, PRODUCT, "managed.json"));
    serve = captured;
    const c2 = clientOn(configDir, { fetchImpl });
    await c2.init();
    expect((await c2.sync()).applied).toBe(false);
    expect(c2.license.isEntitled("pro")).toBe(false);
    expect(c2.status().status).toBe("needs-activation");
    c2.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-04 — The gate read the raw wall clock: no monotonic floor, no server-time anchor.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-04: clock rollback / grace extension", () => {
  // FIXED (R4-04) — §4.2. The gate evaluates at `max(systemClock, highWaterMark)`, where the
  // high-water mark is the greatest `issuedAt` ever VERIFIED, recomputed at load from the
  // cached JWSs. Winding the clock back below it buys nothing, and the planted cache that made
  // the original PoC cheap does not survive re-verification at all.
  it("re-enters 'ok' when the system clock is moved back inside a long-expired doc's window, and never notices lastVerifiedAt is in the future", async () => {
    const configDir = tempConfigDir();
    const realNow = Math.floor(Date.now() / 1000);
    const issued = realNow - 400 * DAY;

    // (a) The original hand-written cache is simply not loadable any more.
    plantCache(configDir, {
      doc: makeLicenseDoc({
        issuedAt: issued,
        expiresAt: issued + HOUR,
        graceUntil: issued + 30 * DAY,
        entitlements: { pro: entry(true) },
      }),
      lastAcceptedIssuedAt: issued,
      lastVerifiedAt: realNow * 1000,
    });
    const planted = clientOn(configDir);
    await planted.init();
    expect(planted.status(realNow).status).toBe("needs-activation");
    expect(planted.isLicensed(issued + 60)).toBe(false); // rollback gains nothing
    planted.close();

    // (b) Now do it the honest way: a genuine, signed, current document in the cache. The
    //     high-water mark it establishes is what makes the rollback inert.
    const signed = await signJws(
      makeLicenseDoc({
        issuedAt: realNow,
        expiresAt: realNow + HOUR,
        graceUntil: realNow + 30 * DAY,
        entitlements: { pro: entry(true) },
      }),
      VENDOR_PEM,
      VENDOR_KID,
      "plrs-license+jws",
    );
    plantCache(configDir, {
      v: CACHE_VERSION,
      docs: { license: signed },
    } satisfies CacheRecordV3);
    const client = clientOn(configDir);
    await client.init();

    // `sudo date -u 0101120024` (or just turning off NTP): the gate is unmoved, because it
    // never sees a time earlier than the newest issuedAt it has verified.
    expect(client.status(realNow).status).toBe("ok");
    expect(client.status(issued + 60).status).toBe("ok");
    expect(client.status(realNow - 400 * DAY).status).toBe(
      client.status(realNow).status,
    );
    // The advertised lastVerifiedAt is derived from the SIGNED issuedAt, so it can no longer
    // be a value the attacker chose.
    expect(client.status(realNow).lastVerifiedAt).toBe(realNow * 1000);
    expect(client.getSyncState().highWaterMark).toBe(realNow);
    client.close();
  });

  // FIXED (R4-04, second half) — §4.2 as CORRECTED. A floor derived from the licence document
  // alone is inert against the attack it was written for: with one cached document
  // `highWaterMark === doc.issuedAt`, which is below that same document's `graceUntil` by
  // construction, so the floor can never reach the end of grace. The trust manifest is the
  // second, independently-advancing signed clock — and in v3 Core refreshes it on its OWN
  // cadence rather than riding a service's document fetch, so it advances for a product that
  // fetches no licence at all.
  it("cannot extend an aged-out document's grace by winding the clock back, because the cached trust manifest anchors time independently", async () => {
    const realNow = Math.floor(Date.now() / 1000);
    const issued = realNow - 400 * DAY; // grace ended 370 days ago
    const doc = await signJws(
      makeLicenseDoc({
        issuedAt: issued,
        expiresAt: issued + HOUR,
        graceUntil: issued + 30 * DAY,
        entitlements: { pro: entry(true) },
      }),
      VENDOR_PEM,
      VENDOR_KID,
      "plrs-license+jws",
    );
    const manifestAt = async (issuedAt: number): Promise<string> =>
      signJws(
        {
          schemaVersion: 1,
          aud: PRODUCT,
          iss: "plrs.im",
          issuedAt,
          expiresAt: issuedAt + 300,
          jwksUrl: "https://k.test/djdl/.well-known/jwks.json",
          cacheSeconds: 300,
          keys: [
            {
              kid: VENDOR_KID,
              kty: "OKP",
              crv: "Ed25519",
              alg: "EdDSA",
              publicKey: VENDOR_PUB,
              status: "active",
            },
          ],
        },
        VENDOR_PEM,
        VENDOR_KID,
        "plrs-trust+jws",
      );

    // (a) Document only — the floor cannot exceed `doc.issuedAt`, so the rollback works.
    const docOnlyDir = tempConfigDir();
    plantCache(docOnlyDir, {
      v: CACHE_VERSION,
      docs: { license: doc },
    } satisfies CacheRecordV3);
    const docOnly = clientOn(docOnlyDir);
    await docOnly.init();
    expect(docOnly.status(realNow).status).toBe("expired");
    expect(docOnly.status(issued + 60).status).toBe("ok"); // ← the residual defect
    docOnly.close();

    // (b) The same rollback with a manifest the client verified YESTERDAY in the cache. The
    //     manifest is long past its 300-second `expiresAt`, which is exactly what a cached
    //     manifest looks like — it still loads (§4.2), and its `issuedAt` still anchors time.
    const anchoredDir = tempConfigDir();
    plantCache(anchoredDir, {
      v: CACHE_VERSION,
      docs: { license: doc },
      trustJws: await manifestAt(realNow - DAY),
    } satisfies CacheRecordV3);
    const anchored = clientOn(anchoredDir);
    await anchored.init();
    expect(anchored.status(issued + 60).status).toBe("expired");
    expect(anchored.isLicensed(issued + 60)).toBe(false);
    expect(anchored.license.isEntitled("pro")).toBe(true); // the doc parsed; the GATE refuses
    // An honest clock is unaffected — the floor is a minimum, never a substitute.
    expect(anchored.status(realNow).status).toBe("expired");
    anchored.close();

    // (c) The network path raises it too, and in v3 it does so on CORE's cadence: the trust
    //     refresh happens inside `sync()` before and independently of the documents, so the
    //     floor advances even though `/license/document` is unreachable.
    const onlineDir = tempConfigDir();
    plantCache(onlineDir, {
      v: CACHE_VERSION,
      docs: { license: doc },
    } satisfies CacheRecordV3);
    const freshManifest = await manifestAt(realNow);
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith("polaris-trust.jws"))
        return new Response(freshManifest, { status: 200 });
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;
    const online = clientOn(onlineDir, { fetchImpl, trustRefresh: true });
    await online.init();
    expect(online.status(issued + 60).status).toBe("ok"); // before the refresh
    await online.sync();
    expect(online.status(issued + 60).status).toBe("expired"); // after it
    expect(online.getSyncState().highWaterMark).toBe(realNow);
    online.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-05 — A tampered cache was echoed verbatim to the server via the report endpoint.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-05: forged cache is reported to the control plane as ground truth", () => {
  // FIXED (R4-05, as a consequence of R4-01) — the snapshot is built from the re-verified
  // documents, so there is no attacker-authored map left to echo. The server's one signal that
  // would reveal a forgery is no longer authored by the forgery. (The route moved to
  // `POST /<p>/devices/report` in v3 §6 — it was licence anti-fraud data living under a config
  // path — which changes where it is sent and nothing about what.)
  it("POSTs the attacker's entitlement/config map to the report endpoint", async () => {
    const configDir = tempConfigDir();
    plantCache(configDir, {
      doc: makeLicenseDoc({
        expiresAt: 316_000_000_000,
        graceUntil: 316_000_000_000,
        entitlements: { enterprise: entry(true) },
      }),
      config: makeConfigDoc({ config: { "quality.floor": entry("lossless") } }),
      lastAcceptedIssuedAt: 316_000_000_000,
    });
    let reported: { config?: unknown; entitlements?: unknown } | null = null;
    let reportPath = "";
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/devices/report")) {
        reportPath = u.pathname;
        reported = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      }
      if (u.pathname.endsWith("/document"))
        return new Response("", { status: 304 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = clientOn(configDir, { fetchImpl });
    await client.init();
    await client.sync();

    expect(reported).not.toBeNull();
    expect(reportPath).toBe(`/${PRODUCT}/devices/report`);
    expect(reported!.entitlements).toEqual({});
    expect(reported!.config).toEqual({});
    expect(JSON.stringify(reported)).not.toContain("lossless");
    client.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-06 — Transport: no scheme validation, no timeout, no in-flight guard.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-06: transport hardening gaps", () => {
  // FIXED (R4-08) — the constructor refuses a `baseUrl` that would carry the bearer token in
  // the clear. Loopback stays usable so `wrangler dev` and integration tests still work.
  it("accepts a plaintext http:// baseUrl and sends the bearer token over it", async () => {
    const configDir = tempConfigDir();
    plantCache(configDir, { v: CACHE_VERSION } satisfies CacheRecordV3);
    const fetchImpl = (async () =>
      new Response("", { status: 500 })) as unknown as typeof fetch;

    expect(() =>
      clientOn(configDir, { baseUrl: "http://key.plrs.im", fetchImpl }),
    ).toThrow(InsecureBaseUrlError);
    expect(() =>
      clientOn(configDir, { baseUrl: "ftp://key.plrs.im", fetchImpl }),
    ).toThrow(InsecureBaseUrlError);
    expect(() =>
      clientOn(configDir, { baseUrl: "not a url", fetchImpl }),
    ).toThrow(InsecureBaseUrlError);

    // Local development is unaffected.
    const dev = clientOn(configDir, {
      baseUrl: "http://localhost:8787",
      fetchImpl,
    });
    dev.close();
    const dev2 = clientOn(configDir, {
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl,
    });
    dev2.close();
  });

  // FIXED (R4-08) — every request now carries an `AbortSignal` with a deadline, so a slowloris
  // on the trust endpoint can no longer stall `sync()` (and therefore the interval tick)
  // indefinitely.
  it("passes no AbortSignal/timeout to fetch, so a slowloris on the trust endpoint hangs sync() forever and interval ticks pile up unbounded", async () => {
    const configDir = tempConfigDir();
    plantCache(configDir, { v: CACHE_VERSION } satisfies CacheRecordV3);
    let sawSignal = false;
    let aborted = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const signal = init?.signal ?? null;
      if (signal) sawSignal = true;
      if (String(input).endsWith("polaris-trust.jws")) {
        // The attacker holds the socket open; the client's own deadline is what ends it.
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted += 1;
            reject(new Error("aborted"));
          });
        });
      }
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;

    const client = clientOn(configDir, {
      fetchImpl,
      trustRefresh: true,
      requestTimeoutMs: 50,
    });
    await client.init();
    // The trust refresh is still awaited before the documents, but it can no longer hang: the
    // deadline fires, the error is swallowed, and the sync completes.
    await Promise.all([client.sync(), client.sync(), client.sync()]);

    expect(sawSignal).toBe(true); // the client supplies a signal on every request
    expect(aborted).toBeGreaterThanOrEqual(3); // …and it actually fires
    client.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// NEW IN v3 — the attack surface the suite re-shape actually added.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("v3: the cache record is discarded across versions, never migrated", () => {
  // §4.1 — `v !== 3` ⇒ the record is DISCARDED. This is what makes every PoC above inert on
  // arrival, and it is worth its own test with a GENUINELY SIGNED v2 artifact: the attacker
  // here is not forging anything, they are replaying a real document this very client would
  // have accepted a phase ago. One network round trip is the correct price for refusing it.
  it("a v2 record holding a genuinely-signed v2 document yields nothing at all", async () => {
    const configDir = tempConfigDir();
    const now = Math.floor(Date.now() / 1000);
    const v2Doc = await signJws(
      {
        schemaVersion: 1,
        aud: PRODUCT,
        iss: "key.plrs.im",
        licenseId: "lic_v2",
        deviceId: DEVICE,
        issuedAt: now,
        expiresAt: now + HOUR,
        graceUntil: now + 30 * DAY,
        profile: {
          name: "Ada",
          firstName: "Ada",
          email: "a@b.c",
          activatedAt: now,
        },
        payload: {
          config: { "quality.floor": entry("lossless", now) },
          secrets: {},
          entitlements: { pro: entry(true, now) },
        },
      },
      VENDOR_PEM,
      VENDOR_KID,
      "pkey-config+jws",
    );
    plantCache(configDir, { v: 2, configJws: v2Doc, etag: '"v2"' });

    const client = clientOn(configDir);
    await client.init();
    expect(client.status().status).toBe("needs-activation");
    expect(client.license.isEntitled("pro")).toBe(false);
    expect(client.config.getConfig("quality.floor", "mp3")).toBe("mp3");
    expect(client.getSyncState().highWaterMark).toBe(0);
    client.close();
  });
});

describe("v3: a valid document in the WRONG cache slice is refused", () => {
  // §2 typ domain separation, applied to the CACHE rather than to the wire. Splitting the
  // fused document created a slot an attacker can fill with the wrong artifact: a config
  // document is signed by the same key, carries the same envelope, and is trivially available
  // to any device — so if `docs.license` were read without asserting `typ`, moving one file
  // field would produce a "licence" with no `licenseId` and no entitlements. The per-slice
  // verifier demands `plrs-license+jws`, so the slice is dropped and the OTHER slice, which is
  // correct, still loads. Fail closed, per artifact, not per record.
  it("a config artifact planted in docs.license drops that slice and leaves the config slice intact", async () => {
    const configDir = tempConfigDir();
    const now = Math.floor(Date.now() / 1000);
    const configJws = await signJws(
      makeConfigDoc({
        issuedAt: now,
        config: { "quality.floor": entry("lossless", now) },
      }),
      VENDOR_PEM,
      VENDOR_KID,
      "plrs-config+jws",
    );
    plantCache(configDir, {
      v: CACHE_VERSION,
      docs: { license: configJws, config: configJws },
    } satisfies CacheRecordV3);

    const client = clientOn(configDir);
    await client.init();
    // The licence slice is absent — not a partial licence, not a licence with empty grants.
    expect(client.status().status).toBe("needs-activation");
    expect(client.license.getLicenseId()).toBeNull();
    expect(client.license.getEntitlements()).toEqual({});
    expect(client.getSyncState().doc).toBeNull();
    // …and the correctly-typed config slice is unaffected: one bad artifact does not blind the
    // device to its settings.
    expect(client.config.getConfig("quality.floor", "mp3")).toBe("lossless");
    client.close();
  });
});

describe("v3 §7: an offline bundle imports everything or nothing", () => {
  // The air-gapped path is the one place a device accepts a whole provisioning payload from a
  // file an operator carried in. `bundle-tampered-inner-license-signature` is the corpus vector
  // for the interesting case: the licence document inside was mutated after signing and the
  // config document beside it is untouched. If import were incremental the attacker would get
  // the config half for free; because it is all-or-nothing they get nothing, and the cache they
  // already had is not disturbed either.
  const here = dirname(fileURLToPath(import.meta.url));
  const corpus = JSON.parse(
    readFileSync(
      join(here, "..", "..", "..", "conformance", "corpus", "v2", "cases.json"),
      "utf8",
    ),
  ) as {
    bundleCases: {
      id: string;
      bundleJws: string;
      pinned: TrustSet;
      expectedAud: string;
      deviceId: string;
      now: number;
      expect: { imports: boolean; reason?: string };
    }[];
  };

  it("a tampered inner document writes NOTHING and leaves the existing record byte-identical", async () => {
    const vector = corpus.bundleCases.find(
      (c) => c.id === "bundle-tampered-inner-license-signature",
    )!;
    const configDir = tempConfigDir();
    // A pre-existing, healthy record — so "wrote nothing" is a real claim rather than a
    // statement about an empty file.
    const incumbent = await signJws(
      makeLicenseDoc({
        deviceId: vector.deviceId,
        issuedAt: vector.now,
        expiresAt: vector.now + HOUR,
        graceUntil: vector.now + 30 * DAY,
        licenseId: "lic_incumbent",
        entitlements: { pro: entry(true, vector.now) },
      }),
      VENDOR_PEM,
      VENDOR_KID,
      "plrs-license+jws",
    );
    plantCache(
      configDir,
      {
        v: CACHE_VERSION,
        docs: { license: incumbent },
        etags: { license: '"incumbent"' },
      } satisfies CacheRecordV3,
      vector.deviceId,
    );
    const before = readFileSync(
      join(configDir, PRODUCT, "managed.json"),
      "utf8",
    );

    const client = clientOn(configDir, {
      trust: { pinnedKeys: vector.pinned },
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as unknown as typeof fetch,
    });
    await client.init();
    // The incumbent is genuinely live before the attempt.
    expect(client.status(vector.now).status).toBe("ok");
    expect(client.license.getLicenseId()).toBe("lic_incumbent");

    await expect(
      client.importBundle(vector.bundleJws, vector.now),
    ).rejects.toMatchObject({ code: vector.expect.reason });

    // Nothing was written, and nothing that was there moved.
    expect(readFileSync(join(configDir, PRODUCT, "managed.json"), "utf8")).toBe(
      before,
    );
    expect(client.license.getLicenseId()).toBe("lic_incumbent");
    expect(readCacheFile(configDir)).not.toHaveProperty("importedBundle");
    client.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-07 — The React desktop bridge is an ambient, unauthenticated global capability.
//   STILL OPEN. `packages/sdk-react` is outside this remediation's scope (client/crypto lane
//   only), so this block deliberately still asserts the VULNERABLE behaviour and will flip
//   red when the React lane lands its fix in P5. `resolveBridge` is bridge.ts:93-100 verbatim;
//   `resolveMode` is Provider.tsx:51-57 verbatim.
// ═══════════════════════════════════════════════════════════════════════════════════════
interface FakeBridge {
  getState(): Promise<unknown>;
  signOut(): Promise<void>;
  submitKey(key: string): Promise<{ kind: string }>;
}
function resolveBridge(explicit?: FakeBridge): FakeBridge | null {
  if (explicit) return explicit;
  if (typeof globalThis !== "undefined") {
    const w = globalThis as unknown as { polarisKey?: FakeBridge };
    if (w.polarisKey) return w.polarisKey;
  }
  return null;
}
function resolveMode(
  requested: "browser" | "desktop" | "auto",
  bridge?: FakeBridge,
) {
  if (requested === "browser" || requested === "desktop") return requested;
  return resolveBridge(bridge) ? "desktop" : "browser";
}

describe("R4-07: desktop bridge has no handshake, capability token or origin check", () => {
  afterEach(() => {
    delete (globalThis as { polarisKey?: unknown }).polarisKey;
  });

  it("lets ANY renderer-realm code (incl. a compromised transitive dep) both impersonate and drive the bridge", async () => {
    // (a) Impersonation: a hostile global is accepted with zero validation, and `auto`
    //     mode silently prefers it over the browser transport.
    const hostile: FakeBridge = {
      getState: async () => ({ hasToken: true, doc: null }),
      signOut: async () => undefined,
      submitKey: async () => ({ kind: "ok" }),
    };
    (globalThis as { polarisKey?: FakeBridge }).polarisKey = hostile;
    expect(resolveBridge()).toBe(hostile);
    expect(resolveMode("auto")).toBe("desktop");

    // (b) Capability leak: the REAL bridge, once exposed on the global, is callable by
    //     every script in the realm — no caller identity, no user confirmation.
    const audit: string[] = [];
    const real: FakeBridge = {
      getState: async () => ({ hasToken: true, doc: null }),
      signOut: async () => {
        audit.push("signOut");
      },
      submitKey: async (k) => {
        audit.push(`submitKey:${k}`);
        return { kind: "ok" };
      },
    };
    (globalThis as { polarisKey?: FakeBridge }).polarisKey = real;
    // This is the entire exploit for a malicious npm dependency in the renderer bundle:
    await (
      globalThis as unknown as { polarisKey: FakeBridge }
    ).polarisKey.signOut();
    await (
      globalThis as unknown as { polarisKey: FakeBridge }
    ).polarisKey.submitKey("PLRS-ATTACKER-SEAT-BURNER");
    expect(audit).toEqual(["signOut", "submitKey:PLRS-ATTACKER-SEAT-BURNER"]);
  });
});
