/// <reference types="@cloudflare/workers-types" />

// `contributes.onDeviceChange` (CC-03.3, R-7): the events a listener hears, that each follows its
// write, and that a listener which throws never fails the request.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW } from "../../seed.js";
import { body, DEVICE, newKeys, put, register, world } from "./keysFixture.js";
import { bindServiceRegistry, bound } from "../../../src/core/contributions.js";
import type { ServiceRegistry } from "../../../src/core/registry.js";
import type {
  DeviceChange,
  DeviceChangeListener,
} from "../../../src/core/devices/lifecycle.js";
import { writeDeviceSubject } from "../../../src/core/devices.js";
import { setDeviceStatus } from "../../../src/core/devices/store.js";
import { getDeviceKeys } from "../../../src/core/devices/keys.js";
import { registerDeviceKeys } from "../../../src/core/devices/registerKeys.js";
import type { Db, DbStatement } from "../../../src/db/types.js";

let saved: ServiceRegistry;
beforeEach(() => {
  saved = bound();
});
afterEach(() => bindServiceRegistry(saved));

function listen(
  ...listeners: Record<string, DeviceChangeListener>[]
): DeviceChange[] {
  const seen: DeviceChange[] = [];
  const recorder: DeviceChangeListener = async (_ctx, e) => {
    seen.push(e);
  };
  const slugs = ["identity", "sync", "config"] as const;
  const registry = new Map(saved);
  registry.set("identity", {
    contributes: { onDeviceChange: { recorder } },
  } as never);
  listeners.forEach((l, i) =>
    registry.set(slugs[i + 1]!, {
      contributes: { onDeviceChange: l },
    } as never),
  );
  bindServiceRegistry(registry);
  return seen;
}

describe("onDeviceChange", () => {
  it("a rotation whose guarded UPDATE matches no row reports unchanged and fires no `keys` event", async () => {
    const w = await world();
    const token = await register(w);
    const k1 = await newKeys();
    await put(w, token, await body(k1));
    const seen = listen();
    // Another writer rotates the key between this call's read and its write.
    const racing: Db = {
      ...w.db,
      first: w.db.first.bind(w.db),
      all: w.db.all.bind(w.db),
      run: w.db.run.bind(w.db),
      runChanges: w.db.runChanges.bind(w.db),
      batch: w.db.batch.bind(w.db),
      batchChanges: async (stmts: DbStatement[]) => {
        await w.db.run(
          "UPDATE device_keys SET sign_key = ? WHERE product = ? AND device_id = ?",
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "djdl",
          DEVICE,
        );
        return w.db.batchChanges!(stmts);
      },
    };
    const k2 = await newKeys();
    const r = await registerDeviceKeys(
      { db: racing, env: w.env, now: NOW + 1 },
      "djdl",
      DEVICE,
      { signKey: k2.signKey, agreeKey: k2.agreeKey },
    );
    expect(r.changed).toBe(false);
    expect(r.rotated).toBe(false);
    expect(seen).toEqual([]);
  });

  it("fires `keys` after a registration and a rotation, not for an unchanged re-send", async () => {
    const w = await world();
    const token = await register(w);
    const seen = listen();
    const k = await newKeys();
    await put(w, token, await body(k));
    await put(w, token, await body(k));
    await put(w, token, await body(await newKeys(), DEVICE, NOW + 1));
    expect(seen).toEqual([
      { product: "djdl", deviceId: DEVICE, kind: "keys", keySeq: 1 },
      { product: "djdl", deviceId: DEVICE, kind: "keys", keySeq: 2 },
    ]);
  });

  it("fires `bound` and `unbound` on a subject write, and nothing for a repeat", async () => {
    const w = await world();
    await register(w);
    const seen = listen();
    await writeDeviceSubject(w.db, "djdl", DEVICE, "sub-a");
    await writeDeviceSubject(w.db, "djdl", DEVICE, "sub-a");
    await writeDeviceSubject(w.db, "djdl", DEVICE, null);
    await writeDeviceSubject(w.db, "djdl", DEVICE, null);
    expect(seen.map((e) => [e.kind, e.subject])).toEqual([
      ["bound", "sub-a"],
      ["unbound", "sub-a"],
    ]);
  });

  it("fires `removed` once the deauthorize has dropped the keys", async () => {
    const w = await world();
    const token = await register(w);
    await put(w, token, await body(await newKeys()));
    const dropped: boolean[] = [];
    const seen = listen({
      check: async (ctx) => {
        dropped.push((await getDeviceKeys(ctx.db, "djdl", DEVICE)) === null);
      },
    });
    await setDeviceStatus(w.db, "djdl", DEVICE, "deauthorized");
    expect(seen.map((e) => e.kind)).toEqual(["removed"]);
    expect(dropped).toEqual([true]);
  });

  it("does not fire for a status other than deauthorized", async () => {
    const w = await world();
    await register(w);
    const seen = listen();
    await setDeviceStatus(w.db, "djdl", DEVICE, "authorized");
    expect(seen).toEqual([]);
  });

  it("never fails the request: a throwing listener is ignored and the others still run", async () => {
    const w = await world();
    const token = await register(w);
    const seen = listen({
      boom: async () => {
        throw new Error("listener failed");
      },
    });
    const r = await put(w, token, await body(await newKeys()));
    expect(r).toEqual({ status: 200, body: { keySeq: 1 } });
    await writeDeviceSubject(w.db, "djdl", DEVICE, "sub-a");
    await setDeviceStatus(w.db, "djdl", DEVICE, "deauthorized");
    expect(seen.map((e) => e.kind)).toEqual(["keys", "bound", "removed"]);
  });
});
