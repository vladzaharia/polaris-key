import { describe, expect, it } from "vitest";
import {
  hashKey,
  isDeviceToken,
  LICENSE_KEY_SHAPE,
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
    expect(productFromKey("pkey_acme_Q7xZr2Lk9vT3mN8pB1cY4w")).toBe("acme");
    expect(productFromKey("pkey_my-app_Q7xZr2Lk9vT3mN8pB1cY4w")).toBe("my-app");
  });
  it("accepts `_` and `-` inside the 22-character secret", () => {
    expect(productFromKey("pkey_acme_Q7x_r2Lk9vT3-N8pB1cY4_")).toBe("acme");
    expect(productFromKey(`pkey_acme_${"_".repeat(22)}`)).toBe("acme");
  });
  it("returns null for non-license strings", () => {
    expect(productFromKey("not-a-key")).toBeNull();
    expect(productFromKey("pkeyt_opaqueXXXXXXXX")).toBeNull(); // token, not key
    expect(productFromKey("pkey_acme_short")).toBeNull(); // suffix too short
    expect(productFromKey("pkey__Q7xZr2Lk9vT3mN8pB1cY4w")).toBeNull(); // empty product
    expect(productFromKey("pkey_UPPER_Q7xZr2Lk9vT3mN8pB1cY4w")).toBeNull(); // uppercase slug illegal
    expect(productFromKey("pkey_acme_Q7xZr2Lk9vT3mN8pB1cY4=")).toBeNull(); // padding is not base64url
    expect(productFromKey(" pkey_acme_Q7xZr2Lk9vT3mN8pB1cY4w")).toBeNull(); // callers trim
  });
  it("requires EXACTLY 22 characters after the slug (owner decision 2026-10-04)", () => {
    const secret = "Q7xZr2Lk9vT3mN8pB1cY4w";
    expect(secret).toHaveLength(22);
    expect(productFromKey(`pkey_acme_${secret.slice(0, 21)}`)).toBeNull(); // cut off by one
    expect(productFromKey(`pkey_acme_${secret}A`)).toBeNull(); // one too many
    expect(productFromKey("pkey_acme_AbCdEfGhIjKl")).toBeNull(); // the old 8+ floor accepted this
    expect(productFromKey(`pkey_acme_${secret}`)).toBe("acme");
  });
  it("accepts every key mintLicenseKey can produce (16 random bytes -> 22 chars)", () => {
    // No issued key can fail the tightened check: 16 bytes are always 22 unpadded base64url
    // characters, so the exact length is a property of the mint, not of the sample.
    for (let i = 0; i < 2000; i++) {
      const slug = i % 2 === 0 ? "djdl" : "my-app-2";
      const key = mintLicenseKey(slug);
      expect(LICENSE_KEY_SHAPE.exec(key)?.[2]).toHaveLength(22);
      expect(productFromKey(key)).toBe(slug);
    }
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
