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
// Ported to wire contract v3. The god-object `PolarisKeyClient` became `PolarisClient` —
// Core plus one sub-client per service — and the single fused document became TWO
// (`plrs-license+jws` for grants, `plrs-config+jws` for config + secrets), fetched IN PARALLEL
// by `sync()` from `/license/document` and `/config/document`. The cache moved to v3, whose
// FIRST rule is that a record with any other `v` is DISCARDED rather than migrated (§4.1) —
// which is why every "plant a JSON file" PoC below is inert before a byte of it is read.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signJws } from "@plrs/jws";
import { ISSUER, type BundleDoc } from "@plrs/protocol/core";
import type { ConfigDoc } from "@plrs/protocol/config";
import type { LicenseDoc } from "@plrs/protocol/license";
import type { TrustManifestDoc } from "@plrs/protocol/trust";
import { PolarisError, type CacheRecordV3 } from "@plrs/client-core";
import { PolarisClient } from "../src/client.js";
import { InsecureBaseUrlError } from "../src/core/context.js";
import { CACHE_VERSION, FileStore } from "../src/core/store.js";

// ── The product's real, pinned signing key (the one a shipped app would embed) ──────────
const VENDOR_KID = "pkey-test-prod-2026";
const VENDOR_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const VENDOR_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const PRODUCT = "djdl";
const DEVICE = "device-under-attack";
/** v3 credential prefix (§8). Never validated locally — holding one is what makes `sync()`
 *  reach the network at all, which is what these attacks need in order to be tested. */
const TOKEN = "plrst_anything_at_all";
const HOUR = 3600;
const DAY = 86_400;

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

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** §2.1 — the LICENSE document: grants and the signed greeting block, nothing else. */
function makeLicenseDoc(over: Partial<LicenseDoc> = {}): LicenseDoc {
  const now = nowSec();
  return {
    iss: ISSUER,
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
    entitlements: {
      pro: { state: "enforced", value: false, updatedAt: now },
    },
    ...over,
  };
}

/** §2.2 — the CONFIG document: config + secrets, and no licence fields whatsoever. */
function makeConfigDoc(over: Partial<ConfigDoc> = {}): ConfigDoc {
  const now = nowSec();
  return {
    iss: ISSUER,
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

const signLicense = (doc: LicenseDoc, pem = VENDOR_PEM, kid = VENDOR_KID) =>
  signJws(doc, pem, kid, "plrs-license+jws");
const signConfig = (doc: ConfigDoc, pem = VENDOR_PEM, kid = VENDOR_KID) =>
  signJws(doc, pem, kid, "plrs-config+jws");

function trustManifest(issuedAt: number): TrustManifestDoc {
  return {
    schemaVersion: 1,
    aud: PRODUCT,
    iss: ISSUER,
    issuedAt,
    expiresAt: issuedAt + 300,
    jwksUrl: `https://k.test/${PRODUCT}/.well-known/jwks.json`,
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
  };
}

const signManifest = (issuedAt: number): Promise<string> =>
  signJws(trustManifest(issuedAt), VENDOR_PEM, VENDOR_KID, "plrs-trust+jws");

/**
 * Plant a raw `managed.json` + `token` + `device` on disk, exactly as `FileStore` would.
 * `token` is nullable so a bundle-activated install can be modelled: §7 mints no credential,
 * and `activation: "bundle"` is only observable when there is no token to supersede it.
 */
function plantCache(
  configDir: string,
  record: unknown,
  deviceId: string,
  token: string | null = TOKEN,
): void {
  const store = new FileStore(PRODUCT, configDir); // creates <dir>/<product>/ 0700
  void store;
  const productDir = join(configDir, PRODUCT);
  writeFileSync(join(productDir, "managed.json"), JSON.stringify(record));
  if (token !== null) writeFileSync(join(productDir, "token"), token);
  writeFileSync(join(productDir, "device"), deviceId);
}

const cachePathIn = (configDir: string): string =>
  join(configDir, PRODUCT, "managed.json");

function readCacheFile(configDir: string): CacheRecordV3 | null {
  try {
    return JSON.parse(
      readFileSync(cachePathIn(configDir), "utf8"),
    ) as CacheRecordV3;
  } catch {
    return null;
  }
}

function clientOn(
  configDir: string,
  extra: Partial<ConstructorParameters<typeof PolarisClient>[0]> = {},
) {
  return new PolarisClient({
    productSlug: PRODUCT,
    baseUrl: "https://k.test",
    version: "1.2.3",
    trust: { pinnedKeys: { [VENDOR_KID]: VENDOR_PUB } },
    store: new FileStore(PRODUCT, configDir),
    // Core's trust cadence has its own pins; the tests that need it turn it on explicitly so
    // an unrelated request never lands in the middle of a call-count assertion.
    trustRefresh: false,
    // Hardware probes shell out (ioreg/sw_vers); nothing here asserts on a fingerprint.
    license: { fingerprint: false },
    devices: { fingerprint: false },
    // An ambient `PLRS_CONFIG_*` var in the developer's shell must not be able to change what
    // these tests observe about the signed config document.
    config: { env: {} },
    ...extra,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-01 — The offline cache is not integrity-protected.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-01: unauthenticated offline cache", () => {
  // FIXED (R4-01 / R2-03) — wire contract v3 §4.1. The cache persists compact JWSs and
  // nothing else, and every slice is re-verified against the PINNED keys on every load. A
  // hand-written document has no signature to re-check, so it never becomes a document;
  // failure to verify is treated as "no cache" and the client falls closed.
  it("grants arbitrary entitlements, secrets and a 300-year grace from a hand-written JSON file (no signature at all)", async () => {
    const configDir = tempConfigDir();
    // The attacker never sees a JWS, never touches a key, never runs a debugger. They
    // write ~40 lines of JSON — and in v3 they must now forge BOTH documents, in a record
    // whose version is checked before any of it is read.
    const forged = {
      doc: makeLicenseDoc({
        licenseId: "lic_ENTERPRISE_UNLIMITED",
        // Year 12000.
        expiresAt: 316_000_000_000,
        graceUntil: 316_000_000_000,
        profile: {
          name: "Totally Legit",
          firstName: "Totally",
          email: "pirate@example.invalid",
          activatedAt: 0,
        },
        entitlements: {
          pro: { state: "enforced", value: true, updatedAt: 0 },
          enterprise: { state: "enforced", value: true, updatedAt: 0 },
          "stem-separation": { state: "enforced", value: true, updatedAt: 0 },
        },
      }),
      config: makeConfigDoc({
        config: {
          "quality.floor": {
            state: "enforced",
            value: "lossless",
            updatedAt: 0,
          },
        },
        // Injected secret — this is the value the host app would hand to a third-party API.
        secrets: {
          "beatport.apiKey": {
            state: "hidden",
            value: "sk_attacker_controlled",
            updatedAt: 0,
          },
        },
      }),
      lastAcceptedIssuedAt: 0,
      lastVerifiedAt: Date.now(),
    };
    plantCache(configDir, forged, DEVICE);

    const client = clientOn(configDir);
    await client.init(); // re-verifies; there is nothing to verify.

    expect(client.status().status).toBe("needs-activation");
    expect(client.isLicensed()).toBe(false);
    expect(client.license.isEntitled("pro")).toBe(false);
    expect(client.license.isEntitled("enterprise")).toBe(false);
    expect(client.license.getEntitlements()).toEqual({});
    expect(client.license.getLicenseId()).toBeNull();
    // No secret injection: the SDK's config-delivery channel now only carries values that
    // arrived inside a signature the pinned key produced.
    expect(client.config.getSecret("beatport.apiKey")).toBeNull();
    expect(client.getConfig("quality.floor", "mp3")).toBe("mp3");
    expect(client.license.getProfile()).toBeNull();
    client.close();
  });

  // FIXED (R4-01) — §4.1 step 3. The reload path runs the SAME §3 claim set the network path
  // does, `aud` and `deviceId` included, so a genuinely-signed doc lifted from a colleague's
  // machine (or another product on the same control plane) is refused. Both slices carry the
  // rule, because the envelope they share is validated in one place (§2).
  it("accepts a doc bound to a DIFFERENT product and a DIFFERENT device (aud/deviceId are only checked on the network path)", async () => {
    const configDir = tempConfigDir();
    // Note these docs are REALLY signed by the vendor key — the only thing wrong with them is
    // who and what they are bound to.
    const foreignLicense = await signLicense(
      makeLicenseDoc({
        aud: "some-other-product",
        deviceId: "not-this-device",
      }),
    );
    const foreignConfig = await signConfig(
      makeConfigDoc({
        aud: "some-other-product",
        deviceId: "not-this-device",
        secrets: {
          "beatport.apiKey": {
            state: "hidden",
            value: "borrowed",
            updatedAt: 0,
          },
        },
      }),
    );
    plantCache(
      configDir,
      {
        v: CACHE_VERSION,
        docs: { license: foreignLicense, config: foreignConfig },
      } satisfies CacheRecordV3,
      DEVICE,
    );
    const client = clientOn(configDir);
    await client.init();
    expect(client.status().status).toBe("needs-activation");
    expect(client.getCurrentDevice().licenseId).toBeUndefined();
    expect(client.license.getEntitlements()).toEqual({});
    expect(client.config.getSecret("beatport.apiKey")).toBeNull();
    client.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-02 — Cache-planted `trustedKeys` turn one file write into permanent signing authority.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-02: trust-set injection via the cache file", () => {
  // FIXED (R4-02 / R2-01) — §1. `trustedKeys` no longer exists: the cache is not a key
  // source. Keys can only be learned from a trust manifest that verifies against the PINNED
  // set, so a file write can neither add a kid nor swap the bytes behind one.
  it("makes the client verify and APPLY a doc signed by an attacker key served over the network", async () => {
    const configDir = tempConfigDir();
    const attacker = attackerKeypair();

    // Step 1 — plant only the trust key. No forged doc yet.
    plantCache(
      configDir,
      {
        doc: null,
        lastAcceptedIssuedAt: 0,
        trustedKeys: { [attacker.kid]: attacker.rawPubB64Url },
      },
      DEVICE,
    );

    // Step 2 — the attacker serves documents they signed themselves. (In the wild: an
    // /etc/hosts entry + a locally trusted CA, or NODE_EXTRA_CA_CERTS, or a plain
    // `http://` baseUrl — see R4-06. No vendor key is ever needed.)
    const evilLicense = await signLicense(
      makeLicenseDoc({
        licenseId: "lic_signed_by_attacker",
        entitlements: {
          pro: { state: "enforced", value: true, updatedAt: 0 },
        },
      }),
      attacker.pem,
      attacker.kid,
    );
    const evilConfig = await signConfig(
      makeConfigDoc({
        secrets: {
          "beatport.apiKey": {
            state: "hidden",
            value: "sk_attacker_controlled",
            updatedAt: 0,
          },
        },
      }),
      attacker.pem,
      attacker.kid,
    );

    const fetchImpl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/license/document"))
        return new Response(evilLicense, {
          status: 200,
          headers: { etag: '"evil-lic"' },
        });
      if (u.pathname.endsWith("/config/document"))
        return new Response(evilConfig, {
          status: 200,
          headers: { etag: '"evil-cfg"' },
        });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = clientOn(configDir, { fetchImpl });
    await client.init();
    const r = await client.sync();

    // verify FAILED on both — `attacker-kid-1` is not in the effective trust set.
    expect(r.applied).toBe(false);
    expect(r.documents.license?.kind).toBe("error");
    expect(r.documents.config?.kind).toBe("error");
    expect(client.license.isEntitled("pro")).toBe(false);
    expect(client.config.getSecret("beatport.apiKey")).toBeNull();
    expect(client.getCurrentDevice().licenseId).toBeUndefined();
    // The planted file is still sitting there untouched — and completely inert: no document
    // was ever accepted from it, and no v3 record was produced from its contents.
    const onDisk = readCacheFile(configDir);
    expect(onDisk?.docs).toBeUndefined();
    expect(onDisk?.v).not.toBe(CACHE_VERSION);
    expect(onDisk).toHaveProperty("trustedKeys"); // still there, still meaningless
    client.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-03 — `lastAcceptedIssuedAt` / `lastTrustIssuedAt` were attacker-writable anti-replay
//          counters. Poisoning them PINNED the forged state even while fully online.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-03: anti-replay counters are attacker-controlled in both directions", () => {
  // FIXED (R4-03) — §4.1. Both counters are gone from disk. The per-TYPE replay floor is
  // derived from the `issuedAt` of the re-verified cached document, so writing a far-future
  // integer into the file no longer blocks a genuine revocation: the vendor's control plane
  // can land again.
  it("pins a forged doc forever: a genuine, correctly-signed server doc is rejected because lastAcceptedIssuedAt was set to the far future", async () => {
    const configDir = tempConfigDir();
    plantCache(
      configDir,
      {
        doc: makeLicenseDoc({
          licenseId: "lic_FORGED",
          expiresAt: 316_000_000_000,
          graceUntil: 316_000_000_000,
          entitlements: {
            pro: { state: "enforced", value: true, updatedAt: 0 },
          },
        }),
        // Year 12000 — under v1 every real doc's issuedAt was smaller, so all of them were
        // rejected and revocation could never land on this device.
        lastAcceptedIssuedAt: 316_000_000_000,
      },
      DEVICE,
    );

    const now = nowSec();
    // The server does its job: it issues a REVOKED, entitlement-free doc, properly signed.
    const genuineRevocation = await signLicense(
      makeLicenseDoc({
        licenseId: "lic_REVOKED",
        issuedAt: now,
        expiresAt: now + HOUR,
        graceUntil: now + HOUR,
        entitlements: {
          pro: { state: "enforced", value: false, updatedAt: now },
        },
      }),
    );
    const genuineConfig = await signConfig(makeConfigDoc({ issuedAt: now }));
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/license/document"))
        return new Response(genuineRevocation, { status: 200 });
      if (u.pathname.endsWith("/config/document"))
        return new Response(genuineConfig, { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = clientOn(configDir, { fetchImpl });
    await client.init();
    const r = await client.sync();

    expect(r.applied).toBe(true); // the legitimate update LANDS
    expect(r.documents.license?.kind).toBe("applied");
    expect(client.license.isEntitled("pro")).toBe(false); // …and revokes the entitlement
    expect(client.getCurrentDevice().licenseId).toBe("lic_REVOKED");
    client.close();
  });

  // FIXED (R4-03) — §4.1. The trust anti-rollback bound is likewise derived from the manifest
  // this client last re-verified, so key rotation — the vendor's mechanism for retiring a
  // compromised signing key — can no longer be disabled by editing a JSON file.
  it("permanently disables trust-key rotation (the key-revocation mechanism) by poisoning lastTrustIssuedAt", async () => {
    const configDir = tempConfigDir();
    plantCache(
      configDir,
      {
        doc: null,
        lastAcceptedIssuedAt: 0,
        lastTrustIssuedAt: 316_000_000_000,
      },
      DEVICE,
    );

    const now = nowSec();
    const rotation = await signJws(
      {
        ...trustManifest(now),
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
    // …and it was INSTALLED: the signed artifact is on disk in a fresh v3 record, and neither
    // poisoned counter is a field any more.
    expect(onDisk?.v).toBe(CACHE_VERSION);
    expect(onDisk?.trustJws).toBe(rotation);
    expect(onDisk).not.toHaveProperty("lastTrustIssuedAt");
    expect(onDisk).not.toHaveProperty("lastAcceptedIssuedAt");
    expect(onDisk).not.toHaveProperty("trustedKeys");
    client.close();
  });

  // FIXED (R4-03c / R2-08) — §3. Deleting the cache does clear the derived replay floor —
  // there is nothing signed left to derive it from, and that is inherent. What closes the
  // capture-and-replay path instead is the `expiresAt` claim: an already-expired document is
  // refused outright, floor or no floor.
  it("resets replay protection to zero when the cache file is simply DELETED — a captured old doc is accepted again", async () => {
    const configDir = tempConfigDir();
    const now = nowSec();
    const entitled = {
      pro: { state: "enforced" as const, value: true, updatedAt: 0 },
    };

    // A current doc, and the same user's year-old captured doc from when they had a licence.
    const current = await signLicense(
      makeLicenseDoc({ issuedAt: now, entitlements: entitled }),
    );
    const captured = await signLicense(
      makeLicenseDoc({
        licenseId: "lic_last_year",
        issuedAt: now - 365 * DAY,
        expiresAt: now - 365 * DAY + HOUR,
        graceUntil: now - 65 * DAY,
        entitlements: entitled,
      }),
    );

    let serve = current;
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/license/document"))
        return new Response(serve, { status: 200 });
      if (u.pathname.endsWith("/config/document"))
        return new Response("", { status: 503 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // Round 1: accept the current doc, which sets the derived floor.
    plantCache(configDir, { v: CACHE_VERSION } satisfies CacheRecordV3, DEVICE);
    const c1 = clientOn(configDir, { fetchImpl });
    await c1.init();
    expect((await c1.sync()).applied).toBe(true);
    // Round 2: same doc, correctly rejected as a replay against the derived floor.
    expect((await c1.sync()).applied).toBe(false);
    c1.close();

    // Round 3: `rm ~/.config/djdl/managed.json` wipes the floor — and the captured doc is
    // STILL refused, because §3 will not accept a document that expired a year ago.
    rmSync(cachePathIn(configDir));
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
    const realNow = nowSec();
    const issued = realNow - 400 * DAY;

    // (a) The original hand-written cache is simply not loadable any more.
    plantCache(
      configDir,
      {
        doc: makeLicenseDoc({
          issuedAt: issued,
          expiresAt: issued + HOUR,
          graceUntil: issued + 30 * DAY,
          entitlements: {
            pro: { state: "enforced", value: true, updatedAt: 0 },
          },
        }),
        lastAcceptedIssuedAt: issued,
        lastVerifiedAt: realNow * 1000,
      },
      DEVICE,
    );
    const planted = clientOn(configDir);
    await planted.init();
    expect(planted.status(realNow).status).toBe("needs-activation");
    expect(planted.isLicensed(issued + 60)).toBe(false); // rollback gains nothing
    planted.close();

    // (b) Now do it the honest way: a genuine, signed, current document in the cache. The
    //     high-water mark it establishes is what makes the rollback inert.
    const signed = await signLicense(
      makeLicenseDoc({
        issuedAt: realNow,
        expiresAt: realNow + HOUR,
        graceUntil: realNow + 30 * DAY,
        entitlements: {
          pro: { state: "enforced", value: true, updatedAt: 0 },
        },
      }),
    );
    plantCache(
      configDir,
      {
        v: CACHE_VERSION,
        docs: { license: signed },
      } satisfies CacheRecordV3,
      DEVICE,
    );
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

  // FIXED (R4-04, second half) — §4.2 as CORRECTED. The floor above is derived from the
  // license document alone, and that is inert against the attack it was written for: with one
  // cached document `highWaterMark === doc.issuedAt`, which is below that same document's
  // `graceUntil` by construction, so the floor can never reach the end of grace. The trust
  // manifest is the second, independently-advancing signed clock, and Core refreshes it on its
  // OWN cadence inside `sync()` rather than riding a service's document fetch — so a client
  // that verified a manifest yesterday cannot claim it is last year.
  it("cannot extend an aged-out document's grace by winding the clock back, because the cached trust manifest anchors time independently", async () => {
    const realNow = nowSec();
    const issued = realNow - 400 * DAY; // grace ended 370 days ago
    const doc = await signLicense(
      makeLicenseDoc({
        issuedAt: issued,
        expiresAt: issued + HOUR,
        graceUntil: issued + 30 * DAY,
        entitlements: {
          pro: { state: "enforced", value: true, updatedAt: 0 },
        },
      }),
    );

    // (a) Document only — the floor cannot exceed `doc.issuedAt`, so the rollback works.
    const docOnlyDir = tempConfigDir();
    plantCache(
      docOnlyDir,
      { v: CACHE_VERSION, docs: { license: doc } } satisfies CacheRecordV3,
      DEVICE,
    );
    const docOnly = clientOn(docOnlyDir);
    await docOnly.init();
    expect(docOnly.status(realNow).status).toBe("expired");
    expect(docOnly.status(issued + 60).status).toBe("ok"); // ← the residual defect
    docOnly.close();

    // (b) The same rollback with a manifest the client verified YESTERDAY in the cache. The
    //     manifest is long past its 300-second `expiresAt`, which is exactly what a cached
    //     manifest looks like — it still loads (§4.1), and its `issuedAt` still anchors time.
    const anchoredDir = tempConfigDir();
    plantCache(
      anchoredDir,
      {
        v: CACHE_VERSION,
        docs: { license: doc },
        trustJws: await signManifest(realNow - DAY),
      } satisfies CacheRecordV3,
      DEVICE,
    );
    const anchored = clientOn(anchoredDir);
    await anchored.init();
    expect(anchored.status(issued + 60).status).toBe("expired");
    expect(anchored.isLicensed(issued + 60)).toBe(false);
    expect(anchored.license.isEntitled("pro")).toBe(true); // the doc parsed; the GATE refuses
    // An honest clock is unaffected — the floor is a minimum, never a substitute.
    expect(anchored.status(realNow).status).toBe("expired");
    anchored.close();

    // (c) The network path raises it too: with `trustRefresh` on, a manifest fetched now
    //     anchors the gate even though NEITHER document is reachable.
    const onlineDir = tempConfigDir();
    plantCache(
      onlineDir,
      { v: CACHE_VERSION, docs: { license: doc } } satisfies CacheRecordV3,
      DEVICE,
    );
    const freshManifest = await signManifest(realNow);
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
// R4-05 — A tampered cache was echoed verbatim to the server. (The route moved in v3:
//   `POST /<p>/config/report` is gone; telemetry is a Core surface at
//   `POST /<p>/devices/report`, because it was always licence anti-fraud data.)
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-05: forged cache is reported to the control plane as ground truth", () => {
  // FIXED (R4-05, as a consequence of R4-01) — the snapshot is built from the RE-VERIFIED
  // documents, so there is no attacker-authored map left to echo. The server's one signal that
  // would reveal a forgery is no longer authored by the forgery.
  it("POSTs the attacker's entitlement/config map to /devices/report", async () => {
    const configDir = tempConfigDir();
    plantCache(
      configDir,
      {
        doc: makeLicenseDoc({
          expiresAt: 316_000_000_000,
          graceUntil: 316_000_000_000,
          entitlements: {
            enterprise: { state: "enforced", value: true, updatedAt: 0 },
          },
        }),
        config: makeConfigDoc({
          config: {
            "quality.floor": {
              state: "enforced",
              value: "lossless",
              updatedAt: 0,
            },
          },
        }),
        lastAcceptedIssuedAt: 316_000_000_000,
      },
      DEVICE,
    );
    let reportedRaw: string | null = null;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/devices/report")) {
        reportedRaw = String(init?.body);
        return new Response("{}", { status: 200 });
      }
      if (u.pathname.endsWith("/document"))
        return new Response("", { status: 304 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = clientOn(configDir, { fetchImpl });
    await client.init();
    await client.sync();

    expect(reportedRaw).not.toBeNull();
    const reported = JSON.parse(String(reportedRaw)) as {
      config?: unknown;
      entitlements?: unknown;
    };
    expect(reported.entitlements).toEqual({});
    expect(reported.config).toEqual({});
    expect(String(reportedRaw)).not.toContain("lossless");
    expect(String(reportedRaw)).not.toContain("enterprise");
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
    plantCache(configDir, { v: CACHE_VERSION } satisfies CacheRecordV3, DEVICE);
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

  // FIXED (R4-08) — every request now carries an `AbortSignal` with a deadline, so a
  // slowloris on the trust endpoint can no longer stall `sync()` (and therefore the
  // interval tick) indefinitely.
  it("passes no AbortSignal/timeout to fetch, so a slowloris on the trust endpoint hangs refresh() forever and interval ticks pile up unbounded", async () => {
    const configDir = tempConfigDir();
    plantCache(configDir, { v: CACHE_VERSION } satisfies CacheRecordV3, DEVICE);
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
// R4-09 (NEW in v3) — Offline activation bundles (§7). The air-gapped path is the one place
//   a client installs a whole cache record from a single file an operator carried in by hand,
//   so it is the one place a partial write would be a licence granted by a failed import.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-09: offline bundle import is all-or-nothing", () => {
  /** Mint a `plrs-bundle+jws` around whatever inner artifacts the caller supplies. */
  async function mintBundle(over: Partial<BundleDoc> = {}): Promise<string> {
    const now = nowSec();
    const bundle: BundleDoc = {
      bundleId: "01HZZBUNDLE0000000000000000",
      aud: PRODUCT,
      deviceId: DEVICE,
      issuedAt: now,
      expiresAt: now + 30 * DAY,
      docs: {},
      trust: await signManifest(now),
      ...over,
    };
    return signJws(bundle, VENDOR_PEM, VENDOR_KID, "plrs-bundle+jws");
  }

  /** Rewrite a compact JWS's payload while keeping its ORIGINAL header and signature — the
   *  literal form of "the document inside the bundle was tampered with". */
  function tamper(jws: string, mutate: (doc: LicenseDoc) => void): string {
    const [header, payload, signature] = jws.split(".") as [
      string,
      string,
      string,
    ];
    const doc = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as LicenseDoc;
    mutate(doc);
    const reencoded = Buffer.from(JSON.stringify(doc), "utf8").toString(
      "base64url",
    );
    return `${header}.${reencoded}.${signature}`;
  }

  // NEW (§7 step 5). A refusal hands back NO documents, so there is nothing partial to write —
  // the rule is structural rather than disciplinary. This pins the observable half: the
  // on-disk record is byte-identical afterwards, and the client still holds exactly the state
  // it held before the bad file was offered to it.
  it("a bundle whose inner license document was tampered with writes NOTHING", async () => {
    const configDir = tempConfigDir();
    const now = nowSec();
    // A device with real, previously-established state. This is what must survive intact.
    const priorLicense = await signLicense(
      makeLicenseDoc({ licenseId: "lic_PRIOR", issuedAt: now }),
    );
    plantCache(
      configDir,
      {
        v: CACHE_VERSION,
        docs: { license: priorLicense },
      } satisfies CacheRecordV3,
      DEVICE,
      null, // §7: a bundle-activated install has no credential
    );
    const before = readFileSync(cachePathIn(configDir), "utf8");

    const innerLicense = await signLicense(
      makeLicenseDoc({
        licenseId: "lic_air_gapped",
        issuedAt: now,
        entitlements: {
          pro: { state: "enforced", value: true, updatedAt: now },
        },
      }),
    );
    const innerConfig = await signConfig(
      makeConfigDoc({
        issuedAt: now,
        secrets: {
          "beatport.apiKey": {
            state: "hidden",
            value: "sk_from_bundle",
            updatedAt: now,
          },
        },
      }),
    );
    // The tamper: grant `enterprise` by rewriting the payload. The signature no longer covers
    // it, so step 4 refuses — and the perfectly good config document beside it must NOT land.
    const tampered = tamper(innerLicense, (doc) => {
      doc.entitlements.enterprise = {
        state: "enforced",
        value: true,
        updatedAt: 0,
      };
    });

    const client = clientOn(configDir);
    await client.init();
    expect(client.license.getLicenseId()).toBe("lic_PRIOR");

    const bad = await mintBundle({
      docs: { license: tampered, config: innerConfig },
    });
    let caught: unknown = null;
    try {
      await client.importBundle(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PolarisError);
    expect((caught as PolarisError).code).toBe("inner-doc-rejected");
    expect([
      "bundle-jws-rejected",
      "bundle-claims-rejected",
      "bundle-trust-rejected",
      "inner-doc-rejected",
    ]).toContain((caught as PolarisError).code);

    // NOTHING was written: not the config document that verified, not an `importedBundle`
    // marker, not the bundle's trust manifest.
    expect(readFileSync(cachePathIn(configDir), "utf8")).toBe(before);
    const onDisk = readCacheFile(configDir);
    expect(onDisk?.importedBundle).toBeUndefined();
    expect(onDisk?.trustJws).toBeUndefined();
    expect(onDisk?.docs?.config).toBeUndefined();
    // …and the live client is untouched too.
    expect(client.license.getLicenseId()).toBe("lic_PRIOR");
    expect(client.license.isEntitled("pro")).toBe(false);
    expect(client.license.isEntitled("enterprise")).toBe(false);
    expect(client.config.getSecret("beatport.apiKey")).toBeNull();
    client.close();

    // The CONTROL, so the refusal above is provably about the tamper and not a broken
    // fixture: the identical bundle with the untampered document imports and replaces the
    // record wholesale (§7 step 5).
    const good = await mintBundle({
      docs: { license: innerLicense, config: innerConfig },
    });
    const c2 = clientOn(configDir);
    await c2.init();
    const result = await c2.importBundle(good);
    expect(result.imported).toEqual(["license", "config"]);
    expect(c2.license.activation()).toBe("bundle");
    expect(c2.status().status).toBe("ok");
    expect(c2.license.getLicenseId()).toBe("lic_air_gapped");
    expect(c2.license.isEntitled("pro")).toBe(true);
    expect(c2.license.isEntitled("enterprise")).toBe(false);
    expect(c2.config.getSecret("beatport.apiKey")).toBe("sk_from_bundle");
    const after = readCacheFile(configDir);
    expect(after?.v).toBe(CACHE_VERSION);
    expect(after?.importedBundle?.bundleId).toBe("01HZZBUNDLE0000000000000000");
    expect(after?.docs?.license).toBe(innerLicense);
    // The replaced record carries no stale slice from the pre-import state (§7 step 5 is a
    // re-provisioning, not a merge).
    expect(after?.docs?.license).not.toBe(priorLicense);
    c2.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-07 — The React desktop bridge is an ambient, unauthenticated global capability.
//   STILL OPEN. `packages/sdk-react` is outside this remediation's scope (client/crypto lane
//   only), so this block deliberately still asserts the VULNERABLE behaviour and will flip
//   red when the React lane lands its fix. `resolveBridge` is bridge.ts:93-100 verbatim;
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
    ).polarisKey.submitKey("PKEY-ATTACKER-SEAT-BURNER");
    expect(audit).toEqual(["signOut", "submitKey:PKEY-ATTACKER-SEAT-BURNER"]);
  });
});
