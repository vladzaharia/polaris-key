// plans/P3-01.md §2.2, "Keeping the signer total": `signJws` refuses to sign a header or payload
// that breaks WIRE-CONTRACT-V4 §1.2 rules 5, 7, 8 or 9, so the Worker can never emit a document
// a v4 verifier refuses. Each refused vector is the one the plan's acceptance names.
import { describe, expect, it } from "vitest";
import {
  MAX_JSON_DEPTH,
  signJws,
  StrictJsonError,
  verifyJws,
} from "./index.js";

const KID = "djdl-test-2026";
const PUB = "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U";
const PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIXpeKmxx2+0A+lz89t+5fp5PPjd2vFGhXqwTpWYeL5O\n-----END PRIVATE KEY-----";
const TRUST = { [KID]: PUB };

/** `{"x":{"x":…{}}}` with `levels` objects in all, the top-level one included. */
function nested(levels: number): Record<string, unknown> {
  let v: Record<string, unknown> = {};
  for (let k = 1; k < levels; k++) v = { x: v };
  return v;
}

async function refusal(payload: unknown, kid = KID): Promise<unknown> {
  try {
    await signJws(payload, PEM, kid, "pkey-license+jws");
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("signJws refuses what a strict verifier refuses (StrictJsonError)", () => {
  const refused: [string, unknown][] = [
    ["a lone high surrogate in a value (rule 5)", { a: "\ud800" }],
    ["a lone low surrogate in a value (rule 5)", { a: "x\udc00y" }],
    ["a reversed surrogate pair (rule 5)", { a: "\udc00\ud800" }],
    ["a lone surrogate in a member name (rule 5)", { "\ud800": 1 }],
    ["U+0000 in a member name (rule 7)", { "a\u0000b": 1 }],
    ["a number that underflows (rule 8)", { a: 1e-320 }],
    ["the smallest subnormal (rule 8)", { a: 5e-324 }],
    ["a number nested in an array (rule 8)", { a: [1, 2, 1e-308] }],
    [`${MAX_JSON_DEPTH + 1} levels (rule 9)`, nested(MAX_JSON_DEPTH + 1)],
    ["a payload that is not an object", 42],
    ["an undefined payload", undefined],
  ];
  for (const [name, payload] of refused) {
    it(name, async () => {
      const e = await refusal(payload);
      expect(e).toBeInstanceOf(StrictJsonError);
      expect((e as StrictJsonError).part).toBe("payload");
    });
  }

  it("a lone surrogate in the header's kid is refused as the header", async () => {
    const e = await refusal({ a: 1 }, "kid-\ud800");
    expect(e).toBeInstanceOf(StrictJsonError);
    expect((e as StrictJsonError).part).toBe("header");
  });

  it("is an Error with a stable name", async () => {
    const e = (await refusal({ a: "\ud800" })) as StrictJsonError;
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("StrictJsonError");
  });
});

describe("signJws still signs everything a strict verifier accepts, byte for byte", () => {
  const accepted: [string, unknown][] = [
    ["a surrogate pair", { a: "😀" }],
    ["U+0000 in a value (V3 §10's docNulReplaced case)", { a: "x\u0000y" }],
    ["canonically equivalent sibling names", { "\u00e9": 1, "e\u0301": 2 }],
    ["rule 8's smallest magnitude", { a: 1e-307 }],
    ["rule 8's largest magnitude", { a: 9.99e307 }],
    ["a fractional value", { a: 1700000000.5 }],
    ["zero and negative zero", { a: 0, b: -0 }],
    [`exactly ${MAX_JSON_DEPTH} levels`, nested(MAX_JSON_DEPTH)],
  ];
  for (const [name, payload] of accepted) {
    it(name, async () => {
      const jws = await signJws(payload, PEM, KID, "pkey-license+jws");
      const v = await verifyJws(jws, TRUST, { typ: "pkey-license+jws" });
      expect(v).not.toBeNull();
      // The guard never rewrites: the signed payload is JSON.stringify's own output.
      const [, p] = jws.split(".") as [string, string];
      expect(Buffer.from(p, "base64url").toString("utf8")).toBe(
        JSON.stringify(payload),
      );
    });
  }
});
