// @pkey-feature connect.protocol connect.lan connect.links
// The Node conformance runner for `conformance/corpus/v2/peer-matrix.json` (WIRE-CONTRACT-V5
// §15.4 to §15.7). It covers React too, since both JS SDKs share `@polaris-key/client-core`. The
// suites are `peerMatrixSuites.ts`, shared with the browser runner; this file only reads the
// matrix with node:fs and supplies SHA-256 from node:crypto. The `lanAddresses` rows (connect.lan)
// and the `contact` rows (connect.links: the secret, the CONTACT body, the exchange, the store, the
// trial order, the pin, the advert, the room id and alias, the ticket body) run through the same
// suites.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerPeerMatrixSuites,
  type PeerMatrix,
} from "./peerMatrixSuites.js";

const here = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  readFileSync(join(here, "../../corpus/v2/peer-matrix.json"), "utf8"),
) as PeerMatrix;

registerPeerMatrixSuites(matrix, {
  sha256: async (b) => new Uint8Array(createHash("sha256").update(b).digest()),
});

import { describe, expect, it } from "vitest";

describe("peer-matrix.json sections this runner must run (connect.links)", () => {
  it("has the contact section", () => {
    expect(Object.keys(matrix)).toContain("contact");
  });
});
