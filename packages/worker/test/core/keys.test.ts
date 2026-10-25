/**
 * Rotation kids (`core/keys.ts`).
 *
 * The kid of a staged key is `PRIMARY KEY (product, kid)`, so a kid that repeats is a rotation
 * that fails. It used to end in `(now % 100000).toString(36)`, which repeats every ~28 hours and
 * is constant within a second; the suffix is now random. `admin.test.ts` drives the real route
 * (two rotations at one instant, a day apart, and a forced collision); this pins the minter.
 */

import { describe, expect, it } from "vitest";
import { KID_RE } from "@polaris-key/manifest";
import { kidSuffix, mintKid } from "../../src/core/keys.js";
import { insertProductKeyIfAbsent } from "../../src/core/products/store.js";
import { makeTestDb } from "../helpers.js";
import { NOW, seedProduct } from "../seed.js";

describe("kidSuffix", () => {
  it("is 8 symbols of an alphabet an operator can read aloud (no i, l, o or u)", () => {
    for (let i = 0; i < 50; i++)
      expect(kidSuffix()).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
  });

  it("does not repeat: 500 mints are 500 distinct suffixes", () => {
    const suffixes = new Set(Array.from({ length: 500 }, () => kidSuffix()));
    expect(suffixes.size).toBe(500);
  });
});

describe("mintKid", () => {
  it("is <slug>-<year>-<suffix>, a valid kid under the manifest's own rule", () => {
    const kid = mintKid("djdl", NOW)!;
    expect(kid).toMatch(
      new RegExp(`^djdl-${new Date(NOW * 1000).getUTCFullYear()}-[0-9a-z]{8}$`),
    );
    expect(KID_RE.test(kid)).toBe(true);
  });

  it("gives two rotations at one instant, and two exactly 100000 s apart, different kids", () => {
    // The old suffix was a function of `now` alone: these three moments collided pairwise.
    const kids = [NOW, NOW, NOW + 100_000].map((at) => mintKid("djdl", at));
    expect(new Set(kids).size).toBe(3);
  });

  it("fits the longest legal slug (64 characters)", () => {
    const kid = mintKid("a".repeat(64), NOW)!;
    expect(kid).not.toBeNull();
    expect(KID_RE.test(kid)).toBe(true);
  });

  it("answers null for a slug that cannot make a valid kid, rather than minting one", () => {
    // Only a product created before the slug rule capped the length can reach this.
    expect(mintKid("a".repeat(120), NOW)).toBeNull();
  });
});

describe("insertProductKeyIfAbsent", () => {
  const row = (kid: string, pub: string) => ({
    product: "djdl",
    kid,
    alg: "Ed25519",
    public_b64url: pub,
    enc_private_json: "{}",
    status: "staged",
    created_at: NOW,
    rotated_at: null,
    revoked_at: null,
  });

  it("inserts a free kid and reports it", async () => {
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    expect(await insertProductKeyIfAbsent(db, row("djdl-next", "pub-a"))).toBe(
      true,
    );
    const stored = await db.first<{ public_b64url: string; status: string }>(
      "SELECT public_b64url, status FROM product_keys WHERE product = 'djdl' AND kid = 'djdl-next'",
    );
    expect(stored).toEqual({ public_b64url: "pub-a", status: "staged" });
  });

  it("reports a taken kid as a fact, leaving the existing row untouched", async () => {
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    expect(await insertProductKeyIfAbsent(db, row("djdl-next", "pub-a"))).toBe(
      true,
    );
    expect(await insertProductKeyIfAbsent(db, row("djdl-next", "pub-b"))).toBe(
      false,
    );
    const stored = await db.all<{ public_b64url: string }>(
      "SELECT public_b64url FROM product_keys WHERE product = 'djdl' AND kid = 'djdl-next'",
    );
    expect(stored).toEqual([{ public_b64url: "pub-a" }]);
  });
});
