// Loader for the decoder-only libzstd wasm build (zdec.c). decompress(src, dict?, size?) -> Uint8Array
export async function load(src) {
  const bytes =
    typeof src === "string" ? await (await fetch(src)).arrayBuffer() : src;
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  const mem = () => new Uint8Array(x.memory.buffer);
  const put = (u8) => {
    const p = x.zd_alloc(u8.length) >>> 0;
    if (!p && u8.length) throw new Error("wasm OOM");
    mem().set(u8, p);
    return p;
  };
  const v = x.zd_version();
  return {
    version: `${Math.floor(v / 10000)}.${Math.floor(v / 100) % 100}.${v % 100}`,
    decompress(src, dict, size) {
      x.zd_reset();
      const sp = put(src);
      const dp = dict ? put(dict) : 0;
      const cap = size ?? Number(x.zd_content_size(sp, src.length));
      if (cap < 0) throw new Error("zstd: unknown content size");
      const op = x.zd_alloc(cap) >>> 0;
      if (!op && cap) throw new Error("wasm OOM");
      const r = Number(
        x.zd_decompress(op, cap, sp, src.length, dp, dict ? dict.length : 0),
      );
      if (r < 0) throw new Error("zstd error " + (-r - 1));
      return mem().slice(op, op + r);
    },
  };
}
