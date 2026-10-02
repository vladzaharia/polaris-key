// @polaris-key/zstd-wasm through its workerd entry, in workerd itself (Miniflare): `zdec.wasm`
// arrives as a compiled `WebAssembly.Module`, as wrangler's CompiledWasm rule gives it, and the
// hand-assembled 2^23 window is accepted at 23 and refused at 22 (plans/P4-01.md §9).
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH_FRAME, WINDOW_23_FRAME, base, target } from "./fixtures.js";

const src = (name: string): string =>
  transformSync(
    readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
    { loader: "ts", format: "esm" },
  ).code;

const WORKER = `
import { decode, decodeWithPrefix, version } from "./workerd.js";
const hex = (s) => new Uint8Array(s.match(/../g).map((b) => parseInt(b, 16)));
const tryCode = (f) => { try { f(); return "decoded"; } catch (e) { return e.code ?? String(e); } };
export default {
  async fetch(request) {
    const q = await request.json();
    const frame = hex(q.window23);
    const patch = hex(q.patch);
    const prefix = hex(q.base);
    const out = decodeWithPrefix(patch, prefix, 20000, 15);
    return Response.json({
      version: version(),
      at23: new TextDecoder().decode(decodeWithPrefix(frame, new Uint8Array(0), 5, 23)),
      at22: tryCode(() => decodeWithPrefix(frame, new Uint8Array(0), 5, 22)),
      oneShot: new TextDecoder().decode(decode(frame, 5)),
      patched: Array.from(out.subarray(4990, 5030)),
      patchedLength: out.length,
      patchAt14: tryCode(() => decodeWithPrefix(patch, prefix, 20000, 14)),
    });
  },
};
`;

const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("the workerd entry", () => {
  let mf: Miniflare;
  beforeAll(() => {
    mf = new Miniflare({
      compatibilityDate: "2026-06-01",
      modules: [
        { type: "ESModule", path: "index.js", contents: WORKER },
        { type: "ESModule", path: "workerd.js", contents: src("workerd") },
        { type: "ESModule", path: "core.js", contents: src("core") },
        {
          type: "CompiledWasm",
          path: "zdec.wasm",
          contents: readFileSync(new URL("../src/zdec.wasm", import.meta.url)),
        },
      ],
    });
  });
  afterAll(async () => {
    await mf.dispose();
  });

  it("decodes, applies a patch and refuses the 2^23 window at 22 inside workerd", async () => {
    const res = await mf.dispatchFetch("http://zstd.test/", {
      method: "POST",
      body: JSON.stringify({
        window23: hexOf(WINDOW_23_FRAME),
        patch: hexOf(PATCH_FRAME),
        base: hexOf(base()),
      }),
    });
    expect(await res.json()).toEqual({
      version: 10507,
      at23: "hello",
      at22: "window",
      oneShot: "hello",
      patched: Array.from(target().subarray(4990, 5030)),
      patchedLength: 20000,
      patchAt14: "window",
    });
  }, 30000);
});
