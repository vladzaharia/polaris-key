// @pkey-feature sync.records
// `client.cloudSync.collection(name)` on the Node client (U-46): the catalog's collections reach
// the machine, the handle's verbs become the wire operations of V5 section 13.3, a refused call
// sends nothing, and a pulled record raises a change on the handle.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG,
  SUBJECT,
  World,
  open,
  type Body,
} from "./cloudSyncFixtures.js";

const CLOUD = {
  collections: [
    { name: "prefs", conflict: "merge" },
    { name: "tags", conflict: "union" },
    { name: "best", conflict: "max", conflictField: "score" },
    { name: "notes.*", conflict: "lastWrite" },
  ],
};

async function rig() {
  const w = new World();
  w.body = ((over: Body = {}) => ({
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
  })) as typeof w.body;
  const client = await open(
    w,
    mkdtempSync(join(tmpdir(), "pkey-ccoll-")),
    { encryption: "server", catalog: { ...CATALOG(1), cloudSync: CLOUD } },
    false,
  );
  await client.cloudSyncHost.start();
  client.events.safeEmit("identity", { kind: "signedIn", subject: SUBJECT });
  await client.cloudSync.flush();
  return { w, client };
}

const pushes = (w: World) =>
  w.syncReqs.filter((r) => r.method === "POST" && r.body?.mutations);

describe("cloudSync.collection", () => {
  it("sends field operations for a merge update, one stamp, only the named fields", async () => {
    const { w, client } = await rig();
    const prefs = await client.cloudSync.collection("prefs");
    expect(
      prefs.update("main", { set: { volume: 3 }, remove: ["old"] }),
    ).toEqual({ ok: true });
    expect(prefs.get("main")).toEqual({
      value: { volume: 3 },
      from: "pending",
    });
    await client.cloudSync.flush();
    const sent = (
      pushes(w).at(-1)!.body!.mutations as Array<Record<string, unknown>>
    ).map((m) => [m.op, m.field, m.editedHlc]);
    expect(sent.map((x) => x.slice(0, 2))).toEqual([
      ["setField", "volume"],
      ["removeField", "old"],
    ]);
    expect(sent[0]![2]).toBe(sent[1]![2]);
    client.close();
  });

  it("matches a pattern, and refuses undeclared names and wrong verbs without sending", async () => {
    const { w, client } = await rig();
    const before = pushes(w).length;
    const notes = await client.cloudSync.collection("notes.work");
    expect(notes.put("n1", { t: "x" })).toEqual({ ok: true });
    expect(
      await (await client.cloudSync.collection("nope")).put("a", 1),
    ).toEqual({
      ok: false,
      error: "collection_unknown",
    });
    const tags = await client.cloudSync.collection("tags");
    expect(tags.put("t", 1)).toEqual({
      ok: false,
      error: "op_invalid_for_policy",
    });
    expect(tags.add("t", "a")).toEqual({ ok: true });
    await client.cloudSync.flush();
    const ops = pushes(w)
      .slice(before)
      .flatMap((r) => r.body!.mutations as Array<Record<string, unknown>>)
      .map((m) => m.op);
    expect(ops.sort()).toEqual(["add", "set"]);
    client.close();
  });

  it("reports a pulled record as a change on the handle", async () => {
    const { w, client } = await rig();
    const prefs = await client.cloudSync.collection("prefs");
    const seen: unknown[] = [];
    prefs.on((e) => seen.push(e));
    w.pull = () =>
      w.body({
        cursor: 5,
        changes: [{ record: ["prefs", "main"], version: 5, value: { a: 1 } }],
      });
    client.cloudSyncHost.machine.setNetwork("online");
    await client.cloudSyncHost.touch();
    await client.cloudSync.flush();
    expect(seen).toContainEqual({
      type: "change",
      ids: ["main"],
      origin: "remote",
    });
    expect(prefs.get("main")).toEqual({ value: { a: 1 }, from: "cloud" });
    client.close();
  });
});
