// @pkey-feature identity.devicecode
// The QR encoder at level Q (UK-67.1, the Light Card): the golden symbol the kits' geometry is
// pinned against, and the capacity that level Q gives.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { encodeQr, qrCapacity } from "../src/qr/encoder.js";

const golden = JSON.parse(
  readFileSync(
    new URL(
      "../../ui-core/test/fixtures/lightCard.golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { payload: string; rows: string[] };

describe("encodeQr at level Q", () => {
  it("gives the golden symbol for the golden payload", () => {
    const q = encodeQr(golden.payload, 1, -1, "Q")!;
    const rows = Array.from({ length: q.size }, (_, y) =>
      Array.from({ length: q.size }, (_, x) =>
        q.modules[y * q.size + x] ? "#" : ".",
      ).join(""),
    );
    expect(rows).toEqual(golden.rows);
  });
  it("holds less than level M and chooses the version by it", () => {
    // Version 1 holds 14 bytes at M and 11 at Q; 4 holds 62 and 46.
    expect([1, 4].map((v) => qrCapacity(v))).toEqual([14, 62]);
    expect([1, 4].map((v) => qrCapacity(v, "Q"))).toEqual([11, 46]);
    expect(encodeQr("a".repeat(12), 1, -1, "Q")!.version).toBe(2);
    expect(encodeQr("a".repeat(12))!.version).toBe(1);
  });
  it("leaves level M as it was", () => {
    expect(encodeQr(golden.payload)!.modules).not.toEqual(
      encodeQr(golden.payload, 1, -1, "Q")!.modules,
    );
  });
});
