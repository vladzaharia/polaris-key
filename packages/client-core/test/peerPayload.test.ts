// WIRE-CONTRACT-V5 §15.5: `v` and `ring` are integer claims; a token written 1.0 or 1e0 is not the
// integer, although JSON.parse reads it as one (corpus peer-matrix handshakePayloads).
import { describe, expect, it } from "vitest";
import { parseHandshakePayload } from "../src/peer/payload.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const cert = "e30.e30.c2ln";

describe("handshake payload integer claims", () => {
  it("refuses `v` written 1.0 or 1e0, in every message and mode", () => {
    for (const v of ["1.0", "1e0", "10e-1"]) {
      expect(parseHandshakePayload("a", 1, utf8(`{"v":${v}}`)).ok, v).toBe(
        false,
      );
      expect(
        parseHandshakePayload("v", 2, utf8(`{"v":${v},"caps":[]}`)).ok,
        v,
      ).toBe(false);
      expect(
        parseHandshakePayload(
          "a",
          3,
          utf8(`{"v":${v},"cert":"${cert}","ring":7,"caps":[]}`),
        ).ok,
        v,
      ).toBe(false);
    }
    expect(parseHandshakePayload("a", 1, utf8('{"v":1}')).ok).toBe(true);
  });

  it("refuses `ring` written 7.0 or 7e0", () => {
    for (const ring of ["7.0", "7e0"])
      expect(
        parseHandshakePayload(
          "a",
          2,
          utf8(`{"v":1,"cert":"${cert}","ring":${ring},"caps":[]}`),
        ).ok,
        ring,
      ).toBe(false);
    expect(
      parseHandshakePayload(
        "a",
        2,
        utf8(`{"v":1,"cert":"${cert}","ring":7,"caps":[]}`),
      ),
    ).toMatchObject({ ok: true, ring: 7 });
  });
});
