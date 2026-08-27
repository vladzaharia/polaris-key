import { describe, expect, it } from "vitest";
import {
  hashKey,
  isDeviceToken,
  mintDeviceToken,
  mintLicenseKey,
  mintOpaqueToken,
  productFromKey,
  randomId,
  sha256Hex,
} from "../src/crypto.js";

describe("mintLicenseKey", () => {
  it("is self-identifying: pkey_<product>_<base64url>", () => {
    const k = mintLicenseKey("djdl");
    expect(k.startsWith("pkey_djdl_")).toBe(true);
    expect(productFromKey(k)).toBe("djdl");
  });

  it("is unique across calls", () => {
    expect(mintLicenseKey("djdl")).not.toBe(mintLicenseKey("djdl"));
  });

  it("round-trips a hyphenated product slug", () => {
    const k = mintLicenseKey("my-app");
    expect(productFromKey(k)).toBe("my-app");
  });
});

describe("mintDeviceToken", () => {
  it("is the wire v3 §6 device principal: pkeyt_ + 43 base64url chars", () => {
    const t = mintDeviceToken();
    expect(t).toMatch(/^pkeyt_[A-Za-z0-9_-]{43}$/);
    // Not product-identifiable — a device token must not leak which product it belongs to.
    expect(productFromKey(t)).toBeNull();
  });

  it("is unique across calls", () => {
    expect(mintDeviceToken()).not.toBe(mintDeviceToken());
  });
});

describe("isDeviceToken", () => {
  it("accepts what mintDeviceToken produces", () => {
    expect(isDeviceToken(mintDeviceToken())).toBe(true);
  });

  it("REJECTS the withdrawn plrst_ prefix (wire v3 §8 — one prefix, never two)", () => {
    expect(
      isDeviceToken("plrst_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).toBe(false);
  });

  it("rejects other credential shapes presented as a device token", () => {
    expect(isDeviceToken(mintLicenseKey("djdl"))).toBe(false);
    expect(isDeviceToken(mintOpaqueToken())).toBe(false);
    expect(isDeviceToken("pkeyt_short")).toBe(false);
    expect(isDeviceToken("pkeyt_" + "A".repeat(43) + "!")).toBe(false);
    expect(isDeviceToken("")).toBe(false);
  });
});

describe("mintOpaqueToken", () => {
  it("carries no prefix at all — it names nothing by itself", () => {
    const t = mintOpaqueToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(productFromKey(t)).toBeNull();
    expect(isDeviceToken(t)).toBe(false);
  });

  it("is unique across calls", () => {
    expect(mintOpaqueToken()).not.toBe(mintOpaqueToken());
  });
});

describe("randomId", () => {
  it("carries the typed prefix", () => {
    expect(randomId("lic").startsWith("lic_")).toBe(true);
    expect(randomId("dev").startsWith("dev_")).toBe(true);
  });
  it("is unique across calls", () => {
    expect(randomId("flow")).not.toBe(randomId("flow"));
  });
});

describe("productFromKey", () => {
  it("extracts from a valid license key", () => {
    expect(productFromKey("pkey_acme_AbCdEfGhIjKl")).toBe("acme");
  });
  it("returns null for non-license strings", () => {
    expect(productFromKey("not-a-key")).toBeNull();
    expect(productFromKey("pkeyt_opaqueXXXXXXXX")).toBeNull(); // token, not key
    expect(productFromKey("pkey_acme_short")).toBeNull(); // suffix too short (<8)
    expect(productFromKey("pkey__AbCdEfGhIjKl")).toBeNull(); // empty product
    expect(productFromKey("pkey_UPPER_AbCdEfGhIjKl")).toBeNull(); // uppercase slug illegal
  });
});

describe("sha256Hex", () => {
  it("is a stable 64-char lowercase hex digest", async () => {
    const h = await sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Known SHA-256("hello").
    expect(h).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("is deterministic and input-sensitive", async () => {
    expect(await sha256Hex("a")).toBe(await sha256Hex("a"));
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });
});

describe("hashKey", () => {
  it("with no pepper equals the plain sha256", async () => {
    expect(await hashKey("secret")).toBe(await sha256Hex("secret"));
  });

  it("is deterministic for the same value+pepper", async () => {
    expect(await hashKey("secret", "pep")).toBe(await hashKey("secret", "pep"));
  });

  it("a different pepper changes the hash", async () => {
    const a = await hashKey("secret", "pep-a");
    const b = await hashKey("secret", "pep-b");
    const none = await hashKey("secret");
    expect(a).not.toBe(b);
    expect(a).not.toBe(none);
    expect(b).not.toBe(none);
  });

  it("a different value changes the hash (same pepper)", async () => {
    expect(await hashKey("a", "pep")).not.toBe(await hashKey("b", "pep"));
  });

  it("produces a hex digest", async () => {
    expect(await hashKey("v", "pep")).toMatch(/^[0-9a-f]{64}$/);
  });
});
