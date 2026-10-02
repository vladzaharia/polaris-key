// The browser conformance runner for corpus v2 / wire contract v4 (P1b-05). It drives the SAME
// suites as the Node runner (`../node/suites.ts`, through `@polaris-key/client-core`) inside a
// real browser engine, so WebCrypto's Ed25519 and SHA-256, not Node's, verify every vector in
// `cases.json`, `gate-matrix.json`, `update-matrix.json`, `outlet-matrix.json` and
// `plan-matrix.json`. The files come in through Vite's JSON import rather than node:fs. The
// content corpus (`content/cases.json`) runs too: its blobs are read raw through Vitest's
// `readFile` command (harness only), and the files index and every apply case decode through
// `@polaris-key/zstd-wasm`'s browser entry (`loadZstdWasm`), the decoder `@polaris-key/react`
// ships, compiled by this engine (wasm32: P = 30). `fingerprint.json` stays
// Node-only (the web has no fingerprint, PARITY §5.4), as do `stage-matrix.json`, `headers.json`
// and the transcripts.
//
// A case this engine cannot run fails; it is never skipped (notes/A7 §5).

import corpus from "../../corpus/v2/cases.json";
import matrix from "../../corpus/v2/gate-matrix.json";
import updateMatrix from "../../corpus/v2/update-matrix.json";
import outletMatrix from "../../corpus/v2/outlet-matrix.json";
import planMatrix from "../../corpus/v2/plan-matrix.json";
import content from "../../corpus/v2/content/cases.json";
import { commands } from "@vitest/browser/context";
import { loadZstdWasm } from "@polaris-key/zstd-wasm/browser";
import {
  defineContentSuites,
  defineCorpusSuites,
  type ContentCorpus,
  type CorpusFiles,
} from "../node/suites.js";

// The banner: which engine build produced this log (PARITY §4.3).
console.log(`[conformance-browser] ${navigator.userAgent}`);

defineCorpusSuites({
  corpus: corpus as unknown as CorpusFiles["corpus"],
  matrix: matrix as unknown as CorpusFiles["matrix"],
  updateMatrix: updateMatrix as unknown as CorpusFiles["updateMatrix"],
  outletMatrix: outletMatrix as unknown as CorpusFiles["outletMatrix"],
  planMatrix: planMatrix as unknown as CorpusFiles["planMatrix"],
});

// Every file under content/blobs/: the glob lists them (its URLs are unused: Vite's dev server
// cannot serve an extensionless file raw), and Vitest's `readFile` command reads each one's bytes
// on the Node side, as base64, relative to this file.
const BLOB_PREFIX = "../../corpus/v2/content/blobs/";
const BLOB_PATHS = Object.keys(
  import.meta.glob<string>("../../corpus/v2/content/blobs/**/*", {
    query: "?url",
    import: "default",
    eager: true,
  }),
);

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const zstd = await loadZstdWasm();

defineContentSuites({
  content: content as unknown as ContentCorpus,
  loadBlobs: async () =>
    new Map(
      await Promise.all(
        BLOB_PATHS.map(
          async (path) =>
            [
              path.slice(BLOB_PREFIX.length),
              fromBase64(await commands.readFile(path, "base64")),
            ] as const,
        ),
      ),
    ),
  backends: [
    {
      label: "wasm (browser entry)",
      zstd: {
        pointerBits: 30,
        decode: zstd.decode,
        decodeWithPrefix: zstd.decodeWithPrefix,
      },
    },
  ],
});
