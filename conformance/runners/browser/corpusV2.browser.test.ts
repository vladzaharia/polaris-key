// The browser conformance runner for corpus v2 / wire contract v4 (P1b-05). It drives the SAME
// suites as the Node runner (`../node/suites.ts`, through `@polaris-key/client-core`) inside a
// real browser engine, so WebCrypto's Ed25519 and SHA-256, not Node's, verify every vector in
// `cases.json`, `gate-matrix.json`, `update-matrix.json` and `outlet-matrix.json`. The files come
// in through Vite's JSON import rather than node:fs. `fingerprint.json` stays Node-only (the web
// has no fingerprint, PARITY §5.4), as do `stage-matrix.json`, `headers.json` and the transcripts.
//
// A case this engine cannot run fails; it is never skipped (notes/A7 §5).

import corpus from "../../corpus/v2/cases.json";
import matrix from "../../corpus/v2/gate-matrix.json";
import updateMatrix from "../../corpus/v2/update-matrix.json";
import outletMatrix from "../../corpus/v2/outlet-matrix.json";
import { defineCorpusSuites, type CorpusFiles } from "../node/suites.js";

// The banner: which engine build produced this log (PARITY §4.3).
console.log(`[conformance-browser] ${navigator.userAgent}`);

defineCorpusSuites({
  corpus: corpus as unknown as CorpusFiles["corpus"],
  matrix: matrix as unknown as CorpusFiles["matrix"],
  updateMatrix: updateMatrix as unknown as CorpusFiles["updateMatrix"],
  outletMatrix: outletMatrix as unknown as CorpusFiles["outletMatrix"],
});
