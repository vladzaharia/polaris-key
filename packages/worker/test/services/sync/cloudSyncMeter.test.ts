/**
 * U-05.18: the per-operation meter. The object returns `{rowsRead, rowsWritten}` for a push, a
 * pull and an absorb (counts only), and the push and pull routes carry it, with the mutation
 * count and the wall time, in one `Server-Timing` header (`handlers/meter.ts`).
 */
import { describe, expect, it } from "vitest";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import type { Classification } from "../../../src/services/sync/engine/types.js";
import {
  callCloudSync,
  exportCloudSync,
} from "../../../src/services/sync/do/client.js";
import { OpTally } from "../../../src/services/sync/handlers/meter.js";
import {
  CloudSyncNamespaceMock,
  asCloudSyncNamespace,
} from "../../cloudSyncDoMock.js";

const P = "acme";
const T0 = 1_760_000_000_000;
const C1 = "c_000000000000000client1";
const LAST: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "lastWrite",
};

const env = () => ({
  CLOUD_SYNC: asCloudSyncNamespace(new CloudSyncNamespaceMock()),
});

const mutation = (id: number, key: string): SyncMutation => ({
  mutationId: id,
  target: { setting: key, scope: "user" },
  op: "set",
  value: id,
  editedHlc: formatHlc(T0 + id, 0),
});

const isCount = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;

describe("the object's meter", () => {
  it("is returned for a push, a pull and an absorb, as two counts", async () => {
    const e = env();
    const alice = { product: P, subject: "sub_alice" };
    const pushed = await callCloudSync<"push">(e, alice, {
      op: "push",
      deviceId: "d1",
      family: "desktop",
      limits: { quotaBytes: 1_000_000_000 },
      request: {
        clientId: C1,
        cursor: 0,
        mutations: [mutation(1, "a.one"), mutation(2, "a.two")],
      },
      classified: [LAST, LAST],
      serverNow: T0 + 3_600_000,
    });
    expect(Object.keys(pushed.meter ?? {}).sort()).toEqual([
      "rowsRead",
      "rowsWritten",
    ]);
    expect(pushed.meter?.rowsWritten).toBeGreaterThan(0);
    expect(isCount(pushed.meter?.rowsRead)).toBe(true);

    const pulled = await callCloudSync<"pull">(e, alice, {
      op: "pull",
      cursor: 0,
      deviceId: "d1",
      family: "desktop",
    });
    expect(pulled.meter?.rowsRead).toBeGreaterThan(0);
    expect(pulled.meter?.rowsWritten).toBe(0);

    const doc = await exportCloudSync(e, alice);
    const absorbed = await callCloudSync<"absorb">(
      e,
      { product: P, subject: "sub_bob" },
      { op: "absorb", document: doc! },
    );
    expect(absorbed.changed).toBeGreaterThan(0);
    expect(absorbed.meter?.rowsWritten).toBeGreaterThan(0);
    expect(isCount(absorbed.meter?.rowsRead)).toBe(true);
  });

  it("counts each operation alone: a repeated pull costs the same", async () => {
    const e = env();
    const pin = { product: P, subject: "sub_alice" };
    const pull = () =>
      callCloudSync<"pull">(e, pin, {
        op: "pull",
        cursor: 0,
        deviceId: "d1",
        family: "desktop",
      });
    const a = await pull();
    const b = await pull();
    expect(b.meter).toEqual(a.meter);
  });
});

describe("the Server-Timing header", () => {
  it("is counts and timings in a fixed form, with no identifier", () => {
    const t = new OpTally();
    t.mutations = 100;
    t.add({ rowsRead: 340, rowsWritten: 212 });
    t.add({ rowsRead: 10, rowsWritten: 0 });
    const h = t.header("push");
    expect(h).toMatch(
      /^sync;desc="push";dur=\d+\.\d, mut;desc="100", rr;desc="350", rw;desc="212"$/,
    );
    for (const id of ["sub_alice", "device", "acme", "@", "pkey"])
      expect(h).not.toContain(id);
  });

  it("is not set before the object was reached", () => {
    const res = new OpTally().stamp(new Response("x"), "pull");
    expect(res.headers.get("server-timing")).toBeNull();
  });
});
