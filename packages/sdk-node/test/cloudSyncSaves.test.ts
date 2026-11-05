// @pkey-feature sync.saves sync.files
// `client.cloudSync.saves` on the Node client (U-22.5): list, read, write and delete a save over the
// machine's records binding and the file transport, against a small fake of the Worker's sync and
// file routes (server mode, whole-file uploads). It pins the order (file first, then the metadata
// `set` at the version `finalize` answered), the transfer events on `client.events`, `transfers()`,
// a conflict that reports the server copy, and the journal and chunk cache going with the person.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TransferEvent } from "../src/constants.generated.js";
import {
  chunkCachePersonDir,
  chunkCacheRoot,
} from "../src/cloudSync/chunkCache.js";
import {
  CATALOG,
  PRODUCT,
  SUBJECT,
  World,
  open,
  rowsWorld,
  serverWorld,
  startSignedIn,
  type Body,
} from "./cloudSyncFixtures.js";

const sha = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

/** The Worker's saves, as far as a whole-file save needs. */
function savesWorld() {
  const w = serverWorld();
  const { rows } = rowsWorld(w, "saves");
  const stored = new Map<number, Uint8Array>();
  const uploads = new Map<string, { id: string; bytes?: Uint8Array }>();
  const files: string[] = [];
  const inner = w.fetch;
  const json = (b: unknown, status = 200): Response =>
    new Response(JSON.stringify(b), { status });
  w.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const prefix = `/${PRODUCT}/sync/files/saves/`;
    if (!url.pathname.startsWith(prefix)) return inner(input, init);
    const [id, ...rest] = url.pathname.slice(prefix.length).split("/");
    const method = init.method ?? "GET";
    files.push(`${method} ${rest.join("/") || "-"}`);
    if (method === "POST" && rest[0] === "begin") {
      const base = JSON.parse(String(init.body)).baseVersion as number | "*";
      const row = rows.get(id!);
      if (base === "*" ? row !== undefined : row?.version !== base)
        return json(
          {
            error: { code: "revision_conflict" },
            server: { version: row?.version ?? 0 },
          },
          409,
        );
      const upId = `up_${uploads.size + 1}`;
      uploads.set(upId, { id: id! });
      return json({
        uploadId: upId,
        mode: "single",
        expiresAt: 1_700_086_400_000,
      });
    }
    if (method === "PUT" && rest[0] === "upload") {
      uploads.get(rest[1]!)!.bytes = init.body as Uint8Array;
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && rest[0] === "upload")
      return json({
        mode: "single",
        size: 0,
        received: [1],
        expiresAt: 1_700_086_400_000,
      });
    if (method === "POST" && rest[0] === "finalize") {
      const up = uploads.get(JSON.parse(String(init.body)).uploadId)!;
      const version = ++w.version;
      const file = {
        version,
        size: up.bytes!.length,
        sha256: sha(up.bytes!),
        format: "whole" as const,
      };
      stored.set(version, up.bytes!);
      rows.set(id!, { value: undefined, version, file });
      return json(file);
    }
    if (method === "GET" && rest.length === 0) {
      const row = rows.get(id!);
      const bytes = row?.file ? stored.get(row.file.version) : undefined;
      if (!bytes) return json({ error: { code: "not_found" } }, 404);
      const range = /bytes=(\d+)-(\d+)/.exec(
        new Headers(init.headers).get("range") ?? "",
      );
      if (!range) return new Response(bytes, { status: 200 });
      const [a, b] = [Number(range[1]), Number(range[2])];
      return new Response(bytes.slice(a, b + 1), {
        status: 206,
        headers: { "content-range": `bytes ${a}-${b}/${bytes.length}` },
      });
    }
    return json({ error: { code: "not_found" } }, 404);
  }) as typeof fetch;
  return { w, rows, files };
}

async function signedIn(w: World) {
  const stateDir = mkdtempSync(join(tmpdir(), "pkey-csaves-"));
  const client = await open(w, stateDir, {
    encryption: "server",
    saves: { delta: false },
    // There is no implicit collection: the catalog declares `saves`.
    catalog: {
      ...CATALOG(1),
      cloudSync: { collections: [{ name: "saves", conflict: "revision" }] },
    },
  });
  await startSignedIn(client);
  return { client, stateDir };
}

const bytes = (n: number, seed = 7): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

describe("cloudSync.saves", () => {
  it("writes a file, then the metadata at the version finalize answered, and reads it back", async () => {
    const { w, rows, files } = savesWorld();
    const { client } = await signedIn(w);
    const events: unknown[] = [];
    client.events.on("cloudSync", (e) => {
      if ("id" in e) events.push(e);
    });
    const data = bytes(3000);

    const transfer = await client.cloudSync.saves.write("slot-1", data, {
      chapter: "one",
    });
    expect(client.cloudSync.transfers().map((t) => t.id)).toEqual([
      "saves:slot-1",
    ]);
    const out = await transfer.done;
    expect(out).toMatchObject({ state: "done", id: "slot-1" });
    expect(files.slice(0, 3)).toEqual([
      "POST begin",
      "PUT upload/up_1",
      "POST finalize",
    ]);
    expect(rows.get("slot-1")).toMatchObject({
      value: { chapter: "one" },
      file: { size: 3000, sha256: sha(data) },
    });
    expect(client.cloudSync.transfers()).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: TransferEvent.transferdone,
      id: "saves:slot-1",
      state: "done",
    });
    expect(
      events.some(
        (e) => (e as { type: string }).type === TransferEvent.transferprogress,
      ),
    ).toBe(true);

    const list = await client.cloudSync.saves.list();
    expect(list).toEqual([
      expect.objectContaining({
        id: "slot-1",
        metadata: expect.objectContaining({
          chapter: "one",
          savedAt: expect.any(Number),
        }),
        file: expect.objectContaining({ size: 3000 }),
      }),
    ]);
    const read = await client.cloudSync.saves.read("slot-1");
    expect(read).toMatchObject({ ok: true, metadata: { chapter: "one" } });
    expect(read.ok && typeof read.metadata.savedAt).toBe("number");
    expect(
      read.ok &&
        read.bytes &&
        Buffer.from(read.bytes).equals(Buffer.from(data)),
    ).toBe(true);
    client.close();
  });

  it("lists the new file at once after a write, with no echo of the record in the push reply", async () => {
    const { w } = savesWorld();
    const push = w.push;
    w.push = (body) => ({ ...push(body), changes: [] });
    const { client } = await signedIn(w);
    const first = bytes(300, 1);
    const out1 = await (
      await client.cloudSync.saves.write("slot-1", first, { chapter: "one" })
    ).done;
    expect(out1).toMatchObject({ state: "done" });
    const list1 = await client.cloudSync.saves.list();
    expect(list1).toEqual([
      expect.objectContaining({
        id: "slot-1",
        file: expect.objectContaining({ size: 300, sha256: sha(first) }),
      }),
    ]);

    const second = bytes(500, 2);
    const out2 = await (
      await client.cloudSync.saves.write(
        "slot-1",
        second,
        { chapter: "two" },
        { baseVersion: out1.state === "done" ? (out1.version ?? 0) : 0 },
      )
    ).done;
    expect(out2).toMatchObject({ state: "done" });
    const read = await client.cloudSync.saves.read("slot-1");
    expect(read).toMatchObject({ ok: true, metadata: { chapter: "two" } });
    expect(
      read.ok &&
        read.bytes &&
        Buffer.from(read.bytes).equals(Buffer.from(second)),
    ).toBe(true);
    client.close();
  });

  it("saveConflictOpensRequest: a stale write is a request that carries the server copy", async () => {
    const { w, rows } = savesWorld();
    rows.set("slot-1", {
      value: { chapter: "two" },
      version: 7,
      file: { version: 7, size: 5, sha256: "a".repeat(64), format: "whole" },
    });
    w.version = 7;
    const { client } = await signedIn(w);
    const t = await client.cloudSync.saves.write(
      "slot-1",
      bytes(500),
      { chapter: "mine" },
      {
        baseVersion: 5,
      },
    );
    const out = await t.done;
    expect(out.state).toBe("conflict");
    if (out.state !== "conflict") return;
    expect(out.request).toMatchObject({
      id: "w:saves/slot-1",
      collection: "saves",
      record: "slot-1",
      remote: { version: 7, value: { chapter: "two" } },
    });
    expect(client.cloudSync.conflicts()).toHaveLength(1);
    expect(client.cloudSync.status().conflicts).toBe(1);
    client.close();
  });

  it("saveKeepRemote: keeping the other version pulls, so the cache holds the server's copy", async () => {
    const { w, rows } = savesWorld();
    const file = (v: number) => ({
      version: v,
      size: 5,
      sha256: "a".repeat(64),
      format: "whole" as const,
    });
    rows.set("slot-1", {
      value: { chapter: "one" },
      version: 3,
      file: file(3),
    });
    w.version = 3;
    const { client } = await signedIn(w);
    expect((await client.cloudSync.saves.list())[0]?.version).toBe(3);
    // Another device writes it again; this device has not pulled.
    rows.set("slot-1", {
      value: { chapter: "theirs" },
      version: 9,
      file: file(9),
    });
    w.version = 9;
    const out = await (
      await client.cloudSync.saves.write("slot-1", bytes(500), {
        chapter: "mine",
      })
    ).done;
    if (out.state !== "conflict") throw new Error(out.state);
    expect(out.request.remote?.version).toBe(9);
    expect(out.request.remote?.value).toMatchObject({ chapter: "theirs" });
    expect(out.request.local?.value).toMatchObject({ chapter: "mine" });
    expect(typeof (out.request.local?.value as any).savedAt).toBe("number");
    expect(out.request.choices).toEqual(["local", "remote", "both"]);
    const kept = await out.request.keep("remote");
    expect(kept).toMatchObject({ ok: true, kept: "remote", version: 9 });
    expect(client.cloudSync.conflicts()).toEqual([]);
    const [row] = await client.cloudSync.saves.list();
    expect(row).toMatchObject({ version: 9, metadata: { chapter: "theirs" } });
    client.close();
  });

  it("saveKeepLocal: keeping this device's save writes it on top of the server's, from the retained bytes", async () => {
    const { w, rows } = savesWorld();
    rows.set("slot-1", {
      value: { chapter: "one" },
      version: 3,
      file: { version: 3, size: 5, sha256: "a".repeat(64), format: "whole" },
    });
    w.version = 3;
    const { client } = await signedIn(w);
    await client.cloudSync.saves.list();
    rows.set("slot-1", {
      value: { chapter: "theirs" },
      version: 9,
      file: { version: 9, size: 5, sha256: "a".repeat(64), format: "whole" },
    });
    w.version = 9;
    const mine = bytes(700);
    const out = await (
      await client.cloudSync.saves.write("slot-1", mine, { chapter: "mine" })
    ).done;
    if (out.state !== "conflict") throw new Error(out.state);
    // The listener sees the request that is already open, and a later write only replaces it.
    const listed: string[] = [];
    client.cloudSync.onConflict((r) => void listed.push(r.id));
    expect(listed).toEqual(["w:saves/slot-1"]);
    const kept = await out.request.keep("local");
    expect(kept).toMatchObject({ ok: true, kept: "local" });
    expect(rows.get("slot-1")).toMatchObject({
      value: { chapter: "mine" },
      file: { size: 700, sha256: sha(mine) },
    });
    expect(client.cloudSync.conflicts()).toEqual([]);
    client.close();
  });

  it("deletes a save at its version", async () => {
    const { w, rows } = savesWorld();
    rows.set("slot-1", {
      value: { chapter: "one" },
      version: 3,
      file: { version: 3, size: 5, sha256: "a".repeat(64), format: "whole" },
    });
    w.version = 3;
    const { client } = await signedIn(w);
    expect(await client.cloudSync.saves.delete("slot-1")).toMatchObject({
      ok: true,
    });
    expect(rows.has("slot-1")).toBe(false);
    expect(await client.cloudSync.saves.list()).toEqual([]);
    client.close();
  });

  it("lists a record that has a file and no value (file-only row)", async () => {
    const { w, rows } = savesWorld();
    rows.set("slot-9", {
      value: undefined,
      version: 4,
      file: { version: 4, size: 9, sha256: "b".repeat(64), format: "whole" },
    });
    w.version = 4;
    const { client } = await signedIn(w);
    expect(await client.cloudSync.saves.list()).toEqual([
      expect.objectContaining({
        id: "slot-9",
        metadata: {},
        file: expect.objectContaining({ size: 9 }),
      }),
    ]);
    client.close();
  });

  it("purges the transfer journal and chunk cache with the person", async () => {
    const { w } = savesWorld();
    const { client, stateDir } = await signedIn(w);
    const dirs = (): string[] => {
      const found: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) {
            if (/^cloud-sync-transfers$/.test(e.name)) found.push(e.name);
            walk(join(d, e.name));
          }
        }
      };
      walk(stateDir);
      return found;
    };
    // Two people on one device: each has a chunk cache directory.
    const state = (client as unknown as { core: { dirs: { state: string } } })
      .core.dirs.state;
    const mine = chunkCachePersonDir(state, SUBJECT);
    const theirs = chunkCachePersonDir(state, "someone-else");
    for (const d of [mine, theirs]) {
      mkdirSync(join(d, "c"), { recursive: true });
      writeFileSync(join(d, "c", "x"), "x");
    }
    // A parked transfer: the journal directory exists until the person goes.
    const t = await client.cloudSync.saves.write("slot-1", bytes(100), {});
    await t.done;
    expect(dirs()).toContain("cloud-sync-transfers");
    await (
      client as unknown as { cloudSyncApi: { beforeSignOut(): Promise<void> } }
    ).cloudSyncApi.beforeSignOut();
    expect(dirs()).toEqual([]);
    // Only the leaving person's chunks go; the other person's stay.
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(join(theirs, "c", "x"))).toBe(true);
    expect(existsSync(stateDir)).toBe(true);
    client.close();
  });

  it("removes every chunk cache when the leaving person is not known in this run", async () => {
    const { w } = savesWorld();
    const stateDir = mkdtempSync(join(tmpdir(), "pkey-csaves-"));
    // A fresh process: nobody is signed in and saves were never used.
    const client = await open(w, stateDir, {
      encryption: "server",
      saves: { delta: true },
    });
    const state = (client as unknown as { core: { dirs: { state: string } } })
      .core.dirs.state;
    for (const who of ["earlier-person", "another"]) {
      const d = chunkCachePersonDir(state, who);
      mkdirSync(join(d, "c"), { recursive: true });
      writeFileSync(join(d, "c", "x"), "x");
    }
    await (
      client as unknown as { savesApi: { purge(): Promise<void> } }
    ).savesApi.purge();
    expect(existsSync(chunkCacheRoot(state))).toBe(false);
    client.close();
  });

  it("cancel() settles a write that waits for its metadata outcome", async () => {
    const { w } = savesWorld();
    const inner = w.fetch;
    let pushed = false;
    // The push never answers: the write waits on its outcome.
    w.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (!new URL(String(input)).pathname.endsWith("/sync/ops"))
        return inner(input, init);
      pushed = true;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const { client } = await signedIn(w);
    const t = await client.cloudSync.saves.write("slot-1", bytes(100), {});
    await vi.waitFor(() => expect(pushed).toBe(true));
    await t.cancel();
    expect(await t.done).toEqual({ state: "cancelled" });
    expect(client.cloudSync.transfers()).toEqual([]);
  });

  it("purge cancels a running write", async () => {
    const { w } = savesWorld();
    const inner = w.fetch;
    let putting = false;
    // The upload's bytes never land: the write is running when the person leaves.
    w.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (init?.method === "PUT" && String(input).includes("/upload/")) {
        putting = true;
        return new Promise<Response>((_, reject) => {
          const stop = (): void =>
            reject(new DOMException("aborted", "AbortError"));
          if (init.signal?.aborted) stop();
          else init.signal?.addEventListener("abort", stop, { once: true });
        });
      }
      return inner(input, init);
    }) as typeof fetch;
    const { client } = await signedIn(w);
    const t = await client.cloudSync.saves.write("slot-1", bytes(100), {});
    await vi.waitFor(() => expect(putting).toBe(true));
    expect(client.cloudSync.transfers()).toHaveLength(1);
    await (
      client as unknown as { cloudSyncApi: { beforeSignOut(): Promise<void> } }
    ).cloudSyncApi.beforeSignOut();
    expect(await t.done).toEqual({ state: "cancelled" });
    expect(client.cloudSync.transfers()).toEqual([]);
    client.close();
  });

  it("purges the save transfers before the ring is forgotten", async () => {
    const { w } = savesWorld();
    const { client, stateDir } = await signedIn(w);
    const t = await client.cloudSync.saves.write("slot-1", bytes(100), {});
    await t.done;
    const seen: boolean[] = [];
    const forget = client.keyring.forget.bind(client.keyring);
    client.keyring.forget = async () => {
      seen.push(
        !readdirSync(stateDir, { recursive: true }).some((p) =>
          String(p).endsWith("cloud-sync-transfers"),
        ),
      );
      return forget();
    };
    await (
      client as unknown as { cloudSyncApi: { beforeSignOut(): Promise<void> } }
    ).cloudSyncApi.beforeSignOut();
    expect(seen).toEqual([true]);
    client.close();
  });
});
