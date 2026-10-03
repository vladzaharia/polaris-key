// Shared driver: works in Node and workerd. `mod` is a WebAssembly.Module.
export function makeEncoder(mod) {
  const inst = new WebAssembly.Instance(mod, {});
  const x = inst.exports;
  const mem = () => new Uint8Array(x.memory.buffer);
  return {
    x,
    mem,
    // prefixLen bytes are filled by fillPrefix(view) (so it can stream from R2 straight into wasm).
    async encode({
      prefixLen,
      fillPrefix,
      srcLen,
      srcChunks,
      level,
      wlog = 0,
      clog = 0,
      hlog = 0,
      ldm = -1,
      onOut,
      chunk = 1 << 20,
    }) {
      const pp = x.ze_alloc(prefixLen);
      if (!pp) throw new Error("oom prefix");
      await fillPrefix((off, bytes) => mem().set(bytes, pp + off));
      const inp = x.ze_alloc(chunk),
        outCap = 1 << 20,
        out = x.ze_alloc(outCap);
      const rc = x.ze_begin(
        pp,
        prefixLen,
        BigInt(srcLen),
        level,
        wlog,
        clog,
        hlog,
        ldm,
      );
      if (rc !== 0) throw new Error("ze_begin " + rc);
      const info = {
        wlog: x.ze_info(0),
        ldm: x.ze_info(1),
        clog: x.ze_info(2),
        hlog: x.ze_info(3),
        strategy: x.ze_info(4),
      };
      let outBytes = 0;
      const emit = async (n) => {
        if (n > 0) {
          outBytes += n;
          await onOut(mem().slice(out, out + n));
        }
      };
      for await (let c of srcChunks) {
        for (let o = 0; o < c.length; o += chunk) {
          const part = c.subarray(o, Math.min(c.length, o + chunk));
          mem().set(part, inp);
          x.ze_input(inp, part.length);
          for (;;) {
            const w = Number(x.ze_step(out, outCap, 0));
            if (w < 0) throw new Error("ze_step " + w);
            await emit(w);
            if (x.ze_inleft() === 0 && w < outCap) break;
          }
        }
      }
      x.ze_input(0, 0);
      for (;;) {
        const w = Number(x.ze_step(out, outCap, 1));
        if (w < 0) throw new Error("ze_step end " + w);
        await emit(w);
        if (x.ze_remaining() === 0) break;
      }
      return {
        info,
        outBytes,
        cctx: x.ze_cctx_size(),
        heapTop: x.ze_heap_top(),
        memBytes: x.memory.buffer.byteLength,
      };
    },
    async decode({
      prefixLen,
      fillPrefix,
      frameChunks,
      wlm,
      onOut,
      chunk = 1 << 20,
    }) {
      const pp = x.ze_alloc(prefixLen);
      if (!pp) throw new Error("oom prefix");
      await fillPrefix((off, bytes) => mem().set(bytes, pp + off));
      const inp = x.ze_alloc(chunk),
        outCap = 1 << 20,
        out = x.ze_alloc(outCap);
      const rc = x.zd_begin(pp, prefixLen, wlm);
      if (rc !== 0) throw new Error("zd_begin " + rc);
      let outBytes = 0;
      for await (let c of frameChunks) {
        for (let o = 0; o < c.length; o += chunk) {
          const part = c.subarray(o, Math.min(c.length, o + chunk));
          mem().set(part, inp);
          x.zd_input(inp, part.length);
          for (;;) {
            const w = Number(x.zd_step(out, outCap));
            if (w < 0) throw new Error("zd_step " + w);
            if (w > 0) {
              outBytes += w;
              await onOut(mem().slice(out, out + w));
            }
            if (x.zd_inleft() === 0 && w < outCap) break;
          }
        }
      }
      return {
        outBytes,
        dctx: x.zd_dctx_size(),
        heapTop: x.ze_heap_top(),
        memBytes: x.memory.buffer.byteLength,
      };
    },
  };
}
