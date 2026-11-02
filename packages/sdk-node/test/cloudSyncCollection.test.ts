// @pkey-feature sync.records
// `client.cloudSync.collection(name)` on the Node client (U-46): the catalog's collections reach
// the machine, the handle's verbs become the wire operations of V5 section 13.3, a refused call
// sends nothing, and a pulled record raises a change on the handle.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SyncCollection } from "@polaris-key/client-core/sync";
import { CloudSyncHost } from "../src/cloudSync/host.js";
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

  it("refuses an id, field or value that cannot be sealed without journalling or sending", async () => {
    const { w, client } = await rig();
    await client.cloudSync.flush();
    const before = pushes(w).length;
    const bad = { ok: false, error: "value_invalid" };
    const notes = await client.cloudSync.collection("notes.work");
    const prefs = await client.cloudSync.collection("prefs");
    expect(notes.put("a\u0000b", 1)).toEqual(bad);
    expect(notes.put("n", Number.NaN)).toEqual(bad);
    expect(prefs.update("main", { set: { "f\u0000": 1 } })).toEqual(bad);
    await client.cloudSync.flush();
    expect(pushes(w).length).toBe(before);
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

describe("a rebuilt machine", () => {
  it("keeps the watched collections and outcome taps of the machine it replaces", async () => {
    const { w, client } = await rig();
    const doc = { values: {} as Record<string, never> };
    const inner = client as unknown as { core: never; tokens: never };
    const host = new CloudSyncHost(
      {
        ctx: inner.core,
        tokens: inner.tokens,
        keyring: client.keyring,
        discovery: () => null,
        fetchSchema: () => client.config.fetchSchema(),
        document: () => doc,
      },
      {
        catalog: { ...CATALOG(1), cloudSync: CLOUD } as never,
        encryption: "server",
      },
    );
    await host.start();
    host.bindSubject(SUBJECT);
    host.machine.signIn(SUBJECT);
    const prefs = new SyncCollection("prefs", {
      get machine() {
        return host.machine;
      },
      onEvents: (fn) => host.onEvents(fn),
      touch: () => void host.touch(),
    });
    const seen: unknown[] = [];
    prefs.on((e) => seen.push(e));
    const old = host.machine;
    (doc.values as Record<string, unknown>).changed = 1;
    host.noteDocumentRefreshed();
    await host.flush();
    expect(host.machine).not.toBe(old);
    w.pull = () =>
      w.body({
        cursor: 5,
        changes: [{ record: ["prefs", "main"], version: 5, value: { a: 1 } }],
      });
    host.machine.setNetwork("online");
    await host.touch();
    await host.flush();
    expect(seen).toContainEqual({
      type: "change",
      ids: ["main"],
      origin: "remote",
    });
    await host.close();
    client.close();
  });
});

describe("cloudSync.collection in end-to-end mode", () => {
  it("a record tombstone removes the held record in end-to-end mode", async () => {
    const w = new World();
    const client = await open(w, mkdtempSync(join(tmpdir(), "pkey-ccoll-")), {
      encryption: "e2e",
      catalog: { ...CATALOG(1), cloudSync: CLOUD },
    });
    await client.keyring.create();
    await client.cloudSyncHost.start();
    client.events.safeEmit("identity", { kind: "signedIn", subject: SUBJECT });
    await client.cloudSync.flush();
    const prefs = await client.cloudSync.collection("notes.work");
    expect(prefs.put("main", { t: "x" })).toEqual({ ok: true });
    await client.cloudSync.flush();
    const sent = pushes(w).at(-1)!.body!.mutations as Array<{
      target: { record: [string, string] };
      ct: string;
    }>;
    const wire = sent[0]!.target.record;
    expect(wire[1]).not.toBe("main");
    // The sealed record comes back on a pull: the machine holds it under its plain name.
    w.pull = () =>
      w.body({
        cursor: 5,
        changes: [
          { record: wire, version: 150, ct: sent[0]!.ct, sealed: true },
        ],
      });
    client.cloudSyncHost.machine.setNetwork("online");
    await client.cloudSyncHost.touch();
    await client.cloudSync.flush();
    expect(client.cloudSyncHost.machine.recordKeys()).toEqual([
      ["notes.work", "main"],
    ]);
    expect(prefs.get("main")).toBeDefined();
    w.pull = () =>
      w.body({ cursor: 9, tombstones: [{ record: wire, version: 200 }] });
    client.cloudSyncHost.machine.setNetwork("online");
    await client.cloudSyncHost.touch();
    await client.cloudSync.flush();
    expect(prefs.get("main")).toBeNull();
    expect(client.cloudSyncHost.machine.recordKeys()).toEqual([]);
    client.close();
  });
});
