// @pkey-feature core.store
// The Node persistence layer: the device-id formula and the three stores that round-trip the
// `pkeyt_` credential and the Core-owned cache record.
//
// A store is DUMB on purpose (§4.1): it moves bytes and knows nothing about versions,
// verification or migration. Discarding a `v !== 3` record is `CacheManager`'s decision, and a
// security rule living in three store implementations would be a security rule with three
// chances to be wrong. So nothing here asserts on verification — what it asserts on is that the
// bytes survive, that the file modes are 0600, and that the record it round-trips is the v3
// SHAPE: per-service `docs`/`etags` slices holding signed artifacts and nothing decoded.
//
// The file names on disk (`token`, `managed.json`, `device`) are deliberately unchanged from
// v2. §8 rebrands wire identifiers and the keyring service tag; it does not rename a file an
// installed host is already reading.

import { mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUER } from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { CacheRecordV3 } from "@polaris-key/client-core";
import { deriveDeviceId, deviceIdFromRaw } from "../src/devices/deviceId.js";
import {
  CACHE_VERSION,
  FileStore,
  InMemoryStore,
  KeyringStore,
} from "../src/core/store.js";

// `KeyringStore` reaches for the OS keyring first. Left alone on a developer's macOS box that
// means a real Keychain write; in CI it means whatever the runner happens to expose. Both are
// the wrong thing to pin, and the interesting branch is the FALLBACK anyway — the headless/CI
// path every server-side install actually takes. This double makes the keyring reliably
// UNAVAILABLE (present, but failing every operation) and records the service tag it was asked
// for, which is the only way to observe §8's `pkey:<product>` service tag without reaching
// into a private field.
const keyring = vi.hoisted(() => ({ services: [] as string[] }));
vi.mock("@napi-rs/keyring", () => {
  class AsyncEntry {
    constructor(service: string, _account: string) {
      keyring.services.push(service);
    }
    async getPassword(): Promise<string | null> {
      throw new Error("keyring unavailable");
    }
    async setPassword(_password: string): Promise<void> {
      throw new Error("keyring unavailable");
    }
    async deleteCredential(): Promise<boolean> {
      throw new Error("keyring unavailable");
    }
  }
  return { AsyncEntry };
});

const PRODUCT = "djdl";

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/** A structurally-valid compact JWS. Never verified here — the store is dumb. */
function fakeJws(typ: string, payload: unknown): string {
  return [
    b64url(JSON.stringify({ alg: "EdDSA", typ, kid: "pkey-test-prod-2026" })),
    b64url(JSON.stringify(payload)),
    "sig",
  ].join(".");
}

function sampleLicenseDoc(): LicenseDoc {
  return {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId: "dev-1",
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    graceUntil: 1_702_592_000,
    licenseId: "lic-1",
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: 1_690_000_000,
    },
    entitlements: {
      polarisVpn: { state: "enforced", value: true, updatedAt: 1_700_000_000 },
    },
  };
}

function sampleConfigDoc(): ConfigDoc {
  return {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId: "dev-1",
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    graceUntil: 1_702_592_000,
    schemaVersion: 4,
    config: {
      "run.concurrency": {
        state: "enforced",
        value: 4,
        updatedAt: 1_700_000_000,
      },
    },
    secrets: {
      "proxy.subscriptionUrl": {
        state: "hidden",
        value: "keychain:ref",
        updatedAt: 1_700_000_000,
      },
    },
  };
}

function sampleCache(): CacheRecordV3 {
  // v3 (§4.1): SIGNED ARTIFACTS ONLY, sliced per service. `doc`, `trustedKeys` and the three
  // unsigned counters went in v2; v2's single `configJws`/`etag` pair went in v3, because
  // license and config are now two independently-fetched, independently-ETagged documents.
  return {
    v: CACHE_VERSION,
    docs: {
      license: fakeJws("pkey-license+jws", sampleLicenseDoc()),
      config: fakeJws("pkey-config+jws", sampleConfigDoc()),
    },
    etags: { license: '"lic-etag-1"', config: '"cfg-etag-1"' },
    lastSyncUnauthorized: false,
  };
}

describe("the cache record shape", () => {
  it("is v3 with per-service slices and none of the retired fields", () => {
    const rec = sampleCache();
    expect(CACHE_VERSION).toBe(3);
    expect(rec.v).toBe(3);
    expect(rec.docs?.license?.split(".")).toHaveLength(3);
    expect(rec.docs?.config?.split(".")).toHaveLength(3);
    expect(rec.etags?.license).not.toBe(rec.etags?.config);
    // Every field a local attacker used to be able to author (R2-03/R4-01/R4-03/R4-04).
    expect(rec).not.toHaveProperty("doc");
    expect(rec).not.toHaveProperty("trustedKeys");
    expect(rec).not.toHaveProperty("lastAcceptedIssuedAt");
    expect(rec).not.toHaveProperty("lastTrustIssuedAt");
    expect(rec).not.toHaveProperty("lastVerifiedAt");
    // …and v2's single-document slice.
    expect(rec).not.toHaveProperty("configJws");
    expect(rec).not.toHaveProperty("etag");
  });
});

describe("deriveDeviceId", () => {
  it("is deterministic for a fixed input (same slug + fallback → same id)", () => {
    const a = deriveDeviceId(PRODUCT, "fixed-input");
    const b = deriveDeviceId(PRODUCT, "fixed-input");
    expect(a).toBe(b);
    // The pure formula underneath it is what the conformance corpus pins across Node, Python
    // and Swift, and it is deterministic without depending on this host's hardware.
    expect(deviceIdFromRaw(PRODUCT, "fixed-input")).toBe(
      deviceIdFromRaw(PRODUCT, "fixed-input"),
    );
  });

  it("is hashed: the raw input never appears in the output", () => {
    // The raw OS identifier is hashed ON THE DEVICE so it never crosses the wire — the same
    // discipline the hardware fingerprint applies per component.
    const raw = "RAW-DEVICE-ID-1234";
    const id = deriveDeviceId(PRODUCT, raw);
    expect(id).not.toContain(raw);
    expect(id).not.toContain("RAW-DEVICE-ID");
    const pure = deviceIdFromRaw(PRODUCT, raw);
    expect(pure).not.toContain(raw);
    expect(pure).not.toContain("RAW-DEVICE-ID");
  });

  it("produces a fixed-length (32-char) base64url id", () => {
    const id = deriveDeviceId(PRODUCT, "fixed-input");
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(deviceIdFromRaw(PRODUCT, "fixed-input")).toMatch(
      /^[A-Za-z0-9_-]{32}$/,
    );
  });

  it("differs by product slug for the same raw input (per-product binding)", () => {
    expect(deriveDeviceId(PRODUCT, "fixed-input")).not.toBe(
      deriveDeviceId("other", "fixed-input"),
    );
    expect(deviceIdFromRaw(PRODUCT, "fixed-input")).not.toBe(
      deviceIdFromRaw("other", "fixed-input"),
    );
  });
});

describe("InMemoryStore", () => {
  it("round-trips token, cache, and exposes a stable device id", async () => {
    const s = new InMemoryStore(PRODUCT);
    expect(await s.getToken()).toBeNull();
    expect(await s.readCache()).toBeNull();

    const dev = await s.getDeviceId();
    expect(dev).toBe(await s.getDeviceId()); // stable across calls

    await s.setToken("pkeyt_x");
    expect(await s.getToken()).toBe("pkeyt_x");

    const rec = sampleCache();
    await s.writeCache(rec);
    expect(await s.readCache()).toEqual(rec);

    await s.clearToken();
    await s.clearCache();
    expect(await s.getToken()).toBeNull();
    expect(await s.readCache()).toBeNull();
  });
});

describe("FileStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "pkey-store-")));
  });

  it("round-trips the token across instances (persisted to disk)", async () => {
    const a = new FileStore(PRODUCT, dir);
    await a.setToken("pkeyt_persisted");
    expect(await a.getToken()).toBe("pkeyt_persisted");
    // A fresh instance over the same dir sees it.
    expect(await new FileStore(PRODUCT, dir).getToken()).toBe(
      "pkeyt_persisted",
    );

    await a.clearToken();
    expect(await a.getToken()).toBeNull();
  });

  it("round-trips the v3 cache record across instances", async () => {
    const a = new FileStore(PRODUCT, dir);
    const rec = sampleCache();
    await a.writeCache(rec);
    // Both slices survive the JSON round trip byte-for-byte — a store that dropped one would
    // silently turn a two-service install into a one-service one.
    expect(await new FileStore(PRODUCT, dir).readCache()).toEqual(rec);

    await a.clearCache();
    expect(await a.readCache()).toBeNull();
  });

  it("persists a stable device id (written once, re-read thereafter)", async () => {
    const a = new FileStore(PRODUCT, dir);
    const id = await a.getDeviceId();
    expect(id).toHaveLength(32);
    // A new instance reads the SAME persisted id (not re-derived fresh).
    expect(await new FileStore(PRODUCT, dir).getDeviceId()).toBe(id);
  });

  it("returns null for a missing token and a missing/corrupt cache", async () => {
    const a = new FileStore(PRODUCT, dir);
    expect(await a.getToken()).toBeNull();
    expect(await a.readCache()).toBeNull();

    // Unparseable JSON reads as ABSENT, not as a throw: a truncated write (a full disk, a
    // crash mid-flush) must degrade to "re-fetch" rather than to a client that cannot boot.
    await a.writeCache(sampleCache());
    writeFileSync(join(dir, PRODUCT, "managed.json"), "{ not json");
    expect(await a.readCache()).toBeNull();
  });

  it("writes the token, cache, and device files with 0600 permissions", async () => {
    const a = new FileStore(PRODUCT, dir);
    await a.setToken("pkeyt_x");
    await a.writeCache(sampleCache());
    await a.getDeviceId();
    const product = join(dir, PRODUCT);
    // The names are v2's on purpose — §8 rebrands wire identifiers, not files on disk.
    expect(statSync(join(product, "token")).mode & 0o777).toBe(0o600);
    expect(statSync(join(product, "managed.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(product, "device")).mode & 0o777).toBe(0o600);
  });
});

describe("KeyringStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "pkey-keyring-")));
    keyring.services.length = 0;
  });

  it("falls back to the 0600 FILE store for the token when the keyring is unavailable", async () => {
    // Headless hosts, containers and CI runners have no usable keyring. The fallback is not a
    // best-effort afterthought: it is the path most server-side installs take, so the token
    // must still land, still round-trip, and still be 0600 — never world-readable because the
    // keyring happened to be missing.
    const store = new KeyringStore(PRODUCT, dir);
    expect(await store.getToken()).toBeNull();

    await store.setToken("pkeyt_fallback");
    expect(await store.getToken()).toBe("pkeyt_fallback");

    // It really is the FILE: a plain FileStore over the same directory reads the same bytes.
    expect(await new FileStore(PRODUCT, dir).getToken()).toBe("pkeyt_fallback");
    expect(statSync(join(dir, PRODUCT, "token")).mode & 0o777).toBe(0o600);

    await store.clearToken();
    expect(await store.getToken()).toBeNull();
    expect(await new FileStore(PRODUCT, dir).getToken()).toBeNull();
  });

  it("asks the keyring for the `pkey:<product>` service tag (§8)", async () => {
    const store = new KeyringStore(PRODUCT, dir);
    await store.setToken("pkeyt_tagged");
    await store.getToken();

    expect(keyring.services.length).toBeGreaterThan(0);
    expect(keyring.services).toContain(`pkey:${PRODUCT}`);
    // The `plrs:` spelling Amendment A1 withdrew must never be written: an install that
    // stored a token under it would silently re-register on every launch.
    expect(keyring.services.every((s) => !s.startsWith("plrs:"))).toBe(true);
  });

  it("delegates the cache record and the device id to the file store", async () => {
    // Only the TOKEN is a keyring concern. The cache is a multi-kilobyte JSON blob of signed
    // artifacts and the device id is not a secret at all; both belong on disk under 0600.
    const store = new KeyringStore(PRODUCT, dir);
    const rec = sampleCache();
    await store.writeCache(rec);
    expect(await store.readCache()).toEqual(rec);
    expect(await new FileStore(PRODUCT, dir).readCache()).toEqual(rec);

    const id = await store.getDeviceId();
    expect(id).toHaveLength(32);
    expect(await new FileStore(PRODUCT, dir).getDeviceId()).toBe(id);

    await store.clearCache();
    expect(await store.readCache()).toBeNull();
  });
});
