// @pkey-feature connect.protocol connect.lan
// The Node conformance runner for `conformance/corpus/v2/peer-matrix.json` (WIRE-CONTRACT-V5
// §15.4 to §15.7). It covers React too, since both JS SDKs share `@polaris-key/client-core`. The
// suites are `peerMatrixSuites.ts`, shared with the browser runner; this file only reads the
// matrix with node:fs and supplies SHA-256 from node:crypto. The `lanAddresses` rows (connect.lan)
// run through the same suites.

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
