// The Node conformance runner for corpus v2 / wire contract v4. The cases themselves live in
// `suites.ts`, which the browser runner (`conformance/runners/browser`, Chromium, Firefox and
// WebKit) drives too; this file only loads the four corpus files from disk and hands them over.
// See `suites.ts` for what each section asserts.
//
// The banner below names the runtime, so a failure on the version-floor job (CI `node-floor`,
// the lowest Node that `engines.node` allows) is attributable to the Node build that produced it
// (PARITY §4.3).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPUS_FILES, defineCorpusSuites, type CorpusFiles } from "./suites.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = <K extends keyof CorpusFiles>(key: K): CorpusFiles[K] =>
  JSON.parse(
    readFileSync(
      join(here, "..", "..", "corpus", "v2", CORPUS_FILES[key]),
      "utf8",
    ),
  ) as CorpusFiles[K];

const { node, openssl, v8 } = process.versions;
console.log(
  `[conformance-node] node ${node} · openssl ${openssl} · v8 ${v8} · ${process.platform}-${process.arch}`,
);

defineCorpusSuites({
  corpus: read("corpus"),
  matrix: read("matrix"),
  updateMatrix: read("updateMatrix"),
  outletMatrix: read("outletMatrix"),
});
