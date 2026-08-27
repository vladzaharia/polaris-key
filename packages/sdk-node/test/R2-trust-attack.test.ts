// R2 RED TEAM — attacks on client-side key custody + document acceptance in @plrs/node.
//
// These began life as PoCs asserting the CURRENT (vulnerable) behaviour. They have now been
// INVERTED: every test asserts that the attack FAILS, so each one is the regression test for
// the fix named in its `// FIXED (…)` comment. Threat model is unchanged — for a licensing
// SDK the *user of the machine* is a first-class adversary, and so is any process running as
// that user (a malicious npm postinstall, a synced/restored `~/.config`, an XDG_CONFIG_HOME
// pointed at a shared directory, a backup restore). Nothing below patches the app binary.
//
// ── WHAT THE P4 RE-SHAPE CHANGED, AND WHAT IT DID NOT ───────────────────────────────────────
//
// The rules moved; the answers did not. Verification now lives in `@plrs/client-core` and the
// SDK is Core + sub-clients, so these tests drive `PolarisClient.sync()` instead of
// `PolarisKeyClient.refresh()` and import the verifiers from client-core. What each attack must
// still not achieve is byte-for-byte what it was.
//
// Three things about wire v3 make these attacks HARDER, and each gets its own assertion:
//   * the fused `/config` document is split, so a forged artifact has to survive `typ` domain
//     separation as well as a signature check (`plrs-license+jws` vs `plrs-config+jws`);
//   * `iss` is the host-neutral `plrs.im`, so v2's `key.plrs.im` is now itself a refusal;
//   * the cache is v3 with per-service slices, and a `v !== 3` record is DISCARDED rather than
//     migrated — which is what makes every "plant a JSON file" PoC below inert on arrival.
//
// Remediation reference: docs/security/WIRE-CONTRACT-V3.md §1 (trust set), §3 (claims),
// §4.1 (cache integrity), §4.2 (clock floor), §5 (ETag freshness).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signJws, base64UrlEncodeBytes } from "@plrs/jws";
import type { ManagedEntry } from "@plrs/protocol/core";
import type { ConfigDoc } from "@plrs/protocol/config";
import type { LicenseDoc } from "@plrs/protocol/license";
import type { TrustManifestDoc } from "@plrs/protocol/trust";
import {
  mergeTrust,
  verifyLicenseDoc,
  verifyTrustManifest,
  type CacheRecordV3,
} from "@plrs/client-core";
import { PolarisClient } from "../src/client.js";
import { CACHE_VERSION, FileStore } from "../src/core/store.js";

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

const entry = (value: ManagedEntry["value"], at: number): ManagedEntry => ({
  state: "enforced",
  value,
  updatedAt: at,
});

interface DocOverrides {
  deviceId: string;
  issuedAt?: number;
  expiresAt?: number;
  graceUntil?: number;
  iss?: string;
  aud?: string;
  entitlement?: boolean;
  secret?: string;
  schemaVersion?: number;
}

/** The v3 GRANT half of what used to be one fused document. */
function makeLicenseDoc(o: DocOverrides): LicenseDoc {
  const t = o.issuedAt ?? nowSec();
  return {
    iss: o.iss ?? "plrs.im",
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
    entitlements: { polarisVpn: entry(o.entitlement ?? true, t) },
  };
}

/** The v3 SETTINGS half. Carries no licence fields whatsoever (§2.2, D-08). */
function makeConfigDoc(o: DocOverrides): ConfigDoc {
  const t = o.issuedAt ?? nowSec();
  return {
    iss: o.iss ?? "plrs.im",
    aud: o.aud ?? PRODUCT,
    deviceId: o.deviceId,
    issuedAt: t,
    expiresAt: o.expiresAt ?? t + 3600,
    graceUntil: o.graceUntil ?? t + 30 * 86400,
    schemaVersion: o.schemaVersion ?? 1,
    config: { "quality.floor": entry("lossless", t) },
    secrets: { "soundcloud.oauth": entry(o.secret ?? "FORGED-SECRET", t) },
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
  const dir = mkdtempSync(join(tmpdir(), "plrs-r2-"));
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
    // v3 is host-neutral: the manifest's issuer is `plrs.im`, not the serving hostname (§8).
    iss: "plrs.im",
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
  /** Serve the documents signed with this PEM under this kid. */
  docSigner?: { pem: string; kid: string };
  /** Overrides for the served documents. */
  docOpts?: Partial<DocOverrides>;
  /** Ordered trust manifests; each refresh consumes the next (the last one repeats). */
  manifests?: Array<{ doc: TrustManifestDoc; pem: string; kid: string }>;
  /** Bump the served documents' `issuedAt` by this much on every fetch, so a second pass can
   *  fail on TRUST rather than on the anti-replay floor. */
  issuedAtStep?: number;
}

function mockFetch(route: Route): {
  impl: typeof fetch;
  paths: string[];
  manifestIndex: () => number;
} {
  const paths: string[] = [];
  let mi = 0;
  let step = 0;
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
      const entryAt = list[Math.min(mi, list.length - 1)]!;
      mi++;
      return new Response(
        await signJws(entryAt.doc, entryAt.pem, entryAt.kid, "plrs-trust+jws"),
        { status: 200, headers: { "content-type": "application/jose" } },
      );
    }
    if (u.pathname.endsWith("/devices/report"))
      return new Response("{}", { status: 200 });

    const signer = route.docSigner ?? { pem: PINNED_PEM, kid: PINNED_KID };
    const deviceId = headers.get("x-polaris-device") ?? "d";
    const base: DocOverrides = { deviceId, ...route.docOpts };

    if (u.pathname.endsWith("/license/document")) {
      const bump = (route.issuedAtStep ?? 0) * step++;
      const doc = makeLicenseDoc({
        ...base,
        issuedAt: (base.issuedAt ?? nowSec()) + bump,
      });
      return new Response(
        await signJws(doc, signer.pem, signer.kid, "plrs-license+jws"),
        {
          status: 200,
          headers: { "content-type": "application/jwt", etag: '"r2-lic"' },
        },
      );
    }
    if (u.pathname.endsWith("/config/document")) {
      const doc = makeConfigDoc(base);
      return new Response(
        await signJws(doc, signer.pem, signer.kid, "plrs-config+jws"),
        {
          status: 200,
          headers: { "content-type": "application/jwt", etag: '"r2-cfg"' },
        },
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, paths, manifestIndex: () => mi };
}

/** The v3 client under attack. Fingerprinting is off throughout: these tests are about key
 *  custody, and shelling out to platform probes would make them depend on this host. */
function clientOn(
  store: FileStore,
  extra: Partial<ConstructorParameters<typeof PolarisClient>[0]> = {},
): PolarisClient {
  return new PolarisClient({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.2.3",
    trust: { pinnedKeys: { [PINNED_KID]: PINNED_PUB } },
    trustRefresh: false,
    store,
    license: { fingerprint: false },
    devices: { fingerprint: false },
    ...extra,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
describe("R2-02 · trust-set poisoning: the on-disk cache OVERRIDES a pinned kid", () => {
  // FIXED (R2-01 / R4-02) — §1. The cache is no longer a key source at all: it persists the
  // trust manifest's compact JWS, which is re-verified against the PINNED keys on every load,
  // and the merge is `{...manifestKeys, ...pinnedKeys}` so a pin is terminal.
  it("a planted managed.json key replaces the pinned public key, so an attacker-signed doc verifies", async () => {
    const atk = await attackerKey();
    const { store, cachePath } = tempStore();
    await store.setToken("plrst_whatever");

    // THE ATTACK, verbatim: one file write planting the PINNED kid with attacker key bytes.
    // Under v3 this record has no `v` at all, so it is DISCARDED, not migrated (§4.1), and
    // `trustedKeys` is not a field the client reads under any version.
    writeFileSync(
      cachePath,
      JSON.stringify({
        doc: null,
        lastAcceptedIssuedAt: 0,
        trustedKeys: { [PINNED_KID]: atk.pub },
      }),
    );

    const client = clientOn(store, {
      fetchImpl: mockFetch({
        docSigner: { pem: atk.pem, kid: PINNED_KID }, // signed by the ATTACKER
        docOpts: { entitlement: true, secret: "ATTACKER-OWNED" },
      }).impl,
    });
    await client.init();

    const r = await client.sync({ force: true });
    expect(r.applied).toBe(false); //  <-- both forged documents REJECTED
    expect(client.isLicensed()).toBe(false);
    expect(client.license.isEntitled("polarisVpn")).toBe(false);
    expect(client.config.getSecret("soundcloud.oauth")).toBeNull();
    expect(client.license.getProfile()).toBeNull();
    // The split does not give the attacker two chances: BOTH documents failed, so neither
    // slice landed and the settings half cannot be smuggled in behind the grant half.
    expect(r.documents.license?.kind).toBe("error");
    expect(r.documents.config?.kind).toBe("error");
    client.close();
  });

  // FIXED (R2-01) — §1 rule 1. Even a manifest signed by the GENUINE pinned key may not
  // re-point a pinned kid: presenting a pinned kid with different bytes is a substitution
  // attempt, so the whole manifest is rejected and the previous trust set is kept.
  it("control: WITHOUT the planted cache the identical forged doc is rejected", async () => {
    const atk = await attackerKey();
    const { store } = tempStore();
    await store.setToken("plrst_whatever");
    const client = clientOn(store, {
      fetchImpl: mockFetch({ docSigner: { pem: atk.pem, kid: PINNED_KID } })
        .impl,
    });
    await client.init();
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
      "plrs-trust+jws",
    );
    const result = await verifyTrustManifest(substitution, {
      pinned: { [PINNED_KID]: PINNED_PUB },
      expectedAud: PRODUCT,
    });
    expect(result.doc).toBeNull();
    expect(result.discovered).toEqual({});
  });

  // FIXED (R2-01 amplifier) — §1. Manifests are verified against the PINNED keys ONLY,
  // never against the current (possibly extended) trust set, so a planted or rotated key can
  // never sign the manifest that mints the next key. The poisoning cannot self-perpetuate.
  it("the poisoned trust set is also accepted for TRUST MANIFESTS — the attacker can self-perpetuate", async () => {
    const atk = await attackerKey();
    const atk2 = await attackerKey();
    const { store, cachePath } = tempStore();
    await store.setToken("plrst_whatever");
    writeFileSync(
      cachePath,
      JSON.stringify({
        doc: null,
        lastAcceptedIssuedAt: 0,
        trustedKeys: { [PINNED_KID]: atk.pub },
      }),
    );

    const t = nowSec();
    const client = clientOn(store, {
      trustRefresh: true,
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
        docSigner: { pem: atk2.pem, kid: "attacker-forever-2099" },
      }).impl,
    });
    await client.init();

    const r = await client.sync({ force: true });
    expect(r.applied).toBe(false);
    // Nothing was installed: the manifest never verified against the pins, so no trustJws was
    // persisted and `attacker-forever-2099` is unknown on this device and every future run.
    const raw = readFileSync(cachePath, "utf8");
    const persisted = JSON.parse(raw) as CacheRecordV3;
    expect(persisted.trustJws).toBeUndefined();
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
    await store.setToken("plrst_whatever");
    const t = nowSec();

    const ROTATED = {
      kid: "product-key-2026",
      alg: "EdDSA" as const,
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      publicKey: rotated.pub,
      status: "active" as const,
    };

    const client = clientOn(store, {
      trustRefresh: true,
      fetchImpl: mockFetch({
        manifests: [
          // 1. Server publishes both keys.
          {
            pem: PINNED_PEM,
            kid: PINNED_KID,
            doc: manifest([PINNED_ENTRY, ROTATED], t),
          },
          // 2. Operator REVOKES `product-key-2026`: the repo filters status='revoked' out, so
          //    it simply disappears from the manifest.
          {
            pem: PINNED_PEM,
            kid: PINNED_KID,
            doc: manifest([PINNED_ENTRY], t + 10),
          },
        ],
        // The documents are served by the REVOKED key.
        docSigner: { pem: rotated.pem, kid: "product-key-2026" },
        // Each pass serves a STRICTLY NEWER document, so the second pass can only fail on
        // trust — never on the anti-replay floor. Without this the test would pass for the
        // wrong reason and prove nothing about pruning.
        issuedAtStep: 100,
      }).impl,
    });
    await client.init();

    // Pass #1 learns the key and the documents it signs are applied…
    expect((await client.sync({ force: true })).applied).toBe(true);
    expect(client.license.isEntitled("polarisVpn")).toBe(true);
    // …pass #2 sees the revocation manifest and prunes it, so the same signer's NEWER document
    // is no longer accepted.
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

    // And it no longer signs valid documents.
    const doc = await verifyLicenseDoc(
      await signJws(
        makeLicenseDoc({
          deviceId: await store.getDeviceId(),
          issuedAt: t + 999,
        }),
        rotated.pem,
        "product-key-2026",
        "plrs-license+jws",
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

  // FIXED (R2-02) — §1. `status` is now read. Note the table is deliberate: `retired` and
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
            // Explicitly published as revoked — the positive signal §1 requires the server to
            // emit for at least 2× cacheSeconds before falling back to prune-on-absence.
            status: "revoked",
          } as unknown as TrustManifestDoc["keys"][number],
        ],
        t,
      ),
      PINNED_PEM,
      PINNED_KID,
      "plrs-trust+jws",
    );

    const result = await verifyTrustManifest(mixed, {
      pinned: { [PINNED_KID]: PINNED_PUB },
      expectedAud: PRODUCT,
    });
    expect(result.doc).not.toBeNull();
    expect(result.discovered["long-retired-2019"]).toBe(retired.pub); // per §1
    expect(result.discovered["compromised-2025"]).toBeUndefined(); // REFUSED

    // End to end: the revoked key cannot sign an accepted document of EITHER type.
    const { store } = tempStore();
    await store.setToken("plrst_whatever");
    const client = clientOn(store, {
      trustRefresh: true,
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
    await client.init();
    const r = await client.sync({ force: true });
    expect(r.applied).toBe(false);
    expect(client.isLicensed()).toBe(false);
    expect(client.config.getSecret("soundcloud.oauth")).toBeNull();
    client.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("R2-08 · verifyDoc omits iss / expiresAt / schemaVersion / licenseId + has zero clock skew", () => {
  // FIXED (R2-08) — §3. `iss` and the freshness window are asserted, so the document is never
  // accepted and never reaches disk. (A `schemaVersion` of 999 is deliberately still fine on a
  // CONFIG document: that field carries the product CATALOG version, not a wire-format id —
  // see client-core's verify.ts.)
  it("a LONG-expired doc with a foreign `iss` and an unknown schemaVersion verifies and is cached", async () => {
    const { store, cachePath } = tempStore();
    await store.setToken("plrst_whatever");
    const t = nowSec() - 400 * 86400; // 400 days ago

    const client = clientOn(store, {
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
    await client.init();

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
    expect(client.config.getSecret("soundcloud.oauth")).toBeNull();
    expect(client.config.getConfig("quality.floor", "mp3")).toBe("mp3");
    client.close();
  });

  // NEW in v3 (§8) — the rebrand is itself a refusal. `iss` is the host-neutral `plrs.im`;
  // a document carrying v2's `key.plrs.im` is a v2 artifact and is refused outright. There is
  // no dual-accept window (§9), so a captured v2 document is not merely stale — it is foreign.
  it("v2's `key.plrs.im` issuer is refused, on both document types and on both paths", async () => {
    const { store } = tempStore();
    const deviceId = await store.getDeviceId();
    const t = nowSec();
    const v2ish = { deviceId, issuedAt: t, iss: "key.plrs.im" };

    for (const checkFreshness of [true, false]) {
      expect(
        await verifyLicenseDoc(
          await signJws(
            makeLicenseDoc(v2ish),
            PINNED_PEM,
            PINNED_KID,
            "plrs-license+jws",
          ),
          {
            trust: { [PINNED_KID]: PINNED_PUB },
            expectedAud: PRODUCT,
            deviceId,
            checkFreshness,
          },
        ),
      ).toBeNull();
    }

    // …and end to end, the client refuses it too.
    await store.setToken("plrst_whatever");
    const client = clientOn(store, {
      fetchImpl: mockFetch({ docOpts: { iss: "key.plrs.im" } }).impl,
    });
    await client.init();
    expect((await client.sync({ force: true })).applied).toBe(false);
    expect(client.status().status).toBe("needs-activation");
    client.close();
  });

  // FIXED (R2-11) — §5. A 304 means "content unchanged, freshness RENEWED". Past the cached
  // doc's half-life the client re-asks unconditionally so the server re-signs the window; a
  // continuously online client can no longer drift into `grace` behind a content-stable ETag.
  //
  // Scoped to the LICENSE document (`expectedServices: ["license"]`) so the fetch counter means
  // one thing. The rule is per-document and the config half is pinned identically in
  // `sync.test.ts`; what this file cares about is that the drift is closed at all.
  it("R2-11: a 304 (content-only ETag) never refreshes the signed validity window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_000;
    vi.setSystemTime(t0 * 1000);

    const { store } = tempStore();
    await store.setToken("plrst_whatever");
    let served = 0;
    const impl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      const headers = new Headers(init?.headers);
      if (u.pathname.endsWith("/devices/report"))
        return new Response("{}", { status: 200 });
      if (u.pathname.endsWith("/license/document")) {
        // The server re-mints with a fresh `now` each time, but the ETag is content-only.
        if (headers.get("if-none-match") === '"stable-content"') {
          return new Response(null, {
            status: 304,
            headers: { etag: '"stable-content"' },
          });
        }
        served++;
        const doc = makeLicenseDoc({
          deviceId: headers.get("x-polaris-device") ?? "d",
          issuedAt: Math.floor(Date.now() / 1000),
        });
        return new Response(
          await signJws(doc, PINNED_PEM, PINNED_KID, "plrs-license+jws"),
          { status: 200, headers: { etag: '"stable-content"' } },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const client = clientOn(store, {
      fetchImpl: impl,
      expectedServices: ["license"],
    });
    await client.init();
    await client.sync({ force: true }); // first fetch → 200
    expect(served).toBe(1);

    // Inside the half-life the conditional request is still a pure optimisation: 304s are
    // taken at face value and cost the server nothing.
    for (let i = 0; i < 5; i++) await client.sync();
    expect(served).toBe(1);

    // Past the half-life the client escalates: the 304 is followed by an unconditional
    // re-request, so a freshly signed window lands…
    vi.setSystemTime((t0 + 1801) * 1000);
    await client.sync();
    expect(served).toBe(2);

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
      "plrs-license+jws",
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
        "plrs-license+jws",
      ),
      { trust: { [PINNED_KID]: PINNED_PUB }, expectedAud: PRODUCT, deviceId },
    );
    expect(future).toBeNull();
  });
});
