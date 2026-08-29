// The signers' key-order claims, PINNED against the corpus (the audit's A5).
//
// `buildLicenseDoc` and `buildConfigDoc` each carry a comment promising their key order
// matches the conformance corpus's `licenseDoc()` / `configDoc()` fixtures — the corpus pins
// the wire byte-for-byte, and a signer that emits a different order still VERIFIES but stops
// being comparable to the fixtures. Until this file, nothing asserted the promise: the
// worker test then named `configDoc.test.ts` actually exercised the identity fused doc (it
// is `identitySessionDoc.test.ts` now).
//
// The pin decodes the valid-control vectors' payloads straight out of
// `conformance/corpus/v2/cases.json` — JSON.parse preserves the serialized member order for
// string keys, and the builders are plain object literals — so a reordered field in either
// builder (or a regenerated corpus that drifts) fails here with the two sequences side by
// side.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildConfigDoc, buildLicenseDoc } from "../src/core/documents.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "conformance", "corpus", "v2", "cases.json"),
    "utf8",
  ),
) as {
  licenseDocCases: Array<{ id: string; jws: string }>;
  configDocCases: Array<{ id: string; jws: string }>;
};

/** The corpus fixture's key sequence, read out of the signed vector itself. */
function vectorKeys(
  pool: Array<{ id: string; jws: string }>,
  id: string,
): string[] {
  const vector = pool.find((c) => c.id === id);
  expect(vector, `corpus vector "${id}"`).toBeDefined();
  const payload = Buffer.from(vector!.jws.split(".")[1]!, "base64url").toString(
    "utf8",
  );
  return Object.keys(JSON.parse(payload) as Record<string, unknown>);
}

describe("document builders emit the corpus fixtures' key order", () => {
  it("buildLicenseDoc matches the licenseDoc() fixture", () => {
    const built = buildLicenseDoc({
      aud: "djdl",
      deviceId: "dev_order",
      licenseId: "lic_order",
      now: 1_700_000_000,
      maxOfflineDays: 30,
      profile: {
        name: "Ada Lovelace",
        firstName: "Ada",
        email: "ada@x.io",
        activatedAt: 1_700_000_000,
      },
      entitlements: {},
    });
    expect(Object.keys(built)).toEqual(
      vectorKeys(cases.licenseDocCases, "license-valid-control"),
    );
  });

  it("buildConfigDoc matches the configDoc() fixture", () => {
    const built = buildConfigDoc({
      aud: "djdl",
      deviceId: "dev_order",
      now: 1_700_000_000,
      maxOfflineDays: 30,
      schemaVersion: 4,
      payload: { config: {}, secrets: {} },
    });
    expect(Object.keys(built)).toEqual(
      vectorKeys(cases.configDocCases, "config-valid-control"),
    );
  });
});
