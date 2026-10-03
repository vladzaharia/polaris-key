// Encode + verify in ONE instance: prefix stays resident, heap reset between phases. Reports peak linear memory.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [, , from, to, level = "9"] = process.argv;
const x = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(new URL("./zenc.wasm", import.meta.url))),
  {},
).exports;
const mem = () => new Uint8Array(x.memory.buffer);
const a = readFileSync(from),
  b = readFileSync(to);
const t0 = performance.now();
const pp = x.ze_alloc(a.length);
mem().set(a, pp);
const mark = x.ze_mark();
const CH = 1 << 20,
  inp = x.ze_alloc(CH),
  out = x.ze_alloc(CH);
if (x.ze_begin(pp, a.length, BigInt(b.length), +level, 0, 0, 0, -1) !== 0)
  throw new Error("begin");
const parts = [];
for (let o = 0; o < b.length; o += CH) {
  const part = b.subarray(o, o + CH);
  mem().set(part, inp);
  x.ze_input(inp, part.length);
  for (;;) {
    const w = Number(x.ze_step(out, CH, 0));
    if (w < 0) throw new Error("step " + w);
    if (w) parts.push(mem().slice(out, out + w));
    if (x.ze_inleft() === 0 && w < CH) break;
  }
}
x.ze_input(0, 0);
for (;;) {
  const w = Number(x.ze_step(out, CH, 1));
  if (w < 0) throw new Error("end " + w);
  if (w) parts.push(mem().slice(out, out + w));
  if (x.ze_remaining() === 0) break;
}
const encMem = x.memory.buffer.byteLength,
  t1 = performance.now();
const frame = Buffer.concat(parts);
x.ze_reset(mark);
const inp2 = x.ze_alloc(CH),
  out2 = x.ze_alloc(CH);
if (x.zd_begin(pp, a.length, 30) !== 0) throw new Error("zd_begin");
const h = createHash("sha256");
let n = 0;
for (let o = 0; o < frame.length; o += CH) {
  const part = frame.subarray(o, o + CH);
  mem().set(part, inp2);
  x.zd_input(inp2, part.length);
  for (;;) {
    const w = Number(x.zd_step(out2, CH));
    if (w < 0) throw new Error("zd " + w);
    if (w) {
      h.update(mem().subarray(out2, out2 + w));
      n += w;
    }
    if (x.zd_inleft() === 0 && w < CH) break;
  }
}
const ok =
  n === b.length &&
  h.digest("hex") === createHash("sha256").update(b).digest("hex");
console.log(
  JSON.stringify({
    pair: from.split("/").pop() + "->" + to.split("/").pop(),
    level: +level,
    frame: frame.length,
    encMiB: +(encMem / 1048576).toFixed(1),
    peakMiB: +(x.memory.buffer.byteLength / 1048576).toFixed(1),
    decHeapTopMiB: +(x.ze_heap_top() / 1048576).toFixed(1),
    ok,
    encMs: Math.round(t1 - t0),
    totalMs: Math.round(performance.now() - t0),
  }),
);
