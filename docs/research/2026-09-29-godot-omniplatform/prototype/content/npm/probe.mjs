import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import zlib from "node:zlib";
const require = createRequire(import.meta.url);
const V = "../vectors/small/";
const doc = JSON.parse(readFileSync(V + "cases.json"));
const full = readFileSync(V + "blobs/payload/v1.full.zst");
const v1 = zlib.zstdDecompressSync(full);
const delta = readFileSync(V + "blobs/deltas/v1-v2.pf.zst");
const want = doc.payloads.v2.sha256;
const probeOld = readFileSync("../probe/old.bin"), probeD = readFileSync("../probe/d.zst"), probeNew = readFileSync("../probe/new.bin");
const sha = (u8) => createHash("sha256").update(u8).digest("hex");
const pkgv = (p) => JSON.parse(readFileSync(`node_modules/${p}/package.json`)).version;
const out = [];
async function test(name, plain, dict) {
  const r = { name };
  try { const t = performance.now(); const o = await plain(full, v1.length); r.plain = sha(o) === doc.payloads.v1.sha256 ? `OK ${(v1.length / 1e6 / ((performance.now() - t) / 1e3)).toFixed(0)} MB/s` : "WRONG"; } catch (e) { r.plain = "ERR " + (e.message || e).toString().slice(0, 60); }
  if (!dict) { r.dict = "no API"; out.push(r); return; }
  try { const o = await dict(delta, v1, doc.payloads.v2.size); r.dict = sha(o) === want ? "OK" : "WRONG"; } catch (e) { r.dict = "ERR " + (e.message || e).toString().slice(0, 80); }
  try { const o = await dict(probeD, probeOld, probeNew.length); r.dict2 = Buffer.compare(Buffer.from(o), probeNew) === 0 ? "OK" : "WRONG"; } catch (e) { r.dict2 = "ERR " + (e.message || e).toString().slice(0, 80); }
  out.push(r);
}
await test(`node:zlib (Node ${process.version})`, (b) => zlib.zstdDecompressSync(b), (b, d) => zlib.zstdDecompressSync(b, { dictionary: d }));
{
  const { Decompressor } = require("zstd-napi");
  await test(`zstd-napi ${pkgv("zstd-napi")}`, (b) => new Decompressor().decompress(b), (b, d) => { const x = new Decompressor(); x.loadDictionary(d); return x.decompress(b); });
}
{
  const m = require("@mongodb-js/zstd");
  await test(`@mongodb-js/zstd ${pkgv("@mongodb-js/zstd")}`, (b) => m.decompress(b), null);
}
{
  const f = require("fzstd");
  await test(`fzstd ${pkgv("fzstd")}`, (b) => f.decompress(b), null);
}
{
  const z = await import("@bokuweb/zstd-wasm");
  await z.init();
  await test(`@bokuweb/zstd-wasm ${pkgv("@bokuweb/zstd-wasm")}`, (b) => z.decompress(b), (b, d) => z.decompressUsingDict(z.createDCtx(), b, d));
}
{
  const { ZstdCodec } = require("zstd-codec");
  const zstd = await new Promise((res) => ZstdCodec.run(res));
  const s = new zstd.Simple();
  await test(`zstd-codec ${pkgv("zstd-codec")}`, (b) => s.decompress(b), (b, d) => s.decompressUsingDict(b, new zstd.Dict.Decompression(d)));
}
{
  const { ZSTDDecoder } = await import("zstddec");
  const z = new ZSTDDecoder(); await z.init();
  await test(`zstddec ${pkgv("zstddec")}`, (b, n) => z.decode(b, n), null);
}
console.table(out);
