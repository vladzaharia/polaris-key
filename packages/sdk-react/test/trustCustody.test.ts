// @vitest-environment node
//
// @pkey-feature core.sync core.cache core.verify
//
// Trust custody in the React bearer session — WIRE-CONTRACT-V4 §1, §2.3, §4.1. The verdicts are
// client-core's (the corpus pins them); this pins what the session does with them: a manifest
// that tombstones a pin is written as `pinRevocations` evidence in the same write, survives a
// reload and a sign-out, and keeps the pin out of every set; and the `?signer=<kid>` retry when
// the served manifest's signer is not a usable pin.

import { describe, expect, it } from "vitest";
import { MAX_TRUST_SIGNER_ATTEMPTS } from "@polaris-key/protocol/core";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import { BearerSession } from "../src/browser/bearer/session.js";
import { newTestKey, signCompact, type TestKey } from "./fixtures.js";

const NOW = 1_700_000_000;
const DEVICE = "TRUSTCUSTODYDEVICE0000000000001";
const PRODUCT = "acme";

class MemStore implements Store {
  cache: CacheRecordV3 | null = null;
  token: string | null = "pkeyt_test";
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

const entry = (k: TestKey, status: string) => ({
  kid: k.kid,
  alg: "EdDSA",
  kty: "OKP",
  crv: "Ed25519",
  publicKey: k.raw,
  status,
});

const manifest = (signer: TestKey, keys: ReturnType<typeof entry>[]) =>
  signCompact(
    {
      schemaVersion: 1,
      aud: PRODUCT,
      iss: "key.plrs.im",
      issuedAt: NOW - 5,
      expiresAt: NOW + 295,
      jwksUrl: "https://key.plrs.im/acme/.well-known/jwks.json",
      cacheSeconds: 300,
      keys,
    },
    signer,
    "pkey-trust+jws",
  );

const license = (signer: TestKey) =>
  signCompact(
    {
      iss: "key.plrs.im",
      aud: PRODUCT,
      deviceId: DEVICE,
      issuedAt: NOW - 10,
      expiresAt: NOW + 3590,
      graceUntil: NOW + 86_400,
      licenseId: "lic-1",
      entitlements: {},
    },
    signer,
    "pkey-license+jws",
  );

function session(
  store: Store,
  pins: TestKey[],
  serve: {
    trust: () => Promise<string | null>;
    signers?: Record<string, () => Promise<string>>;
    license?: () => Promise<string>;
  },
) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/.well-known/polaris-trust.jws")) {
      const signer = url.searchParams.get("signer");
      const body =
        signer === null
          ? await serve.trust()
          : await serve.signers?.[signer]?.();
      return body ? new Response(body) : new Response("", { status: 404 });
    }
    if (url.pathname.endsWith("/license/document") && serve.license)
      return new Response(await serve.license(), {
        headers: { etag: '"L"' },
      });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const s = new BearerSession({
    baseUrl: "https://key.plrs.im",
    product: PRODUCT,
    version: "1.0.0",
    fetchImpl,
    now: () => NOW,
    pinned: Object.fromEntries(pins.map((k) => [k.kid, k.raw])),
    store,
    enabled: (slug) => slug === "license",
    random: () => 0,
  });
  return { s, calls };
}

describe("pinned-key tombstones in the bearer session (§1, §4.1)", () => {
  it("writes the evidence with the manifest, drops the pin, and keeps it across a reload", async () => {
    const [a, b] = [await newTestKey("pin-a"), await newTestKey("pin-b")];
    const store = new MemStore();
    const revoking = await manifest(b, [
      entry(a, "revoked"),
      entry(b, "active"),
    ]);
    const first = session(store, [a, b], {
      trust: async () => revoking,
      license: () => license(a),
    });
    await first.s.init();
    const r = await first.s.sync();
    expect(store.cache?.pinRevocations).toEqual({ [a.kid]: revoking });
    // A licence signed by the tombstoned pin no longer verifies.
    expect(r.documents.license?.kind).toBe("error");

    // Reload: the revoked pin's own manifest is refused, the retry asks for the other pin's.
    const second = session(store, [a, b], {
      trust: () => manifest(a, [entry(a, "active"), entry(b, "active")]),
      signers: { [b.kid]: () => manifest(b, [entry(b, "active")]) },
      license: () => license(b),
    });
    await second.s.init();
    const r2 = await second.s.sync();
    expect(r2.documents.license?.kind).toBe("applied");
    expect(second.calls).toContain(
      `/${PRODUCT}/.well-known/polaris-trust.jws?signer=${b.kid}`,
    );
    expect(store.cache?.pinRevocations).toEqual({ [a.kid]: revoking });
  });
});

describe("the ?signer= retry (§2.3)", () => {
  it("retries for a pin when the active key is not pinned, and caps the attempts", async () => {
    const active = await newTestKey("active-key");
    const pinned = await newTestKey("old-pin");
    const store = new MemStore();
    const { s, calls } = session(store, [pinned], {
      trust: () => manifest(active, [entry(active, "active")]),
      signers: {
        [pinned.kid]: () =>
          manifest(pinned, [entry(active, "active"), entry(pinned, "retired")]),
      },
      license: () => license(active),
    });
    await s.init();
    const r = await s.sync();
    expect(r.documents.license?.kind).toBe("applied");
    expect(calls.filter((u) => u.includes("polaris-trust"))).toEqual([
      `/${PRODUCT}/.well-known/polaris-trust.jws`,
      `/${PRODUCT}/.well-known/polaris-trust.jws?signer=${pinned.kid}`,
    ]);

    const many = await Promise.all(
      ["e", "a", "d", "c", "b", "f"].map((k) => newTestKey(`pin-${k}`)),
    );
    const capped = session(new MemStore(), many, {
      trust: () => manifest(active, [entry(active, "active")]),
    });
    await capped.s.init();
    await capped.s.sync();
    expect(
      capped.calls
        .filter((u) => u.includes("signer="))
        .map((u) => new URL(`https://x${u}`).searchParams.get("signer")),
    ).toEqual(
      ["pin-a", "pin-b", "pin-c", "pin-d", "pin-e", "pin-f"].slice(
        0,
        MAX_TRUST_SIGNER_ATTEMPTS,
      ),
    );
  });
});
