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
  open,
  pushes,
  rowsWorld,
  serverWorld,
  startSignedIn,
  type Body,
} from "./cloudSyncFixtures.js";

async function rig(over: Body = {}) {
  const w = serverWorld(over);
  const { rows } = rowsWorld(w, "progress");
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
  await startSignedIn(client);
  return { w, rows, client };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** Another device saved "a" first: this device's put of "a" meets a conflict. */
async function clash({ w, rows, client }: Rig) {
  rows.set("a", { value: "theirs", version: 7 });
  w.version = 7;
  const col = await client.cloudSync.collection("progress");
  col.put("a", "mine");
  await client.cloudSync.flush();
  return col;
}

describe("cloudSync.conflicts", () => {
  it("opens a request on a refused revision put and holds the copy unsent until keep", async () => {
    const r = await rig();
    const { w, rows, client } = r;
    const events: unknown[] = [];
    client.events.on("cloudSync", (e) => {
      if (e.type === MergeEvent.conflictopened || e.type === "conflictClosed")
        events.push(e);
    });
    const col = await clash(r);

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
    const r = await rig();
    const { w, rows, client } = r;
    await clash(r);
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
    const r = await rig();
    const { w, rows, client } = r;
    await clash(r);
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
