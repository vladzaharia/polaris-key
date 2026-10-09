// WIRE-CONTRACT-V4 §1: canonical base64url. A lenient decoder maps several spellings onto the
// same bytes (the unused low bits of the last character are ignored), so a verifier that
// accepted them would accept a signature segment, header or key the signer never wrote. The
// corpus pins the same rule as signed vectors (`*-noncanonical-trailing-bits` in `jwsCases`).
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  importSigningKey,
  importVerifyKey,
  isCanonicalB64url,
  signJws,
  verifyJws,
} from "./index.js";

const KID = "djdl-test-2026";
const PUB = "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U";
const PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIXpeKmxx2+0A+lz89t+5fp5PPjd2vFGhXqwTpWYeL5O\n-----END PRIVATE KEY-----";
const TRUST = { [KID]: PUB };
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const utf8 = new TextEncoder();

/** The same base64url text with the last character's unused bits set: decodes leniently to the
 *  same bytes, and is not canonical. Only for lengths 2 or 3 mod 4. */
function trailingBits(s: string): string {
  // Bit 0 is unused at both lengths: 4 unused bits at 2 mod 4, 2 at 3 mod 4.
  const last = ALPHABET.indexOf(s[s.length - 1]!);
  return s.slice(0, -1) + ALPHABET[last | 0x01]!;
}

/** Sign over the given ENCODED header and payload segments, verbatim. */
async function signSegments(encHeader: string, encPayload: string) {
  const key = await importSigningKey(PEM);
  const input = `${encHeader}.${encPayload}`;
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    utf8.encode(input),
  );
  return `${input}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}

describe("isCanonicalB64url (WIRE-CONTRACT-V4 §1)", () => {
  it("accepts exactly the encoder's own output", () => {
    for (const [s, ok] of [
      ["", true],
      ["AA", true],
      ["AQ", true],
      ["AB", false],
      ["AAA", true],
      ["AAE", true],
      ["AAB", false],
      ["AAAA", true],
      ["A", false],
      ["AAAAA", false],
      ["AA==", false],
      ["A+/A", false],
      ["AA\n", false],
      [" AA", false],
    ] as const)
      expect(isCanonicalB64url(s), JSON.stringify(s)).toBe(ok);
  });

  it("every length round-trips, and every trailing-bits variant is refused", () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = Uint8Array.from(
        { length: n },
        (_, i) => (i * 37 + n) & 0xff,
      );
      const enc = base64UrlEncodeBytes(bytes);
      expect(isCanonicalB64url(enc), `length ${n}`).toBe(true);
      if (enc.length % 4 === 0) continue;
      const bad = trailingBits(enc);
      // The attack: a lenient decoder reads the variant as the same bytes.
      expect(base64UrlDecode(bad)).toEqual(bytes);
      expect(isCanonicalB64url(bad), `variant of length ${n}`).toBe(false);
    }
  });
});

describe("verifyJws refuses non-canonical segments and keys (WIRE-CONTRACT-V4 §1)", () => {
  it("a signature whose last character differs only in its unused bits", async () => {
    const jws = await signJws({ a: 1 }, PEM, KID, "pkey-license+jws");
    expect(await verifyJws(jws, TRUST)).not.toBeNull();
    const [h, p, s] = jws.split(".") as [string, string, string];
    expect(await verifyJws(`${h}.${p}.${trailingBits(s)}`, TRUST)).toBeNull();
  });

  it("a header or payload spelled non-canonically, even when signed as spelled", async () => {
    const header = base64UrlEncodeBytes(
      utf8.encode(`{"alg":"EdDSA","typ":"pkey-config+jws","kid":"${KID}"}`),
    );
    const payload = base64UrlEncodeBytes(utf8.encode('{"a":1}'));
    expect(header.length % 4).not.toBe(0);
    expect(payload.length % 4).not.toBe(0);
    expect(
      await verifyJws(await signSegments(header, payload), TRUST),
    ).not.toBeNull();
    expect(
      await verifyJws(await signSegments(trailingBits(header), payload), TRUST),
    ).toBeNull();
    expect(
      await verifyJws(await signSegments(header, trailingBits(payload)), TRUST),
    ).toBeNull();
  });

  it("a trust-set key with its trailing bits set, at import and at verification", async () => {
    const jws = await signJws({ a: 1 }, PEM, KID, "pkey-license+jws");
    const bent = trailingBits(PUB);
    expect(base64UrlDecode(bent)).toEqual(base64UrlDecode(PUB));
    await expect(importVerifyKey(bent)).rejects.toThrow(/canonical/);
    expect(await verifyJws(jws, { [KID]: bent })).toBeNull();
    // Out-of-alphabet spellings of the key are refused too (atob would have accepted them).
    expect(
      await verifyJws(jws, {
        [KID]: PUB.replace(/-/g, "+").replace(/_/g, "/"),
      }),
    ).toBeNull();
    expect(await verifyJws(jws, { [KID]: `${PUB}=` })).toBeNull();
  });

  it("a segment with a trailing newline", async () => {
    const jws = await signJws({ a: 1 }, PEM, KID, "pkey-license+jws");
    expect(await verifyJws(`${jws}\n`, TRUST)).toBeNull();
    const [h, p, s] = jws.split(".") as [string, string, string];
    expect(await verifyJws(`${h}\n.${p}.${s}`, TRUST)).toBeNull();
  });
});
