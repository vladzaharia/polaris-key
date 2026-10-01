// R2 RED TEAM — adversarial tests against the FROZEN wire contract (@polaris-key/jws).
// These tests document CURRENT behaviour. Several of them assert the *insecure* /
// divergent behaviour on purpose, so that a future fix flips them red and forces a
// deliberate wire-contract decision. Nothing here modifies src/index.ts.

import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  importSigningKey,
  signJws,
  StrictJsonError,
  verifyJws,
  type TrustSet,
} from "./index.js";

const KID = "pkey-test-prod-2026";
const PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const enc = (o: unknown): string =>
  base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(o)));
const encRaw = (s: string): string =>
  base64UrlEncodeBytes(new TextEncoder().encode(s));

const DOC = { schemaVersion: 1, aud: "djdl", iss: "key.plrs.im" };

/** A trust set that records every `kid` lookup, so we can observe HOW FAR into the
 *  verifier an attacker-controlled input is allowed to travel before rejection. */
function watchedTrust(inner: TrustSet): { trust: TrustSet; reads: string[] } {
  const reads: string[] = [];
  const trust = new Proxy(inner, {
    get(target, prop, recv) {
      if (typeof prop === "string") reads.push(prop);
      return Reflect.get(target, prop, recv);
    },
  }) as TrustSet;
  return { trust, reads };
}

// FIXED (R2-04). `MAX_HEADER_BYTES` (1 KiB) now bounds the protected header, and both
// segments are length-checked in their ENCODED form before anything is decoded.
describe("R2-04 · the protected header is size-capped (regression)", () => {
  // Sizes are deliberately just-over-cap rather than dramatic. The original versions used
  // 8 MiB and 16 MiB fillers, which passed locally and TIMED OUT on CI — the first CI run in
  // this repository's history is what surfaced it. `MAX_HEADER_BYTES` is 1 KiB and
  // `MAX_DOC_BYTES` is 64 KiB, so a few KiB over the line exercises exactly the same branch
  // as a few MiB while keeping the suite fast. Proving a bound needs one byte past it, not
  // four orders of magnitude.
  it("an over-cap attacker-controlled HEADER is rejected before any decode or trust lookup", async () => {
    // Previously MAX_DOC_BYTES guarded only `encPayload`, so moving the blob into the
    // header skipped the guard entirely and bought the attacker a free decode + JSON.parse
    // on an unauthenticated segment.
    const bigHeader = { alg: "EdDSA", kid: KID, junk: "A".repeat(4 * 1024) };
    const jws = `${enc(bigHeader)}.${enc(DOC)}.${encRaw("sig")}`;

    const { trust, reads } = watchedTrust({ [KID]: PUB });
    expect(await verifyJws(jws, trust)).toBeNull();
    // The kid is never looked up: the encoded-length check fires first, so no attacker-sized
    // allocation and no JSON.parse ever happens.
    expect(reads).not.toContain(KID);
  });

  it("contrast: an over-cap PAYLOAD is short-circuited before the trust lookup too", async () => {
    const jws = `${enc({ alg: "EdDSA", kid: KID })}.${enc({ ...DOC, junk: "A".repeat(128 * 1024) })}.${encRaw("sig")}`;

    const { trust, reads } = watchedTrust({ [KID]: PUB });
    expect(await verifyJws(jws, trust)).toBeNull();
    expect(reads).not.toContain(KID);
  });

  it("the cap is applied to the ENCODED segment, before any base64 decode or allocation", async () => {
    // This replaces a test that measured how long an over-cap payload took to reject, back
    // when `base64UrlDecode` materialised the whole attacker-chosen buffer before the length
    // check. That is no longer possible: both segments are bounded in their encoded form, so
    // there is nothing to time. Assert the property directly instead of its old symptom.
    const overCap = "A".repeat(200 * 1024);
    const jws = `${enc({ alg: "EdDSA", kid: KID })}.${overCap}.${encRaw("s")}`;

    // A Proxy on the trust set proves rejection happened before key selection, which is the
    // first thing that follows a successful decode.
    const { trust, reads } = watchedTrust({ [KID]: PUB });
    expect(await verifyJws(jws, trust)).toBeNull();
    expect(reads).toEqual([]);
  });
});

// MEASURED cross-language ground truth for duplicate JSON object members (probed directly
// against each runtime, see docs/security/findings/R2-crypto.md):
//   TS      JSON.parse                 -> LAST member wins
//   Python  json.loads                 -> LAST member wins
//   Swift   JSONSerialization          -> FIRST member wins   <-- diverges
// So `{"alg":"none","kid":K,"alg":"EdDSA"}` is EdDSA to TS/Python and `none` to Swift:
// the same signed bytes produce OPPOSITE answers from the algorithm-downgrade guard.
// FIXED (R2-06). Duplicate object members are now REJECTED outright rather than resolved,
// so every language agrees regardless of whether its parser is first-wins or last-wins.
describe("R2-06 · duplicate JSON keys are rejected, not resolved (regression)", () => {
  it('{"alg":"none",...,"alg":"EdDSA"} is REJECTED — no member "wins"', async () => {
    // Craft the header bytes by hand so both `alg` members survive into the wire form.
    const headerJson = `{"alg":"none","kid":${JSON.stringify(KID)},"alg":"EdDSA"}`;
    const encHeader = encRaw(headerJson);
    const encPayload = enc(DOC);
    // Sign the exact crafted signing input (an insider/compromised signer, or the SERVER,
    // could emit this; the point is which member a verifier READS, not who signed it).
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8(PEM),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const raw = await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      new TextEncoder().encode(
        `${encHeader}.${encPayload}`,
      ) as unknown as ArrayBuffer,
    );
    const jws = `${encHeader}.${encPayload}.${base64UrlEncodeBytes(new Uint8Array(raw))}`;

    // Before the fix this VERIFIED: TS took the trailing `alg:"EdDSA"` while Swift's
    // JSONSerialization took the leading `alg:"none"` — the downgrade guard giving opposite
    // answers for identical signed bytes. Rejection is the only resolution all five
    // implementations can agree on.
    expect(await verifyJws(jws, { [KID]: PUB })).toBeNull();
  });

  it('{"alg":"EdDSA",...,"alg":"none"} is REJECTED — proving order, not presence, decides', async () => {
    const headerJson = `{"alg":"EdDSA","kid":${JSON.stringify(KID)},"alg":"none"}`;
    const encHeader = encRaw(headerJson);
    const encPayload = enc(DOC);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8(PEM),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const raw = await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      new TextEncoder().encode(
        `${encHeader}.${encPayload}`,
      ) as unknown as ArrayBuffer,
    );
    const jws = `${encHeader}.${encPayload}.${base64UrlEncodeBytes(new Uint8Array(raw))}`;
    expect(await verifyJws(jws, { [KID]: PUB })).toBeNull();
  });
});

describe("R2-05 · base64url decoding is LENIENT in TS (diverges from Swift's strict decoder)", () => {
  it("accepts the STANDARD base64 alphabet (+ and /) as well as -_", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]); // encodes to "+/+/" family
    const urlSafe = base64UrlEncodeBytes(bytes);
    const standard = urlSafe.replace(/-/g, "+").replace(/_/g, "/");
    expect(standard).not.toBe(urlSafe);
    // Both decode to the same bytes: the wire form is NOT canonical.
    expect([...base64UrlDecode(standard)]).toEqual([...bytes]);
    expect([...base64UrlDecode(urlSafe)]).toEqual([...bytes]);
  });

  it("TS REJECTS out-of-alphabet characters — Python's decoder ACCEPTS the same bytes", () => {
    // Node's `atob` is not `forgiving-base64` for arbitrary junk: it throws. Swift's
    // `Data(base64Encoded:)` (default options, no .ignoreUnknownCharacters) returns nil.
    // Python's `base64.urlsafe_b64decode(..., validate=False)` SILENTLY DISCARDS them —
    // verified out-of-band with the exact source of sdks/python/src/polaris_key/b64url.py:
    //     b64url_decode("AQ!!IDBAUG") -> b"\x01\x02\x03\x04\x05\x06"   (same as "AQIDBAUG")
    // so Python accepts a JWS the TS/Swift verifiers reject. Three-way divergence.
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const clean = base64UrlEncodeBytes(bytes);
    expect(clean).toBe("AQIDBAUG");
    for (const junk of ["\n \t", "!!", "@", "***"]) {
      const dirty = clean.slice(0, 2) + junk + clean.slice(2);
      expect(() => base64UrlDecode(dirty)).toThrow();
    }
  });

  it("a junk-injected SIGNATURE segment: TS rejects, Python's decode yields identical sig bytes", async () => {
    const jws = await signJws(DOC, PEM, KID);
    const [h, p, s] = jws.split(".") as [string, string, string];
    const mangled = `${h}.${p}.${s.slice(0, 4)}!!${s.slice(4)}`;
    // TS: atob throws inside verifyJws's try → null (fail-closed).
    expect(await verifyJws(mangled, { [KID]: PUB })).toBeNull();
    // Python: `sig = b64url_decode(enc_sig)` returns the SAME 64 bytes as the clean form,
    // and `signing_input` is built from enc_header/enc_payload only — so `key.verify`
    // sees identical inputs and SUCCEEDS. Unlimited distinct wire strings, one valid doc.
  });
});

describe("R2-07 · verifyJws does ZERO payload schema validation (diverges from Swift Codable)", () => {
  it("a signed JSON scalar is refused: the payload must be exactly one object (WIRE-CONTRACT-V4 §1.2 rule 3)", async () => {
    // `signJws` refuses to write one (plans/P3-01.md §2.2's signer guard), so the vector is
    // signed over raw segments, as an attacker holding the key would.
    await expect(signJws(42, PEM, KID)).rejects.toBeInstanceOf(StrictJsonError);
    const input = `${enc({ alg: "EdDSA", kid: KID })}.${encRaw("42")}`;
    const sig = await crypto.subtle.sign(
      { name: "Ed25519" },
      await importSigningKey(PEM),
      new TextEncoder().encode(input),
    );
    const jws = `${input}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
    expect(await verifyJws<unknown>(jws, { [KID]: PUB })).toBeNull();
    // v3 returned the scalar here (Python too, while Swift's typed decode refused it); v4's
    // strict JSON profile makes every SDK refuse it at the same step.
  });

  it("a doc missing every required field verifies in TS", async () => {
    const jws = await signJws({}, PEM, KID);
    const v = await verifyJws<Record<string, unknown>>(jws, { [KID]: PUB });
    expect(v).not.toBeNull();
    expect(v?.payload).toEqual({});
  });

  it("a `__proto__` key survives JSON.parse as an own property (no prototype pollution, but unfiltered)", async () => {
    const jws = await signJws({ __proto__: { polluted: true } }, PEM, KID);
    const v = await verifyJws<Record<string, unknown>>(jws, { [KID]: PUB });
    expect(v).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("R2 · control cases — these SHOULD pass and do", () => {
  it("rejects alg=none, alg=HS256, unknown kid, tampered payload", async () => {
    const good = await signJws(DOC, PEM, KID);
    const [, p, s] = good.split(".") as [string, string, string];
    expect(
      await verifyJws(`${enc({ alg: "none", kid: KID })}.${p}.`, {
        [KID]: PUB,
      }),
    ).toBeNull();
    expect(
      await verifyJws(`${enc({ alg: "HS256", kid: KID })}.${p}.${s}`, {
        [KID]: PUB,
      }),
    ).toBeNull();
    expect(await verifyJws(good, { other: PUB })).toBeNull();
    expect(
      await verifyJws(`${good.split(".")[0]}.${enc({ evil: 1 })}.${s}`, {
        [KID]: PUB,
      }),
    ).toBeNull();
  });

  it("rejects a non-32-byte trusted key and never throws", async () => {
    const good = await signJws(DOC, PEM, KID);
    expect(await verifyJws(good, { [KID]: "AAAA" })).toBeNull();
  });
});

/** PKCS#8 PEM → ArrayBuffer (local copy; the module does not export this). */
function pkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
