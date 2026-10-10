// The Node conformance runner for corpus v2 / wire contract v4. The cases themselves live in
// `suites.ts`, which the browser runner (`conformance/runners/browser`, Chromium, Firefox and
// WebKit) drives too; this file only loads the four corpus files from disk and hands them over,
// with the content corpus (`content/cases.json`, its blobs read raw) under three zstd backends:
// `@polaris-key/zstd-wasm` alone; the Node SDK's own backend (`node:zlib` where it has zstd, and
// for `--patch-from` frames only when its start-up probe decodes); and that backend with the
// probe failed, as on a Node whose dictionary option is ignored (22.15–22.18, 24.0–24.5), where
// deltas go through the WASM decoder. See `suites.ts` for what each section asserts.
//
// The banner below names the runtime, so a failure on the version-floor job (CI `node-floor`,
// the lowest Node that `engines.node` allows) is attributable to the Node build that produced it
// (PARITY §4.3).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { selectNodeZstd } from "@polaris-key/node/packs";
import { BACKEND_LOCALES } from "@polaris-key/client-core/backend";
import {
  BACKEND_MATRIX_FILE,
  backendCopyFile,
  CONTENT_DIR,
  CORPUS_FILES,
  defineBackendSuites,
  defineContentSuites,
  defineCorpusSuites,
  type BackendMatrix,
  type ContentCorpus,
  type CorpusFiles,
} from "./suites.js";

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
  planMatrix: read("planMatrix"),
});

// Product backends (WIRE-CONTRACT-V4 §14): `backend-matrix.json`, with the copy catalog's `codes`
// tables (`conformance/parity/copy.<locale>.json`) that its problem rows are written from.
const parity = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, "..", "..", "parity", name), "utf8"));
defineBackendSuites({
  matrix: JSON.parse(
    readFileSync(
      join(here, "..", "..", "corpus", "v2", BACKEND_MATRIX_FILE),
      "utf8",
    ),
  ) as BackendMatrix,
  copy: Object.fromEntries(
    BACKEND_LOCALES.map((l) => [
      l,
      (parity(backendCopyFile(l)) as { codes: unknown }).codes,
    ]),
  ) as Parameters<typeof defineBackendSuites>[0]["copy"],
});

// The content corpus: `content/cases.json` and every file under `content/blobs/`, by its path
// there with `/` separators.
const contentDir = join(here, "..", "..", "corpus", "v2", CONTENT_DIR);
const blobsDir = join(contentDir, "blobs");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const [wasm, auto, failedProbe] = await Promise.all([
  selectNodeZstd({ mode: "wasm" }),
  selectNodeZstd({ mode: "auto" }),
  selectNodeZstd({ mode: "fail-probe" }),
]);
console.log(
  `[conformance-node] zstd: plain ${auto.info.plain}, prefix ${auto.info.prefix}` +
    (auto.info.dictionaryIgnored ? " (node:zlib dictionary ignored)" : ""),
);

defineContentSuites({
  content: JSON.parse(
    readFileSync(join(contentDir, "cases.json"), "utf8"),
  ) as ContentCorpus,
  loadBlobs: () =>
    Promise.resolve(
      new Map(
        walk(blobsDir).map((path) => [
          relative(blobsDir, path).split(sep).join("/"),
          new Uint8Array(readFileSync(path)),
        ]),
      ),
    ),
  backends: [
    { label: "wasm", zstd: wasm.zstd },
    {
      label: `node (plain ${auto.info.plain}, prefix ${auto.info.prefix})`,
      zstd: auto.zstd,
    },
    {
      label: `node, probe failed (plain ${failedProbe.info.plain}, prefix ${failedProbe.info.prefix})`,
      zstd: failedProbe.zstd,
    },
  ],
});
