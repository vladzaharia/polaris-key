import { describe, expect, it } from "vitest";
import {
  MergeRegistry,
  type MergeEvent,
  type MergeMachine,
} from "../src/sync/index.js";
import type {
  CallResult,
  MachineConflict,
  RecordRow,
  SyncEvent,
} from "../src/cloud-sync.js";

const side = (
  value: string,
  version: number | null,
  savedAt: number | null,
) => ({
  value,
  version,
  savedAt,
  device: null,
  file: null,
});

const request = (record: string): MachineConflict => ({
  id: `w:notes/${record}`,
  cause: "write",
  collection: "notes",
  record,
  local: side("mine", 1, 10),
  remote: side("theirs", 4, 20),
  choices: ["local", "remote", "value"],
  state: "open",
  error: null,
});

/** The machine as far as the registry sees it. */
function fakeMachine() {
  const open = new Map<string, MachineConflict>();
  const kept: Array<[string, unknown]> = [];
  const m: MergeMachine = {
    conflicts: () => [...open.values()],
    keep: (id, choice): CallResult => {
      kept.push([id, choice]);
      const c = open.get(id);
      if (!c) return { ok: false, error: "sync-merge-closed" };
      if (choice === "remote") open.delete(id);
      else c.state = "applying";
      return { ok: true };
    },
    records: (): RecordRow[] => [{ id: "a", version: 9 } as RecordRow],
  };
  return { m, open, kept };
}

const opened = (record: string): SyncEvent => ({
  type: "conflict",
  id: `w:notes/${record}`,
  cause: "write",
  collection: "notes",
  record,
});

describe("MergeRegistry over the machine", () => {
  it("lists open requests, replays them to a new listener and reports newer", () => {
    const f = fakeMachine();
    f.open.set("w:notes/b", request("b"));
    f.open.set("w:notes/a", request("a"));
    const reg = new MergeRegistry({ machine: f.m });
    expect(reg.conflicts().map((c) => c.id)).toEqual([
      "w:notes/a",
      "w:notes/b",
    ]);
    const seen: string[] = [];
    reg.onConflict((r) => void seen.push(r.id));
    expect(seen).toEqual(["w:notes/a", "w:notes/b"]);
    const first = reg.conflicts()[0]!;
    expect(first.newer).toBe("remote");
    expect(first.remote).toMatchObject({ value: "theirs", version: 4 });
  });

  it("a listener that returns a choice decides inline", async () => {
    const f = fakeMachine();
    const reg = new MergeRegistry({ machine: f.m });
    reg.onConflict(() => "remote");
    f.open.set("w:notes/a", request("a"));
    reg.feed([opened("a")]);
    expect(f.kept).toEqual([["w:notes/a", "remote"]]);
    expect(reg.conflicts()).toEqual([]);
  });

  it("keep local is applying until the machine closes it", async () => {
    const f = fakeMachine();
    const reg = new MergeRegistry({ machine: f.m });
    const events: MergeEvent[] = [];
    reg.onEvent((e) => events.push(e));
    f.open.set("w:notes/a", request("a"));
    reg.feed([opened("a")]);
    const r = reg.conflicts()[0]!;
    const pending = r.keep("local");
    expect(r.state).toBe("applying");
    expect(await r.keep("local")).toEqual({
      ok: false,
      code: "bad_request",
      reopened: false,
    });
    f.open.delete("w:notes/a");
    reg.feed([{ type: "conflictClosed", id: "w:notes/a", how: "local" }]);
    expect(await pending).toEqual({ ok: true, kept: "local", version: 9 });
    expect(events.map((e) => e.type)).toEqual([
      "conflictOpened",
      "conflictClosed",
    ]);
    expect(await r.keep("local")).toMatchObject({
      ok: false,
      code: "sync-merge-closed",
    });
  });

  it("a keep that conflicts again reopens, a refused one reopens with its code", async () => {
    const f = fakeMachine();
    const reg = new MergeRegistry({ machine: f.m });
    f.open.set("w:notes/a", request("a"));
    reg.feed([opened("a")]);
    const r = reg.conflicts()[0]!;
    const first = r.keep("local");
    f.open.get("w:notes/a")!.state = "open";
    reg.feed([opened("a")]);
    expect(await first).toEqual({
      ok: false,
      code: "conflict",
      reopened: true,
    });
    const second = r.keep({ value: "x" });
    const c = f.open.get("w:notes/a")!;
    c.state = "open";
    c.error = "value_invalid";
    reg.feed([{ type: "rejected", mutationId: 1, code: "value_invalid" }]);
    expect(await second).toEqual({
      ok: false,
      code: "value_invalid",
      reopened: true,
    });
    expect(r.error).toBe("value_invalid");
    expect(r.state).toBe("open");
  });

  it("a choice that is not offered is bad_request and sends nothing", async () => {
    const f = fakeMachine();
    const reg = new MergeRegistry({ machine: f.m });
    f.open.set("w:notes/a", request("a"));
    reg.feed([opened("a")]);
    expect(await reg.conflicts()[0]!.keep("both")).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    expect(f.kept).toEqual([]);
  });

  it("tells a request opening with no listener once", () => {
    const f = fakeMachine();
    let notices = 0;
    const reg = new MergeRegistry({ machine: f.m, notice: () => notices++ });
    f.open.set("w:notes/a", request("a"));
    f.open.set("w:notes/b", request("b"));
    reg.feed([opened("a"), opened("b")]);
    expect(notices).toBe(1);
  });
});
