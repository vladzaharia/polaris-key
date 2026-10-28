/**
 * CC-06.3: the Connect ring's device-lifecycle listener (plans/CC-01-cloud-connect.md §1): every
 * event moves the affected rings at once, an unrelated subject is untouched, a leave keeps no
 * previous key, a merge forces a bump on the survivor, the audit row names no key, the relay-poke
 * port is told, and a failing listener never fails the write.
 */
import { releaseDormantSeats } from "../../../src/core/devices/store.js";
import type { Db } from "../../../src/db/types.js";
import { mergeAccounts } from "../../../src/services/identity/accounts/merge.js";
import { undoMerge } from "../../../src/services/identity/accounts/mergeUndo.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchWith } from "../../../src/dispatch.js";

import { NOW } from "../../seed.js";
import { newKeys } from "../../deviceKeyFixtures.js";

import {
  accountDeviceKeys,
  upsertDeviceKeys,
} from "../../../src/core/devices/keys.js";
import { writeDeviceSubject } from "../../../src/core/devices.js";
import { setDeviceStatus } from "../../../src/core/devices/store.js";
import { notifyDeviceChange } from "../../../src/core/devices/lifecycle.js";
import { registerDeviceKeys } from "../../../src/core/devices/registerKeys.js";
import { setRelayPokePort } from "../../../src/services/connect/relayPoke.js";
import { bumpRingNow } from "../../../src/services/connect/ringListener.js";
import { currentRing, getRing } from "../../../src/services/connect/ring.js";

async function ringOf(w: World, subject = w.subject) {
  return getRing(w.db, SLUG, subject);
}

/** Create the ring (the first read), as a device's identity fetch does. */
async function seedRing(w: World, subject = w.subject): Promise<void> {
  await currentRing(
    w.db,
    SLUG,
    subject,
    () => accountDeviceKeys(w.db, SLUG, subject, { seatsHeld: true, now: NOW }),
    NOW,
  );
}

async function bumpAudits(w: World) {
  return w.db.all<Record<string, unknown>>(
    "SELECT * FROM audit WHERE product = ? AND action = 'connect.ring.bump' ORDER BY at, id",
    SLUG,
  );
}

import {
  SLUG,
  BASE,
  A,
  B,
  C,
  type World,
  enable,
  activate,
  bindTo,
  world,
} from "./connectFixture.js";

describe("connect ring listener (CC-06.3)", () => {
  let w: World;
  const pokes: { subject: string; epoch: number }[] = [];
  beforeEach(async () => {
    w = await world();
    pokes.length = 0;
    setRelayPokePort(async (p) => {
      pokes.push({ subject: p.subject, epoch: p.epoch });
    });
    await seedRing(w);
  });
  afterEach(() => setRelayPokePort(null));

  it("a removed device bumps the ring at once and keeps no previous key", async () => {
    const before = (await ringOf(w))!;
    await setDeviceStatus(w.db, SLUG, B, "deauthorized");
    const after = (await ringOf(w))!;
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.disc_key).not.toBe(before.disc_key);
    expect(after.prev_disc_key).toBeNull();
    expect(after.member_ids).toBe(A);
    expect(pokes).toEqual([{ subject: w.subject, epoch: after.epoch }]);
  });

  it("an unbound device bumps the ring and keeps no previous key", async () => {
    const before = (await ringOf(w))!;
    await writeDeviceSubject(w.db, SLUG, B, null);
    const after = (await ringOf(w))!;
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.prev_disc_key).toBeNull();
  });

  it("a device bound to another subject leaves the old ring and joins the new one", async () => {
    // C belongs to a second person, with a ring of its own.
    w.tokens[C] = await activate(w, w.key, C);
    const grace = await bindTo(w, C, "grace@example.com");
    await upsertDeviceKeys(w.db, SLUG, C, await newKeys(), NOW);
    await seedRing(w, grace);
    const ada = (await ringOf(w))!;
    const gr = (await ringOf(w, grace))!;
    await writeDeviceSubject(w.db, SLUG, C, w.subject);
    const adaAfter = (await ringOf(w))!;
    const grAfter = (await ringOf(w, grace))!;
    // Joining: the epoch moves and the previous key is kept.
    expect(adaAfter.epoch).toBe(ada.epoch + 1);
    expect(adaAfter.member_ids).toBe([A, B, C].join("\n"));
    expect(adaAfter.prev_disc_key).toBe(ada.disc_key);
    // Leaving: the epoch moves and no previous key is kept.
    expect(grAfter.epoch).toBe(gr.epoch + 1);
    expect(grAfter.member_ids).toBe("");
    expect(grAfter.prev_disc_key).toBeNull();
  });

  it("a key rotation bumps the ring and keeps no previous key", async () => {
    const before = (await ringOf(w))!;
    await upsertDeviceKeys(w.db, SLUG, B, await newKeys(), NOW + 1);
    await notifyDeviceChange(
      { db: w.db, env: w.env, now: NOW + 1 },
      { product: SLUG, deviceId: B, kind: "keys", keySeq: 2 },
    );
    const after = (await ringOf(w))!;
    expect(after.epoch).toBe(before.epoch + 1);
    // A rotation is treated as a leave: no previous key.
    expect(after.prev_disc_key).toBeNull();
    expect(pokes).toHaveLength(1);
  });

  it("registering a rotation through the Core operation bumps the ring, and the same keys again do not (I-13.9)", async () => {
    const before = (await ringOf(w))!;
    const keys = await newKeys();
    const ctx = { db: w.db, env: w.env, now: NOW + 1 };
    await registerDeviceKeys(ctx, SLUG, B, keys);
    const after = (await ringOf(w))!;
    expect(after.epoch).toBe(before.epoch + 1);
    expect(pokes).toHaveLength(1);
    await registerDeviceKeys(ctx, SLUG, B, keys);
    expect((await ringOf(w))!.epoch).toBe(after.epoch);
  });

  it("an event for a device with no change in the members moves nothing", async () => {
    const before = (await ringOf(w))!;
    await notifyDeviceChange(
      { db: w.db, env: w.env, now: NOW },
      { product: SLUG, deviceId: A, kind: "keys", keySeq: 1 },
    );
    expect(await ringOf(w)).toEqual(before);
    expect(pokes).toEqual([]);
    expect(await bumpAudits(w)).toEqual([]);
  });

  it("leaves an unrelated subject's ring untouched", async () => {
    await w.db.run(
      `INSERT INTO connect_rings (product, subject, epoch, members_hash, member_ids, disc_key, prev_disc_key, prev_epoch, bumped_at)
       VALUES (?, 'other-subject', 4, 'h', 'ZZZZ', 'k', NULL, NULL, 1)`,
      SLUG,
    );
    const other = (await ringOf(w, "other-subject"))!;
    await setDeviceStatus(w.db, SLUG, B, "deauthorized");
    expect(await ringOf(w, "other-subject")).toEqual(other);
  });

  it("does nothing when the product has Connect off, and creates no ring", async () => {
    await enable(w.db, ["license", "identity"]);
    const before = (await ringOf(w))!;
    await setDeviceStatus(w.db, SLUG, B, "deauthorized");
    expect(await ringOf(w)).toEqual(before);
    expect(await bumpRingNow(w.db, SLUG, "nobody", NOW, "keys")).toBe(false);
    expect(await ringOf(w, "nobody")).toBeNull();
  });

  it("writes one audit row per bump with the reason and the epoch, and no key", async () => {
    const before = (await ringOf(w))!;
    await setDeviceStatus(w.db, SLUG, B, "deauthorized");
    const after = (await ringOf(w))!;
    const rows = await bumpAudits(w);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      action: "connect.ring.bump",
      target_kind: "connectRing",
      reason: "removed",
    });
    expect(JSON.parse(row.after_json as string)).toEqual({
      epoch: after.epoch,
      left: true,
    });
    const text = JSON.stringify(row);
    for (const secret of [before.disc_key, after.disc_key, before.members_hash])
      expect(text).not.toContain(secret);
  });

  it("a read that finds a change is the backstop, audited as a read", async () => {
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = ?",
      SLUG,
      B,
    );
    const before = (await ringOf(w))!;
    const res = await dispatchWith(
      new Request(`${BASE}/${SLUG}/connect/identity`, {
        headers: {
          authorization: `Bearer ${w.tokens[A]}`,
          "x-pkey-device": A,
        },
      }) as unknown as Request,
      w.env,
      w.db,
      NOW + 5,
    );
    expect(res.status).toBe(200);
    const after = (await ringOf(w))!;
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.prev_disc_key).toBeNull();
    expect((await bumpAudits(w)).map((r) => r.reason)).toEqual(["read"]);
    // The read-time path tells the relay too.
    expect(pokes).toEqual([{ subject: w.subject, epoch: after.epoch }]);
  });

  it("a failing relay port, or a failing audit, never fails the write", async () => {
    setRelayPokePort(async () => {
      throw new Error("relay down");
    });
    await expect(
      setDeviceStatus(w.db, SLUG, B, "deauthorized"),
    ).resolves.not.toThrow();
    expect((await ringOf(w))!.member_ids).toBe(A);
  });

  it("a dormant seat released by the sweep leaves the roster at once", async () => {
    const before = (await ringOf(w))!;
    await w.db.run(
      "UPDATE devices SET last_seen = 1 WHERE product = ? AND device_id = ?",
      SLUG,
      B,
    );
    expect(await releaseDormantSeats(w.db, SLUG, NOW)).toBe(1);
    const after = (await ringOf(w))!;
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.member_ids).toBe(A);
    expect(after.prev_disc_key).toBeNull();
  });

  it("a failure to move a ring is audited as bump_failed, with no key", async () => {
    const before = (await ringOf(w))!;
    const broken = Object.create(w.db) as Db;
    broken.all = async (sql, ...params) => {
      if (sql.includes("FROM device_keys")) throw new Error("boom");
      return w.db.all(sql, ...params);
    };
    await notifyDeviceChange(
      { db: broken, env: w.env, now: NOW },
      { product: SLUG, deviceId: A, kind: "removed", subject: w.subject },
    );
    const rows = await w.db.all<Record<string, unknown>>(
      "SELECT * FROM audit WHERE action = 'connect.ring.bump_failed'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "removed", target_id: w.subject });
    expect(JSON.stringify(rows[0])).not.toContain(before.disc_key);
  });
});

describe("the keyring listener on the `bound` event a merge sends (CC-06.3)", () => {
  it("keeps the wraps of the new subject and drops those of another", async () => {
    const w = await world();
    const wrap = (subject: string) =>
      w.db.run(
        `INSERT INTO keyring_wraps
           (product, subject, device_id, ring_id, epoch, kid, kem, enc, ct, by_device, created_at)
         VALUES (?, ?, ?, 'r', 1, 'k', 'kem', 'enc', 'ct', ?, ?)`,
        SLUG,
        subject,
        A,
        B,
        NOW,
      );
    await wrap(w.subject);
    await wrap("someone-else");
    await notifyDeviceChange(
      { db: w.db, env: w.env, now: NOW },
      { product: SLUG, deviceId: A, kind: "bound", subject: w.subject },
    );
    const left = await w.db.all<{ subject: string }>(
      "SELECT subject FROM keyring_wraps WHERE product = ? AND device_id = ?",
      SLUG,
      A,
    );
    expect(left.map((r) => r.subject)).toEqual([w.subject]);
  });
});

describe("connect ring through the real account merge (CC-06.3)", () => {
  /** The account behind a subject (the sign-in that `bindTo` made created it). */
  const accountOf = async (w: World, subject: string) => ({
    id: (await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM account_product_subjects WHERE product = ? AND subject = ?",
      SLUG,
      subject,
    ))!.account_id,
    subject,
  });

  it("moves the survivor's roster after the merge batch, and again on undo", async () => {
    const w = await world();
    const ada = await accountOf(w, w.subject);
    // Device C belongs to a second person, with a ring of its own.
    w.tokens[C] = await activate(w, w.key, C);
    const bob = await accountOf(w, await bindTo(w, C, "bob@example.com"));
    await upsertDeviceKeys(w.db, SLUG, C, await newKeys(), NOW);
    await seedRing(w);
    await seedRing(w, bob.subject);
    const before = (await ringOf(w))!;
    const ctx = {
      db: w.db,
      env: w.env,
      now: NOW,
      origin: "https://key.plrs.im",
    };
    const merged = await mergeAccounts(ctx, {
      survivor: { accountId: ada.id, authenticatedAt: NOW },
      absorbed: { accountId: bob.id, authenticatedAt: NOW },
    });
    if (!merged.ok) throw new Error(merged.reason);
    const joined = (await ringOf(w))!;
    expect(joined.epoch).toBe(before.epoch + 1);
    expect(joined.member_ids).toBe([A, B, C].join("\n"));
    expect(joined.prev_disc_key).toBe(before.disc_key);
    expect(await ringOf(w, bob.subject)).toBeNull();

    const undone = await undoMerge(
      ctx,
      { accountId: ada.id, authenticatedAt: NOW },
      merged.mergeId,
    );
    expect(undone).toMatchObject({ ok: true });
    const left = (await ringOf(w))!;
    expect(left.epoch).toBeGreaterThan(joined.epoch);
    expect(left.member_ids).toBe([A, B].join("\n"));
    expect(left.prev_disc_key).toBeNull();
  });
});
