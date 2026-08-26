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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
import { InsecureBaseUrlError, PolarisKeyClient } from "../src/client.js";
import { CACHE_VERSION, FileStore, type CacheRecord } from "../src/store.js";

// ── The product's real, pinned signing key (the one a shipped app would embed) ──────────
const VENDOR_KID = "pkey-test-prod-2026";
const VENDOR_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const VENDOR_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const PRODUCT = "djdl";
const HOUR = 3600;
const DAY = 86_400;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), "r4-pkey-"));
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

function makeDoc(over: Partial<ManagedConfigDoc> = {}): ManagedConfigDoc {
  const now = Math.floor(Date.now() / 1000);
  return {
    schemaVersion: 1,
    aud: PRODUCT,
    iss: "key.plrs.im",
    licenseId: "lic_free_tier",
    deviceId: "device-under-attack",
    issuedAt: now,
    expiresAt: now + HOUR,
    graceUntil: now + 30 * DAY,
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: now,
    },
    payload: {
      config: {},
      secrets: {},
      entitlements: {
        pro: { state: "enforced", value: false, updatedAt: now },
      },
    },
    ...over,
  } as ManagedConfigDoc;
}

/** Plant a raw `managed.json` + `token` + `device` on disk, exactly as `FileStore` would. */
function plantCache(
  configDir: string,
  record: unknown,
  deviceId: string,
): void {
  const store = new FileStore(PRODUCT, configDir); // creates <dir>/<product>/ 0700
  void store;
  const productDir = join(configDir, PRODUCT);
  writeFileSync(join(productDir, "managed.json"), JSON.stringify(record));
  writeFileSync(join(productDir, "token"), "pkeyt_anything_at_all");
  writeFileSync(join(productDir, "device"), deviceId);
}

function readCacheFile(configDir: string): CacheRecord | null {
  try {
    return JSON.parse(
      readFileSync(join(configDir, PRODUCT, "managed.json"), "utf8"),
    ) as CacheRecord;
  } catch {
    return null;
  }
}

function clientOn(
  configDir: string,
  extra: Partial<ConstructorParameters<typeof PolarisKeyClient>[0]> = {},
) {
  return new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: "https://k.test",
    version: "1.2.3",
    trust: { pinnedKeys: { [VENDOR_KID]: VENDOR_PUB } },
    store: new FileStore(PRODUCT, configDir),
    trustRefresh: false,
    fingerprint: false,
    ...extra,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-01 — The offline cache is not integrity-protected.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-01: unauthenticated offline cache", () => {
  // FIXED (R4-01 / R2-03) — wire contract v2 §4. The cache persists the compact JWS and
  // nothing else, and it is re-verified against the PINNED keys on every load. A hand-written
  // document has no signature to re-check, so it never becomes a document; failure to verify
  // is treated as "no cache" and the client falls closed to `needs-activation`.
  it("grants arbitrary entitlements, secrets and a 300-year grace from a hand-written JSON file (no signature at all)", async () => {
    const configDir = tempConfigDir();
    // The attacker never sees a JWS, never touches a key, never runs a debugger. They
    // write ~40 lines of JSON.
    const forged = {
      doc: makeDoc({
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
        payload: {
          config: {
            "quality.floor": {
              state: "enforced",
              value: "lossless",
              updatedAt: 0,
            },
          },
          // Injected secret — this is the value the host app will hand to a third-party API.
          secrets: {
            "beatport.apiKey": {
              state: "hidden",
              value: "sk_attacker_controlled",
              updatedAt: 0,
            },
          },
          entitlements: {
            pro: { state: "enforced", value: true, updatedAt: 0 },
            enterprise: { state: "enforced", value: true, updatedAt: 0 },
            "stem-separation": { state: "enforced", value: true, updatedAt: 0 },
          },
        },
      }),
      lastAcceptedIssuedAt: 0,
      lastVerifiedAt: Date.now(),
    };
    plantCache(configDir, forged, "device-under-attack");

    const client = clientOn(configDir);
    await client.init(); // re-verifies; there is nothing to verify.

    expect(client.status().status).toBe("needs-activation");
    expect(client.isLicensed()).toBe(false);
    expect(client.isEntitled("pro")).toBe(false);
    expect(client.isEntitled("enterprise")).toBe(false);
    expect(client.getEntitlements()).toEqual({});
    // No secret injection: the SDK's config-delivery channel now only carries values that
    // arrived inside a signature the pinned key produced.
    expect(client.getSecret("beatport.apiKey")).toBeNull();
    expect(client.getConfig("quality.floor", "mp3")).toBe("mp3");
    expect(client.getProfile()).toBeNull();
    client.close();
  });

  // FIXED (R4-01) — §4.2 step 3. The reload path runs the SAME §3 claim set the network path
  // does, `aud` and `deviceId` included, so a genuinely-signed doc lifted from a colleague's
  // machine (or another product on the same control plane) is refused.
  it("accepts a doc bound to a DIFFERENT product and a DIFFERENT device (aud/deviceId are only checked on the network path)", async () => {
    const configDir = tempConfigDir();
    // Note this doc is REALLY signed by the vendor key — the only thing wrong with it is who
    // and what it is bound to.
    const foreign = await signJws(
      makeDoc({
        aud: "some-other-product",
        deviceId: "not-this-device",
      }),
      VENDOR_PEM,
      VENDOR_KID,
    );
    plantCache(
      configDir,
      { v: CACHE_VERSION, configJws: foreign } satisfies CacheRecord,
      "device-under-attack",
    );
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
  // FIXED (R4-02 / R2-01) — §1.1. `trustedKeys` no longer exists: the cache is not a key
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
      "device-under-attack",
    );

    // Step 2 — the attacker serves a doc they signed themselves. (In the wild: an
    // /etc/hosts entry + a locally trusted CA, or NODE_EXTRA_CA_CERTS, or a plain
    // `http://` baseUrl — see R4-06. No vendor key is ever needed.)
    const evilDoc = makeDoc({
      licenseId: "lic_signed_by_attacker",
      deviceId: "device-under-attack",
      payload: {
        config: {},
        secrets: {},
        entitlements: { pro: { state: "enforced", value: true, updatedAt: 0 } },
      },
    });
    const evilJws = await signJws(evilDoc, attacker.pem, attacker.kid);

    const fetchImpl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/config"))
        return new Response(evilJws, {
          status: 200,
          headers: { etag: '"evil"' },
        });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = clientOn(configDir, { fetchImpl });
    await client.init();
    const r = await client.refresh();

    expect(r.applied).toBe(false); // verifyDoc FAILED — `attacker-kid-1` is not trusted
    expect(client.isEntitled("pro")).toBe(false);
    expect(client.getCurrentDevice().licenseId).toBeUndefined();
    // The planted file is still sitting there untouched — and completely inert: no document
    // was ever accepted from it, and no v2 record was produced from its contents.
    const onDisk = readCacheFile(configDir);
    expect(onDisk?.configJws).toBeUndefined();
    expect(onDisk?.v).not.toBe(CACHE_VERSION);
    client.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-03 — `lastAcceptedIssuedAt` / `lastTrustIssuedAt` were attacker-writable anti-replay
//          counters. Poisoning them PINNED the forged state even while fully online.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-03: anti-replay counters are attacker-controlled in both directions", () => {
  // FIXED (R4-03) — §4.1. Both counters are gone from disk. `lastAcceptedIssuedAt` is derived
  // from the issuedAt of the re-verified cached doc, so writing a far-future integer into the
  // file no longer blocks a genuine revocation: the vendor's control plane can land again.
  it("pins a forged doc forever: a genuine, correctly-signed server doc is rejected because lastAcceptedIssuedAt was set to the far future", async () => {
    const configDir = tempConfigDir();
    plantCache(
      configDir,
      {
        doc: makeDoc({
          licenseId: "lic_FORGED",
          expiresAt: 316_000_000_000,
          graceUntil: 316_000_000_000,
          payload: {
            config: {},
            secrets: {},
            entitlements: {
              pro: { state: "enforced", value: true, updatedAt: 0 },
            },
          },
        }),
        // Year 12000 — under v1 every real doc's issuedAt was smaller, so all of them were
        // rejected and revocation could never land on this device.
        lastAcceptedIssuedAt: 316_000_000_000,
      },
      "device-under-attack",
    );

    const now = Math.floor(Date.now() / 1000);
    // The server does its job: it issues a REVOKED, entitlement-free doc, properly signed.
    const genuineRevocation = await signJws(
      makeDoc({
        licenseId: "lic_REVOKED",
        deviceId: "device-under-attack",
        issuedAt: now,
        expiresAt: now + HOUR,
        graceUntil: now + HOUR,
        payload: {
          config: {},
          secrets: {},
          entitlements: {
            pro: { state: "enforced", value: false, updatedAt: now },
          },
        },
      }),
      VENDOR_PEM,
      VENDOR_KID,
    );
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/config"))
        return new Response(genuineRevocation, { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = clientOn(configDir, { fetchImpl });
    await client.init();
    const r = await client.refresh();

    expect(r.applied).toBe(true); // the legitimate update LANDS
    expect(client.isEntitled("pro")).toBe(false); // …and revokes the entitlement
    expect(client.getCurrentDevice().licenseId).toBe("lic_REVOKED");
    client.close();
  });

  // FIXED (R4-03) — §4.1. `lastTrustIssuedAt` is likewise derived from the re-verified
  // manifest, so key rotation — the vendor's mechanism for retiring a compromised signing
  // key — can no longer be disabled by editing a JSON file.
  it("permanently disables trust-key rotation (the key-revocation mechanism) by poisoning lastTrustIssuedAt", async () => {
    const configDir = tempConfigDir();
    plantCache(
      configDir,
      {
        doc: null,
        lastAcceptedIssuedAt: 0,
        lastTrustIssuedAt: 316_000_000_000,
      },
      "device-under-attack",
    );

    const now = Math.floor(Date.now() / 1000);
    const rotation = await signJws(
      {
        schemaVersion: 1,
        aud: PRODUCT,
        iss: "key.plrs.im",
        issuedAt: now,
        expiresAt: now + 300,
        jwksUrl: "https://k.test/djdl/.well-known/jwks.json",
        cacheSeconds: 300,
        keys: [
          {
            kid: "pkey-rotated-2027",
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
    );
    let trustFetches = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("polaris-trust.jws")) {
        trustFetches += 1;
        return new Response(rotation, { status: 200 });
      }
      if (u.pathname.endsWith("/config"))
        return new Response("", { status: 500 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = clientOn(configDir, { fetchImpl, trustRefresh: true });
    await client.init();
    await client.refresh();

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
    const entitled = {
      config: {},
      secrets: {},
      entitlements: { pro: { state: "enforced", value: true, updatedAt: 0 } },
    } as ManagedConfigDoc["payload"];

    // A current doc, and the same user's year-old captured doc from when they had a licence.
    const current = await signJws(
      makeDoc({ deviceId: "device-under-attack", payload: entitled }),
      VENDOR_PEM,
      VENDOR_KID,
    );
    const captured = await signJws(
      makeDoc({
        licenseId: "lic_last_year",
        deviceId: "device-under-attack",
        issuedAt: now - 365 * DAY,
        expiresAt: now - 365 * DAY + HOUR,
        graceUntil: now - 65 * DAY,
        payload: entitled,
      }),
      VENDOR_PEM,
      VENDOR_KID,
    );

    let serve = current;
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/config"))
        return new Response(serve, { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // Round 1: accept the current doc, which sets the derived floor.
    plantCache(
      configDir,
      { v: CACHE_VERSION } satisfies CacheRecord,
      "device-under-attack",
    );
    const c1 = clientOn(configDir, { fetchImpl });
    await c1.init();
    expect((await c1.refresh()).applied).toBe(true);
    // Round 2: same doc, correctly rejected as a replay against the derived floor.
    expect((await c1.refresh()).applied).toBe(false);
    c1.close();

    // Round 3: `rm ~/.config/djdl/managed.json` wipes the floor — and the captured doc is
    // STILL refused, because §3 will not accept a document that expired a year ago.
    rmSync(join(configDir, PRODUCT, "managed.json"));
    serve = captured;
    const c2 = clientOn(configDir, { fetchImpl });
    await c2.init();
    expect((await c2.refresh()).applied).toBe(false);
    expect(c2.isEntitled("pro")).toBe(false);
    expect(c2.status().status).toBe("needs-activation");
    c2.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-04 — The gate read the raw wall clock: no monotonic floor, no server-time anchor.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-04: clock rollback / grace extension", () => {
  // FIXED (R4-04) — §4.3. The gate evaluates at `max(systemClock, highWaterMark)`, where the
  // high-water mark is the greatest `issuedAt` ever VERIFIED, recomputed at load from the
  // cached JWS. Winding the clock back below it buys nothing, and the planted cache that made
  // the original PoC cheap does not survive re-verification at all.
  it("re-enters 'ok' when the system clock is moved back inside a long-expired doc's window, and never notices lastVerifiedAt is in the future", async () => {
    const configDir = tempConfigDir();
    const realNow = Math.floor(Date.now() / 1000);
    const issued = realNow - 400 * DAY;

    // (a) The original hand-written cache is simply not loadable any more.
    plantCache(
      configDir,
      {
        doc: makeDoc({
          issuedAt: issued,
          expiresAt: issued + HOUR,
          graceUntil: issued + 30 * DAY,
          payload: {
            config: {},
            secrets: {},
            entitlements: {
              pro: { state: "enforced", value: true, updatedAt: 0 },
            },
          },
        }),
        lastAcceptedIssuedAt: issued,
        lastVerifiedAt: realNow * 1000,
      },
      "device-under-attack",
    );
    const planted = clientOn(configDir);
    await planted.init();
    expect(planted.status(realNow).status).toBe("needs-activation");
    expect(planted.isLicensed(issued + 60)).toBe(false); // rollback gains nothing
    planted.close();

    // (b) Now do it the honest way: a genuine, signed, current document in the cache. The
    //     high-water mark it establishes is what makes the rollback inert.
    const signed = await signJws(
      makeDoc({
        deviceId: "device-under-attack",
        issuedAt: realNow,
        expiresAt: realNow + HOUR,
        graceUntil: realNow + 30 * DAY,
        payload: {
          config: {},
          secrets: {},
          entitlements: {
            pro: { state: "enforced", value: true, updatedAt: 0 },
          },
        },
      }),
      VENDOR_PEM,
      VENDOR_KID,
    );
    plantCache(
      configDir,
      { v: CACHE_VERSION, configJws: signed } satisfies CacheRecord,
      "device-under-attack",
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
    client.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// R4-05 — A tampered cache was echoed verbatim to the server via POST /config/report.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe("R4-05: forged cache is reported to the control plane as ground truth", () => {
  // FIXED (R4-05, as a consequence of R4-01) — the snapshot is built from the re-verified
  // document, so there is no attacker-authored map left to echo. The server's one signal that
  // would reveal a forgery is no longer authored by the forgery.
  it("POSTs the attacker's entitlement/config map to /config/report", async () => {
    const configDir = tempConfigDir();
    plantCache(
      configDir,
      {
        doc: makeDoc({
          expiresAt: 316_000_000_000,
          graceUntil: 316_000_000_000,
          payload: {
            config: {
              "quality.floor": {
                state: "enforced",
                value: "lossless",
                updatedAt: 0,
              },
            },
            secrets: {},
            entitlements: {
              enterprise: { state: "enforced", value: true, updatedAt: 0 },
            },
          },
        }),
        lastAcceptedIssuedAt: 316_000_000_000,
      },
      "device-under-attack",
    );
    let reported: { config?: unknown; entitlements?: unknown } | null = null;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/config/report")) {
        reported = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      }
      if (u.pathname.endsWith("/config"))
        return new Response("", { status: 304 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = clientOn(configDir, { fetchImpl });
    await client.init();
    await client.refresh();

    expect(reported).not.toBeNull();
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
    plantCache(
      configDir,
      { v: CACHE_VERSION } satisfies CacheRecord,
      "device-under-attack",
    );
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
  // slowloris on the trust endpoint can no longer stall `refresh()` (and therefore the
  // interval tick) indefinitely.
  it("passes no AbortSignal/timeout to fetch, so a slowloris on the trust endpoint hangs refresh() forever and interval ticks pile up unbounded", async () => {
    const configDir = tempConfigDir();
    plantCache(
      configDir,
      { v: CACHE_VERSION } satisfies CacheRecord,
      "device-under-attack",
    );
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
    // refreshTrust() is still awaited before /config, but it can no longer hang: the deadline
    // fires, the error is swallowed, and the refresh completes.
    await Promise.all([client.refresh(), client.refresh(), client.refresh()]);

    expect(sawSignal).toBe(true); // the client supplies a signal on every request
    expect(aborted).toBeGreaterThanOrEqual(3); // …and it actually fires
    client.close();
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
