// @vitest-environment node
// P4-16: the v3 pack types through `createBrowserPacks` (the in-memory store): `data.json` and
// `l10n.table` (built in), `ml.model` (the host's handler, load-tested from the staged bytes, as
// a page with no file paths must), a game's `custom.dialogue`, the typed refusals, and
// `supports()` for the pairs the web declares N/A (`godot.zip`, `audio.bank`).
//
// @pkey-feature packs.handlers packs.type.l10n.table packs.type.data.json packs.type.ml.model packs.type.godot.zip packs.type.audio.bank

import { describe, expect, it } from "vitest";
import type { ZstdPort } from "@polaris-key/client-core";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { Feature, UnsupportedReason } from "../src/constants.generated.js";
import {
  DataJsonHandler,
  L10nTableHandler,
  MlModelHandler,
  createBrowserPacks,
  type PackHandler,
} from "../src/index.js";
import {
  PRODUCT,
  PRODUCT_TRUST,
  RELEASE_KEYS,
  byteServer,
  stampFor,
  treePack,
  type TreePack,
} from "./packFixtures.js";
import { makeDoc, makeFakeFetch, NOW_SEC, services } from "./fixtures.js";

const BASE = "https://k.test";
const zstd: ZstdPort = {
  pointerBits: 30,
  decode: wasmDecode,
  decodeWithPrefix: wasmDecodeWithPrefix,
};
const discovery = {
  version: 2,
  protocolVersion: 4,
  product: PRODUCT,
  baseUrl: BASE,
  services: {
    release: {
      enabled: true,
      endpoints: { record: `${BASE}/${PRODUCT}/release/records/{sha256}` },
    },
    distribution: {
      enabled: true,
      endpoints: {
        blobs: `${BASE}/${PRODUCT}/distribution/blobs/sha256/{sha256}`,
      },
    },
  },
};

function fetchOver(server: ReturnType<typeof byteServer>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const rec = /\/release\/records\/([0-9a-f]{64})$/.exec(url.pathname);
    if (rec) {
      const r = await server.fetchRecord(rec[1]!);
      return r.ok ? new Response(r.body) : new Response("", { status: 404 });
    }
    const blob = /\/distribution\/blobs\/sha256\/([0-9a-f]{64})$/.exec(
      url.pathname,
    );
    if (!blob) return new Response("", { status: 404 });
    const range = new Headers(init?.headers).get("range");
    const o = await server.fetchObject({
      sha256: blob[1]!,
      offset: range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0,
      ifRange: null,
    });
    const parts: Uint8Array[] = [];
    for await (const c of o.chunks) parts.push(c);
    return new Response(Buffer.concat(parts), {
      status: o.status,
      headers: o.contentRange ? { "content-range": o.contentRange } : {},
    });
  }) as typeof fetch;
}

function packs(stamp: TreePack[], handlers: PackHandler[] = []) {
  return createBrowserPacks({
    baseUrl: BASE,
    product: PRODUCT,
    discovery: discovery as never,
    releaseKeys: RELEASE_KEYS,
    productTrust: PRODUCT_TRUST,
    contentStamp: JSON.stringify({
      format: "pkey-content/1",
      ...stampFor(...stamp),
    }),
    fetchImpl: fetchOver(byteServer(...stamp)),
    zstd,
    storage: "memory",
    axes: { locale: ["fr"] },
    handlers,
  });
}

describe("v3 pack types in @polaris-key/react (web)", () => {
  it("installs data.json and l10n.table packs with the built-in handlers", async () => {
    const events = await treePack({
      packId: "djdl.events",
      version: "1.0.0",
      seq: 1,
      files: { "a.json": '{"v":1}' },
      type: "data.json",
    });
    const l10n = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: { "fr.csv": "keys,fr\nplay,Jouer\n" },
      type: "l10n.table",
      variant: { locale: "fr" },
    });
    const data = new DataJsonHandler();
    const tables = new L10nTableHandler();
    const p = packs([events, l10n], [data, tables]);
    await p.ensure(["djdl.events", "djdl.l10n"]);
    expect(data.documents("djdl.events")?.get("a.json")).toEqual({ v: 1 });
    expect(tables.tables("djdl.l10n")?.[0]?.messages[0]?.strings).toEqual([
      "Jouer",
    ]);
  });

  it("refuses a data.json pack whose file is not strict JSON", async () => {
    const bad = await treePack({
      packId: "djdl.events",
      version: "1.0.0",
      seq: 1,
      files: { "a.json": "{'v': 1}" },
      type: "data.json",
    });
    await expect(packs([bad]).ensure(["djdl.events"])).rejects.toMatchObject({
      code: "pack-type-check-failed",
      detail: "json",
      path: "a.json",
    });
  });

  it("load-tests an ml.model from the staged bytes, and refuses another runtime", async () => {
    const model = (runtime: string) =>
      treePack({
        packId: "djdl.model",
        version: "1.0.0",
        seq: 1,
        files: {
          "model.json": JSON.stringify({
            runtime,
            file: "m.onnx",
            memBytes: 1,
          }),
          "m.onnx": "ONNX",
        },
        type: "ml.model",
      });
    const seen: string[] = [];
    const h = new MlModelHandler({
      runtimes: ["onnx"],
      ramBytes: 64,
      loadTest: async ({ file }) => {
        seen.push(
          new TextDecoder().decode(await file.source.read(0, file.size)),
        );
        return true;
      },
    });
    const v1 = await model("onnx");
    await packs([v1], [h]).ensure(["djdl.model"]);
    expect(seen).toEqual(["ONNX"]);
    expect(h.model("djdl.model")?.path).toBe("m.onnx");
    const other = await model("gguf");
    await expect(
      packs([other], [h]).ensure(["djdl.model"]),
    ).rejects.toMatchObject({
      code: "pack-type-check-failed",
      detail: "runtime",
    });
  });

  it("installs a game's custom.dialogue pack end to end through registerHandler", async () => {
    const v1 = await treePack({
      packId: "djdl.dialogue",
      version: "1.0.0",
      seq: 1,
      files: { "intro.txt": "Hello." },
      type: "custom.dialogue",
    });
    const got: string[] = [];
    const p = packs([v1]);
    p.registerHandler({
      type: "custom.dialogue",
      layout: "tree",
      activation: "hot",
      supports: (fv) => fv === 1,
      activate: async (_i, payload) => {
        for (const f of (await payload.read())?.files ?? [])
          got.push(new TextDecoder().decode(await f.source.read(0, f.size)));
      },
    });
    await p.ensure(["djdl.dialogue"]);
    expect(got).toEqual(["Hello."]);
  });

  it("answers supports() per type: godot.zip and audio.bank are web N/As", async () => {
    const a = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc(), {
        capabilities: services("release", "distribution", "update"),
      }),
      now: () => NOW_SEC,
    });
    for (let i = 0; i < 50 && a.snapshot().phase === "loading"; i++)
      await new Promise((r) => setTimeout(r, 0));
    for (const id of [
      Feature.packsTypeL10nTable,
      Feature.packsTypeDataJson,
      Feature.packsTypeMlModel,
    ])
      expect(a.supports(id).supported, id).toBe(true);
    for (const id of [Feature.packsTypeGodotZip, Feature.packsTypeAudioBank])
      expect(a.supports(id)).toMatchObject({
        supported: false,
        reason: UnsupportedReason.runtime,
      });
    a.dispose();
  });
});
