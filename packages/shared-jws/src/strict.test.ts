// WIRE-CONTRACT-V4 §1.1–§1.2 and §2: the strict verifier every `typ` shares. The corpus pins
// the same rules as signed vectors (`jwsCases`); these are the unit-level proofs.
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  ed25519Prechecks,
  isNonWireIntegerToken,
  MAX_JSON_DEPTH,
  numberTokenInRange,
  scanStrictJson,
  signJws,
  SMALL_ORDER_ENCODINGS,
  verifyJws,
  type JwsTyp,
} from "./index.js";

const KID = "djdl-test-2026";
const PUB = "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U";
const PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIXpeKmxx2+0A+lz89t+5fp5PPjd2vFGhXqwTpWYeL5O\n-----END PRIVATE KEY-----";
const TRUST = { [KID]: PUB };

const ALL_TYPS: JwsTyp[] = [
  "pkey-license+jws",
  "pkey-config+jws",
  "pkey-trust+jws",
  "pkey-bundle+jws",
  "pkey-feed+jws",
  "pkey-release+jws",
];

const utf8 = new TextEncoder();

/** Sign raw header and payload bytes (for vectors `JSON.stringify` cannot write). */
async function signRaw(
  header: Uint8Array,
  payload: Uint8Array,
): Promise<string> {
  const { importSigningKey } = await import("./index.js");
  const input = `${base64UrlEncodeBytes(header)}.${base64UrlEncodeBytes(payload)}`;
  const key = await importSigningKey(PEM);
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    utf8.encode(input),
  );
  return `${input}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}
const HEADER = utf8.encode(
  `{"alg":"EdDSA","typ":"pkey-license+jws","kid":"${KID}"}`,
);

describe("typ separation between every pair (WIRE-CONTRACT-V4 §2)", () => {
  for (const signed of ALL_TYPS) {
    for (const expected of ALL_TYPS) {
      it(`${signed} at a ${expected} call site → ${signed === expected ? "ok" : "refused"}`, async () => {
        const jws = await signJws({ a: 1 }, PEM, KID, signed);
        const v = await verifyJws(jws, TRUST, { typ: expected });
        if (signed === expected) expect(v?.payload).toEqual({ a: 1 });
        else expect(v).toBeNull();
      });
    }
  }
});

describe("Ed25519 pre-checks (WIRE-CONTRACT-V4 §1.1)", () => {
  it("refuses S + L, an equation valid mod L (check 1)", async () => {
    const jws = await signJws({ a: 1 }, PEM, KID, "pkey-license+jws");
    const [h, p, s] = jws.split(".") as [string, string, string];
    const sig = base64UrlDecode(s);
    let carry = 0;
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const lBytes = new Uint8Array(32);
    for (let k = 0, n = L; k < 32; k++, n >>= 8n) lBytes[k] = Number(n & 0xffn);
    const out = new Uint8Array(sig);
    for (let k = 0; k < 32; k++) {
      const sum = out[32 + k]! + lBytes[k]! + carry;
      out[32 + k] = sum & 0xff;
      carry = sum >> 8;
    }
    expect(ed25519Prechecks(base64UrlDecode(PUB), out)).toBe(false);
    expect(
      await verifyJws(`${h}.${p}.${base64UrlEncodeBytes(out)}`, TRUST),
    ).toBeNull();
    expect(ed25519Prechecks(base64UrlDecode(PUB), sig)).toBe(true);
  });

  it("refuses every small-order key and R (check 3)", () => {
    const sig = new Uint8Array(64);
    sig.set(base64UrlDecode(PUB), 0); // any canonical, not small-order R
    for (const hex of SMALL_ORDER_ENCODINGS) {
      const bytes = Uint8Array.from(
        hex.match(/../g)!.map((b) => parseInt(b, 16)),
      );
      expect(ed25519Prechecks(bytes, sig)).toBe(false);
      const withR = new Uint8Array(64);
      withR.set(bytes, 0);
      expect(ed25519Prechecks(base64UrlDecode(PUB), withR)).toBe(false);
    }
    expect(SMALL_ORDER_ENCODINGS).toHaveLength(8);
  });

  it("refuses non-canonical encodings: y ≥ p, and x = 0 with the sign bit (check 2)", () => {
    const sig = new Uint8Array(64);
    sig.set(base64UrlDecode(PUB), 0);
    const yPlusOne = new Uint8Array(32).fill(0xff);
    yPlusOne[0] = 0xee; // p + 1 = 2^255 − 18
    yPlusOne[31] = 0x7f;
    const negZero = new Uint8Array(32);
    negZero[0] = 1;
    negZero[31] = 0x80;
    for (const bad of [yPlusOne, negZero]) {
      expect(ed25519Prechecks(bad, sig)).toBe(false);
      const withR = new Uint8Array(64);
      withR.set(bad, 0);
      expect(ed25519Prechecks(base64UrlDecode(PUB), withR)).toBe(false);
    }
  });
});

describe("scanStrictJson (WIRE-CONTRACT-V4 §1.2)", () => {
  const refused = [
    ["a NaN literal", '{"a":NaN}'],
    ["Infinity", '{"a":Infinity}'],
    ["-Infinity", '{"a":-Infinity}'],
    ["a trailing comma", '{"a":1,}'],
    ["a comment", '{"a":1/*x*/}'],
    ["a raw control character", '{"a":"\u0001"}'],
    ["a lone high surrogate escape", '{"a":"\\ud800"}'],
    ["a lone low surrogate escape", '{"a":"\\udc00"}'],
    ["a reversed pair", '{"a":"\\udc00\\ud800"}'],
    ["a lone surrogate in a member name", '{"\\ud800":1}'],
    ["U+0000 in a member name", '{"a\\u0000b":1}'],
    ["a duplicate name after unescaping", '{"a":1,"\\u0061":2}'],
    ["1e400", '{"a":1e400}'],
    ["1e-400", '{"a":1e-400}'],
    ["5e-324", '{"a":5e-324}'],
    ["an exponent of ten digits", '{"a":1e4294967297}'],
    ["zero with a seven-digit exponent", '{"a":0e1000000}'],
    ["negative zero with a seven-digit exponent", '{"a":-0.0e1234567}'],
    ["a top-level array", "[1]"],
    ["a top-level scalar", "42"],
    ["a leading BOM", '\ufeff{"a":1}'],
    ["two objects", '{"a":1}{"b":2}'],
  ] as const;
  for (const [name, text] of refused) {
    it(`refuses ${name}`, () => {
      expect(scanStrictJson(text).ok).toBe(false);
    });
  }

  it("accepts canonically equivalent names (scalar comparison, never normalized)", () => {
    expect(scanStrictJson('{"\\u00e9":1,"e\\u0301":2}').ok).toBe(true);
  });

  it("accepts an escaped surrogate pair, noncharacters and an escaped backslash before u0000", () => {
    expect(scanStrictJson('{"a":"\\ud83d\\udcbb"}').ok).toBe(true);
    expect(scanStrictJson('{"\\uffff":"\\uffff"}').ok).toBe(true);
    expect(scanStrictJson('{"a\\\\u0000":1}').ok).toBe(true);
  });

  it("counts depth with the top-level object as level 1", () => {
    const nest = (levels: number): string =>
      `${"{".repeat(1)}"a":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}`;
    expect(MAX_JSON_DEPTH).toBe(64);
    expect(scanStrictJson(nest(64)).ok).toBe(true);
    expect(scanStrictJson(nest(65)).ok).toBe(false);
  });

  it("reports the pointer of every number that cannot be a wire integer, sorted", () => {
    const scan = scanStrictJson(
      '{"seq":7,"b":7.0,"a/b":[1,17e8,9007199254740991,9007199254740992],"t~":{"x":-0,"y":1.5}}',
    );
    expect(scan.ok).toBe(true);
    expect(scan.nonWireIntegers).toEqual([
      "/a~1b/1",
      "/a~1b/3",
      "/b",
      "/t~0/y",
    ]);
  });

  it("judges rule 8 from the digits and the token rule from the spelling", () => {
    for (const t of [
      "7",
      "-0",
      "7.0",
      "7e0",
      "7.5",
      "1e-7",
      "1e+21",
      "1e-307",
      "9.99e307",
      "0e5",
      "0e999999",
    ])
      expect(numberTokenInRange(t)).toBe(true);
    for (const t of [
      "1e308",
      "1e-308",
      "5e-324",
      "1e400",
      "1e4294967297",
      "0e1000000",
      "-0.0e1234567",
      "0e-0001000000",
    ])
      expect(numberTokenInRange(t)).toBe(false);
    for (const t of ["7", "-0", "0", "9007199254740991", "-9007199254740991"])
      expect(isNonWireIntegerToken(t)).toBe(false);
    for (const t of [
      "7.0",
      "7e0",
      "17e8",
      "9007199254740992",
      "10000000000000000",
    ])
      expect(isNonWireIntegerToken(t)).toBe(true);
  });
});

describe("verifyJws applies the strict profile to header and payload", () => {
  it("returns nonWireIntegers beside the payload", async () => {
    const jws = await signRaw(
      HEADER,
      utf8.encode('{"issuedAt":1700000000.0,"n":3}'),
    );
    const v = await verifyJws(jws, TRUST, { typ: "pkey-license+jws" });
    expect(v?.payload).toEqual({ issuedAt: 1700000000, n: 3 });
    expect([...(v?.nonWireIntegers ?? [])]).toEqual(["/issuedAt"]);
  });

  it("refuses ill-formed UTF-8, CESU-8, an overlong and a BOM", async () => {
    const bad = [
      Uint8Array.from([...utf8.encode('{"a":"'), 0xff, ...utf8.encode('"}')]),
      Uint8Array.from([
        ...utf8.encode('{"a":"'),
        0xed,
        0xa0,
        0x80,
        ...utf8.encode('"}'),
      ]),
      Uint8Array.from([
        ...utf8.encode('{"a":"'),
        0xc0,
        0xaf,
        ...utf8.encode('"}'),
      ]),
      Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8.encode('{"a":1}')]),
    ];
    for (const payload of bad)
      expect(await verifyJws(await signRaw(HEADER, payload), TRUST)).toBeNull();
    const bomHeader = Uint8Array.from([0xef, 0xbb, 0xbf, ...HEADER]);
    expect(
      await verifyJws(await signRaw(bomHeader, utf8.encode('{"a":1}')), TRUST),
    ).toBeNull();
    expect(
      await verifyJws(await signRaw(HEADER, utf8.encode('{"a":1}')), TRUST),
    ).not.toBeNull();
  });
});
