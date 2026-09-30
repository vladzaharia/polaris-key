import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { load } from "../runners/browser/zstddec-prefix.mjs";
const require = createRequire(import.meta.url);
// Run from content/. PACKS_DIR holds the 160 MB pair (big_old.bin, big.pf.zst); default: the patching experiment's out/.
const B = (process.env.PACKS_DIR || "../patching/out") + "/",
  o = readFileSync(B + "big_old.bin"),
  d = readFileSync(B + "big.pf.zst");
const want = "085b1d1a9302e7ff1a7fff61d23f9e097e0f6c2021e0f24a2b51acb9e3a23239";
const chk = async (n, f) => {
  const t = performance.now();
  try {
    const r = await f();
    console.log(
      n.padEnd(34),
      createHash("sha256").update(r).digest("hex") === want ? "OK" : "WRONG",
      (performance.now() - t).toFixed(0) + " ms",
    );
  } catch (e) {
    console.log(n.padEnd(34), "ERROR", String(e.message || e).slice(0, 80));
  }
};
const z = await load(readFileSync("runners/browser/zstddec-prefix.wasm"));
await chk("custom wasm (one-shot refPrefix)", () => z.decompress(d, o));
const ZW = require("../npm/node_modules/@bokuweb/zstd-wasm/dist/common/index.node.js");
await ZW.init();
await chk("@bokuweb/zstd-wasm usingDict", () =>
  ZW.decompressUsingDict(ZW.createDCtx(), d, o),
);
const { Decompressor } = require("../npm/node_modules/zstd-napi");
await chk("zstd-napi (default windowLogMax)", () => {
  const x = new Decompressor();
  x.loadDictionary(o);
  return x.decompress(d);
});
await chk("zstd-napi (windowLogMax 31)", () => {
  const x = new Decompressor();
  x.setParameters({ windowLogMax: 31 });
  x.loadDictionary(o);
  return x.decompress(d);
});
