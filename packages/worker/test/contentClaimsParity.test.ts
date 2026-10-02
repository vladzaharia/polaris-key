// The two `content` checks agree (P4-02 review N3). A descriptor's `content` moves unchanged into
// the signed record, so the descriptor validator (`@polaris-key/manifest`'s
// `descriptorContentProblem`) and the record verifier (`@polaris-key/client-core`'s
// `contentClaims`) must give the same verdict on every content value: a descriptor the validator
// accepts must never become a record the ingest refuses at `claims`, and the other way round.
//
// The cases are every `content` the conformance corpus signs into a release or pack record
// (decoded from its JWS payloads), plus a hand table for the edges the corpus has no record for.
// One deliberate difference is asserted rather than hidden: the manifest refuses the reserved
// `holds` and `packChannels` members until P4-12, and the verifier ignores unknown members.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { descriptorContentProblem } from "@polaris-key/manifest";
import { contentClaims } from "@polaris-key/client-core";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "conformance", "corpus", "v2", "cases.json"),
    "utf8",
  ),
) as Record<string, Array<{ id: string; jws?: unknown }>>;

function payloadOf(jws: unknown): Record<string, unknown> | null {
  if (typeof jws !== "string") return null;
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    const doc = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as unknown;
    return typeof doc === "object" && doc !== null && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const RESERVED = ["holds", "packChannels"] as const;

function hasReserved(c: unknown): boolean {
  return (
    typeof c === "object" &&
    c !== null &&
    RESERVED.some((k) => Object.hasOwn(c, k))
  );
}

const corpusContent: Array<[id: string, content: unknown]> = [];
for (const group of ["releaseRecordCases", "packRecordCases"]) {
  for (const c of corpus[group] ?? []) {
    const doc = payloadOf(c.jws);
    if (doc && Object.hasOwn(doc, "content"))
      corpusContent.push([c.id, doc.content]);
  }
}

const SHA = "5a1b28503acd3f1d1a89bf78a52fe7c5dd69060fda4a3e20ee0439e5efdfff45";
const pin = (pack: string, over: Record<string, unknown> = {}) => ({
  pack,
  release: { sha256: SHA, seq: 2, version: "1.1.0", ...over },
});
const expect1 = (pack: string, over: Record<string, unknown> = {}) => ({
  pack,
  required: true,
  delivery: "essential",
  ...over,
});
const base = (over: Record<string, unknown> = {}) => ({
  contentApi: 3,
  pins: [pin("djdl.levels")],
  expects: [expect1("djdl.levels")],
  ...over,
});

const handTable: Array<[id: string, content: unknown]> = [
  ["valid", base()],
  ["empty pins and expects", base({ pins: [], expects: [] })],
  ["not an object", "content"],
  ["an array", [base()]],
  ["null", null],
  ["contentApi a string", base({ contentApi: "3" })],
  ["contentApi negative", base({ contentApi: -1 })],
  ["contentApi fractional", base({ contentApi: 1.5 })],
  ["contentApi max safe", base({ contentApi: Number.MAX_SAFE_INTEGER })],
  ["pins not an array", base({ pins: {} })],
  ["pin pack with a slash", base({ pins: [pin("djdl/levels")] })],
  ["pin pack exactly 64 bytes", base({ pins: [pin("a".repeat(64))] })],
  ["pin release not an object", base({ pins: [{ pack: "x", release: 1 }] })],
  ["pin seq a string", base({ pins: [pin("djdl.levels", { seq: "2" })] })],
  ["pin version empty", base({ pins: [pin("djdl.levels", { version: "" })] })],
  [
    "pin sha256 short",
    base({ pins: [pin("djdl.levels", { sha256: SHA.slice(1) })] }),
  ],
  ["unknown member ignored", base({ extra: true })],
  ["expects not an array", base({ expects: null })],
  [
    "expect delivery uppercase",
    base({ expects: [expect1("djdl.levels", { delivery: "Essential" })] }),
  ],
  [
    "expect required a number",
    base({ expects: [expect1("djdl.levels", { required: 1 })] }),
  ],
  [
    "pins over the maximum",
    base({ pins: Array.from({ length: 257 }, (_, i) => pin(`p${i}`)) }),
  ],
  [
    "pins at the maximum",
    base({ pins: Array.from({ length: 256 }, (_, i) => pin(`p${i}`)) }),
  ],
];

describe("descriptorContentProblem and contentClaims agree (N3)", () => {
  it("the corpus signs content into records", () => {
    expect(corpusContent.length).toBeGreaterThan(20);
  });

  it.each([...corpusContent, ...handTable])("%s", (_id, content) => {
    const manifestOk = descriptorContentProblem(content) === null;
    const recordOk = contentClaims(content);
    if (hasReserved(content)) {
      // The one deliberate difference: reserved until P4-12 in the manifest, ignored by the
      // verifier. Without them, the verdicts agree again.
      expect(manifestOk).toBe(false);
      const stripped = { ...(content as Record<string, unknown>) };
      for (const k of RESERVED) delete stripped[k];
      expect(descriptorContentProblem(stripped) === null).toBe(
        contentClaims(stripped),
      );
      return;
    }
    expect(manifestOk).toBe(recordOk);
  });
});
