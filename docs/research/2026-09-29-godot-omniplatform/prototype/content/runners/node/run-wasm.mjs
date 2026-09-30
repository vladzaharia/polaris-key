// Node runner using the custom decoder-only wasm (same module the browser uses).
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Store, runAll } from "../js/cases.mjs";
import { load } from "../browser/zstddec-prefix.mjs";
const [
  root,
  wasm = new URL("../browser/zstddec-prefix.wasm", import.meta.url).pathname,
] = process.argv.slice(2);
const z = await load(await readFile(wasm));
const prim = {
  sha256: (u8) => createHash("sha256").update(u8).digest("hex"),
  zstd: (u8, { dict, size } = {}) => z.decompress(u8, dict, size),
};
const doc = JSON.parse(await readFile(join(root, "cases.json"), "utf8"));
const store = new Store(
  { raw: async (n) => new Uint8Array(await readFile(join(root, "blobs", n))) },
  prim,
);
const t0 = performance.now();
const { n, bad } = await runAll(doc, store, console.log, !!process.env.VERBOSE);
console.log(
  `node ${process.version} [custom wasm libzstd ${z.version}, ${wasm.split("/").pop()}]: ${n - bad}/${n} cases match, ${(performance.now() - t0).toFixed(0)} ms`,
);
process.exit(bad ? 1 : 0);
