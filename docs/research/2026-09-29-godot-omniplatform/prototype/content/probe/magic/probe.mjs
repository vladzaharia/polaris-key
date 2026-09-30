import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { load } from "../../runners/browser/zstddec-prefix.mjs";
const require = createRequire(import.meta.url);
const d = readFileSync("probe/magic/d.zst"),
  old = readFileSync("probe/magic/old.bin"),
  neu = readFileSync("probe/magic/new.bin");
const chk = async (name, fn) => {
  try {
    const o = await fn();
    console.log(
      name.padEnd(28),
      Buffer.compare(Buffer.from(o), neu) === 0 ? "OK" : "WRONG OUTPUT",
    );
  } catch (e) {
    console.log(
      name.padEnd(28),
      "ERROR",
      String(e.code || e.message || e).slice(0, 70),
    );
  }
};
await chk("node:zlib dictionary", () =>
  zlib.zstdDecompressSync(d, { dictionary: old }),
);
const { Decompressor } = require("../../npm/node_modules/zstd-napi");
await chk("zstd-napi loadDictionary", () => {
  const x = new Decompressor();
  x.loadDictionary(old);
  return x.decompress(d);
});
const ZW = require("../../npm/node_modules/@bokuweb/zstd-wasm/dist/common/index.node.js");
await ZW.init();
await chk("@bokuweb/zstd-wasm usingDict", () =>
  ZW.decompressUsingDict(ZW.createDCtx(), d, old),
);
const z = await load(readFileSync("runners/browser/zstddec-prefix.wasm"));
await chk("custom wasm refPrefix", () => z.decompress(d, old));
