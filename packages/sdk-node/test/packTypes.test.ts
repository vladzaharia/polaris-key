// P4-16: the v3 pack types through `client.update.packs` on disk, against a local fake byte
// server: `data.json` and `l10n.table` (built in), `ml.model` (the host's handler, load-tested
// from its real path), a game's `custom.dialogue`, the typed refusals, and `supports()` for the
// pairs this SDK declares N/A (`godot.zip`, `audio.bank`).
//
// @pkey-feature packs.handlers packs.type.l10n.table packs.type.data.json packs.type.ml.model packs.type.godot.zip packs.type.audio.bank

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DataJsonHandler,
  L10nTableHandler,
  MlModelHandler,
  PolarisKeyClient,
} from "../src/index.js";
import type { PackHandler } from "../src/packs/index.js";
import {
  PRODUCT,
  PRODUCT_TRUST,
  RELEASE_KEYS,
  stampFor,
  treePack,
  type TreePack,
} from "./packFixtures.js";
import { MemStore } from "./updateFixtures.js";

/** Discovery, records by hash and whole blobs by hash: all `ensure` needs. */
class FakeServer {
  server!: Server;
  base = "";
  packs: TreePack[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", this.base);
      if (url.pathname === `/${PRODUCT}/.well-known/polaris.json`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(this.discovery()));
        return;
      }
      const rec = /^\/djdl\/release\/records\/([0-9a-f]{64})$/.exec(
        url.pathname,
      );
      if (rec) {
        const p = this.packs.find((x) => x.recordSha256 === rec[1]);
        if (!p) return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": "application/jose" });
        res.end(p.jws);
        return;
      }
      const blob = /^\/djdl\/distribution\/blobs\/sha256\/([0-9a-f]{64})$/.exec(
        url.pathname,
      );
      const bytes = blob
        ? this.packs
            .map((p) => p.objects.get(blob[1]!))
            .find((b) => b !== undefined)
        : undefined;
      if (!bytes) return void res.writeHead(404).end();
      res.writeHead(200, {
        etag: `"${blob![1]}"`,
        "content-length": String(bytes.byteLength),
      });
      res.end(Buffer.from(bytes));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const a = this.server.address() as { port: number };
    this.base = `http://127.0.0.1:${a.port}`;
  }

  discovery(): unknown {
    const b = this.base;
    return {
      version: 2,
      protocolVersion: 4,
      product: PRODUCT,
      baseUrl: b,
      services: {
        license: { enabled: false },
        config: { enabled: false },
        release: {
          enabled: true,
          endpoints: { record: `${b}/${PRODUCT}/release/records/{sha256}` },
        },
        distribution: {
          enabled: true,
          endpoints: {
            blobs: `${b}/${PRODUCT}/distribution/blobs/sha256/{sha256}`,
          },
        },
        update: {
          enabled: true,
          endpoints: { feed: `${b}/${PRODUCT}/update/{channel}/feed.jws` },
        },
        identity: { enabled: false },
      },
    };
  }
}

let srv: FakeServer;
let work: string | null = null;
beforeAll(async () => {
  srv = new FakeServer();
  await srv.start();
});
afterAll(async () => {
  await new Promise((r) => srv.server.close(r));
});
afterEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
  work = null;
});

let stamps = 0;
async function client(stamp: TreePack[], handlers: PackHandler[] = []) {
  work ??= await mkdtemp(join(tmpdir(), "pkey-types-"));
  srv.packs = [...srv.packs, ...stamp];
  const stampPath = join(work, `stamp-${++stamps}.json`);
  await writeFile(
    stampPath,
    JSON.stringify({ format: "pkey-content/1", ...stampFor(...stamp) }),
  );
  const store = new MemStore("dev_types");
  store.token = "pkeyt_test";
  return PolarisKeyClient.create({
    productSlug: PRODUCT,
    baseUrl: srv.base,
    version: "1.0.0",
    trust: { pinnedKeys: PRODUCT_TRUST },
    store,
    dataDir: join(work, "data"),
    requestTimeoutMs: 0,
    expectedServices: ["release", "distribution", "update"] as never,
    update: {
      pinnedReleaseKeys: RELEASE_KEYS,
      outlet: "direct",
      packs: { contentStamp: stampPath, axes: { locale: ["fr"] }, handlers },
    },
  });
}

describe("v3 pack types in @polaris-key/node", () => {
  it("installs a data.json pack with the built-in handler, and a host's handler reads it", async () => {
    const v1 = await treePack({
      packId: "djdl.events",
      version: "1.0.0",
      seq: 1,
      files: { "winter.json": '{"snow":true}' },
      type: "data.json",
    });
    const h = new DataJsonHandler();
    const c = await client([v1], [h]);
    await c.update.packs.ensure(["djdl.events"]);
    expect(h.documents("djdl.events")?.get("winter.json")).toEqual({
      snow: true,
    });
  });

  it("installs an l10n.table pack and refuses one whose table is another locale", async () => {
    const po = (lang: string) =>
      `msgid ""\nmsgstr "Language: ${lang}\\n"\n\nmsgid "play"\nmsgstr "Jouer"\n`;
    const fr = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: { "fr.po": po("fr") },
      type: "l10n.table",
      variant: { locale: "fr" },
    });
    const h = new L10nTableHandler();
    const c = await client([fr], [h]);
    await c.update.packs.ensure(["djdl.l10n"]);
    expect(h.tables("djdl.l10n")?.[0]).toMatchObject({
      locale: "fr",
      messages: [{ id: "play", strings: ["Jouer"] }],
    });

    const wrong = await treePack({
      packId: "djdl.l10n2",
      version: "1.0.0",
      seq: 1,
      files: { "fr.po": po("de") },
      type: "l10n.table",
      variant: { locale: "fr" },
    });
    const c2 = await client([wrong]);
    await expect(c2.update.packs.ensure(["djdl.l10n2"])).rejects.toMatchObject({
      code: "pack-type-check-failed",
      detail: "locale",
      path: "fr.po",
    });
  });

  it("load-tests an ml.model from its real path before swapping, and refuses one over budget", async () => {
    const model = (memBytes: number) =>
      treePack({
        packId: "djdl.model",
        version: `1.${memBytes}.0`,
        seq: memBytes,
        files: {
          "model.json": JSON.stringify({
            runtime: "gguf",
            file: "weights/m.gguf",
            memBytes,
          }),
          "weights/m.gguf": "GGUF-bytes",
        },
        type: "ml.model",
      });
    const v1 = await model(10);
    const read: string[] = [];
    const h = new MlModelHandler({
      runtimes: ["gguf"],
      ramBytes: 100,
      loadTest: async ({ location, file }) => {
        read.push(await readFile(join(location, file.path), "utf8"));
        return true;
      },
    });
    const c = await client([v1], [h]);
    await c.update.packs.ensure(["djdl.model"]);
    expect(read).toEqual(["GGUF-bytes"]);
    expect(h.model("djdl.model")?.path).toBe("weights/m.gguf");

    const big = await model(101);
    const c2 = await client([big], [h]);
    await expect(c2.update.packs.ensure(["djdl.model"])).rejects.toMatchObject({
      code: "pack-type-check-failed",
      detail: "memory",
    });
  });

  it("installs a game's custom.dialogue pack end to end through registerHandler", async () => {
    const v1 = await treePack({
      packId: "djdl.dialogue",
      version: "1.0.0",
      seq: 1,
      files: { "intro.txt": "Hello, traveller." },
      type: "custom.dialogue",
    });
    const lines: string[] = [];
    const c = await client([v1]);
    c.update.packs.registerHandler({
      type: "custom.dialogue",
      layout: "tree",
      activation: "hot",
      supports: (fv) => fv === 1,
      activate: async (i) => {
        lines.push(await readFile(join(i.location, "intro.txt"), "utf8"));
      },
    });
    await c.update.packs.ensure(["djdl.dialogue"]);
    expect(lines).toEqual(["Hello, traveller."]);
  });

  it("answers supports() for each type: N/A godot.zip and audio.bank, the rest supported", async () => {
    const c = await client([]);
    for (const id of [
      "packs.type.l10n.table",
      "packs.type.data.json",
      "packs.type.ml.model",
    ])
      expect(c.supports(id).supported, id).toBe(true);
    for (const id of ["packs.type.godot.zip", "packs.type.audio.bank"])
      expect(c.supports(id)).toMatchObject({
        supported: false,
        reason: "runtime",
      });
  });
});
