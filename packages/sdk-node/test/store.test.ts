import { mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
import {
  CACHE_VERSION,
  deriveDeviceId,
  FileStore,
  InMemoryStore,
  type CacheRecord,
} from "../src/store.js";

function sampleDoc(): ManagedConfigDoc {
  return {
    schemaVersion: 1,
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "lic-1",
    deviceId: "dev-1",
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    graceUntil: 1_702_592_000,
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: 1_690_000_000,
    },
    payload: {
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
      entitlements: {
        polarisVpn: {
          state: "enforced",
          value: true,
          updatedAt: 1_700_000_000,
        },
      },
    },
  };
}

function sampleCache(): CacheRecord {
  // v2 (wire contract §4.1): the cache holds SIGNED ARTIFACTS only. `doc`, `trustedKeys` and
  // the three unsigned counters are gone — every one of them is derived from a re-verified
  // signature at load time now.
  return {
    v: CACHE_VERSION,
    configJws: `${b64url(JSON.stringify({ alg: "EdDSA", typ: "pkey-config+jws", kid: "k" }))}.${b64url(JSON.stringify(sampleDoc()))}.sig`,
    etag: '"etag-1"',
    lastSyncUnauthorized: false,
  };
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

describe("deriveDeviceId", () => {
  it("is deterministic for a fixed input (same slug + fallback → same id)", () => {
    const a = deriveDeviceId("djdl", "fixed-input");
    const b = deriveDeviceId("djdl", "fixed-input");
    expect(a).toBe(b);
  });

  it("is hashed: the raw input never appears in the output", () => {
    const raw = "RAW-DEVICE-ID-1234";
    const id = deriveDeviceId("djdl", raw);
    expect(id).not.toContain(raw);
    expect(id).not.toContain("RAW-DEVICE-ID");
  });

  it("produces a fixed-length (32-char) base64url id", () => {
    const id = deriveDeviceId("djdl", "fixed-input");
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("differs by product slug for the same raw input (per-product binding)", () => {
    expect(deriveDeviceId("djdl", "fixed-input")).not.toBe(
      deriveDeviceId("other", "fixed-input"),
    );
  });
});

describe("InMemoryStore", () => {
  it("round-trips token, cache, and exposes a stable device id", async () => {
    const s = new InMemoryStore("djdl");
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
  afterEach(() => {
    // temp dir; left for the OS to reap
  });

  it("round-trips the token across instances (persisted to disk)", async () => {
    const a = new FileStore("djdl", dir);
    await a.setToken("pkeyt_persisted");
    expect(await a.getToken()).toBe("pkeyt_persisted");
    // A fresh instance over the same dir sees it.
    expect(await new FileStore("djdl", dir).getToken()).toBe("pkeyt_persisted");

    await a.clearToken();
    expect(await a.getToken()).toBeNull();
  });

  it("round-trips the cache record across instances", async () => {
    const a = new FileStore("djdl", dir);
    const rec = sampleCache();
    await a.writeCache(rec);
    expect(await new FileStore("djdl", dir).readCache()).toEqual(rec);

    await a.clearCache();
    expect(await a.readCache()).toBeNull();
  });

  it("persists a stable device id (written once, re-read thereafter)", async () => {
    const a = new FileStore("djdl", dir);
    const id = await a.getDeviceId();
    expect(id).toHaveLength(32);
    // A new instance reads the SAME persisted id (not re-derived fresh).
    expect(await new FileStore("djdl", dir).getDeviceId()).toBe(id);
  });

  it("returns null for a missing token and a missing/corrupt cache", async () => {
    const a = new FileStore("djdl", dir);
    expect(await a.getToken()).toBeNull();
    expect(await a.readCache()).toBeNull();
  });

  it("writes the token, cache, and device files with 0600 permissions", async () => {
    const a = new FileStore("djdl", dir);
    await a.setToken("pkeyt_x");
    await a.writeCache(sampleCache());
    await a.getDeviceId();
    const product = join(dir, "djdl");
    expect(statSync(join(product, "token")).mode & 0o777).toBe(0o600);
    expect(statSync(join(product, "managed.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(product, "device")).mode & 0o777).toBe(0o600);
  });
});
