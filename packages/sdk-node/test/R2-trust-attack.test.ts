// R2 RED TEAM — attacks on client-side key custody + document acceptance in @polaris-key/node.
//
// These began life as PoCs asserting the CURRENT (vulnerable) behaviour. They have now been
// INVERTED: every test asserts that the attack FAILS, so each one is the regression test for
// the fix named in its `// FIXED (…)` comment. Threat model is unchanged — for a licensing
// SDK the *user of the machine* is a first-class adversary, and so is any process running as
// that user (a malicious npm postinstall, a synced/restored `~/.config`, an XDG_CONFIG_HOME
// pointed at a shared directory, a backup restore). Nothing below patches the app binary.
//
// Remediation reference: docs/security/WIRE-CONTRACT-V2.md §1 (trust set), §3 (claims),
// §4 (cache integrity), §5 (ETag freshness).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signJws, base64UrlEncodeBytes } from "@polaris-key/jws";
import type { ManagedConfigDoc, TrustManifestDoc } from "@polaris-key/protocol";
import { PolarisKeyClient } from "../src/client.js";
import { verifyDoc } from "../src/verify.js";
import { mergeTrust, verifyTrustManifest } from "../src/trust.js";
import { CACHE_VERSION, FileStore, type CacheRecord } from "../src/store.js";

// ── The legitimate, PINNED product key (the corpus test key) ───────────────────
const PINNED_KID = "pkey-test-prod-2026";
const PINNED_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const PINNED_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const PRODUCT = "djdl";
const BASE = "https://k.test";
const nowSec = (): number => Math.floor(Date.now() / 1000);

afterEach(() => {
  vi.useRealTimers();
});

type WebCryptoKey = Parameters<typeof crypto.subtle.exportKey>[1];

/** Freshly generated ATTACKER Ed25519 keypair — no relationship to the pinned key. */
async function attackerKey(): Promise<{ pem: string; pub: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as { privateKey: WebCryptoKey; publicKey: WebCryptoKey };
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const pem = `-----BEGIN PRIVATE KEY-----\n${(b64.match(/.{1,64}/g) ?? [b64]).join("\n")}\n-----END PRIVATE KEY-----`;
  return { pem, pub: base64UrlEncodeBytes(raw) };
}

interface DocOverrides {
  deviceId: string;
  issuedAt?: number;
  expiresAt?: number;
  graceUntil?: number;
  iss?: string;
  aud?: string;
  schemaVersion?: number;
  entitlement?: boolean;
  secret?: string;
  concurrency?: number;
}

function makeDoc(o: DocOverrides): ManagedConfigDoc {
  const t = o.issuedAt ?? nowSec();
  return {
    schemaVersion: o.schemaVersion ?? 1,
    aud: o.aud ?? PRODUCT,
    iss: o.iss ?? "key.plrs.im",
    licenseId: "lic_r2",
    deviceId: o.deviceId,
    issuedAt: t,
    expiresAt: o.expiresAt ?? t + 3600,
    graceUntil: o.graceUntil ?? t + 30 * 86400,
    profile: {
      name: "Mallory",
      firstName: "Mallory",
      email: "mallory@evil.test",
      activatedAt: t,
    },
    payload: {
      config: {
        "quality.floor": {
          state: "enforced",
          value: o.concurrency ?? 9999,
          updatedAt: t,
        },
      },
      secrets: {
        "soundcloud.oauth": {
          state: "hidden",
          value: o.secret ?? "FORGED-SECRET",
          updatedAt: t,
        },
      },
      entitlements: {
        polarisVpn: {
          state: "enforced",
          value: o.entitlement ?? true,
          updatedAt: t,
        },
      },
    },
  };
}

function readMaybe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function tempStore(): { dir: string; store: FileStore; cachePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pkey-r2-"));
  const store = new FileStore(PRODUCT, dir);
  return { dir, store, cachePath: join(dir, PRODUCT, "managed.json") };
}

function manifest(
  keys: TrustManifestDoc["keys"],
  issuedAt: number,
): TrustManifestDoc {
  return {
    schemaVersion: 1,
    aud: PRODUCT,
    iss: "key.plrs.im",
    issuedAt,
    expiresAt: issuedAt + 300,
    jwksUrl: `${BASE}/${PRODUCT}/.well-known/jwks.json`,
    cacheSeconds: 300,
    keys,
  };
}

const PINNED_ENTRY = {
  kid: PINNED_KID,
  alg: "EdDSA" as const,
  kty: "OKP" as const,
  crv: "Ed25519" as const,
  publicKey: PINNED_PUB,
  status: "active" as const,
};

interface Route {
  /** Serve /config signed with this PEM under this kid. */
  configSigner?: { pem: string; kid: string };
  /** Doc overrides for the served /config doc. */
  docOpts?: Partial<DocOverrides>;
  /** Ordered trust manifests; each refresh consumes the next (last one repeats). */
  manifests?: Array<{ doc: TrustManifestDoc; pem: string; kid: string }>;
}

function mockFetch(route: Route): {
  impl: typeof fetch;
  paths: string[];
  manifestIndex: () => number;
} {
  const paths: string[] = [];
  let mi = 0;
  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    paths.push(u.pathname);

    if (u.pathname.endsWith("/polaris-trust.jws")) {
      const list = route.manifests ?? [];
      if (list.length === 0) return new Response("", { status: 404 });
      const entry = list[Math.min(mi, list.length - 1)]!;
      mi++;
      return new Response(await signJws(entry.doc, entry.pem, entry.kid), {
        status: 200,
        headers: { "content-type": "application/jose" },
      });
    }
    if (u.pathname.endsWith("/config/report"))
      return new Response("{}", { status: 200 });
    if (u.pathname.endsWith("/config")) {
      const signer = route.configSigner ?? { pem: PINNED_PEM, kid: PINNED_KID };
      const doc = makeDoc({
        deviceId: headers.get("x-pkey-device") ?? "d",
        ...route.docOpts,
      });
      return new Response(await signJws(doc, signer.pem, signer.kid), {
        status: 200,
        headers: { "content-type": "application/jose", etag: '"r2"' },
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, paths, manifestIndex: () => mi };
}

// ══════════════════════════════════════════════════════════════════════════════
describe("R2-02 · trust-set poisoning: the on-disk cache OVERRIDES a pinned kid", () => {
  // FIXED (R2-01 / R4-02) — §1.1. The cache is no longer a key source at all: it persists the
  // trust manifest's compact JWS, which is re-verified against the PINNED keys on every load,
  // and the merge is `{...manifestKeys, ...pinnedKeys}` so a pin is terminal.
  it("a planted managed.json key replaces the pinned public key, so an attacker-signed doc verifies", async () => {
    const atk = await attackerKey();
    const { store, cachePath } = tempStore();
    await store.setToken("pkeyt_whatever");

    // THE ATTACK, verbatim: one file write planting the PINNED kid with attacker key bytes.
    // Under v2 this record is a v1 record — no `v` field — so it is DISCARDED, not migrated
    // (§7.3), and `trustedKeys` is not a field the client reads under any version.
    writeFileSync(
      cachePath,
      JSON.stringify({
        doc: null,
        lastAcceptedIssuedAt: 0,
        trustedKeys: { [PINNED_KID]: atk.pub },
      }),
    );

    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } }, // <- the real, pinned key
      trustRefresh: false,
      store,
      fetchImpl: mockFetch({
        configSigner: { pem: atk.pem, kid: PINNED_KID }, // signed by the ATTACKER
        docOpts: { entitlement: true, secret: "ATTACKER-OWNED" },
      }).impl,
    });

    const r = await client.refresh({ force: true });
    expect(r.applied).toBe(false); //  <-- forged document REJECTED
    expect(client.isLicensed()).toBe(false);
    expect(client.isEntitled("polarisVpn")).toBe(false);
    expect(client.getSecret("soundcloud.oauth")).toBeNull();
    expect(client.getProfile()).toBeNull();
    client.close();
  });

  // FIXED (R2-01) — §1.1 rule 1. Even a manifest signed by the GENUINE pinned key may not
  // re-point a pinned kid: presenting a pinned kid with different bytes is a substitution
  // attempt, so the whole manifest is rejected and the previous trust set is kept.
  it("control: WITHOUT the planted cache the identical forged doc is rejected", async () => {
    const atk = await attackerKey();
    const { store } = tempStore();
    await store.setToken("pkeyt_whatever");
    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
      trustRefresh: false,
      store,
      fetchImpl: mockFetch({ configSigner: { pem: atk.pem, kid: PINNED_KID } })
        .impl,
    });
    const r = await client.refresh({ force: true });
    expect(r.applied).toBe(false);
    expect(client.isLicensed()).toBe(false);
    client.close();

    // The same rule, expressed against the manifest path directly: a genuine, correctly
    // signed manifest that swaps the pinned kid's bytes is refused WHOLESALE — not merged
    // with the substitution silently dropped.
    const t = nowSec();
    const substitution = await signJws(
      manifest([{ ...PINNED_ENTRY, publicKey: atk.pub }], t),
      PINNED_PEM,
      PINNED_KID,
    );
    const result = await verifyTrustManifest(substitution, {
      pinned: { [PINNED_KID]: PINNED_PUB },
      expectedAud: PRODUCT,
    });
    expect(result.doc).toBeNull();
    expect(result.discovered).toEqual({});
  });

  // FIXED (R2-01 amplifier) — §4.2. Manifests are verified against the PINNED keys ONLY,
  // never against the current (possibly extended) trust set, so a planted or rotated key can
  // never sign the manifest that mints the next key. The poisoning cannot self-perpetuate.
  it("the poisoned trust set is also accepted for TRUST MANIFESTS — the attacker can self-perpetuate", async () => {
    const atk = await attackerKey();
    const atk2 = await attackerKey();
    const { store, cachePath } = tempStore();
    await store.setToken("pkeyt_whatever");
    writeFileSync(
      cachePath,
      JSON.stringify({
        doc: null,
        lastAcceptedIssuedAt: 0,
        trustedKeys: { [PINNED_KID]: atk.pub },
      }),
    );

    const t = nowSec();
    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
      trustRefresh: true,
      store,
      fetchImpl: mockFetch({
        // Manifest signed by the PLANTED key, minting a brand-new attacker kid.
        manifests: [
          {
            pem: atk.pem,
            kid: PINNED_KID,
            doc: manifest(
              [
                {
                  kid: "attacker-forever-2099",
                  alg: "EdDSA",
                  kty: "OKP",
                  crv: "Ed25519",
                  publicKey: atk2.pub,
                  status: "active",
                },
              ],
              t,
            ),
          },
        ],
        configSigner: { pem: atk2.pem, kid: "attacker-forever-2099" },
      }).impl,
    });

    const r = await client.refresh({ force: true });
    expect(r.applied).toBe(false);
    // Nothing was installed: the manifest never verified against the pins, so no trustJws was
    // persisted and `attacker-forever-2099` is unknown on this device and every future run.
    const persisted = JSON.parse(
      readFileSync(cachePath, "utf8"),
    ) as CacheRecord;
    expect(persisted.trustJws).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain("attacker-forever-2099");
    client.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("R2-03 · no client-side key revocation: the trust set only ever GROWS", () => {
  // FIXED (R2-02) — §1.2 rule 4. The trust set becomes exactly `pinned ∪ {manifest keys with
  // status ≠ revoked}` on every refresh. A kid the server stops publishing is DROPPED, which
  // is what restores revocation-by-omission.
  it("a key dropped from a later signed manifest stays trusted forever", async () => {
    const rotated = await attackerKey(); // stand-in for a key that later gets revoked
    const { store, cachePath } = tempStore();
    await store.setToken("pkeyt_whatever");
    const t = nowSec();

    const ROTATED = {
      kid: "product-key-2026",
      alg: "EdDSA" as const,
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      publicKey: rotated.pub,
      status: "active" as const,
    };

    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
      trustRefresh: true,
      store,
      fetchImpl: mockFetch({
        manifests: [
          // 1. Server publishes both keys.
          {
            pem: PINNED_PEM,
            kid: PINNED_KID,
            doc: manifest([PINNED_ENTRY, ROTATED], t),
          },
          // 2. Operator REVOKES `product-key-2026`: repo.ts's listVerificationProductKeys
          //    filters status='revoked' out, so it simply disappears from the manifest.
          {
            pem: PINNED_PEM,
            kid: PINNED_KID,
            doc: manifest([PINNED_ENTRY], t + 10),
          },
        ],
        // /config is served by the REVOKED key.
        configSigner: { pem: rotated.pem, kid: "product-key-2026" },
      }).impl,
    });

    // Refresh #1 learns the key and the doc it signs is applied…
    expect((await client.refresh({ force: true })).applied).toBe(true);
    expect(client.isEntitled("polarisVpn")).toBe(true);
    // …refresh #2 sees the revocation manifest and prunes it, so the same signer's document
    // is no longer accepted.
    expect((await client.refresh({ force: true })).applied).toBe(false);

    // Rebuild the persisted trust set through the production path: the revoked kid is gone.
    const persisted = JSON.parse(
      readFileSync(cachePath, "utf8"),
    ) as CacheRecord;
    const reloaded = await verifyTrustManifest(persisted.trustJws!, {
      pinned: { [PINNED_KID]: PINNED_PUB },
      expectedAud: PRODUCT,
      checkFreshness: false,
    });
    const trust = mergeTrust({ [PINNED_KID]: PINNED_PUB }, reloaded.discovered);
    expect(trust["product-key-2026"]).toBeUndefined();
    expect(trust[PINNED_KID]).toBe(PINNED_PUB);

    // And it no longer signs valid documents.
    const doc = await verifyDoc(
      await signJws(
        makeDoc({ deviceId: await store.getDeviceId(), issuedAt: t + 999 }),
        rotated.pem,
        "product-key-2026",
      ),
      {
        trust,
        expectedAud: PRODUCT,
        deviceId: await store.getDeviceId(),
      },
    );
    expect(doc).toBeNull();
    client.close();
  });

  // FIXED (R2-02) — §1.2. `status` is now read. Note the table is deliberate: `retired` and
  // `staged` MAY still verify (in-flight docs must not break, and a key must be trusted
  // before it signs or rotation can never land). `revoked` is the status that must fail, and
  // it is the one this test now pins.
  it("`status` is ignored: a manifest key marked `retired` is merged as fully trusted", async () => {
    const retired = await attackerKey();
    const revoked = await attackerKey();
    const t = nowSec();
    const mixed = await signJws(
      manifest(
        [
          PINNED_ENTRY,
          {
            kid: "long-retired-2019",
            alg: "EdDSA",
            kty: "OKP",
            crv: "Ed25519",
            publicKey: retired.pub,
            status: "retired",
          },
          {
            kid: "compromised-2025",
            alg: "EdDSA",
            kty: "OKP",
            crv: "Ed25519",
            publicKey: revoked.pub,
            // Explicitly published as revoked — the positive signal §1.2 requires the server
            // to emit for at least 2× cacheSeconds before falling back to prune-on-absence.
            status: "revoked",
          } as unknown as TrustManifestDoc["keys"][number],
        ],
        t,
      ),
      PINNED_PEM,
      PINNED_KID,
    );

    const result = await verifyTrustManifest(mixed, {
      pinned: { [PINNED_KID]: PINNED_PUB },
      expectedAud: PRODUCT,
    });
    expect(result.doc).not.toBeNull();
    expect(result.discovered["long-retired-2019"]).toBe(retired.pub); // per §1.2
    expect(result.discovered["compromised-2025"]).toBeUndefined(); // REFUSED

    // End to end: the revoked key cannot sign an accepted /config document.
    const { store } = tempStore();
    await store.setToken("pkeyt_whatever");
    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
      trustRefresh: true,
      store,
      fetchImpl: mockFetch({
        manifests: [
          {
            pem: PINNED_PEM,
            kid: PINNED_KID,
            doc: JSON.parse(
              Buffer.from(mixed.split(".")[1]!, "base64url").toString("utf8"),
            ) as TrustManifestDoc,
          },
        ],
        configSigner: { pem: revoked.pem, kid: "compromised-2025" },
      }).impl,
    });
    expect((await client.refresh({ force: true })).applied).toBe(false);
    expect(client.isLicensed()).toBe(false);
    client.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("R2-04 · the cached document is NEVER re-verified when it is loaded", () => {
  // FIXED (R2-03 / R4-01) — §4.1/§4.2. The cache stores the compact JWS and nothing else, and
  // it is re-verified against the pinned keys on every load. A hand-written document has no
  // signature to re-check, so it is simply not a document.
  it("a hand-written managed.json with no signature at all yields full entitlements + secrets", async () => {
    const { store, cachePath } = tempStore();
    await store.setToken("pkeyt_whatever");
    const t = nowSec();
    writeFileSync(
      cachePath,
      JSON.stringify({
        doc: makeDoc({
          deviceId: await store.getDeviceId(),
          issuedAt: t,
          graceUntil: t + 100 * 365 * 86400, // a century of "grace"
          secret: "NEVER-SIGNED",
        }),
        lastAcceptedIssuedAt: 0,
        lastVerifiedAt: Date.now(),
      }),
    );

    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
      trustRefresh: false,
      store,
      // No network at all — offline-first path.
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as typeof fetch,
    });

    expect(client.status().status).toBe("needs-activation");
    expect(client.isLicensed()).toBe(false);
    expect(client.isEntitled("polarisVpn")).toBe(false);
    expect(client.getSecret("soundcloud.oauth")).toBeNull();
    client.close();

    // The same holds for a v2-shaped record carrying a doc that was never signed by a pinned
    // key: an attacker-signed JWS is re-verified and refused.
    const atk = await attackerKey();
    writeFileSync(
      cachePath,
      JSON.stringify({
        v: CACHE_VERSION,
        configJws: await signJws(
          makeDoc({ deviceId: await store.getDeviceId(), issuedAt: t }),
          atk.pem,
          PINNED_KID,
        ),
      } satisfies CacheRecord),
    );
    const c2 = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
      trustRefresh: false,
      store,
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as typeof fetch,
    });
    expect(c2.status().status).toBe("needs-activation");
    c2.close();
  });

  // FIXED (R2-03 / R4-03) — §4.1/§4.2. There is no `lastAcceptedIssuedAt` on disk to rewrite:
  // the replay floor is DERIVED from the issuedAt of the cached document after it has been
  // re-verified. Lowering the floor now requires forging a signature.
  it("`lastAcceptedIssuedAt` lives in the same attacker-writable file, so anti-replay is resettable", async () => {
    const { store, cachePath } = tempStore();
    await store.setToken("pkeyt_whatever");
    const deviceId = await store.getDeviceId();
    const t = nowSec();

    // A genuine, current document is cached — that sets the floor at its issuedAt.
    const current = await signJws(
      makeDoc({ deviceId, issuedAt: t }),
      PINNED_PEM,
      PINNED_KID,
    );
    writeFileSync(
      cachePath,
      JSON.stringify({
        v: CACHE_VERSION,
        configJws: current,
        // The attacker adds the old counter back by hand. It is not a field any more.
        lastAcceptedIssuedAt: 0,
      }),
    );

    // An older, genuinely-signed document (e.g. a captured higher-tier doc) is replayed.
    const replayed = await signJws(
      makeDoc({ deviceId, issuedAt: t - 86400, secret: "REPLAYED" }),
      PINNED_PEM,
      PINNED_KID,
    );
    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
      trustRefresh: false,
      store,
      fetchImpl: (async (input: string | URL | Request) => {
        const u = new URL(String(input));
        if (u.pathname.endsWith("/config/report"))
          return new Response("{}", { status: 200 });
        if (u.pathname.endsWith("/config"))
          return new Response(replayed, { status: 200 });
        return new Response("", { status: 404 });
      }) as typeof fetch,
    });

    expect((await client.refresh({ force: true })).applied).toBe(false);
    expect(client.getSecret("soundcloud.oauth")).toBe("FORGED-SECRET"); // still the current doc
    client.close();

    // And the floor is genuinely derived — verifyDoc rejects the older doc against it.
    expect(
      await verifyDoc(replayed, {
        trust: { [PINNED_KID]: PINNED_PUB },
        expectedAud: PRODUCT,
        deviceId,
        lastAcceptedIssuedAt: t,
      }),
    ).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("R2-08 · verifyDoc omits iss / expiresAt / schemaVersion / licenseId + has zero clock skew", () => {
  // FIXED (R2-08) — §3. `iss` and the freshness window are asserted, so the document is never
  // accepted and never reaches disk. (`schemaVersion: 999` is deliberately still fine: that
  // field carries the product CATALOG version, not a wire-format id — see verify.ts.)
  it("a LONG-expired doc with a foreign `iss` and an unknown schemaVersion verifies and is cached", async () => {
    const { store, cachePath } = tempStore();
    await store.setToken("pkeyt_whatever");
    const t = nowSec() - 400 * 86400; // 400 days ago

    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
      trustRefresh: false,
      store,
      fetchImpl: mockFetch({
        docOpts: {
          issuedAt: t,
          expiresAt: t + 3600, // long expired
          graceUntil: t + 86400, // grace long gone
          iss: "https://evil.example", // now CHECKED
          schemaVersion: 999, // legitimate catalog version
        },
      }).impl,
    });

    const r = await client.refresh({ force: true });
    expect(r.applied).toBe(false); // refused at verify, not merely at the gate
    // Nothing reached disk at all — v1 wrote the doc verbatim, foreign `iss` and all.
    const raw = readMaybe(cachePath);
    if (raw !== null) {
      const persisted = JSON.parse(raw) as CacheRecord;
      expect(persisted.configJws).toBeUndefined();
      expect(raw).not.toContain("evil.example");
    }

    // Nothing to read: an unverifiable document is not a document.
    expect(client.status().status).toBe("needs-activation");
    expect(client.isLicensed()).toBe(false);
    expect(client.isEntitled("polarisVpn")).toBe(false);
    expect(client.getSecret("soundcloud.oauth")).toBeNull();
    expect(client.getConfig("quality.floor", 1)).toBe(1);
    client.close();
  });

  // FIXED (R2-11) — §5. A 304 means "content unchanged, freshness RENEWED". Past the cached
  // doc's half-life the client re-asks unconditionally so the server re-signs the window; a
  // continuously online client can no longer drift into `grace` behind a content-stable ETag.
  it("R2-11: a 304 (content-only ETag) never refreshes the signed validity window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_000;
    vi.setSystemTime(t0 * 1000);

    const { store } = tempStore();
    await store.setToken("pkeyt_whatever");
    let served = 0;
    const impl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      const headers = new Headers(init?.headers);
      if (u.pathname.endsWith("/config/report"))
        return new Response("{}", { status: 200 });
      if (u.pathname.endsWith("/config")) {
        // Server re-mints with a fresh `now` each time, but the ETag is content-only.
        if (headers.get("if-none-match") === '"stable-content"')
          return new Response(null, {
            status: 304,
            headers: { etag: '"stable-content"' },
          });
        served++;
        const doc = makeDoc({
          deviceId: headers.get("x-pkey-device") ?? "d",
          issuedAt: Math.floor(Date.now() / 1000),
        });
        return new Response(await signJws(doc, PINNED_PEM, PINNED_KID), {
          status: 200,
          headers: { etag: '"stable-content"' },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
      trustRefresh: false,
      store,
      fetchImpl: impl,
    });
    await client.refresh({ force: true }); // first fetch → 200
    expect(served).toBe(1);

    // Inside the half-life the conditional request is still a pure optimisation: 304s are
    // taken at face value and cost the server nothing.
    for (let i = 0; i < 5; i++) await client.refresh();
    expect(served).toBe(1);

    // Past the half-life the client escalates: the 304 is followed by an unconditional
    // re-request, so a freshly signed window lands…
    vi.setSystemTime((t0 + 1801) * 1000);
    await client.refresh();
    expect(served).toBe(2);

    // …and the client stays `ok` well beyond the FIRST doc's expiry instead of drifting.
    vi.setSystemTime((t0 + 3601) * 1000);
    expect(client.status().status).toBe("ok");
    await client.refresh();
    vi.setSystemTime((t0 + 31 * 86400) * 1000);
    await client.refresh();
    expect(client.status().status).toBe("ok");
    client.close();
  });

  // FIXED (R2-08) — §3. CLOCK_SKEW = 300 in every implementation, and `issuedAt` now has an
  // upper bound, so a far-future document is refused rather than gating `ok`.
  it("zero clock-skew tolerance: one second of client clock drift flips a fresh doc into `grace`", async () => {
    const deviceId = "dev_fixture";
    const t = nowSec();
    const jws = await signJws(
      makeDoc({ deviceId, issuedAt: t }),
      PINNED_PEM,
      PINNED_KID,
    );
    // A client up to CLOCK_SKEW seconds fast still accepts a brand-new document.
    const doc = await verifyDoc(jws, {
      trust: { [PINNED_KID]: PINNED_PUB },
      expectedAud: PRODUCT,
      deviceId,
      now: t - 300,
    });
    expect(doc).not.toBeNull();

    // And a doc issued in the FUTURE is now refused outright — there is an `iat` sanity check.
    const future = await verifyDoc(
      await signJws(
        makeDoc({ deviceId, issuedAt: t + 10 * 365 * 86400 }),
        PINNED_PEM,
        PINNED_KID,
      ),
      { trust: { [PINNED_KID]: PINNED_PUB }, expectedAud: PRODUCT, deviceId },
    );
    expect(future).toBeNull();
  });
});
