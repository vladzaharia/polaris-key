// `client.update.packs` end to end against a local fake byte server (P4-06 acceptance): a
// `files.tree` pack installed from its pinned record into the platform data directory, updated
// by the file strategy, resumed after a dropped connection, served from an embedded baseline,
// and its `packSetId` reported through `devices/report` as `content`.
//
// @pkey-feature packs.state packs.handlers packs.record packs.revoke update.content packs.provides

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { packSetId, type PackHandler } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/index.js";
import {
  DirPackStorage,
  measureFile,
  selectNodeZstd,
} from "../src/packs/index.js";
import {
  PROBE_BASE,
  PROBE_FRAME,
  PROBE_TARGET,
  PRODUCT,
  PRODUCT_TRUST,
  RELEASE_KEYS,
  contentKeyPair,
  delegationFor,
  markerFor,
  revocationFor,
  signFeedDoc,
  signReleaseDoc,
  stampFor,
  treePack,
  type TreePack,
} from "./packFixtures.js";
import { MemStore } from "./updateFixtures.js";
import {
  chunkStamp,
  containerPack,
  sha,
  type ContainerPack,
} from "./chunkFixtures.js";

interface Seen {
  path: string;
  range: string | null;
  ifRange: string | null;
  auth: string | null;
  acceptEncoding: string | null;
}

/** A local Worker stand-in: discovery, records by hash, blobs by hash (Range, If-Range) and
 *  `devices/report`. `drop` cuts the next blob body after that many bytes. */
class FakeServer {
  server!: Server;
  base = "";
  packs: TreePack[] = [];
  seen: Seen[] = [];
  reports: unknown[] = [];
  drop: number | null = null;
  /** P4-11: answer bounded ranges with 200 and the whole object (a server that ignores Range). */
  ignoreRange = false;
  /** P4-11: cut the body of the Nth bounded range request (1-based) half way. */
  cutRange = 0;
  private boundedRanges = 0;
  /** Extra records by hash (app records, revocations) and the signed feed `update/stable`
   *  serves (P4-13). */
  records = new Map<string, string>();
  feed: string | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const a = this.server.address() as { port: number };
    this.base = `http://127.0.0.1:${a.port}`;
  }

  private async handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    this.seen.push({
      path: url.pathname,
      range: req.headers.range ?? null,
      ifRange: (req.headers["if-range"] as string | undefined) ?? null,
      auth: req.headers.authorization ?? null,
      acceptEncoding:
        (req.headers["accept-encoding"] as string | undefined) ?? null,
    });
    if (url.pathname === `/${PRODUCT}/.well-known/polaris.json`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(this.discovery()));
      return;
    }
    const rec = /^\/djdl\/release\/records\/([0-9a-f]{64})$/.exec(url.pathname);
    if (rec) {
      const p = this.packs.find((x) => x.recordSha256 === rec[1]);
      const body = p?.jws ?? this.records.get(rec[1]!);
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/jose" });
      res.end(body);
      return;
    }
    if (url.pathname === `/${PRODUCT}/update/stable/feed.jws` && this.feed) {
      res.writeHead(200, { "content-type": "application/jose" });
      res.end(this.feed);
      return;
    }
    const blob = /^\/djdl\/distribution\/blobs\/sha256\/([0-9a-f]{64})$/.exec(
      url.pathname,
    );
    if (blob) {
      const h = blob[1]!;
      const bytes = this.packs
        .map((p) => p.objects.get(h))
        .find((b) => b !== undefined);
      if (!bytes) return void res.writeHead(404).end();
      const etag = `"${h}"`;
      const range = req.headers.range;
      const ifRange = req.headers["if-range"];
      let start = 0;
      let end = bytes.byteLength - 1;
      let status = 200;
      const m = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
      const bounded = m !== null && m[2] !== "";
      let cut = false;
      if (bounded) {
        this.boundedRanges++;
        cut = this.boundedRanges === this.cutRange;
      }
      if (
        m &&
        (ifRange === undefined || ifRange === etag) &&
        !(bounded && this.ignoreRange)
      ) {
        start = Number(m[1]);
        if (bounded) end = Math.min(end, Number(m[2]));
        status = 206;
      }
      const body = Buffer.from(bytes.subarray(start, end + 1));
      res.writeHead(status, {
        etag,
        "accept-ranges": "bytes",
        "content-length": String(body.byteLength),
        ...(status === 206
          ? {
              "content-range": `bytes ${start}-${end}/${bytes.byteLength}`,
            }
          : {}),
      });
      if (cut) {
        res.write(body.subarray(0, body.byteLength >> 1), () => res.destroy());
        return;
      }
      if (this.drop !== null) {
        const n = this.drop;
        this.drop = null;
        res.write(body.subarray(0, n), () => res.destroy());
        return;
      }
      res.end(body);
      return;
    }
    if (
      url.pathname === `/${PRODUCT}/devices/report` &&
      req.method === "POST"
    ) {
      let text = "";
      for await (const c of req) text += String(c);
      this.reports.push(JSON.parse(text));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404).end();
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

  blobRequests(): Seen[] {
    return this.seen.filter((s) => s.path.includes("/distribution/blobs/"));
  }
}

const v1Files = {
  "fr/strings.json": '{"hello":"bonjour"}',
  "fr/menu.json": '{"play":"jouer"}',
  "big.bin": "x".repeat(60000),
};

let srv: FakeServer;
let work: string;
let stampDocs = 0;
beforeAll(async () => {
  srv = new FakeServer();
  await srv.start();
});
afterAll(async () => {
  await new Promise((r) => srv.server.close(r));
});
afterEach(async () => {
  srv.seen = [];
  srv.reports = [];
  srv.ignoreRange = false;
  srv.cutRange = 0;
  if (work) await rm(work, { recursive: true, force: true });
});

async function client(o: {
  stamp: TreePack[];
  /** The stamp body to write instead of `stampFor(...stamp)` (holds, say). */
  stampDoc?: Record<string, unknown>;
  embedded?: { path: string }[];
  token?: boolean;
  dataDir?: string;
  handlers?: PackHandler[];
  /** A store of the caller's (its cache survives into the next client). */
  store?: MemStore;
}) {
  work ??= await mkdtemp(join(tmpdir(), "pkey-packs-"));
  const stampPath = join(
    work,
    `stamp-${o.stamp.map((p) => p.version).join("-")}${o.stampDoc ? `-${++stampDocs}` : ""}.json`,
  );
  await writeFile(
    stampPath,
    JSON.stringify({
      format: "pkey-content/1",
      ...(o.stampDoc ?? stampFor(...o.stamp)),
    }),
  );
  const store = o.store ?? new MemStore("dev_packs");
  if (o.token !== false) store.token = "pkeyt_test";
  return PolarisKeyClient.create({
    productSlug: PRODUCT,
    baseUrl: srv.base,
    version: "1.0.0",
    trust: { pinnedKeys: PRODUCT_TRUST },
    store,
    dataDir: o.dataDir ?? join(work, "data"),
    requestTimeoutMs: 0,
    expectedServices: ["release", "distribution", "update"] as never,
    update: {
      pinnedReleaseKeys: RELEASE_KEYS,
      outlet: "direct",
      packs: {
        contentStamp: stampPath,
        ...(o.embedded ? { embedded: o.embedded } : {}),
        ...(o.handlers ? { handlers: o.handlers } : {}),
      },
    },
  });
}

async function treeOnDisk(
  dir: string,
  files: Record<string, Uint8Array>,
): Promise<boolean> {
  for (const [p, b] of Object.entries(files)) {
    const got = await readFile(join(dir, ...p.split("/")));
    if (Buffer.compare(got, Buffer.from(b)) !== 0) return false;
  }
  return true;
}

describe("client.update.packs (Node)", () => {
  it("installs a files.tree pack from the fake byte server and reports packSetId", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    srv.packs = [v1];
    const c = await client({ stamp: [v1] });
    const progress: string[] = [];
    c.update.packs.on((e) => progress.push(e.phase));
    const [install] = await c.update.packs.ensure(["djdl.l10n"]);
    expect(install!.recordSha256).toBe(v1.recordSha256);
    const dir = await c.update.packs.path("djdl.l10n");
    expect(dir).toBe(
      join(work, "data", PRODUCT, "packs", "store", "djdl.l10n", v1.treeDigest),
    );
    expect(await treeOnDisk(dir!, v1.files)).toBe(true);
    expect(progress).toContain("done");
    // The device bearer goes to the control plane's own origin.
    expect(
      srv.blobRequests().every((s) => s.auth === "Bearer pkeyt_test"),
    ).toBe(true);

    expect(await c.devices.report()).toBe(true);
    const want = await packSetId([
      { packId: "djdl.l10n", releaseSha256: v1.recordSha256 },
    ]);
    expect(srv.reports).toEqual([
      expect.objectContaining({ content: { packSetId: want } }),
    ]);
    expect((await c.update.packs.state()).active["djdl.l10n"]!.version).toBe(
      "1.0.0",
    );
    c.close();
  });

  it("updates by the file strategy after a relaunch, and resumes a dropped download with Range", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const v2 = await treePack({
      packId: "djdl.l10n",
      version: "1.1.0",
      seq: 2,
      files: {
        ...v1Files,
        "fr/strings.json": '{"hello":"salut"}',
        "big2.bin": "y".repeat(40000),
      },
    });
    srv.packs = [v1, v2];
    let c = await client({ stamp: [v1] });
    await c.update.packs.ensure(["djdl.l10n"]);
    c.close();

    // A relaunch on the v2 build: the big new file's download drops after 1,000 bytes.
    srv.seen = [];
    srv.drop = null;
    c = await client({ stamp: [v2] });
    let n = 0;
    // Drop the first blob after the index: count requests as they come.
    const handler = srv.server.listeners("request")[0] as (
      ...a: unknown[]
    ) => void;
    srv.server.removeAllListeners("request");
    srv.server.on(
      "request",
      (req: import("node:http").IncomingMessage, res: unknown) => {
        if ((req.url ?? "").includes("/distribution/blobs/") && ++n === 2)
          srv.drop = 1000;
        handler(req, res);
      },
    );
    await expect(c.update.packs.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "network-error",
    });
    srv.server.removeAllListeners("request");
    srv.server.on("request", handler);
    c.close();

    srv.seen = [];
    c = await client({ stamp: [v2] });
    const [install] = await c.update.packs.ensure(["djdl.l10n"]);
    expect(install!.version).toBe("1.1.0");
    expect(
      await treeOnDisk((await c.update.packs.path("djdl.l10n"))!, v2.files),
    ).toBe(true);
    const resumed = srv.blobRequests().find((s) => s.range !== null);
    expect(resumed).toMatchObject({ range: "bytes=1000-" });
    expect(resumed!.ifRange).toMatch(/^"[0-9a-f]{64}"$/);
    // Only the changed files' blobs were fetched, never the full object.
    expect(srv.blobRequests().some((s) => s.path.endsWith(v2.fullSha256))).toBe(
      false,
    );
    expect((await c.update.packs.state()).previous["djdl.l10n"]!.version).toBe(
      "1.0.0",
    );
    // P4-17: the report carries the pair it moved between, for lazy-delta demand.
    srv.reports.length = 0;
    expect(await c.devices.report()).toBe(true);
    expect(srv.reports).toEqual([
      expect.objectContaining({
        packInstalls: [
          expect.objectContaining({
            pack: "djdl.l10n",
            from: v1.treeDigest,
            to: v2.treeDigest,
            strategy: "file",
            fallbackUsed: false,
          }),
        ],
      }),
    ]);
    c.close();
  });

  it("uses an embedded baseline as installed state and fetches nothing", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    srv.packs = [v1];
    const emb = join(work, "app", "pkey_packs", "djdl.l10n");
    for (const [p, b] of Object.entries(v1.files)) {
      const abs = join(emb, ...p.split("/"));
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, b);
    }
    await mkdir(join(emb, ".pkey"), { recursive: true });
    await writeFile(join(emb, ".pkey", "pack.json"), markerFor(v1));
    const c = await client({ stamp: [v1], embedded: [{ path: emb }] });
    expect(await c.update.packs.refusedEmbedded()).toEqual([]);
    const [install] = await c.update.packs.ensure(["djdl.l10n"]);
    expect(install!.embedded).toBe(true);
    expect(await c.update.packs.path("djdl.l10n")).toBe(emb);
    expect(srv.blobRequests()).toEqual([]);
    c.close();
  });

  it("answers isAvailable from the active set and packFor from the stamp's pins (P4-20)", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const l10n = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
      recordExtra: { provides: ["l10n.fr"] },
    });
    const foes = await treePack({
      packId: "djdl.foes",
      version: "2.0.0",
      seq: 4,
      files: { "foes.json": "{}" },
      recordExtra: { provides: ["foe.goblin"] },
    });
    srv.packs = [l10n, foes];
    const c = await client({ stamp: [l10n, foes] });
    expect(await c.update.packs.isAvailable("l10n.fr")).toBe(false);
    await c.update.packs.ensure(["djdl.l10n"]);
    expect(await c.update.packs.isAvailable("l10n.fr")).toBe(true);
    expect(await c.update.packs.isAvailable("foe.goblin")).toBe(false);
    srv.seen = [];
    expect(await c.update.packs.packFor("foe.goblin")).toEqual({
      packId: "djdl.foes",
      release: { sha256: foes.recordSha256, seq: 4, version: "2.0.0" },
    });
    expect(srv.blobRequests()).toEqual([]);
    expect(await c.update.packs.packFor("foe.dragon")).toBeNull();
    c.close();
  });

  it("raises not-configured without a stamp and content-stamp-invalid for a bad one", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const c = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: srv.base,
      version: "1.0.0",
      trust: { pinnedKeys: PRODUCT_TRUST },
      store: new MemStore("dev_x"),
      dataDir: join(work, "data"),
      expectedServices: ["release", "distribution", "update"] as never,
      update: { pinnedReleaseKeys: RELEASE_KEYS, outlet: "direct" },
    });
    await expect(c.update.packs.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "not-configured",
    });
    expect(await c.update.packs.packSetId()).toBeNull();
    c.close();
    const bad = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: srv.base,
      version: "1.0.0",
      trust: { pinnedKeys: PRODUCT_TRUST },
      store: new MemStore("dev_x"),
      dataDir: join(work, "data"),
      expectedServices: ["release", "distribution", "update"] as never,
      update: {
        pinnedReleaseKeys: RELEASE_KEYS,
        outlet: "direct",
        packs: {
          contentStamp: new TextEncoder().encode('{"format":"pkey-content/2"}'),
        },
      },
    });
    await expect(bad.update.packs.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "content-stamp-invalid",
    });
    bad.close();
  });
});

describe("the Node zstd backend (plans/P4-01.md §5; PARITY §6.3)", () => {
  it("probes node:zlib and falls back to the WASM decoder for deltas when the probe fails", async () => {
    const auto = await selectNodeZstd();
    const [major, minor] = process.versions.node.split(".").map(Number) as [
      number,
      number,
    ];
    const hasZlibZstd = major > 22 || (major === 22 && minor >= 15);
    expect(auto.info.plain).toBe(hasZlibZstd ? "node:zlib" : "wasm");
    expect(auto.info.patchMethods).toEqual(["zstd-patch-from"]);
    const failed = await selectNodeZstd({ mode: "fail-probe" });
    expect(failed.info.prefix).toBe("wasm");
    expect(failed.zstd.pointerBits).toBe(30);
    expect(failed.info.patchMethods).toEqual(["zstd-patch-from"]);
    const wasm = await selectNodeZstd({ mode: "wasm" });
    expect(wasm.info).toEqual({
      plain: "wasm",
      prefix: "wasm",
      dictionaryIgnored: false,
      patchMethods: ["zstd-patch-from"],
    });
  });
});

describe("DirPackStorage", () => {
  it("never reads a stored seed index over MAX_CHUNK_INDEX_BYTES (P4-11)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pkey-idx-"));
    try {
      const s = new DirPackStorage({ root: dir });
      const sha = "cd".repeat(32);
      await s.chunkIndexes.put(sha, new Uint8Array(16));
      expect(await s.chunkIndexes.get(sha)).toHaveLength(16);
      await writeFile(
        join(dir, "index", sha),
        new Uint8Array(16 * 1024 * 1024 + 1),
      );
      expect(await s.chunkIndexes.get(sha)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads an embedded single-file baseline from the file itself", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pkey-store-"));
    try {
      const file = join(dir, "levels.pck");
      await writeFile(file, "payload bytes");
      const storage = new DirPackStorage({ root: join(dir, "packs") });
      const { sha256, size } = await measureFile(file);
      const install = {
        packId: "djdl.levels",
        record: "x",
        recordSha256: sha256,
        version: "1.0.0",
        seq: 1,
        type: "custom.blob",
        variant: "",
        layout: "container",
        payloadSha256: sha256,
        payloadSize: size,
        activation: "restart" as const,
        location: file,
        embedded: true,
        installedAt: 1,
      };
      const got = await storage.installed(install);
      expect(got?.payload?.size).toBe(size);
      expect(await storage.verify(install)).toBe(true);
      expect(await storage.verify({ ...install, payloadSize: size + 1 })).toBe(
        false,
      );
      // Removing an embedded payload (outside the store) is refused.
      await storage.remove(file);
      expect((await measureFile(file)).size).toBe(size);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps a record body at the record bound: an oversized one is refused at hash", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const huge = { ...v1, jws: v1.jws + "A".repeat(200_000) };
    srv.packs = [huge];
    const c = await client({ stamp: [v1] });
    await expect(c.update.packs.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "record-rejected",
      detail: "hash",
    });
    c.close();
  });
});

describe("state.json that cannot be trusted (Node)", () => {
  it("holds a torn state.json aside across loads and keeps the store", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    srv.packs = [v1];
    let c = await client({ stamp: [v1] });
    await c.update.packs.ensure(["djdl.l10n"]);
    const root = join(work, "data", PRODUCT, "packs");
    const dir = (await c.update.packs.path("djdl.l10n"))!;
    c.close();
    await writeFile(join(root, "state.json"), '{"v":1,"active":{"djdl');
    for (let n = 0; n < 2; n++) {
      c = await client({ stamp: [v1] });
      expect((await c.update.packs.state()).stateIssue).toBe("torn");
      expect(await treeOnDisk(dir, v1.files)).toBe(true);
      c.close();
    }
    expect(
      (await readFile(join(root, "state.json.torn"), "utf8")).startsWith(
        '{"v":1',
      ),
    ).toBe(true);
  });

  it("refuses to write or install over a state.json it cannot read", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    srv.packs = [v1];
    let c = await client({ stamp: [v1] });
    await c.update.packs.ensure(["djdl.l10n"]);
    const root = join(work, "data", PRODUCT, "packs");
    const good = await readFile(join(root, "state.json"), "utf8");
    c.close();
    // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
    await rm(join(root, "state.json"));
    await mkdir(join(root, "state.json"));
    c = await client({ stamp: [v1] });
    await expect(c.update.packs.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "pack-state-unreadable",
    });
    c.close();
    await rm(join(root, "state.json"), { recursive: true });
    await writeFile(join(root, "state.json"), good);
    c = await client({ stamp: [v1] });
    expect((await c.update.packs.state()).active["djdl.l10n"]!.version).toBe(
      "1.0.0",
    );
    c.close();
  });
});

describe("a payload the process cannot read (Node, EACCES)", () => {
  it.skipIf(process.getuid?.() === 0)(
    "throws from verify and keeps the install across two loads",
    async () => {
      work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
      const v1 = await treePack({
        packId: "djdl.l10n",
        version: "1.0.0",
        seq: 1,
        files: v1Files,
      });
      srv.packs = [v1];
      let c = await client({ stamp: [v1] });
      await c.update.packs.ensure(["djdl.l10n"]);
      const dir = (await c.update.packs.path("djdl.l10n"))!;
      c.close();
      await chmod(dir, 0o000);
      try {
        for (let n = 0; n < 2; n++) {
          c = await client({ stamp: [v1] });
          const s = await c.update.packs.state();
          expect(s.active["djdl.l10n"]).toBeUndefined();
          expect(s.running["djdl.l10n"]).toBeUndefined();
          c.close();
        }
      } finally {
        await chmod(dir, 0o755);
      }
      c = await client({ stamp: [v1] });
      expect((await c.update.packs.state()).active["djdl.l10n"]!.location).toBe(
        dir,
      );
      expect(await treeOnDisk(dir, v1.files)).toBe(true);
      c.close();
    },
  );
});

describe("DirPackStorage.list never answers a partial listing (round 3)", () => {
  it.skipIf(process.getuid?.() === 0)(
    "a torn load with an unreadable pack directory keeps every pre-hold location",
    async () => {
      work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
      const a = await treePack({
        packId: "djdl.l10n",
        version: "1.0.0",
        seq: 1,
        files: v1Files,
      });
      const b = await treePack({
        packId: "djdl.extra",
        version: "1.0.0",
        seq: 1,
        files: { "x.txt": "x" },
      });
      srv.packs = [a, b];
      let c = await client({ stamp: [a, b] });
      await c.update.packs.ensure(["djdl.l10n", "djdl.extra"]);
      const dirA = (await c.update.packs.path("djdl.l10n"))!;
      c.close();
      const root = join(work, "data", PRODUCT, "packs");
      await writeFile(join(root, "state.json"), '{"v":1,"act');
      const packDir = join(root, "store", "djdl.l10n");
      await chmod(packDir, 0o000);
      try {
        await expect(new DirPackStorage({ root }).list()).rejects.toMatchObject(
          { code: "EACCES" },
        );
        c = await client({ stamp: [b] });
        expect((await c.update.packs.state()).stateIssue).toBe("torn");
        await c.update.packs.ensure(["djdl.extra"]);
        c.close();
      } finally {
        await chmod(packDir, 0o755);
      }
      expect(await treeOnDisk(dirA, a.files)).toBe(true);
    },
  );
});

describe("client.update.decide() with packs (plans/P4-13.md §2.5, §2.6)", () => {
  it("learns a revocation of the running pack, blocks required content and refuses the release", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    srv.packs = [v1];
    const appJws = await signReleaseDoc({
      schemaVersion: 1,
      aud: PRODUCT,
      deliverable: "app",
      kind: "app",
      version: "1.0.0",
      seq: 10,
      issuedAt: 1_759_000_000,
      builds: [
        {
          id: "macos-dmg",
          platform: "macos",
          arch: "universal",
          format: "dmg",
          artifacts: [
            { name: "a.dmg", role: "payload", sha256: "a".repeat(64), size: 1 },
          ],
        },
      ],
    });
    const rev = await revocationFor(v1);
    srv.records = new Map([
      [createHash("sha256").update(appJws).digest("hex"), appJws],
      [rev.record, rev.jws],
    ]);
    const now = Math.floor(Date.now() / 1000);
    const platform = { darwin: "macos", win32: "windows", linux: "linux" }[
      process.platform as "darwin" | "win32" | "linux"
    ];
    srv.feed = await signFeedDoc({
      schemaVersion: 1,
      iss: "key.plrs.im",
      aud: PRODUCT,
      channel: "stable",
      selector: {},
      seq: 1,
      issuedAt: now - 10,
      expiresAt: now + 800,
      app: {
        deliverable: "app",
        versionScheme: "semver",
        targets: [
          {
            platform,
            release: {
              sha256: createHash("sha256").update(appJws).digest("hex"),
              seq: 10,
              version: "1.0.0",
            },
            floor: null,
            critical: false,
            outlets: {
              direct: {
                kind: "direct",
                live: { version: "1.0.0", seq: 10 },
                halted: false,
              },
            },
          },
        ],
      },
      revocations: [rev.entry],
    });
    const c = await client({ stamp: [v1] });
    await c.update.packs.ensure(["djdl.l10n"]);
    const check = await c.update.decide();
    expect(check.decision).toMatchObject({
      action: "blocked",
      reason: "revoked-content",
    });
    // Persisted beside the pack state, the flag first; the release no longer runs.
    const root = join(work, "data", PRODUCT, "packs");
    const revs = JSON.parse(
      await readFile(join(root, "revocations.json"), "utf8"),
    );
    expect(Object.keys(revs.revoked)).toEqual([v1.recordSha256]);
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(state.revocationsStored).toBe(true);
    expect((await c.update.packs.state()).running["djdl.l10n"]).toBeUndefined();
    await expect(c.update.packs.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "pack-revoked",
    });
    srv.feed = null;
    srv.records = new Map();
  });
});

describe("client.update.packs and delegated releases (plans/P4-19.md §2.4)", () => {
  it("refuses a held release signed under a delegation through the packs client; unheld, it installs", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const now = Math.floor(Date.now() / 1000);
    const ck = contentKeyPair();
    const d = await delegationFor({
      deliverable: "djdl.events",
      publicKey: ck.pub,
      issuedAt: now - 86400,
      expiresAt: now + 30 * 86400,
    });
    const held = await treePack({
      packId: "djdl.events.halloween",
      version: "1.0.0",
      seq: 1,
      files: { "a.json": "{}" },
      issuedAt: now - 3600,
      signer: { pem: ck.pem, kid: d.kid },
    });
    srv.packs = [held];
    srv.records = new Map([[d.sha256, d.jws]]);
    const release = {
      sha256: held.recordSha256,
      seq: held.seq,
      version: held.version,
    };
    const expects = [
      { pack: held.packId, required: true, delivery: "essential" },
    ];
    const target = { pack: held.packId, release };
    try {
      // The stamp holds the release: the engine never takes the delegated path for it.
      const c = await client({
        stamp: [],
        dataDir: join(work, "held"),
        stampDoc: {
          contentApi: 1,
          pins: [],
          expects,
          holds: [{ pack: held.packId, release, reason: "held in a test" }],
        },
      });
      await expect(
        c.update.packs.ensureReleases([target]),
      ).rejects.toMatchObject({ code: "record-rejected", detail: "jws" });
      c.close();

      // Without the hold the same target installs through its delegation.
      const free = await client({
        stamp: [],
        dataDir: join(work, "free"),
        stampDoc: { contentApi: 1, pins: [], expects },
      });
      const [install] = await free.update.packs.ensureReleases([target]);
      expect(install!.delegation).toBe(d.jws);
      free.close();
    } finally {
      srv.records = new Map();
    }
  });
});

// @pkey-feature packs.apply.chunk packs.index.chunks
describe("client.update.packs and chunk sync (P4-11)", () => {
  const BLOB: PackHandler = {
    type: "custom.blob",
    layout: "container",
    activation: "restart",
    supports: (v) => v === 1,
  };
  async function chain() {
    const v1 = await containerPack({
      packId: "djdl.levels",
      version: "1.0.0",
      seq: 1,
      chunks: ["a", "b", "c", "d", "e", "f"],
      bundles: [["a", "b", "c", "d", "e", "f"]],
    });
    const v2 = await containerPack({
      packId: "djdl.levels",
      version: "1.1.0",
      seq: 2,
      chunks: ["a", "g", "c", "h", "i", "f", "j"],
      bundles: [
        ["a", "b", "c", "d", "e", "f"],
        ["g", null, "h", "i", null, "j"],
      ],
    });
    srv.packs = [v1, v2] as unknown as TreePack[];
    return { v1, v2 };
  }
  const target = (p: ContainerPack) => ({
    pack: p.packId,
    release: { sha256: p.recordSha256, seq: p.seq, version: p.version },
  });
  const ranged = () =>
    srv.blobRequests().filter((s) => s.range !== null && /-\d+$/.test(s.range));

  it("keeps v1's index on disk, installs v2 in single-range runs, and resumes a cut run from journal.json", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const { v1, v2 } = await chain();
    const c = await client({
      stamp: [],
      stampDoc: chunkStamp(v1),
      handlers: [BLOB],
    });
    await c.update.packs.ensure([v1.packId]);
    const root = join(work, "data", PRODUCT, "packs");
    expect(
      Buffer.compare(
        await readFile(join(root, "index", v1.indexSha256)),
        Buffer.from(v1.index),
      ),
    ).toBe(0);
    expect(ranged()).toHaveLength(0);

    // The second run's body is cut half way: the install stops, keeping its journals.
    srv.seen = [];
    srv.cutRange = 2;
    await expect(
      c.update.packs.ensureReleases([target(v2)]),
    ).rejects.toMatchObject({ code: "network-error", detail: "chunk" });
    const first = ranged();
    expect(first.map((s) => s.range)).toEqual([
      "bytes=0-65535",
      "bytes=131072-262143",
    ]);
    for (const s of first) {
      // The Fetch standard's own `Accept-Encoding: identity` for a `Range` request.
      expect(s.acceptEncoding).toBe("identity");
      expect(s.ifRange).toMatch(/^"[0-9a-f]{64}"$/);
    }
    const planId = (await c.update.packs.state()).inflight[v2.packId]!.planId;
    expect(
      JSON.parse(
        await readFile(join(root, "staging", planId, "journal.json"), "utf8"),
      ),
    ).toMatchObject({ v: 1, index: v2.indexSha256, runs: 3, bitmap: "01" });
    c.close();

    // A relaunch resumes: run 0 is re-hashed from staging/<plan>/out and reused.
    srv.seen = [];
    srv.cutRange = 0;
    const again = await client({
      stamp: [],
      stampDoc: chunkStamp(v1),
      handlers: [BLOB],
    });
    const [install] = await again.update.packs.ensureReleases([target(v2)]);
    expect(install!.payloadSha256).toBe(sha(v2.payload));
    expect(ranged().map((s) => s.range)).toEqual([
      "bytes=131072-262143",
      "bytes=327680-393215",
    ]);
    const m = await measureFile(
      join(root, "store", v2.packId, sha(v2.payload), "payload.bin"),
    );
    expect(m.sha256).toBe(sha(v2.payload));
    // The full payload was never fetched.
    expect(
      srv.blobRequests().some((s) => s.path.endsWith(sha(v2.payload))),
    ).toBe(false);
    again.close();
  });

  it("falls back to the full payload when the server ignores Range", async () => {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const { v1, v2 } = await chain();
    const c = await client({
      stamp: [],
      stampDoc: chunkStamp(v1),
      handlers: [BLOB],
    });
    await c.update.packs.ensure([v1.packId]);
    srv.seen = [];
    srv.ignoreRange = true;
    const [install] = await c.update.packs.ensureReleases([target(v2)]);
    expect(install!.payloadSha256).toBe(sha(v2.payload));
    expect(ranged()).toHaveLength(1);
    expect(
      srv.blobRequests().some((s) => s.path.endsWith(sha(v2.payload))),
    ).toBe(true);
    c.close();
  });
});

// @pkey-feature packs.delta.feed
describe("client.update.packs and the feed's delta menu (plans/P4-29.md §2.4)", () => {
  const PACK = "djdl.levels";
  const BLOB: PackHandler = {
    type: "custom.blob",
    layout: "container",
    activation: "hot",
    supports: (v) => v === 1,
  };
  /** A one-file container release over `payload`, with no record delta. */
  async function container(version: string, seq: number, payload: Uint8Array) {
    const index = new TextEncoder().encode(
      JSON.stringify({
        format: "pkey-files/1",
        layout: "container",
        payload: { size: payload.byteLength, sha256: sha(payload) },
        files: [
          {
            path: "data.bin",
            offset: 0,
            size: payload.byteLength,
            sha256: sha(payload),
            blob: {
              sha256: sha(payload),
              bytes: payload.byteLength,
              codec: "none",
            },
          },
        ],
      }),
    );
    const gaps = new Uint8Array();
    const jws = await signReleaseDoc({
      schemaVersion: 1,
      aud: PRODUCT,
      deliverable: PACK,
      kind: "pack",
      version,
      seq,
      issuedAt: 1759300000 + seq,
      type: "custom.blob",
      formatVersion: 1,
      handler: { activation: "hot" },
      variants: [
        {
          variant: {},
          payload: { size: payload.byteLength, sha256: sha(payload) },
          full: {
            sha256: sha(payload),
            bytes: payload.byteLength,
            size: payload.byteLength,
            codec: "none",
          },
          files: {
            format: "pkey-files/1",
            layout: "container",
            sha256: sha(index),
            bytes: index.byteLength,
            size: index.byteLength,
            codec: "none",
            gaps: { sha256: sha(gaps), bytes: 0, size: 0, codec: "none" },
          },
        },
      ],
    });
    return {
      packId: PACK,
      version,
      seq,
      jws,
      recordSha256: sha(jws),
      objects: new Map<string, Uint8Array>([
        [sha(payload), payload],
        [sha(index), index],
        [sha(gaps), gaps],
      ]),
    };
  }
  async function feedWithMenu(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const platform = { darwin: "macos", win32: "windows", linux: "linux" }[
      process.platform as "darwin" | "win32" | "linux"
    ];
    return signFeedDoc({
      schemaVersion: 1,
      iss: "key.plrs.im",
      aud: PRODUCT,
      channel: "stable",
      selector: {},
      seq: 1,
      issuedAt: now - 10,
      expiresAt: now + 800,
      app: {
        deliverable: "app",
        versionScheme: "semver",
        targets: [
          {
            platform,
            release: { sha256: "a".repeat(64), seq: 10, version: "1.0.0" },
            floor: null,
            critical: false,
            outlets: {
              direct: {
                kind: "direct",
                live: { version: "1.0.0", seq: 10 },
                halted: false,
              },
            },
          },
        ],
      },
      deltas: {
        [sha(PROBE_TARGET)]: [
          {
            from: sha(PROBE_BASE),
            method: "zstd-patch-from",
            scope: "payload",
            memBytes: PROBE_BASE.byteLength + PROBE_TARGET.byteLength,
            artifact: {
              sha256: sha(PROBE_FRAME),
              bytes: PROBE_FRAME.byteLength,
            },
          },
        ],
      },
    });
  }
  async function setup() {
    work = await mkdtemp(join(tmpdir(), "pkey-packs-"));
    const v1 = await container("1.0.0", 1, PROBE_BASE);
    const v2 = await container("1.1.0", 2, PROBE_TARGET);
    v2.objects.set(sha(PROBE_FRAME), PROBE_FRAME);
    srv.packs = [v1, v2] as unknown as TreePack[];
    srv.feed = await feedWithMenu();
    const stampDoc = {
      contentApi: 1,
      pins: [
        {
          pack: PACK,
          release: { sha256: v1.recordSha256, seq: 1, version: "1.0.0" },
        },
      ],
      expects: [{ pack: PACK, required: true, delivery: "essential" }],
    };
    const v2Target = {
      pack: PACK,
      release: { sha256: v2.recordSha256, seq: 2, version: "1.1.0" },
    };
    return { stampDoc, v2Target };
  }
  const blobPaths = () =>
    srv.blobRequests().map((s) => s.path.split("/").pop());

  it("plans the committed feed's lazy delta after update.feed() and installs it", async () => {
    const { stampDoc, v2Target } = await setup();
    const c = await client({ stamp: [], stampDoc, handlers: [BLOB] });
    await c.update.packs.ensure([PACK]);
    await c.update.feed();
    srv.seen = [];
    const [install] = await c.update.packs.ensureReleases([v2Target]);
    expect(install!.payloadSha256).toBe(sha(PROBE_TARGET));
    expect(blobPaths()).toEqual([sha(PROBE_FRAME)]);
    c.close();
    srv.feed = null;
  });

  it("reads the committed feed's menu from the cache when the engine starts, before any check (offline)", async () => {
    const { stampDoc, v2Target } = await setup();
    const store = new MemStore("dev_packs");
    const first = await client({
      stamp: [],
      stampDoc,
      handlers: [BLOB],
      store,
    });
    await first.update.packs.ensure([PACK]);
    await first.update.feed();
    first.close();
    // The Worker is gone; the next process has only the committed feed.
    srv.feed = null;
    srv.seen = [];
    const again = await client({
      stamp: [],
      stampDoc,
      handlers: [BLOB],
      store,
    });
    const [install] = await again.update.packs.ensureReleases([v2Target]);
    expect(install!.payloadSha256).toBe(sha(PROBE_TARGET));
    expect(blobPaths()).toEqual([sha(PROBE_FRAME)]);
    again.close();
  });
});
