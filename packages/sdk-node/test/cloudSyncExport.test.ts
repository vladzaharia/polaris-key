// @pkey-feature sync.export
// `client.cloudSync.export(destination)` on the Node client (U-51.3; WIRE-CONTRACT-V5 §13.12): a
// zip of the synced data written to a path, against a small fake of the Worker's sync and file
// routes (server mode), plus the destination rules: `<destination>.partial` created exclusively with
// 0600, renamed over the destination, removed on an error or a cancel, the old destination kept,
// a stale partial removed, a link or a non-regular file refused, and a full disk. No wall-clock
// waits: the sleep is injected.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import {
  PolarisError,
  SyncExportError,
  type CloudSyncExport,
} from "../src/index.js";
import {
  createExportFile,
  prepareDestination,
} from "../src/cloudSync/exportFile.js";
import {
  CATALOG,
  PRODUCT,
  SUBJECT,
  World,
  open,
  serverWorld,
  startSignedIn,
  type Body,
} from "./cloudSyncFixtures.js";

const sha = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

/** The entries of a STORED zip: the central directory's records, read with Buffer. */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = new Map<string, Uint8Array>();
  let at = buf.readUInt32LE(end + 16);
  for (let left = buf.readUInt16LE(end + 10); left > 0; left--) {
    const [size, nameLen, extra, comment, local] = [
      buf.readUInt32LE(at + 20),
      buf.readUInt16LE(at + 28),
      buf.readUInt16LE(at + 30),
      buf.readUInt16LE(at + 32),
      buf.readUInt32LE(at + 42),
    ];
    const start =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    entries.set(
      buf.toString("utf8", at + 46, at + 46 + nameLen),
      buf.subarray(start, start + size),
    );
    at += 46 + nameLen + extra + comment;
  }
  return entries;
}

const same = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && Buffer.compare(a, b) === 0;

const text = (b: Uint8Array | undefined): string =>
  Buffer.from(b ?? []).toString("utf8");

const bytes = (n: number, seed = 7): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

interface Stored {
  bytes: Uint8Array;
  version: number;
}

/** The Worker's `docs` collection in server mode: one record with a file, a setting. */
function exportWorld(opts: { file?: Stored; pointerSize?: number } = {}) {
  const w = serverWorld();
  const file = opts.file ?? { bytes: bytes(2500), version: 3 };
  const pointer = {
    version: file.version,
    size: opts.pointerSize ?? file.bytes.length,
    sha256: sha(file.bytes),
    format: "whole" as const,
  };
  w.pull = () =>
    w.body({
      cursor: 9,
      changes: [
        { setting: "theme", scope: "user", version: 4, value: "dark" },
        {
          record: ["docs", "report"],
          version: 7,
          value: { title: "Q3" },
          file: pointer,
        },
      ],
    });
  const log: string[] = [];
  const hooks = {
    /** Called before a file range is answered. */
    onFile: (): Response | void => undefined,
    revisions: [] as unknown[],
  };
  const inner = w.fetch;
  w.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const prefix = `/${PRODUCT}/sync/files/docs/`;
    if (!url.pathname.startsWith(prefix)) return inner(input, init);
    const [id, ...rest] = url.pathname.slice(prefix.length).split("/");
    const json = (b: unknown, status = 200): Response =>
      new Response(JSON.stringify(b), { status });
    if (rest[0] === "revisions") {
      log.push("revisions");
      return json({ revisions: hooks.revisions });
    }
    if (id !== "report" || rest.length > 0)
      return json({ error: { code: "not_found" } }, 404);
    log.push(`file ${url.search}`);
    const early = hooks.onFile();
    if (early) return early;
    const range = /bytes=(\d+)-(\d+)/.exec(
      new Headers(init.headers).get("range") ?? "",
    );
    const all = file.bytes;
    if (!range) return new Response(all, { status: 200 });
    const a = Number(range[1]);
    const b = Math.min(Number(range[2]), all.length - 1);
    return new Response(all.slice(a, b + 1), {
      status: 206,
      headers: { "content-range": `bytes ${a}-${b}/${all.length}` },
    });
  }) as typeof fetch;
  return { w, file, log, hooks };
}

const CATALOG_DOCS = {
  ...CATALOG(1),
  cloudSync: { collections: [{ name: "docs", conflict: "revision" }] },
};

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pkey-cexport-"));
  dirs.push(d);
  return d;
};

/** The sleeps the export asked for, never taken. */
const sleeps: number[] = [];
const sleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};

async function signedIn(
  w: World,
  over: Record<string, unknown> = {},
  encryption: "server" | "e2e" = "server",
) {
  const stateDir = tmp();
  const client = await open(
    w,
    stateDir,
    {
      encryption,
      catalog: CATALOG_DOCS,
      exportClock: { now: () => 1_700_000_123_456, sleep },
      ...over,
    },
    encryption === "e2e",
  );
  if (encryption === "e2e") await client.keyring.create();
  await startSignedIn(client);
  return { client, stateDir };
}

afterEach(() => {
  sleeps.length = 0;
  vi.restoreAllMocks();
});

const files = (dir: string): string[] => readdirSync(dir).sort();

describe("cloudSync.export: the archive", () => {
  it("writes the synced data to the destination as a zip, 0600, and leaves no partial", async () => {
    const { w, file } = exportWorld();
    const { client } = await signedIn(w);
    const dir = tmp();
    const dest = join(dir, "copy.zip");
    const r: CloudSyncExport = await client.cloudSync.export(dest);
    expect(r).toMatchObject({
      path: dest,
      settings: 1,
      records: 1,
      files: 1,
      skipped: [],
      unsynced: 0,
    });
    expect(files(dir)).toEqual(["copy.zip"]);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(statSync(dest).size).toBe(r.bytes);
    const zip = readZip(readFileSync(dest));
    expect([...zip.keys()]).toEqual([
      "README.txt",
      "stores/sync.cloudSync/settings.json",
      "stores/sync.cloudSync/records/0.ndjson",
      "stores/sync.cloudSync/files/0.bin",
      "stores/sync.cloudSync/files.json",
      "stores/sync.cloudSync/index.json",
      "data.json",
    ]);
    expect(same(zip.get("stores/sync.cloudSync/files/0.bin"), file.bytes)).toBe(
      true,
    );
    expect(text(zip.get("stores/sync.cloudSync/settings.json"))).toBe(
      '{"theme":"dark"}\n',
    );
    const data = JSON.parse(text(zip.get("data.json")));
    expect(data).toMatchObject({
      schema: "pkey-sync-export/1",
      source: "device",
      product: PRODUCT,
      exportedAt: 1_700_000_123_456,
      encryption: "server",
      counts: { settings: 1, records: 1, files: 1 },
    });
    // Neither the subject nor a token is written.
    for (const [, b] of zip) {
      expect(text(b)).not.toContain(SUBJECT);
      expect(text(b)).not.toContain("pkeyt_");
    }
  });

  it("replaces an existing destination whole, and never changes its mode on the way", async () => {
    const { w } = exportWorld();
    const { client } = await signedIn(w);
    const dir = tmp();
    const dest = join(dir, "copy.zip");
    writeFileSync(dest, "old");
    await client.cloudSync.export(dest);
    expect(readFileSync(dest).subarray(0, 2)).toEqual(Buffer.from("PK"));
    expect(files(dir)).toEqual(["copy.zip"]);
  });

  it("waits out a 429 on the file with the injected sleep, and the wait is bounded", async () => {
    const { w, hooks, file } = exportWorld();
    const { client } = await signedIn(w);
    let n = 0;
    hooks.onFile = () =>
      n++ < 2
        ? new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
            status: 429,
            headers: { "retry-after": "2" },
          })
        : undefined;
    const dir = tmp();
    const r = await client.cloudSync.export(join(dir, "a.zip"));
    expect(r.files).toBe(1);
    expect(sleeps).toEqual([2000, 2000]);
    const got = readZip(readFileSync(join(dir, "a.zip"))).get(
      "stores/sync.cloudSync/files/0.bin",
    );
    expect(same(got, file.bytes)).toBe(true);
  });

  it("fails with reason network once the waits are spent, leaving nothing", async () => {
    const { w, hooks } = exportWorld();
    const { client } = await signedIn(w);
    hooks.onFile = () =>
      new Response("{}", {
        status: 429,
        headers: { "retry-after": "900" },
      });
    const dir = tmp();
    const err = await client.cloudSync
      .export(join(dir, "a.zip"))
      .catch((e) => e);
    expect(err).toBeInstanceOf(SyncExportError);
    expect(err).toMatchObject({
      code: "sync-export-failed",
      reason: "network",
    });
    // 5,400,000 ms of waits in all, never taken.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5_400_000);
    expect(files(dir)).toEqual([]);
  });

  it("refuses an export over a bound before writing anything", async () => {
    const { w } = exportWorld({
      file: { bytes: bytes(10), version: 3 },
      pointerSize: 5_000_000_000,
    });
    const { client } = await signedIn(w);
    const dir = tmp();
    const err = await client.cloudSync
      .export(join(dir, "a.zip"))
      .catch((e) => e);
    expect(err).toBeInstanceOf(PolarisError);
    expect(err.code).toBe("sync-export-too-large");
    expect(files(dir)).toEqual([]);
  });

  it("allows one export at a time per client", async () => {
    const { w, hooks } = exportWorld();
    const { client } = await signedIn(w);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    hooks.onFile = () => void held;
    const dir = tmp();
    const first = client.cloudSync.export(join(dir, "a.zip"));
    const second = await client.cloudSync
      .export(join(dir, "b.zip"))
      .catch((e) => e);
    expect(second).toMatchObject({
      code: "sync-export-failed",
      reason: "busy",
    });
    release();
    await first;
    expect(files(dir)).toEqual(["a.zip"]);
  });

  it("refuses a person who is not signed in", async () => {
    const { w } = exportWorld();
    const client = await open(w, tmp(), {
      encryption: "server",
      catalog: CATALOG_DOCS,
    });
    const err = await client.cloudSync
      .export(join(tmp(), "a.zip"))
      .catch((e) => e);
    expect(err).toMatchObject({ code: "account_required" });
  });

  it("a product without Sync answers the typed N/A", async () => {
    const w = new World();
    const { PolarisKeyClient } = await import("../src/client.js");
    const { memStore } = await import("./cloudSyncFixtures.js");
    const client = new PolarisKeyClient({
      productSlug: PRODUCT,
      baseUrl: "https://k.test",
      version: "1.0.0",
      trust: { pinnedKeys: {} },
      store: memStore(),
      fetchImpl: w.fetch,
      stateDir: tmp(),
      expectedServices: ["license"],
    });
    await expect(
      client.cloudSync.export(join(tmp(), "a.zip")),
    ).rejects.toMatchObject({
      unsupported: { supported: false, reason: "product" },
    });
  });
});

describe("cloudSync.export: end-to-end rows and the ring", () => {
  const change = (over: Body): Body => ({
    setting: "theme",
    scope: "user",
    version: 5,
    editedHlc: "0199c82cc000:0000",
    updatedBy: "c_AAAAAAAAAAAAAAAAAAAAAA",
    ...over,
  });

  /** A signed-in end-to-end client whose Worker serves one sealed `theme` setting. */
  async function sealedTheme() {
    const w = new World();
    const { client } = await signedIn(w, {}, "e2e");
    const sealed = base64UrlEncodeBytes(
      await client.keyring.codec.seal("$settings", "theme", "dark"),
    );
    return { w, client, sealed };
  }

  it("opens sealed settings and lists one that does not open", async () => {
    const { w, client, sealed } = await sealedTheme();
    w.pull = () =>
      w.body({
        cursor: 6,
        changes: [
          change({ ct: sealed }),
          change({ setting: "AAAAAAAAAAAAAAAAAAAAAA", ct: "AAAA", version: 6 }),
        ],
      });
    const dir = tmp();
    const r = await client.cloudSync.export(join(dir, "a.zip"));
    expect(r.settings).toBe(1);
    expect(r.skipped).toEqual([{ kind: "setting", code: "invalid" }]);
    const zip = readZip(readFileSync(join(dir, "a.zip")));
    expect(text(zip.get("stores/sync.cloudSync/settings.json"))).toBe(
      '{"theme":"dark"}\n',
    );
    expect(JSON.parse(text(zip.get("data.json"))).encryption).toBe("e2e");
  });

  it("a locked ring refuses before anything is read", async () => {
    const w = new World();
    const { client } = await signedIn(w, {}, "e2e");
    client.keyring.lock();
    const before = w.syncReqs.length;
    const err = await client.cloudSync
      .export(join(tmp(), "a.zip"))
      .catch((e) => e);
    expect(err).toMatchObject({ code: "sync-locked" });
    // No pull for the export (the machine sends nothing while locked).
    expect(w.syncReqs.length).toBe(before);
  });

  it("a ring that locks during the export ends it with sync-locked and no file", async () => {
    const { w, client, sealed } = await sealedTheme();
    w.pull = () => {
      // The person signs out while the export is pulling.
      client.keyring.lock();
      return w.body({ cursor: 5, changes: [change({ ct: sealed })] });
    };
    const dir = tmp();
    const err = await client.cloudSync
      .export(join(dir, "a.zip"))
      .catch((e) => e);
    expect(err).toMatchObject({ code: "sync-locked" });
    expect(files(dir)).toEqual([]);
  });
});

describe("cloudSync.export: cancel and failure leave nothing behind", () => {
  it("a cancel in the middle of a file removes the partial and keeps the old destination", async () => {
    const { w, hooks } = exportWorld({
      file: { bytes: bytes(20_000_000), version: 3 },
    });
    const { client } = await signedIn(w);
    const dir = tmp();
    const dest = join(dir, "copy.zip");
    writeFileSync(dest, "keep me");
    const ctl = new AbortController();
    let served = 0;
    hooks.onFile = () => {
      // The second range is being asked for: the first piece is already in the partial.
      if (++served === 2) ctl.abort();
    };
    const err = await client.cloudSync
      .export(dest, { signal: ctl.signal })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "cancelled" });
    expect(served).toBeGreaterThanOrEqual(2);
    expect(files(dir)).toEqual(["copy.zip"]);
    expect(readFileSync(dest, "utf8")).toBe("keep me");
  });

  it("an aborted signal before the call writes and reads nothing", async () => {
    const { w } = exportWorld();
    const { client } = await signedIn(w);
    const dir = tmp();
    const ctl = new AbortController();
    ctl.abort();
    const err = await client.cloudSync
      .export(join(dir, "a.zip"), { signal: ctl.signal })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "cancelled" });
    expect(files(dir)).toEqual([]);
  });

  it("a full disk is reason destination, with the partial removed and the old file kept", async () => {
    const { w } = exportWorld();
    const { client } = await signedIn(w);
    const dir = tmp();
    const dest = join(dir, "copy.zip");
    writeFileSync(dest, "keep me");
    const probe = await openFile(join(dir, "probe"), "w");
    const proto = Object.getPrototypeOf(probe) as {
      write: (...a: unknown[]) => Promise<unknown>;
    };
    await probe.close();
    const real = proto.write;
    let calls = 0;
    vi.spyOn(proto, "write").mockImplementation(function (
      this: unknown,
      ...a: unknown[]
    ) {
      if (++calls > 3)
        return Promise.reject(
          Object.assign(new Error("no space left"), { code: "ENOSPC" }),
        );
      return real.apply(this, a);
    });
    const err = await client.cloudSync.export(dest).catch((e) => e);
    expect(err).toBeInstanceOf(SyncExportError);
    expect(err).toMatchObject({
      code: "sync-export-failed",
      reason: "destination",
    });
    // Nothing of the cause's text (a path) is in the message.
    expect(String(err.message)).not.toContain(dir);
    expect(files(dir).filter((f) => f !== "probe")).toEqual(["copy.zip"]);
    expect(readFileSync(dest, "utf8")).toBe("keep me");
  });
});

describe("cloudSync.export: the destination rules", () => {
  it("removes a stale partial an earlier crash left", async () => {
    const { w } = exportWorld();
    const { client } = await signedIn(w);
    const dir = tmp();
    const dest = join(dir, "copy.zip");
    writeFileSync(`${dest}.partial`, "half a zip from a crash");
    await client.cloudSync.export(dest);
    expect(files(dir)).toEqual(["copy.zip"]);
    expect(readFileSync(dest).subarray(0, 2)).toEqual(Buffer.from("PK"));
  });

  it("refuses a partial that is a link, and writes nothing through it", async () => {
    const { w } = exportWorld();
    const { client } = await signedIn(w);
    const dir = tmp();
    const target = join(dir, "victim");
    writeFileSync(target, "precious");
    const dest = join(dir, "copy.zip");
    symlinkSync(target, `${dest}.partial`);
    const err = await client.cloudSync.export(dest).catch((e) => e);
    expect(err).toMatchObject({
      code: "sync-export-failed",
      reason: "destination",
    });
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(existsSync(dest)).toBe(false);
    expect(lstatSync(`${dest}.partial`).isSymbolicLink()).toBe(true);
  });

  it("refuses a destination that is a directory or a link", async () => {
    const { w } = exportWorld();
    const { client } = await signedIn(w);
    const dir = tmp();
    const asDir = join(dir, "adir");
    mkdirSync(asDir);
    expect(await client.cloudSync.export(asDir).catch((e) => e)).toMatchObject({
      reason: "destination",
    });
    const real = join(dir, "real");
    writeFileSync(real, "x");
    const link = join(dir, "link");
    symlinkSync(real, link);
    expect(await client.cloudSync.export(link).catch((e) => e)).toMatchObject({
      reason: "destination",
    });
    expect(readFileSync(real, "utf8")).toBe("x");
    expect(files(dir)).toEqual(["adir", "link", "real"]);
  });

  it("refuses a destination in a directory that does not exist, and an empty path", async () => {
    const { w } = exportWorld();
    const { client } = await signedIn(w);
    const dir = tmp();
    for (const dest of [join(dir, "no", "such", "a.zip"), ""])
      expect(await client.cloudSync.export(dest).catch((e) => e)).toMatchObject(
        { code: "sync-export-failed", reason: "destination" },
      );
  });

  it("creates the partial exclusively with 0600 at creation, whatever the umask", async () => {
    const dir = tmp();
    const dest = join(dir, "copy.zip");
    const paths = await prepareDestination(dest);
    const was = process.umask(0);
    let file: Awaited<ReturnType<typeof createExportFile>>;
    try {
      file = await createExportFile(paths);
    } finally {
      process.umask(was);
    }
    expect(statSync(paths.partial).mode & 0o777).toBe(0o600);
    // Another creator, or a link planted after the check, is refused: exclusive and no-follow.
    await expect(createExportFile(paths)).rejects.toMatchObject({
      reason: "destination",
    });
    await file.sink.write(Uint8Array.of(1, 2, 3));
    await file.commit();
    expect(files(dir)).toEqual(["copy.zip"]);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(readFileSync(dest)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("does not follow a link planted at the partial between the check and the create", async () => {
    const dir = tmp();
    const dest = join(dir, "copy.zip");
    const paths = await prepareDestination(dest);
    const target = join(dir, "victim");
    writeFileSync(target, "precious");
    symlinkSync(target, paths.partial);
    await expect(createExportFile(paths)).rejects.toMatchObject({
      reason: "destination",
    });
    expect(readFileSync(target, "utf8")).toBe("precious");
  });

  it("discard removes the partial and leaves the destination", async () => {
    const dir = tmp();
    const dest = join(dir, "copy.zip");
    writeFileSync(dest, "old");
    const paths = await prepareDestination(dest);
    const file = await createExportFile(paths);
    await file.sink.write(Uint8Array.of(9));
    await file.discard();
    expect(files(dir)).toEqual(["copy.zip"]);
    expect(readFileSync(dest, "utf8")).toBe("old");
  });
});
