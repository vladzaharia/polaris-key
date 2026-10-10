/// <reference types="@cloudflare/workers-types" />
// A-14: the Operations snapshot's bindings in real workerd. What only this lane can show
// (notes/S-13 §10, the [U] the spike left open): `Queue.metrics()` answers on a PRODUCER-only
// binding, including one to a queue nothing consumes (the DLQ, `DELTA_DLQ`), and D1's
// `meta.size_after` is a real number through the binding. The Node lane covers the shape with
// fakes; this covers the runtime.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Db } from "../src/db/d1.js";
import { operationsSnapshot, queueStatus } from "../src/core/ops/operations.js";
import { writeHeartbeat } from "../src/core/ops/platformOps.js";
import { missingRequiredIndexes } from "../src/scheduled.js";

describe("operations bindings in workerd", () => {
  it("reads the dead-letter queue's backlog through a producer-only binding", async () => {
    const status = await queueStatus(env.DELTA_DLQ);
    expect(status.bound).toBe(true);
    expect(status.error).toBeUndefined();
    expect(status.ok).toBe(true);
    expect(typeof status.backlogCount).toBe("number");
    expect(typeof status.backlogBytes).toBe("number");
  });

  it("reads the lazy-delta queue's backlog through its producer binding", async () => {
    const status = await queueStatus(env.DELTA_QUEUE);
    expect(status.ok).toBe(true);
    expect(typeof status.backlogCount).toBe("number");
  });

  it("assembles the snapshot: probes answer and D1 reports its size", async () => {
    const db = new D1Db(env.DB);
    await writeHeartbeat(db, env, {
      script: "main",
      at: Math.floor(Date.now() / 1000),
      outcome: "maintenance:ok",
    });
    const snap = await operationsSnapshot(
      env,
      db,
      Math.floor(Date.now() / 1000),
      { missingIndexes: missingRequiredIndexes },
    );
    expect(snap.probes.d1.ok).toBe(true);
    expect(snap.probes.kv.ok).toBe(true);
    expect(snap.probes.r2.ok).toBe(true);
    expect(snap.storage.d1.sizeBytes).toBeGreaterThan(0);
    expect(snap.queues.deadLetter.ok).toBe(true);
    expect(snap.indexes.missing).toEqual([]);
    expect(snap.heartbeats?.map((h) => h.script)).toContain("main");
    expect(snap.storage.r2?.committedBytes).toBeGreaterThanOrEqual(0);
  });
});
