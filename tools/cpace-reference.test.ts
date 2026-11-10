// The CPace reference's own checks (CC-29.1; WIRE-CONTRACT-V5 §15.12). The draft's vectors
// (tools/corpus/inputs/cpace-anchors.json) are reproduced by tools/corpus/cpace.ts when the corpus
// is generated; this test holds the reference to them directly and shows it is not vacuous.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCpace } from "./corpus/cpace.js";
import {
  REF_P,
  bytesHex,
  hexBytes,
  refC1,
  refCpaceGenerator,
  refCpaceRun,
  refElligator2,
  refEncodeU,
  refParseC1,
  refParseC2,
  refShareCheck,
} from "./corpus/reference/cpace.js";
import { refPrologue } from "./corpus/reference/peerMatrix.js";

const here = dirname(fileURLToPath(import.meta.url));
const anchors = JSON.parse(
  readFileSync(join(here, "corpus", "inputs", "cpace-anchors.json"), "utf8"),
) as {
  source: { url: string; sha256: string };
  vectors: { id: string; vector: Record<string, string> }[];
};

describe("cpace reference", () => {
  it("pins the draft revision and reproduces its vectors", () => {
    expect(anchors.source.url).toContain("draft-irtf-cfrg-cpace-21");
    expect(anchors.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    // buildCpace throws when any vendored vector is not reproduced.
    expect(() => buildCpace()).not.toThrow();
  });

  it("derives the draft's generator", () => {
    const v = anchors.vectors.find((a) => a.id === "B.1.1")!.vector;
    const g = refCpaceGenerator(
      hexBytes(v.PRS!),
      hexBytes(v.CI!),
      hexBytes(v.sid!),
    );
    expect(bytesHex(g.g)).toBe(v.g);
  });

  it("maps a value at or above p like its residue", () => {
    expect(bytesHex(refElligator2(refEncodeU(REF_P + 5n)).u)).toBe(
      bytesHex(refElligator2(refEncodeU(5n)).u),
    );
    const top = refEncodeU(7n);
    top[31] = 0x80;
    expect(bytesHex(refElligator2(top).u)).toBe(
      bytesHex(refElligator2(refEncodeU(7n)).u),
    );
  });

  const ci = refPrologue("demo", "q");
  const base = {
    kind: "code" as const,
    slug: "demo",
    ci,
    sid: new Uint8Array(10).fill(3),
    ya: new Uint8Array(32).fill(5),
    yb: new Uint8Array(32).fill(6),
  };

  it("agrees on one key for one password and not for another", () => {
    const ok = refCpaceRun({ ...base, secret: "123456" });
    expect(bytesHex(ok.kJoiner)).toBe(bytesHex(ok.kShower));
    expect(ok.psk).toHaveLength(32);
    const other = refCpaceRun({ ...base, secret: "123457" });
    expect(bytesHex(other.psk)).not.toBe(bytesHex(ok.psk));
    expect(
      bytesHex(refCpaceRun({ ...base, slug: "other", secret: "123456" }).psk),
    ).not.toBe(bytesHex(ok.psk));
  });

  it("refuses the frames and shares the contract names", () => {
    const run = refCpaceRun({ ...base, secret: "123456" });
    expect(refParseC1(run.c1).ok).toBe(true);
    expect(refParseC2(run.c2).ok).toBe(true);
    expect(refParseC1(run.c1.slice(1)).ok).toBe(false);
    expect(refParseC1(refC1("code", new Uint8Array(32))).ok).toBe(false);
    expect(refShareCheck(refEncodeU(REF_P)).ok).toBe(false);
    const top = Uint8Array.from(run.Ya);
    top[31] = top[31]! | 0x80;
    expect(refShareCheck(top)).toEqual({ ok: false, reason: "non-canonical" });
  });
});
