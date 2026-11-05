// @pkey-feature sync.conflict
// `client.cloudSync.onConflict`, `conflicts()` and `cloudEmpty()` on the Node client (U-08.4): a
// `revision` put the server refuses opens one MergeRequest, the device keeps its copy unsent until
// `keep`, a listener may decide inline, and `conflictOpened` / `conflictClosed` reach the stream.
// The machine's own scenarios run in the conformance runner; this pins the Node binding.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MergeEvent } from "../src/constants.generated.js";
import {
  CATALOG,
  SUBJECT,
  World,
  open,
  type Body,
} from "./cloudSyncFixtures.js";

interface Row {
  value: unknown;
  version: number;
}

async function rig(over: Body = {}) {
  const w = new World();
  w.body = ((extra: Body = {}) => ({
    subject: SUBJECT,
    serverNow: 1_700_000_000_000,
    cursor: 0,
    more: false,
    lastMutationId: 0,
    catalogVersion: 1,
    aliases: {},
    usage: { files: 0, records: 0, settings: 0, bytes: 0 },
    quota: { files: true, bytes: 2 ** 28 },
    encryption: "server",
    changes: [],
    tombstones: [],
    ...over,
    ...extra,
  })) as typeof w.body;
  const rows = new Map<string, Row>();
  const change = (id: string, r: Row): Body => ({
    record: ["progress", id],
    version: r.version,
    value: r.value,
  });
  w.pull = () =>
    w.body({
      cursor: w.version,
      changes: [...rows].map(([id, r]) => change(id, r)),
    });
  w.push = (body) => {
    const results: Body[] = [];
    const changes: Body[] = [];
    for (const m of body.mutations as Array<Record<string, any>>) {
      const id = m.target.record[1] as string;
      const row = rows.get(id);
      const base = m.baseVersion as number | "*";
      const stale = base === "*" ? row !== undefined : row?.version !== base;
      if (stale) {
        results.push({
          mutationId: m.mutationId,
          status: "conflict",
          server: row ? change(id, row) : { version: w.version },
        });
        continue;
      }
      const version = ++w.version;
      const next: Row = { value: m.value, version };
      rows.set(id, next);
      changes.push(change(id, next));
      results.push({ mutationId: m.mutationId, status: "ok", version });
    }
    return w.body({ cursor: w.version, results, changes });
  };
  const client = await open(
    w,
    mkdtempSync(join(tmpdir(), "pkey-cconf-")),
    {
      encryption: "server",
      catalog: {
        ...CATALOG(1),
        cloudSync: {
          collections: [{ name: "progress", conflict: "revision" }],
        },
      },
    },
    false,
  );
  await client.cloudSyncHost.start();
  client.events.safeEmit("identity", { kind: "signedIn", subject: SUBJECT });
  await client.cloudSync.flush();
  return { w, rows, client };
}

const pushes = (w: World) =>
  w.syncReqs.filter((r) => r.method === "POST" && r.body?.mutations);

describe("cloudSync.conflicts", () => {
  it("opens a request on a refused revision put and holds the copy unsent until keep", async () => {
    const { w, rows, client } = await rig();
    const events: unknown[] = [];
    client.events.on("cloudSync", (e) => {
      if (e.type === MergeEvent.conflictopened || e.type === "conflictClosed")
        events.push(e);
    });
    rows.set("a", { value: "theirs", version: 7 });
    w.version = 7;
    const col = await client.cloudSync.collection("progress");
    col.put("a", "mine");
    await client.cloudSync.flush();

    const [req] = client.cloudSync.conflicts();
    expect(req).toMatchObject({
      id: "w:progress/a",
      cause: "write",
      collection: "progress",
      record: "a",
      state: "open",
      choices: ["local", "remote", "value"],
      local: { value: "mine" },
      remote: { value: "theirs", version: 7 },
    });
    expect(client.cloudSync.status().conflicts).toBe(1);
    expect(events).toEqual([
      {
        type: MergeEvent.conflictopened,
        id: "w:progress/a",
        cause: "write",
        collection: "progress",
        record: "a",
      },
    ]);
    // The device reads its copy, the cloud keeps the other, and nothing more is sent.
    expect(col.get("a")).toMatchObject({ value: "mine", from: "pending" });
    const sent = pushes(w).length;
    await client.cloudSync.flush();
    expect(pushes(w).length).toBe(sent);
    expect(rows.get("a")?.value).toBe("theirs");

    const out = await req!.keep("local");
    expect(out).toMatchObject({ ok: true, kept: "local" });
    expect(rows.get("a")?.value).toBe("mine");
    expect(client.cloudSync.conflicts()).toEqual([]);
    expect(client.cloudSync.status().conflicts).toBeUndefined();
    expect(events.at(-1)).toEqual({
      type: MergeEvent.conflictclosed,
      id: "w:progress/a",
      how: "local",
    });
    client.close();
  });

  it("replays open requests to a new listener, and a returned choice decides inline", async () => {
    const { w, rows, client } = await rig();
    rows.set("a", { value: "theirs", version: 7 });
    w.version = 7;
    const col = await client.cloudSync.collection("progress");
    col.put("a", "mine");
    await client.cloudSync.flush();
    expect(client.cloudSync.conflicts()).toHaveLength(1);

    const seen: string[] = [];
    const off = client.cloudSync.onConflict((r) => {
      seen.push(r.id);
      return "remote";
    });
    expect(seen).toEqual(["w:progress/a"]);
    await client.cloudSync.flush();
    expect(client.cloudSync.conflicts()).toEqual([]);
    expect(rows.get("a")?.value).toBe("theirs");
    off();
    client.close();
  });

  it("refuses a choice the request does not offer, and a closed request", async () => {
    const { w, rows, client } = await rig();
    rows.set("a", { value: "theirs", version: 7 });
    w.version = 7;
    (await client.cloudSync.collection("progress")).put("a", "mine");
    await client.cloudSync.flush();
    const [req] = client.cloudSync.conflicts();
    expect(await req!.keep("both")).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    expect(await req!.keep({ value: "merged" })).toMatchObject({ ok: true });
    expect(await req!.keep("local")).toMatchObject({
      ok: false,
      code: "sync-merge-closed",
    });
    expect(rows.get("a")?.value).toBe("merged");
    client.close();
  });

  it("reports whether the cloud was empty at the first pull", async () => {
    const empty = await rig({ empty: true });
    expect(empty.client.cloudSync.cloudEmpty()).toBe(true);
    empty.client.close();
    const full = await rig();
    expect(full.client.cloudSync.cloudEmpty()).toBe(false);
    full.client.close();
  });
});
