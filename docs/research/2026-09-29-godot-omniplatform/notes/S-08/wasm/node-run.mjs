import {
  readFileSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { makeEncoder } from "./zenc.mjs";
const [
  ,
  ,
  from,
  to,
  out,
  level = "19",
  wlog = "0",
  clog = "0",
  hlog = "0",
  ldm = "-1",
] = process.argv;
const mod = new WebAssembly.Module(
  readFileSync(new URL("./zenc.wasm", import.meta.url)),
);
const enc = makeEncoder(mod);
const a = readFileSync(from),
  b = readFileSync(to);
const fd = openSync(out, "w");
const t0 = process.hrtime.bigint();
const c0 = process.cpuUsage();
const r = await enc.encode({
  prefixLen: a.length,
  fillPrefix: async (put) => put(0, a),
  srcLen: b.length,
  srcChunks: (async function* () {
    for (let o = 0; o < b.length; o += 1 << 20)
      yield b.subarray(o, o + (1 << 20));
  })(),
  level: +level,
  wlog: +wlog,
  clog: +clog,
  hlog: +hlog,
  ldm: +ldm,
  onOut: async (u) => writeSync(fd, u),
});
closeSync(fd);
const c1 = process.cpuUsage(c0);
console.log(
  JSON.stringify({
    from,
    to,
    level: +level,
    ...r,
    wallMs: Number(process.hrtime.bigint() - t0) / 1e6,
    cpuMs: (c1.user + c1.system) / 1000,
  }),
);
