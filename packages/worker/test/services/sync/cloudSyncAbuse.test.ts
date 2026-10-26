/**
 * Abuse tests for Cloud Sync through the real dispatch pipeline and the real object: each asserts
 * a bound that must hold (stored rows, bindings, the users ceiling, the purge window, the pull
 * limit, an erased object).
 */
import { describe, expect, it } from "vitest";
import {
  authed,
  clear,
  count,
  pull,
  push,
  send,
  set,
  SLUG,
  world,
  nextId,
  type World,
} from "./cloudSyncAbuseWorld.js";
import { syncProductPurge } from "../../../src/services/sync/productDeletion.js";
import { productIsPurging } from "../../../src/services/sync/purgeFlag.js";
import { deleteProduct } from "../../../src/core/products/store.js";
import { NOW } from "../../seed.js";
import {
  deleteCloudSync,
  callCloudSync,
} from "../../../src/services/sync/do/client.js";
import { SYNC_MAX_SETTINGS } from "@polaris-key/protocol/sync";

describe("tombstones on open keys are unbounded and free (T6)", () => {
  it("a device cannot park more tombstone rows than the settings budget", async () => {
    const w = await world();
    for (let b = 0; b < 4; b++) {
      const res = await push(
        w,
        Array.from({ length: 100 }, (_, i) => clear(`junk.${b}.${i}`)),
      );
      expect(res.status).toBe(200);
    }
    // 400 uncounted rows after four requests; at 60 pushes a minute this is 6,000 rows a minute,
    // kept 90 days, and every one is replayed by a pull and loaded whole by export and merge.
    expect(count(w, "tombstones")).toBeLessThanOrEqual(SYNC_MAX_SETTINGS);
  });
});

describe("client bindings are unbounded and free (T6)", () => {
  it("fresh clientIds with empty batches do not each add a row", async () => {
    const w = await world();
    const ids = Array.from(
      { length: 30 },
      (_, i) => `c_${String(i).padStart(22, "A")}`,
    );
    for (const id of ids) {
      const res = await push(w, [], id);
      expect(res.status).toBe(200);
    }
    expect(count(w, "clients")).toBeLessThanOrEqual(16);
  });
});

describe("the users ceiling is bypassed by a first clear (T6)", () => {
  async function atUsersCeiling(w: World) {
    await w.db.run(
      `INSERT INTO sync_product_usage
         (product, bytes, users, settings_bytes, record_bytes, file_bytes, revision_bytes, breakdown_json, computed_at)
       VALUES (?, 0, 100000, 0, 0, 0, 0, '{}', ?)`,
      SLUG,
      NOW,
    );
  }
  it("a new person at the ceiling still cannot grow after a clear-only push", async () => {
    const w = await world();
    await atUsersCeiling(w);
    // Control: the first write is refused.
    const first = await push(w, [set("a.b", 1)]);
    const r1 = ((await first.json()) as { results: { status: string }[] })
      .results;
    expect(r1[0]?.status).toBe("rejected");
    // A clear (never refused) leaves a tombstone, so the object is no longer `isEmpty()`.
    expect((await push(w, [clear("x.y")])).status).toBe(200);
    const again = await push(w, [set("a.b", 1)]);
    const r2 = ((await again.json()) as { results: { status: string }[] })
      .results;
    expect(r2[0]?.status).toBe("rejected");
  });
});

describe("a push after the purge reports done, before the product row flips (T17)", () => {
  it("is refused, so no object outlives the product's directory rows", async () => {
    const w = await world();
    expect((await push(w, [set("a.b", 1)])).status).toBe(200);
    const done = await syncProductPurge({
      db: w.db,
      env: w.env,
      product: SLUG,
      now: NOW,
    });
    expect(done.done).toBe(true);
    // The console now deletes the per-device tokens and only then calls deleteProduct. The flag
    // outlives the purge's last run, and the product is still live.
    expect(await productIsPurging(w.env, SLUG)).toBe(true);
    const rowsOf = () => {
      const inst = w.ns.instances.get(`${SLUG}:${w.subject}`);
      return inst
        ? (
            inst.storage.sql.db
              .prepare("SELECT COUNT(*) AS n FROM settings")
              .get() as { n: number }
          ).n
        : 0;
    };
    const before = rowsOf();
    const late = await push(w, [set("c.d", 2)]);
    expect(late.status).toBe(404);
    await deleteProduct(w.db, SLUG, NOW);
    // The refused push built nothing.
    expect(rowsOf()).toBe(before);
  });
});

describe("the pull has no rate limit (T6)", () => {
  it("answers 429 to a device that pulls hundreds of times in a minute", async () => {
    const w = await world();
    let limited = 0;
    for (let i = 0; i < 300; i++) {
      const res = await pull(w);
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("an erased person's object can be rebuilt by an in-flight push (T3/T8)", () => {
  it("refuses a push to an object that was erased for an account deletion", async () => {
    const w = await world();
    expect((await push(w, [set("a.b", 1)])).status).toBe(200);
    const pin = { product: SLUG, subject: w.subject };
    await deleteCloudSync(w.env, pin);
    // A request that resolved the principal before the erasure now reaches the object.
    let recreated = false;
    try {
      await callCloudSync<"push">(w.env, pin, {
        op: "push",
        deviceId: "dev-attack-1",
        family: "desktop",
        limits: { quotaBytes: 1 << 20 },
        request: {
          clientId: "c_AAAAAAAAAAAAAAAAAAAAAA",
          cursor: 0,
          mutations: [
            {
              mutationId: nextId() + 1000,
              target: { setting: "a.b", scope: "user" },
              op: "set",
              value: 1,
              editedHlc: "000000000001:0000",
            },
          ],
        },
        classified: [{ verdict: "accept", scope: "user", policy: "lastWrite" }],
        serverNow: NOW * 1000,
      });
      recreated = true;
    } catch {
      recreated = false;
    }
    expect(recreated).toBe(false);
  });
});

void send;
void authed;
