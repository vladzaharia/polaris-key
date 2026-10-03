// @pkey-feature core.verify core.cache
// R2 RED TEAM — attacks on client-side key custody + document acceptance in @polaris-key/node.
//
// These began life as PoCs asserting the CURRENT (vulnerable) behaviour. They have now been
// INVERTED: every test asserts that the attack FAILS, so each one is the regression test for
// the fix named in its `// FIXED (…)` comment. Threat model is unchanged — for a licensing
// SDK the *user of the machine* is a first-class adversary, and so is any process running as
// that user (a malicious npm postinstall, a synced/restored `~/.config`, an XDG_CONFIG_HOME
// pointed at a shared directory, a backup restore). Nothing below patches the app binary.
//
// Ported to wire contract v3. What the port changed, and why each change is itself a pin:
//
//   * ONE fused document became TWO (§2.1/§2.2), fetched IN PARALLEL from `/license/document`
//     and `/config/document`, so every fixture answers both and a forgery has to beat both.
//   * `refresh()` became `sync()` (§5); the god-object client became Core + sub-clients, so the
//     reads live on `client.license.*` / `client.config.*`.
//   * `signJws` MUST be handed a `typ`: v3 sets `requireTyp`, so an untyped JWS is refused
//     outright and cross-document replay is closed by construction.
//   * `iss` is the fixed `key.plrs.im`. Any OTHER issuer is REFUSED — pinned explicitly below,
//     because "a second issuer also verifies" would let a document minted under a different
//     name stand in for the real one.
//   * The cache is v3 (§4.1). A record whose `v !== 3` is DISCARDED, never migrated, which is
//     what makes every "plant a JSON file" PoC in this file inert before a byte is read.
//
// Remediation reference: docs/security/WIRE-CONTRACT-V3.md §1 (trust set), §3 (claims),
// §4 (cache integrity + clock floor), §5 (ETag freshness).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signJws, base64UrlEncodeBytes } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { TrustManifestDoc } from "@polaris-key/protocol/trust";
import {
  mergeTrust,
  verifyConfigDoc,
  verifyLicenseDoc,
  verifyTrustManifest,
  type CacheRecordV3,
} from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { CACHE_VERSION, FileStore } from "../src/core/store.js";

// ── The legitimate, PINNED product key (the corpus test key) ───────────────────
const PINNED_KID = "pkey-test-prod-2026";
const PINNED_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const PINNED_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const PRODUCT = "djdl";
const BASE = "https://k.test";
/** v3 credential prefix (§8). The value is never checked by the client — holding *a* token is
 *  what makes `sync()` go to the network at all, which is what these attacks need. */
const TOKEN = "pkeyt_whatever";
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

/** §2.1 — grants only. `entitlements` and `profile` moved HERE out of the fused v2 doc. */
function makeLicenseDoc(o: DocOverrides): LicenseDoc {
  const t = o.issuedAt ?? nowSec();
  return {
    iss: o.iss ?? ISSUER,
    aud: o.aud ?? PRODUCT,
    deviceId: o.deviceId,
    issuedAt: t,
    expiresAt: o.expiresAt ?? t + 3600,
    graceUntil: o.graceUntil ?? t + 30 * 86400,
    licenseId: "lic_r2",
    profile: {
      name: "Mallory",
      firstName: "Mallory",
      email: "mallory@evil.test",
      activatedAt: t,
    },
    entitlements: {
      polarisVpn: {
        state: "enforced",
        value: o.entitlement ?? true,
        updatedAt: t,
      },
    },
  };
}

/** §2.2 — config + secrets only, and no licence fields whatsoever. */
function makeConfigDoc(o: DocOverrides): ConfigDoc {
  const t = o.issuedAt ?? nowSec();
  return {
    iss: o.iss ?? ISSUER,
    aud: o.aud ?? PRODUCT,
    deviceId: o.deviceId,
    issuedAt: t,
    expiresAt: o.expiresAt ?? t + 3600,
    graceUntil: o.graceUntil ?? t + 30 * 86400,
    // The product CATALOG version, not a wire-format id — see client-core's verify.ts. Any
    // positive integer is legitimate; the SHAPE is what §3 can actually enforce.
    schemaVersion: o.schemaVersion ?? 1,
    config: {
      "quality.floor": {
        state: "enforced",
        value: o.concurrency ?? 9999,
        updatedAt: t,
      },
    },
    secrets: {
      "serviceA.oauth": {
        state: "hidden",
        value: o.secret ?? "FORGED-SECRET",
        updatedAt: t,
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
    iss: ISSUER,
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

/** The shared client shape. Fingerprint probes shell out to `ioreg`/`sw_vers` and nothing
 *  here asserts on hardware, so they are off; `config.env` is pinned empty so an ambient
 *  `PKEY_CONFIG_*` in the developer's shell cannot change what a test observes. */
const base = {
  productSlug: PRODUCT,
  baseUrl: BASE,
  version: "1.2.3",
  trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
  license: { fingerprint: false },
  devices: { fingerprint: false },
  config: { env: {} },
} as const;

interface Route {
  /** Serve BOTH documents signed with this PEM under this kid. */
  docSigner?: { pem: string; kid: string };
  /** Overrides applied to both served documents. */
  docOpts?: Partial<DocOverrides>;
  /** Ordered trust manifests; each refresh consumes the next (last one repeats). */
  manifests?: Array<{ doc: TrustManifestDoc; pem: string; kid: string }>;
}

/**
 * The mock control plane. §5's routes: two independently-ETagged document GETs, the Core
 * telemetry POST, and the trust manifest. `/config` and `/config/report` are GONE in v3, so
 * a fixture that still answered them would be testing a surface no client calls.
 */
function mockFetch(route: Route): {
  impl: typeof fetch;
  paths: string[];
  manifestIndex: () => number;
} {
  const paths: string[] = [];
  let mi = 0;
  // §3 anti-replay is per TYPE and strictly-newer. A monotonic bump gives every re-mint a
  // distinct `issuedAt` without depending on the wall clock ticking between two calls.
  let bump = 0;
  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    paths.push(u.pathname);
    const device = headers.get("x-pkey-device") ?? "d";
    const signer = route.docSigner ?? { pem: PINNED_PEM, kid: PINNED_KID };

    if (u.pathname.endsWith("/polaris-trust.jws")) {
      const list = route.manifests ?? [];
      if (list.length === 0) return new Response("", { status: 404 });
      const entry = list[Math.min(mi, list.length - 1)]!;
      mi++;
      return new Response(
        await signJws(entry.doc, entry.pem, entry.kid, "pkey-trust+jws"),
        { status: 200, headers: { "content-type": "application/jose" } },
      );
    }
    // §6 — telemetry is a Core surface now (`POST /<p>/devices/report`).
    if (u.pathname.endsWith("/devices/report"))
      return new Response("{}", { status: 200 });
    if (u.pathname.endsWith("/license/document")) {
      const doc = makeLicenseDoc({
        deviceId: device,
        issuedAt: nowSec() + bump++,
        ...route.docOpts,
      });
      return new Response(
        await signJws(doc, signer.pem, signer.kid, "pkey-license+jws"),
        {
          status: 200,
          headers: { "content-type": "application/jose", etag: '"r2-lic"' },
        },
      );
    }
    if (u.pathname.endsWith("/config/document")) {
      const doc = makeConfigDoc({
        deviceId: device,
        issuedAt: nowSec() + bump++,
        ...route.docOpts,
      });
      return new Response(
        await signJws(doc, signer.pem, signer.kid, "pkey-config+jws"),
        {
          status: 200,
          headers: { "content-type": "application/jose", etag: '"r2-cfg"' },
        },
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, paths, manifestIndex: () => mi };
}

// ══════════════════════════════════════════════════════════════════════════════
describe("R2-02 · trust-set poisoning: the on-disk cache OVERRIDES a pinned kid", () => {
  // FIXED (R2-01 / R4-02) — §1. The cache is no longer a key source at all: it persists the
  // trust manifest's compact JWS, which is re-verified against the PINNED keys on every load,
  // and the merge is `{...manifestKeys, ...pinnedKeys}` so a pin is terminal.
  it("a planted managed.json key replaces the pinned public key, so an attacker-signed doc verifies", async () => {
    const atk = await attackerKey();
    const { store, cachePath } = tempStore();
    await store.setToken(TOKEN);

    // THE ATTACK, verbatim: one file write planting the PINNED kid with attacker key bytes.
    // Under v3 this record has no `v`, so it is DISCARDED before a field is read (§4.1) — and
    // `trustedKeys` is not a field the client reads under ANY version.
    writeFileSync(
      cachePath,
      JSON.stringify({
        doc: null,
        lastAcceptedIssuedAt: 0,
        trustedKeys: { [PINNED_KID]: atk.pub },
      }),
    );

    const m = mockFetch({
      docSigner: { pem: atk.pem, kid: PINNED_KID }, // signed by the ATTACKER
      docOpts: { entitlement: true, secret: "ATTACKER-OWNED" },
    });
    const client = await PolarisKeyClient.create({
      ...base,
      trustRefresh: false,
      store,
      fetchImpl: m.impl,
    });

    const r = await client.sync({ force: true });
    expect(r.applied).toBe(false); //  <-- forged documents REJECTED
    // Not vacuous: both documents really were fetched and really were refused at verify.
    expect(m.paths).toContain(`/${PRODUCT}/license/document`);
    expect(m.paths).toContain(`/${PRODUCT}/config/document`);
    expect(r.documents.license?.kind).toBe("error");
    expect(r.documents.config?.kind).toBe("error");
    expect(client.isLicensed()).toBe(false);
    expect(client.license.isEntitled("polarisVpn")).toBe(false);
    expect(client.config.getSecret("serviceA.oauth")).toBeNull();
    expect(client.license.getProfile()).toBeNull();
    client.close();
  });

  // FIXED (R2-01) — §1 rule 1. Even a manifest signed by the GENUINE pinned key may not
  // re-point a pinned kid: presenting a pinned kid with different bytes is a substitution
  // attempt, so the whole manifest is rejected and the previous trust set is kept.
  it("control: WITHOUT the planted cache the identical forged doc is rejected", async () => {
    const atk = await attackerKey();
    const { store } = tempStore();
    await store.setToken(TOKEN);
    const client = await PolarisKeyClient.create({
      ...base,
      trustRefresh: false,
      store,
      fetchImpl: mockFetch({ docSigner: { pem: atk.pem, kid: PINNED_KID } })
        .impl,
    });
    const r = await client.sync({ force: true });
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
      "pkey-trust+jws",
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
    await store.setToken(TOKEN);
    writeFileSync(
      cachePath,
      JSON.stringify({
        doc: null,
        lastAcceptedIssuedAt: 0,
        trustedKeys: { [PINNED_KID]: atk.pub },
      }),
    );

    const t = nowSec();
    const m = mockFetch({
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
      docSigner: { pem: atk2.pem, kid: "attacker-forever-2099" },
    });
    const client = await PolarisKeyClient.create({
      ...base,
      trustRefresh: true,
      store,
      fetchImpl: m.impl,
    });

    const r = await client.sync({ force: true });
    expect(r.applied).toBe(false);
    expect(m.manifestIndex()).toBe(1); // the manifest WAS fetched — and refused at the pins
    // Nothing was installed: the manifest never verified against the pins, so no trustJws was
    // persisted and `attacker-forever-2099` is unknown on this device and every future run.
    const raw = readFileSync(cachePath, "utf8");
    const persisted = JSON.parse(raw) as CacheRecordV3;
    expect(persisted.trustJws).toBeUndefined();
    expect(persisted.docs).toBeUndefined();
    // The planted file was never even rewritten — a flush would have stamped it `v: 3`.
    expect(persisted.v).not.toBe(CACHE_VERSION);
    expect(raw).not.toContain("attacker-forever-2099");
    client.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("R2-03 · no client-side key revocation: the trust set only ever GROWS", () => {
  // FIXED (R2-02) — §1 rule 2. The trust set becomes exactly `pinned ∪ {manifest keys with
  // status ≠ revoked}` on every refresh. A kid the server stops publishing is DROPPED, which
  // is what restores revocation-by-omission.
  it("a key dropped from a later signed manifest stays trusted forever", async () => {
    const rotated = await attackerKey(); // stand-in for a key that later gets revoked
    const { store, cachePath } = tempStore();
    await store.setToken(TOKEN);
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
      ...base,
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
        // BOTH documents are served by the REVOKED key.
        docSigner: { pem: rotated.pem, kid: "product-key-2026" },
      }).impl,
    });

    // Sync #1 learns the key and the documents it signs are applied…
    expect((await client.sync({ force: true })).applied).toBe(true);
    expect(client.license.isEntitled("polarisVpn")).toBe(true);
    // …sync #2 sees the revocation manifest and prunes it, so the same signer's documents are
    // no longer accepted. Every served doc carries a strictly newer `issuedAt`, so the refusal
    // is the pruned key and not the §3 anti-replay floor.
    expect((await client.sync({ force: true })).applied).toBe(false);

    // Rebuild the persisted trust set through the production path: the revoked kid is gone.
    const persisted = JSON.parse(
      readFileSync(cachePath, "utf8"),
    ) as CacheRecordV3;
    const reloaded = await verifyTrustManifest(persisted.trustJws!, {
      pinned: { [PINNED_KID]: PINNED_PUB },
      expectedAud: PRODUCT,
      checkFreshness: false,
    });
    const trust = mergeTrust({ [PINNED_KID]: PINNED_PUB }, reloaded.discovered);
    expect(trust["product-key-2026"]).toBeUndefined();
    expect(trust[PINNED_KID]).toBe(PINNED_PUB);

    // And it no longer signs valid documents — on EITHER type.
    const deviceId = await store.getDeviceId();
    expect(
      await verifyLicenseDoc(
        await signJws(
          makeLicenseDoc({ deviceId, issuedAt: t + 999 }),
          rotated.pem,
          "product-key-2026",
          "pkey-license+jws",
        ),
        { trust, expectedAud: PRODUCT, deviceId },
      ),
    ).toBeNull();
    expect(
      await verifyConfigDoc(
        await signJws(
          makeConfigDoc({ deviceId, issuedAt: t + 999 }),
          rotated.pem,
          "product-key-2026",
          "pkey-config+jws",
        ),
        { trust, expectedAud: PRODUCT, deviceId },
      ),
    ).toBeNull();
    client.close();
  });

  // FIXED (R2-02) — §1. `status` is now read. Note the table is deliberate: `retired` and
  // `staged` MAY still verify (in-flight docs must not break, and a key must be trusted
  // before it signs or rotation can never land). `revoked` is the status that must fail, and
  // it is the one this test now pins.
  it("`status` is ignored: a manifest key marked `retired` is merged as fully trusted", async () => {
    const retired = await attackerKey();
    const staged = await attackerKey();
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
            kid: "next-year-2027",
            alg: "EdDSA",
            kty: "OKP",
            crv: "Ed25519",
            publicKey: staged.pub,
            status: "staged",
          },
          {
            kid: "compromised-2025",
            alg: "EdDSA",
            kty: "OKP",
            crv: "Ed25519",
            publicKey: revoked.pub,
            // Explicitly published as revoked — the positive signal §1 requires the server to
            // emit for at least 2× cacheSeconds before falling back to prune-on-absence.
            status: "revoked",
          } as unknown as TrustManifestDoc["keys"][number],
        ],
        t,
      ),
      PINNED_PEM,
      PINNED_KID,
      "pkey-trust+jws",
    );

    const result = await verifyTrustManifest(mixed, {
      pinned: { [PINNED_KID]: PINNED_PUB },
      expectedAud: PRODUCT,
    });
    expect(result.doc).not.toBeNull();
    expect(result.discovered["long-retired-2019"]).toBe(retired.pub); // per §1
    expect(result.discovered["next-year-2027"]).toBe(staged.pub); // rotation must be able to land
    expect(result.discovered["compromised-2025"]).toBeUndefined(); // REFUSED

    // End to end: the revoked key cannot sign an accepted document of either type.
    const { store } = tempStore();
    await store.setToken(TOKEN);
    const client = await PolarisKeyClient.create({
      ...base,
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
        docSigner: { pem: revoked.pem, kid: "compromised-2025" },
      }).impl,
    });
    const r = await client.sync({ force: true });
    expect(r.applied).toBe(false);
    expect(r.documents.license?.kind).toBe("error");
    expect(r.documents.config?.kind).toBe("error");
    expect(client.isLicensed()).toBe(false);
    client.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("R2-04 · the cached document is NEVER re-verified when it is loaded", () => {
  // FIXED (R2-03 / R4-01) — §4.1. The cache stores compact JWSs and nothing else, and every
  // slice is re-verified against the pinned keys on every load. A hand-written document has no
  // signature to re-check, so it is simply not a document.
  it("a hand-written managed.json with no signature at all yields full entitlements + secrets", async () => {
    const { store, cachePath } = tempStore();
    await store.setToken(TOKEN);
    const deviceId = await store.getDeviceId();
    const t = nowSec();
    const offline = {
      ...base,
      trustRefresh: false,
      store,
      // No network at all — offline-first path, so the cache is the only possible source.
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as typeof fetch,
    };
    writeFileSync(
      cachePath,
      JSON.stringify({
        doc: makeLicenseDoc({
          deviceId,
          issuedAt: t,
          graceUntil: t + 100 * 365 * 86400, // a century of "grace"
        }),
        config: makeConfigDoc({
          deviceId,
          issuedAt: t,
          secret: "NEVER-SIGNED",
        }),
        lastAcceptedIssuedAt: 0,
        lastVerifiedAt: Date.now(),
      }),
    );

    const client = await PolarisKeyClient.create(offline);
    expect(client.status().status).toBe("needs-activation");
    expect(client.isLicensed()).toBe(false);
    expect(client.license.isEntitled("polarisVpn")).toBe(false);
    expect(client.config.getSecret("serviceA.oauth")).toBeNull();
    client.close();

    // The same holds for a correctly-versioned v3 record whose artifacts were never signed by
    // a pinned key: the JWSs are re-verified on load and refused. Note the attacker even used
    // the PINNED kid — the bytes behind it are what they could not produce.
    const atk = await attackerKey();
    writeFileSync(
      cachePath,
      JSON.stringify({
        v: CACHE_VERSION,
        docs: {
          license: await signJws(
            makeLicenseDoc({ deviceId, issuedAt: t }),
            atk.pem,
            PINNED_KID,
            "pkey-license+jws",
          ),
          config: await signJws(
            makeConfigDoc({ deviceId, issuedAt: t }),
            atk.pem,
            PINNED_KID,
            "pkey-config+jws",
          ),
        },
      } satisfies CacheRecordV3),
    );
    const c2 = await PolarisKeyClient.create(offline);
    expect(c2.status().status).toBe("needs-activation");
    expect(c2.license.getEntitlements()).toEqual({});
    expect(c2.config.getSecret("serviceA.oauth")).toBeNull();
    c2.close();
  });

  // FIXED (R2-03 / R4-03) — §4.1. There is no `lastAcceptedIssuedAt` on disk to rewrite: the
  // replay floor is DERIVED, per document TYPE, from the `issuedAt` of the cached document
  // after it has been re-verified. Lowering the floor now requires forging a signature.
  it("`lastAcceptedIssuedAt` lives in the same attacker-writable file, so anti-replay is resettable", async () => {
    const { store, cachePath } = tempStore();
    await store.setToken(TOKEN);
    const deviceId = await store.getDeviceId();
    const t = nowSec();

    // Genuine, current documents are cached — that sets each type's floor at its issuedAt.
    writeFileSync(
      cachePath,
      JSON.stringify({
        v: CACHE_VERSION,
        docs: {
          license: await signJws(
            makeLicenseDoc({ deviceId, issuedAt: t }),
            PINNED_PEM,
            PINNED_KID,
            "pkey-license+jws",
          ),
          config: await signJws(
            makeConfigDoc({ deviceId, issuedAt: t, secret: "CURRENT-SECRET" }),
            PINNED_PEM,
            PINNED_KID,
            "pkey-config+jws",
          ),
        },
        // The attacker adds the old counter back by hand. It is not a field any more, in
        // either direction: it cannot raise the floor (R4-03) and it cannot lower it.
        lastAcceptedIssuedAt: 0,
      }),
    );

    // Older, genuinely-signed documents (a captured higher-tier pair) are replayed. They are
    // still INSIDE their freshness window — `expiresAt` is in the future — so the only thing
    // standing between them and the cache is the derived anti-replay floor.
    const replayedOpts = {
      deviceId,
      issuedAt: t - 86400,
      expiresAt: t + 3600,
      graceUntil: t + 30 * 86400,
    };
    const replayedLicense = await signJws(
      makeLicenseDoc(replayedOpts),
      PINNED_PEM,
      PINNED_KID,
      "pkey-license+jws",
    );
    const replayedConfig = await signJws(
      makeConfigDoc({ ...replayedOpts, secret: "REPLAYED" }),
      PINNED_PEM,
      PINNED_KID,
      "pkey-config+jws",
    );
    const client = await PolarisKeyClient.create({
      ...base,
      trustRefresh: false,
      store,
      fetchImpl: (async (input: string | URL | Request) => {
        const u = new URL(String(input));
        if (u.pathname.endsWith("/devices/report"))
          return new Response("{}", { status: 200 });
        if (u.pathname.endsWith("/license/document"))
          return new Response(replayedLicense, { status: 200 });
        if (u.pathname.endsWith("/config/document"))
          return new Response(replayedConfig, { status: 200 });
        return new Response("", { status: 404 });
      }) as typeof fetch,
    });

    const r = await client.sync({ force: true });
    expect(r.applied).toBe(false);
    expect(r.documents.license?.kind).toBe("error");
    expect(r.documents.config?.kind).toBe("error");
    // Nothing previously held was disturbed: the CURRENT documents still answer the reads.
    expect(client.config.getSecret("serviceA.oauth")).toBe("CURRENT-SECRET");
    expect(client.status().status).toBe("ok");
    client.close();

    // And the floor is genuinely derived — the same artifact is accepted without it and
    // refused with it, on both document types.
    const trust = { [PINNED_KID]: PINNED_PUB };
    expect(
      await verifyLicenseDoc(replayedLicense, {
        trust,
        expectedAud: PRODUCT,
        deviceId,
      }),
    ).not.toBeNull();
    expect(
      await verifyLicenseDoc(replayedLicense, {
        trust,
        expectedAud: PRODUCT,
        deviceId,
        lastAcceptedIssuedAt: t,
      }),
    ).toBeNull();
    expect(
      await verifyConfigDoc(replayedConfig, {
        trust,
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
  // accepted and never reaches disk. (`schemaVersion: 999` is deliberately still fine on a
  // CONFIG document: that field carries the product CATALOG version, not a wire-format id —
  // see client-core's verify.ts. What §3 can enforce there is the SHAPE.)
  it("a LONG-expired doc with a foreign `iss` and an unknown schemaVersion verifies and is cached", async () => {
    const { store, cachePath } = tempStore();
    await store.setToken(TOKEN);
    const t = nowSec() - 400 * 86400; // 400 days ago

    const client = await PolarisKeyClient.create({
      ...base,
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

    const r = await client.sync({ force: true });
    expect(r.applied).toBe(false); // refused at verify, not merely at the gate
    // Nothing reached disk at all — v1 wrote the doc verbatim, foreign `iss` and all.
    const raw = readMaybe(cachePath);
    if (raw !== null) {
      const persisted = JSON.parse(raw) as CacheRecordV3;
      expect(persisted.docs?.license).toBeUndefined();
      expect(persisted.docs?.config).toBeUndefined();
      expect(raw).not.toContain("evil.example");
    }

    // Nothing to read: an unverifiable document is not a document.
    expect(client.status().status).toBe("needs-activation");
    expect(client.isLicensed()).toBe(false);
    expect(client.license.isEntitled("polarisVpn")).toBe(false);
    expect(client.license.getEntitlements()).toEqual({});
    expect(client.config.getSecret("serviceA.oauth")).toBeNull();
    expect(client.getConfig("quality.floor", 1)).toBe(1);
    client.close();
  });

  // NEW IN v3 — §3 / §8. The issuer is the FIXED `key.plrs.im`, never derived from the base URL
  // or the serving hostname. Any other issuer — including the `plrs.im` spelling the interim
  // suite design proposed and Amendment A1 withdrew — must not verify against a v3 client:
  // honouring a second issuer would let a document minted under a different name pass here.
  it("a foreign issuer (`plrs.im`) is REFUSED on both document types", async () => {
    const deviceId = "dev_fixture";
    const t = nowSec();
    const opts = {
      trust: { [PINNED_KID]: PINNED_PUB },
      expectedAud: PRODUCT,
      deviceId,
    };

    // The control: identical documents, correct issuer, genuinely signed → accepted.
    expect(
      await verifyLicenseDoc(
        await signJws(
          makeLicenseDoc({ deviceId, issuedAt: t }),
          PINNED_PEM,
          PINNED_KID,
          "pkey-license+jws",
        ),
        opts,
      ),
    ).not.toBeNull();
    expect(
      await verifyConfigDoc(
        await signJws(
          makeConfigDoc({ deviceId, issuedAt: t }),
          PINNED_PEM,
          PINNED_KID,
          "pkey-config+jws",
        ),
        opts,
      ),
    ).not.toBeNull();

    // …and the only thing changed is `iss`.
    expect(
      await verifyLicenseDoc(
        await signJws(
          makeLicenseDoc({ deviceId, issuedAt: t, iss: "plrs.im" }),
          PINNED_PEM,
          PINNED_KID,
          "pkey-license+jws",
        ),
        opts,
      ),
    ).toBeNull();
    expect(
      await verifyConfigDoc(
        await signJws(
          makeConfigDoc({ deviceId, issuedAt: t, iss: "plrs.im" }),
          PINNED_PEM,
          PINNED_KID,
          "pkey-config+jws",
        ),
        opts,
      ),
    ).toBeNull();

    // The manifest carries the same rule (§2.3), so a v2 manifest cannot re-seed trust either.
    expect(
      (
        await verifyTrustManifest(
          await signJws(
            { ...manifest([PINNED_ENTRY], t), iss: "plrs.im" },
            PINNED_PEM,
            PINNED_KID,
            "pkey-trust+jws",
          ),
          { pinned: { [PINNED_KID]: PINNED_PUB }, expectedAud: PRODUCT },
        )
      ).doc,
    ).toBeNull();
  });

  // FIXED (R2-11) — §5. A 304 means "content unchanged, freshness RENEWED". Past the cached
  // doc's half-life the client re-asks unconditionally so the server re-signs the window; a
  // continuously online client can no longer drift into `grace` behind a content-stable ETag.
  // v3 applies the rule PER DOCUMENT — license and config carry independent ETags — so both
  // slices escalate on their own schedule below.
  it("R2-11: a 304 (content-only ETag) never refreshes the signed validity window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_000;
    vi.setSystemTime(t0 * 1000);

    const { store } = tempStore();
    await store.setToken(TOKEN);
    let servedLicense = 0;
    let servedConfig = 0;
    const impl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      const headers = new Headers(init?.headers);
      const device = headers.get("x-pkey-device") ?? "d";
      if (u.pathname.endsWith("/devices/report"))
        return new Response("{}", { status: 200 });

      // Server re-mints with a fresh `now` each time, but the ETag is content-only.
      if (u.pathname.endsWith("/license/document")) {
        if (headers.get("if-none-match") === '"stable-license"')
          return new Response(null, {
            status: 304,
            headers: { etag: '"stable-license"' },
          });
        servedLicense++;
        const doc = makeLicenseDoc({ deviceId: device, issuedAt: nowSec() });
        return new Response(
          await signJws(doc, PINNED_PEM, PINNED_KID, "pkey-license+jws"),
          { status: 200, headers: { etag: '"stable-license"' } },
        );
      }
      if (u.pathname.endsWith("/config/document")) {
        if (headers.get("if-none-match") === '"stable-config"')
          return new Response(null, {
            status: 304,
            headers: { etag: '"stable-config"' },
          });
        servedConfig++;
        const doc = makeConfigDoc({ deviceId: device, issuedAt: nowSec() });
        return new Response(
          await signJws(doc, PINNED_PEM, PINNED_KID, "pkey-config+jws"),
          { status: 200, headers: { etag: '"stable-config"' } },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const client = await PolarisKeyClient.create({
      ...base,
      trustRefresh: false,
      store,
      fetchImpl: impl,
    });
    await client.sync({ force: true }); // first fetch → 200 on both
    expect(servedLicense).toBe(1);
    expect(servedConfig).toBe(1);

    // Inside the half-life the conditional request is still a pure optimisation: 304s are
    // taken at face value and cost the server nothing.
    for (let i = 0; i < 5; i++) await client.sync();
    expect(servedLicense).toBe(1);
    expect(servedConfig).toBe(1);

    // Past the half-life the client escalates: the 304 is followed by an unconditional
    // re-request, so a freshly signed window lands…
    vi.setSystemTime((t0 + 1801) * 1000);
    await client.sync();
    expect(servedLicense).toBe(2);
    expect(servedConfig).toBe(2);

    // …and the client stays `ok` well beyond the FIRST doc's expiry instead of drifting.
    vi.setSystemTime((t0 + 3601) * 1000);
    expect(client.status().status).toBe("ok");
    await client.sync();
    vi.setSystemTime((t0 + 31 * 86400) * 1000);
    await client.sync();
    expect(client.status().status).toBe("ok");
    client.close();
  });

  // FIXED (R2-08) — §3. CLOCK_SKEW = 300 in every implementation, and `issuedAt` now has an
  // upper bound, so a far-future document is refused rather than gating `ok`.
  it("zero clock-skew tolerance: one second of client clock drift flips a fresh doc into `grace`", async () => {
    const deviceId = "dev_fixture";
    const t = nowSec();
    const jws = await signJws(
      makeLicenseDoc({ deviceId, issuedAt: t }),
      PINNED_PEM,
      PINNED_KID,
      "pkey-license+jws",
    );
    // A client up to CLOCK_SKEW seconds fast still accepts a brand-new document.
    const doc = await verifyLicenseDoc(jws, {
      trust: { [PINNED_KID]: PINNED_PUB },
      expectedAud: PRODUCT,
      deviceId,
      now: t - 300,
    });
    expect(doc).not.toBeNull();

    // And a doc issued in the FUTURE is now refused outright — there is an `iat` sanity check.
    const future = await verifyLicenseDoc(
      await signJws(
        makeLicenseDoc({ deviceId, issuedAt: t + 10 * 365 * 86400 }),
        PINNED_PEM,
        PINNED_KID,
        "pkey-license+jws",
      ),
      { trust: { [PINNED_KID]: PINNED_PUB }, expectedAud: PRODUCT, deviceId },
    );
    expect(future).toBeNull();
    // The config document shares the envelope (§2), so it shares the bound.
    expect(
      await verifyConfigDoc(
        await signJws(
          makeConfigDoc({ deviceId, issuedAt: t + 10 * 365 * 86400 }),
          PINNED_PEM,
          PINNED_KID,
          "pkey-config+jws",
        ),
        { trust: { [PINNED_KID]: PINNED_PUB }, expectedAud: PRODUCT, deviceId },
      ),
    ).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NEW IN v3 — the cache-shaped attack surface the split documents opened.
// ══════════════════════════════════════════════════════════════════════════════
describe("R2-12 · cache-version and document-type confusion through the cache", () => {
  // NEW (§4.1). A record whose `v !== 3` is DISCARDED, never migrated — `v` is checked before
  // ANY field is read. That is what makes an inherited/restored/synced v2 cache inert instead
  // of a migration surface: the v2 record's fused doc, its bare `trustedKeys` map and its three
  // unsigned counters are never even looked at, no matter how genuine the artifact inside is.
  it("a v2 cache record carrying a GENUINELY SIGNED v2 document is discarded, not migrated", async () => {
    const { store, cachePath } = tempStore();
    await store.setToken(TOKEN);
    const deviceId = await store.getDeviceId();
    const t = nowSec();

    // A real v2 artifact: the fused `pkey-config+jws` document, correctly signed by the
    // PINNED key, addressed to THIS product and THIS device. Nothing about it is forged —
    // the only thing wrong with it is that it belongs to a wire contract this client retired.
    const v2Jws = await signJws(
      {
        schemaVersion: 1,
        aud: PRODUCT,
        iss: "key.plrs.im",
        licenseId: "lic_v2_carryover",
        deviceId,
        issuedAt: t,
        expiresAt: t + 3600,
        graceUntil: t + 30 * 86400,
        profile: {
          name: "Ada Lovelace",
          firstName: "Ada",
          email: "ada@example.com",
          activatedAt: t,
        },
        payload: {
          config: {
            "quality.floor": {
              state: "enforced",
              value: "v2-carryover",
              updatedAt: t,
            },
          },
          secrets: {
            "serviceA.oauth": {
              state: "hidden",
              value: "V2-SECRET",
              updatedAt: t,
            },
          },
          entitlements: {
            polarisVpn: { state: "enforced", value: true, updatedAt: t },
          },
        },
      },
      PINNED_PEM,
      PINNED_KID,
      "pkey-config+jws",
    );
    writeFileSync(cachePath, JSON.stringify({ v: 2, configJws: v2Jws }));

    const client = await PolarisKeyClient.create({
      ...base,
      trustRefresh: false,
      store,
      // Offline: the ONLY thing that could grant anything here is the planted record.
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as typeof fetch,
    });

    expect(client.status().status).toBe("needs-activation");
    expect(client.isLicensed()).toBe(false);
    expect(client.license.isEntitled("polarisVpn")).toBe(false);
    expect(client.license.getEntitlements()).toEqual({});
    expect(client.license.getProfile()).toBeNull();
    expect(client.config.getSecret("serviceA.oauth")).toBeNull();
    expect(client.getConfig("quality.floor", "mp3")).toBe("mp3");
    // Never read ⇒ never rewritten: the v2 record is still sitting there verbatim, and no v3
    // record was synthesised from it.
    const persisted = JSON.parse(readFileSync(cachePath, "utf8")) as {
      v: number;
      docs?: unknown;
    };
    expect(persisted.v).toBe(2);
    expect(persisted.v).not.toBe(CACHE_VERSION);
    expect(persisted.docs).toBeUndefined();
    client.close();
  });

  // NEW (§4.1), and the sharp form of the rule above. The previous test's artifact would have
  // been refused on its `typ` and its v2 `iss` even if the record HAD been read, so it cannot
  // by itself prove that `v` is what stopped it. This one can: the record below is a perfectly
  // good v3 record — genuinely signed, correctly typed, bound to this product and this device
  // — wearing nothing but a v2 version stamp. It grants nothing. The identical record stamped
  // `v: 3` gates `ok`, which is what makes `v` the load-bearing field.
  it("`v` alone decides: a v3-shaped record stamped `v: 2` is discarded, the same bytes at `v: 3` load", async () => {
    const { store, cachePath } = tempStore();
    await store.setToken(TOKEN);
    const deviceId = await store.getDeviceId();
    const t = nowSec();
    const docs = {
      license: await signJws(
        makeLicenseDoc({ deviceId, issuedAt: t }),
        PINNED_PEM,
        PINNED_KID,
        "pkey-license+jws",
      ),
      config: await signJws(
        makeConfigDoc({ deviceId, issuedAt: t, secret: "STOWAWAY" }),
        PINNED_PEM,
        PINNED_KID,
        "pkey-config+jws",
      ),
    };
    const offline = {
      ...base,
      trustRefresh: false,
      store,
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as typeof fetch,
    };

    writeFileSync(cachePath, JSON.stringify({ v: 2, docs }));
    const stale = await PolarisKeyClient.create(offline);
    expect(stale.status().status).toBe("needs-activation");
    expect(stale.license.isEntitled("polarisVpn")).toBe(false);
    expect(stale.config.getSecret("serviceA.oauth")).toBeNull();
    expect(stale.getSyncState().highWaterMark).toBe(0); // not even the clock floor moved
    stale.close();

    // The control: one integer different, and the very same bytes are a licence.
    writeFileSync(
      cachePath,
      JSON.stringify({ v: CACHE_VERSION, docs } satisfies CacheRecordV3),
    );
    const current = await PolarisKeyClient.create(offline);
    expect(current.status().status).toBe("ok");
    expect(current.license.isEntitled("polarisVpn")).toBe(true);
    expect(current.config.getSecret("serviceA.oauth")).toBe("STOWAWAY");
    current.close();
  });

  // NEW (§2 / §4.1) — the v3 form of the typ-separation attack. Splitting one document into
  // two created a new place to swap them: the cache's own slices. `verifyLicenseDoc` demands
  // `typ: pkey-license+jws` with `requireTyp` on, so a config artifact filed under
  // `docs.license` is not a licence — it is dropped, and dropped SLICE-WISE, so the honest
  // config slice beside it still loads. Fail-closed, not fail-empty.
  it("a valid config artifact planted in `docs.license` grants nothing, and the real config slice still loads", async () => {
    const { store, cachePath } = tempStore();
    await store.setToken(TOKEN);
    const deviceId = await store.getDeviceId();
    const t = nowSec();

    const configJws = await signJws(
      makeConfigDoc({ deviceId, issuedAt: t, secret: "REAL-SECRET" }),
      PINNED_PEM,
      PINNED_KID,
      "pkey-config+jws",
    );
    // The same artifact in BOTH slices: correct in one, type-confused in the other.
    writeFileSync(
      cachePath,
      JSON.stringify({
        v: CACHE_VERSION,
        docs: { license: configJws, config: configJws },
      } satisfies CacheRecordV3),
    );

    const client = await PolarisKeyClient.create({
      ...base,
      trustRefresh: false,
      store,
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as typeof fetch,
    });
    // The licence slice is ABSENT — a config document is not a licence, whatever it is filed
    // under, so there are no entitlements and no gate.
    expect(client.status().status).toBe("needs-activation");
    expect(client.isLicensed()).toBe(false);
    expect(client.license.getLicenseId()).toBeNull();
    expect(client.license.getEntitlements()).toEqual({});
    // …and the honest config slice is unaffected.
    expect(client.getConfig("quality.floor", 1)).toBe(9999);
    expect(client.config.getSecret("serviceA.oauth")).toBe("REAL-SECRET");
    client.close();

    // The mirror image: a licence artifact planted in `docs.config` yields no config, while
    // the licence slice beside it loads and gates normally.
    const licenseJws = await signJws(
      makeLicenseDoc({ deviceId, issuedAt: t }),
      PINNED_PEM,
      PINNED_KID,
      "pkey-license+jws",
    );
    writeFileSync(
      cachePath,
      JSON.stringify({
        v: CACHE_VERSION,
        docs: { license: licenseJws, config: licenseJws },
      } satisfies CacheRecordV3),
    );
    const mirrored = await PolarisKeyClient.create({
      ...base,
      trustRefresh: false,
      store,
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as typeof fetch,
    });
    expect(mirrored.status().status).toBe("ok");
    expect(mirrored.license.isEntitled("polarisVpn")).toBe(true);
    expect(mirrored.config.getSecret("serviceA.oauth")).toBeNull();
    expect(mirrored.getConfig("quality.floor", 1)).toBe(1);
    expect(mirrored.config.schemaVersion()).toBeNull();
    mirrored.close();
  });
});
