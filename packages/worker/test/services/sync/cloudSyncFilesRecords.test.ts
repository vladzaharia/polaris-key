/**
 * U-10.9: files on records through the routes (WIRE-CONTRACT-V5 §13.4, §13.5, §13.8.1; GF1, GF4,
 * GF6): the pull carries the pointer, a record `delete` pushed to the Worker retires the file and
 * its revisions, and discovery names the file routes only while the Worker has a file store and the
 * launch gate is on. The engine rules are `cloudSyncFilesPull.test.ts`'s.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PullResponse, PushResponse } from "@polaris-key/protocol/sync";
import { installDigestStream } from "../../r2Mock.js";
import { hlc, nextId, pull, send } from "./cloudSyncAbuseWorld.js";
import {
  SLUG,
  authed,
  bytesOf,
  call,
  filesPath,
  filesWorld,
  push,
  rows,
  setGate,
  setQuota,
  stored,
  usageOf,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";
import { world } from "./cloudSyncAbuseWorld.js";

beforeAll(() => installDigestStream());

const pulled = async (w: FilesWorld) =>
  (await (await pull(w)).json()) as PullResponse;

const del = async (w: FilesWorld, collection: string, id: string) => {
  const res = await push(w, [
    {
      mutationId: nextId(),
      target: { record: [collection, id] },
      op: "delete",
      editedHlc: hlc,
    },
  ]);
  expect(res.status).toBe(200);
  return ((await res.json()) as PushResponse).results[0];
};

describe("the pull carries the file pointer", () => {
  it("a file-only record, then the same record with a value", async () => {
    const w = await filesWorld();
    const out = await stored(w, "saves", "s1", bytesOf(500), {
      baseVersion: "*",
    });
    const first = await pulled(w);
    expect(first.changes).toEqual([
      {
        record: ["saves", "s1"],
        version: out.version,
        editedHlc: expect.any(String),
        file: {
          version: out.version,
          size: 500,
          sha256: out.sha256,
          format: "whole",
        },
      },
    ]);
    expect(first.usage.files).toBe(1);
    const set = await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["saves", "s1"] },
        op: "set",
        value: { chapter: "three" },
        editedHlc: hlc,
        baseVersion: out.version,
      },
    ]);
    expect(((await set.json()) as PushResponse).results[0]).toMatchObject({
      status: "ok",
    });
    const second = await pulled(w);
    expect(second.changes).toEqual([
      expect.objectContaining({
        record: ["saves", "s1"],
        value: { chapter: "three" },
        file: expect.objectContaining({ version: out.version, size: 500 }),
      }),
    ]);
  });

  it("a push that conflicts on a record with a file answers the pointer in the server copy", async () => {
    const w = await filesWorld();
    const out = await stored(w, "saves", "s1", bytesOf(40), {
      baseVersion: "*",
    });
    const res = await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["saves", "s1"] },
        op: "set",
        value: { n: 1 },
        editedHlc: hlc,
        baseVersion: out.version + 5,
      },
    ]);
    const [r] = ((await res.json()) as PushResponse).results;
    expect(r).toMatchObject({
      status: "conflict",
      server: {
        version: out.version,
        file: { version: out.version, size: 40 },
      },
    });
  });
});

describe("a record delete pushed to the Worker (GF4)", () => {
  it("retires the file and its revisions, frees the quota, and the file is gone to every route", async () => {
    const w = await filesWorld();
    await setQuota(w, 1_000_000);
    await stored(w, "saves", "s1", bytesOf(1000, 1), { baseVersion: "*" });
    const live = await stored(w, "saves", "s1", bytesOf(2000, 2));
    expect(usageOf(w)).toMatchObject({
      files: 1,
      file_bytes: 2000,
      revision_bytes: 1000,
    });
    expect((await del(w, "saves", "s1"))?.status).toBe("ok");

    expect(rows(w, "SELECT status FROM files ORDER BY version")).toEqual([
      { status: "dead" },
      { status: "dead" },
    ]);
    const u = usageOf(w);
    expect(u.files ?? 0).toBe(0);
    expect(u.file_bytes ?? 0).toBe(0);
    expect(u.revision_bytes ?? 0).toBe(0);
    expect(u.bytes).toBe(0);
    // Both objects wait for the alarm (U-10.10); nothing a client can name reaches them.
    expect(w.r2.keys()).toHaveLength(2);
    const base = `/${SLUG}/sync/files/saves/s1`;
    expect((await call(w, "GET", base)).status).toBe(404);
    expect(
      (await call(w, "GET", `${base}?version=${live.version}`)).status,
    ).toBe(404);
    expect(
      await (
        await call(w, "GET", filesPath("saves", "s1", "revisions"))
      ).json(),
    ).toEqual({ revisions: [] });
    const after = await pulled(w);
    expect(after.changes).toEqual([]);
    expect(after.tombstones).toEqual([
      { record: ["saves", "s1"], editedHlc: expect.any(String) },
    ]);
    expect(after.usage.files).toBe(0);
  });
});

describe("discovery (GF6)", () => {
  const discovered = async (w: Pick<FilesWorld, "db" | "env" | "token">) => {
    const res = await send(
      w as never,
      authed(w as never),
      `/${SLUG}/.well-known/polaris.json`,
      "GET",
    );
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        services: {
          sync: {
            saves: boolean;
            endpoints: { files: string | null; pull: string };
          };
        };
      }
    ).services.sync;
  };

  it("saves and files turn on with the file store and the launch gate, and off with either", async () => {
    const w = await filesWorld();
    const on = await discovered(w);
    expect(on.saves).toBe(true);
    expect(on.endpoints.files).toBe(`${on.endpoints.pull}/files`);
    expect(on.endpoints.files).toMatch(/\/djdl\/sync\/files$/);

    setGate(w, "off");
    expect(await discovered(w)).toMatchObject({
      saves: false,
      endpoints: { files: null },
    });
    setGate(w, "on");
    expect((await discovered(w)).saves).toBe(true);
  });

  it("a Worker with no file store says off, whatever the gate", async () => {
    const w = await world();
    setGate(w, "on");
    expect(await discovered(w)).toMatchObject({
      saves: false,
      endpoints: { files: null },
    });
  });
});
