// @pkey-feature core.sync core.cache core.verify
// Trust custody in the Node SDK — WIRE-CONTRACT-V4 §1, §2.3 and §4.1. The verdicts are
// client-core's and the corpus pins them; this suite pins what only the HOST does with them:
//
//   * a manifest that tombstones a pin is persisted as `pinRevocations` evidence in the same
//     write as the manifest, survives a restart, a deactivation and an air-gapped re-import,
//     and keeps the revoked pin out of every set (a document it signed no longer verifies);
//   * the `?signer=<kid>` retry: asked only when the default manifest's signer is not a usable
//     pin, in ascending kid byte order, at most MAX_TRUST_SIGNER_ATTEMPTS times, stopping at the
//     first manifest accepted.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import { MAX_TRUST_SIGNER_ATTEMPTS } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { TrustManifestDoc } from "@polaris-key/protocol/trust";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { CACHE_VERSION } from "../src/core/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "conformance", "corpus", "v2", "cases.json"),
    "utf8",
  ),
) as {
  keys: { kid: string; publicKeyRaw: string; privateKeyPkcs8Pem: string }[];
};
const key = (kid: string) => corpus.keys.find((k) => k.kid === kid)!;
const PIN = key("pkey-test-prod-2026");
const ALT = key("djdl-test-2026");
const PRODUCT = "djdl";
const DEVICE = "dev_custody";
const BASE = "https://k.test";
const now = () => Math.floor(Date.now() / 1000);

class FakeStore implements Store {
  token: string | null = "pkeyt_custody";
  cache: CacheRecordV3 | null = null;
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
    return DEVICE;
  }
  async readCache() {
    return this.cache;
  }
  async writeCache(rec: CacheRecordV3) {
    this.cache = structuredClone(rec);
  }
  async clearCache() {
    this.cache = null;
  }
}

type Signer = typeof PIN;
const entry = (k: Signer, status: string) => ({
  kid: k.kid,
  alg: "EdDSA" as const,
  kty: "OKP" as const,
  crv: "Ed25519" as const,
  publicKey: k.publicKeyRaw,
  status: status as "active",
});

function manifest(
  signer: Signer,
  keys: ReturnType<typeof entry>[],
  issuedAt = now(),
): Promise<string> {
  const doc: TrustManifestDoc = {
    schemaVersion: 1,
    aud: PRODUCT,
    iss: "key.plrs.im",
    issuedAt,
    expiresAt: issuedAt + 300,
    jwksUrl: `${BASE}/${PRODUCT}/.well-known/jwks.json`,
    cacheSeconds: 300,
    keys,
  };
  return signJws(doc, signer.privateKeyPkcs8Pem, signer.kid, "pkey-trust+jws");
}

function license(signer: Signer, issuedAt = now()): Promise<string> {
  const doc: LicenseDoc = {
    iss: "key.plrs.im",
    aud: PRODUCT,
    deviceId: DEVICE,
    issuedAt,
    expiresAt: issuedAt + 3600,
    graceUntil: issuedAt + 30 * 86400,
    licenseId: "lic_custody",
    entitlements: {},
  };
  return signJws(
    doc,
    signer.privateKeyPkcs8Pem,
    signer.kid,
    "pkey-license+jws",
  );
}

/** A fake Worker: the trust route (default and `?signer=`), the licence document, the report. */
function server(opts: {
  trust: () => Promise<string | null>;
  signers?: Record<string, () => Promise<string | null>>;
  license?: () => Promise<string>;
}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const body = (text: string | null) =>
      text === null
        ? new Response("", { status: 404 })
        : new Response(text, { status: 200 });
    if (url.pathname === `/${PRODUCT}/.well-known/polaris-trust.jws`) {
      const signer = url.searchParams.get("signer");
      if (signer === null) return body(await opts.trust());
      return body((await opts.signers?.[signer]?.()) ?? null);
    }
    if (url.pathname === `/${PRODUCT}/license/document` && opts.license)
      return new Response(await opts.license(), {
        status: 200,
        headers: { etag: '"L"' },
      });
    if (url.pathname === `/${PRODUCT}/devices/report`)
      return new Response("{}", { status: 200 });
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function client(
  store: Store,
  pins: Signer[],
  fetchImpl: typeof fetch,
): PolarisKeyClient {
  return new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.2.3",
    trust: {
      pinnedKeys: Object.fromEntries(pins.map((k) => [k.kid, k.publicKeyRaw])),
    },
    expectedServices: ["license"],
    store,
    fetchImpl,
  });
}

describe("pinned-key tombstones in the Node SDK (§1, §4.1)", () => {
  it("persists the revoking manifest as evidence, in the same write, and drops the pin", async () => {
    const store = new FakeStore();
    const revoking = await manifest(ALT, [
      entry(PIN, "revoked"),
      entry(ALT, "active"),
    ]);
    const net = server({
      trust: async () => revoking,
      license: () => license(PIN),
    });
    const c = client(store, [PIN, ALT], net.fetchImpl);
    await c.init();
    const r = await c.sync();
    expect(store.cache?.trustJws).toBe(revoking);
    expect(store.cache?.pinRevocations).toEqual({ [PIN.kid]: revoking });
    // A licence document signed by the tombstoned pin no longer verifies.
    expect(r.documents.license?.kind).toBe("error");
    expect(c.license.status().status).toBe("needs-activation");
  });

  it("the tombstone survives a restart, a deactivation-style clear and refuses the pin's manifests", async () => {
    const store = new FakeStore();
    const revoking = await manifest(ALT, [
      entry(PIN, "revoked"),
      entry(ALT, "active"),
    ]);
    const first = client(
      store,
      [PIN, ALT],
      server({ trust: async () => revoking }).fetchImpl,
    );
    await first.init();
    await first.sync();

    // The next process: the server now serves a manifest signed by the revoked pin, which
    // lists it as active. It is refused; the evidence stays.
    const byPin = await manifest(PIN, [
      entry(PIN, "active"),
      entry(ALT, "active"),
    ]);
    const net = server({
      trust: async () => byPin,
      license: () => license(ALT),
    });
    const second = client(store, [PIN, ALT], net.fetchImpl);
    await second.init();
    const r = await second.sync();
    expect(store.cache?.trustJws).toBe(revoking);
    expect(store.cache?.pinRevocations).toEqual({ [PIN.kid]: revoking });
    expect(r.documents.license?.kind).toBe("applied");

    // A deactivation clears grants, never the evidence.
    await second.license.deactivate();
    expect(store.token).toBeNull();
    expect(store.cache?.docs).toBeUndefined();
    expect(store.cache?.pinRevocations).toEqual({ [PIN.kid]: revoking });
  });

  it("drops evidence that no longer verifies", async () => {
    const store = new FakeStore();
    const forged = await manifest(ALT, [entry(ALT, "active")]);
    store.cache = { v: CACHE_VERSION, pinRevocations: { [PIN.kid]: forged } };
    const net = server({
      trust: () => manifest(PIN, [entry(PIN, "active")]),
      license: () => license(PIN),
    });
    const c = client(store, [PIN, ALT], net.fetchImpl);
    await c.init();
    const r = await c.sync();
    expect(r.documents.license?.kind).toBe("applied");
    expect(store.cache?.pinRevocations).toBeUndefined();
  });
});

describe("the ?signer= retry (§2.3)", () => {
  it("asks for the manifest signed by a pin when the active key is not pinned", async () => {
    const store = new FakeStore();
    // The app pins only ALT; the product's active key is PIN.
    const net = server({
      trust: () => manifest(PIN, [entry(PIN, "active"), entry(ALT, "retired")]),
      signers: {
        [ALT.kid]: () =>
          manifest(ALT, [entry(PIN, "active"), entry(ALT, "retired")]),
      },
      license: () => license(PIN),
    });
    const c = client(store, [ALT], net.fetchImpl);
    await c.init();
    const r = await c.sync();
    const trustCalls = net.calls.filter((u) => u.includes("polaris-trust"));
    expect(trustCalls).toEqual([
      `/${PRODUCT}/.well-known/polaris-trust.jws`,
      `/${PRODUCT}/.well-known/polaris-trust.jws?signer=${ALT.kid}`,
    ]);
    // The ALT-signed manifest publishes the active key, so PIN's licence now verifies.
    expect(r.documents.license?.kind).toBe("applied");
  });

  it("does not retry when the default manifest's signer is a usable pin", async () => {
    const store = new FakeStore();
    const net = server({
      // Signed by the pinned key but stale: refused, and no retry would change that.
      trust: () => manifest(PIN, [entry(PIN, "active")], now() - 100_000),
    });
    const c = client(store, [PIN, ALT], net.fetchImpl);
    await c.init();
    await c.sync();
    expect(net.calls.filter((u) => u.includes("signer="))).toEqual([]);
  });

  it("tries each usable pin in ascending kid byte order, at most MAX_TRUST_SIGNER_ATTEMPTS", async () => {
    const store = new FakeStore();
    const pins: Signer[] = ["zz", "b", "a", "y", "c", "x"].map((kid) => ({
      ...ALT,
      kid: `pin-${kid}`,
    }));
    const net = server({
      trust: () => manifest(PIN, [entry(PIN, "active")]),
    });
    const c = client(store, pins, net.fetchImpl);
    await c.init();
    await c.sync();
    const tried = net.calls
      .filter((u) => u.includes("signer="))
      .map((u) => new URL(`https://x${u}`).searchParams.get("signer"));
    expect(tried).toEqual(
      ["pin-a", "pin-b", "pin-c", "pin-x", "pin-y", "pin-zz"].slice(
        0,
        MAX_TRUST_SIGNER_ATTEMPTS,
      ),
    );
  });
});
