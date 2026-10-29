// @pkey-feature connect.protocol
// The browser conformance runner for `peer-matrix.json` (WIRE-CONTRACT-V5 §15.4 to §15.7): the
// same suites as the Node runner (`../node/peerMatrixSuites.ts`, through
// `@polaris-key/client-core`) inside a real browser engine, with SHA-256 from `crypto.subtle`.
// The file comes in through Vite's JSON import rather than node:fs. Every row runs in every
// engine (the matrix needs only HMAC, SHA-256 and HKDF); a row this engine cannot run fails and
// is never skipped (notes/A7 §5).

import peerMatrix from "../../corpus/v2/peer-matrix.json";
import {
  registerPeerMatrixSuites,
  type PeerMatrix,
} from "../node/peerMatrixSuites.js";

// The banner: which engine build produced this log (PARITY §4.3).
console.log(`[conformance-browser] ${navigator.userAgent}`);

registerPeerMatrixSuites(peerMatrix as unknown as PeerMatrix, {
  sha256: async (b) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>),
    ),
});
