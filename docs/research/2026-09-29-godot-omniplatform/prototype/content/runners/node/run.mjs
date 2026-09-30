// usage: node run.mjs <vector-dir> [zlib|zstd-napi]
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { join } from "node:path";
import { Store, runAll } from "../js/cases.mjs";

const [root, backend = "zlib"] = process.argv.slice(2);
const sha256 = (u8) => createHash("sha256").update(u8).digest("hex");
let zstd;
if (backend === "zlib") {
  // node:zlib zstd (Node >= 22.15); `dictionary` = raw-content dictionary, which decodes --patch-from frames.
  const params = { [zlib.constants.ZSTD_d_windowLogMax]: 31 };
  zstd = (u8, { dict } = {}) =>
    new Uint8Array(
      zlib.zstdDecompressSync(
        u8,
        dict ? { dictionary: dict, params } : { params },
      ),
    );
} else if (backend === "zstd-napi") {
  const { Decompressor } = await import(process.env.NAPI_PATH || "zstd-napi");
  zstd = (u8, { dict } = {}) => {
    const d = new Decompressor();
    d.setParameters({ windowLogMax: 31 });
    if (dict) d.loadDictionary(Buffer.from(dict));
    return new Uint8Array(d.decompress(Buffer.from(u8)));
  };
}
const prim = { sha256, zstd };
const doc = JSON.parse(await readFile(join(root, "cases.json"), "utf8"));
const store = new Store(
  { raw: async (n) => new Uint8Array(await readFile(join(root, "blobs", n))) },
  prim,
);
const t0 = performance.now();
const { n, bad, results } = await runAll(
  doc,
  store,
  console.log,
  !!process.env.VERBOSE,
);
console.log(
  `node ${process.version} [${backend}, libzstd ${process.versions.zstd}]: ${n - bad}/${n} cases match, ${(performance.now() - t0).toFixed(0)} ms total`,
);
if (process.env.DUMP)
  await writeFile(process.env.DUMP, JSON.stringify(results, null, 1));
process.exit(bad ? 1 : 0);
