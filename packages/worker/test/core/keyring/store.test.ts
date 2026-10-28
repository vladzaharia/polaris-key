/// <reference types="@cloudflare/workers-types" />
// The key ring store (U-36.1): ring and wrap rows, the `core.keyring` subject store, and the
// device lifecycle subscription. Fake values only: the store never opens them.
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { NOW } from "../../seed.js";
import { DEVICE, DEVICE_2, register, world } from "../devices/keysFixture.js";
import {
  addAdopted,
  createRing,
  deleteWrap,
  getRecovery,
  getRing,
  getWrap,
  keyringStore,
  purgeExpiredPrevious,
  putWrap,
  resetRing,
  stmtsDeleteProductKeyrings,
  setRecovery,
  PREVIOUS_RING_SECONDS,
  type WrapInput,
} from "../../../src/core/keyring/store.js";
import { subjectStoreNames } from "../../../src/core/accounts/subjectHooks.js";
import { setDeviceStatus } from "../../../src/core/devices/store.js";
import { writeDeviceSubject } from "../../../src/core/devices.js";
import { hasDeviceChangeListeners } from "../../../src/core/devices/lifecycle.js";

const P = "djdl";
const S = "sub-a";
const RING = "rg_AAAAAAAAAAAAAAAAAAAAAA";
const RING2 = "rg_BBBBBBBBBBBBBBBBBBBBBB";
const wrap = (deviceId: string, over: Partial<WrapInput> = {}): WrapInput => ({
  deviceId,
  ringId: RING,
  epoch: 1,
  kid: "k1",
  kem: "x25519",
  enc: "enc-" + deviceId,
  ct: "ct-" + deviceId,
  by: deviceId,
  ...over,
});
const create = (db = makeTestDb(), subject = S) =>
  createRing(db, {
    product: P,
    subject,
    ringId: RING,
    rootKid: "k1",
    wrap: wrap("d1"),
    recoveryCt: "rec",
    now: NOW,
  }).then((r) => ({ db, r }));
const count = async (db: ReturnType<typeof makeTestDb>, t: string) =>
  (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;

describe("ring and wraps", () => {
  it("creates a ring with its first wrap, once", async () => {
    const { db, r } = await create();
    expect(r).toBe("created");
    const ring = await getRing(db, P, S);
    expect(ring).toMatchObject({
      ringId: RING,
      epoch: 1,
      rootKid: "k1",
      recoverySet: true,
      previous: null,
      adopted: [],
    });
    expect(await getWrap(db, P, S, "d1")).toMatchObject({
      ct: "ct-d1",
      by: "d1",
    });
    const again = await createRing(db, {
      product: P,
      subject: S,
      ringId: RING2,
      rootKid: "k2",
      wrap: wrap("d2", { ringId: RING2 }),
      now: NOW + 1,
    });
    expect(again).toBe("conflict");
    expect((await getRing(db, P, S))!.ringId).toBe(RING);
    expect(await getWrap(db, P, S, "d2")).toBeNull();
    expect(await count(db, "keyring_wraps")).toBe(1);
  });

  it("wraps are create-only and need the ring", async () => {
    const { db } = await create();
    expect(await putWrap(db, P, S, wrap("d2"), NOW)).toBe("created");
    expect(await putWrap(db, P, S, wrap("d2", { ct: "other" }), NOW)).toBe(
      "exists",
    );
    expect((await getWrap(db, P, S, "d2"))!.ct).toBe("ct-d2");
    expect(await putWrap(db, P, S, wrap("d3", { epoch: 2 }), NOW)).toBe(
      "no_ring",
    );
    expect(await putWrap(db, P, "nobody", wrap("d3"), NOW)).toBe("no_ring");
    await deleteWrap(db, P, S, "d2");
    expect(await getWrap(db, P, S, "d2")).toBeNull();
  });

  it("recovery and adoption", async () => {
    const { db } = await create();
    expect(await getRecovery(db, P, S)).toEqual({
      ct: "rec",
      epoch: 1,
      kid: "k1",
    });
    expect(await setRecovery(db, P, S, "rec2", NOW + 5)).toBe(true);
    expect((await getRecovery(db, P, S))!.ct).toBe("rec2");
    expect(await setRecovery(db, P, "nobody", "x", NOW)).toBe(false);
    const a = { ringId: RING2, epoch: 1, kid: "k2", ct: "sealed" };
    expect(await addAdopted(db, P, S, a, NOW)).toBe(true);
    expect(await addAdopted(db, P, S, { ...a, ct: "again" }, NOW)).toBe(true);
    expect((await getRing(db, P, S))!.adopted).toEqual([a]);
    expect(await addAdopted(db, P, "nobody", a, NOW)).toBe(false);
  });

  it("a reset keeps the old ring as previous for 30 days, then forgets it", async () => {
    const { db } = await create();
    const reset = (expectedRingId: string) =>
      resetRing(db, {
        product: P,
        subject: S,
        expectedRingId,
        ringId: RING2,
        epoch: 2,
        rootKid: "k2",
        wrap: wrap("d1", { ringId: RING2, epoch: 2, kid: "k2" }),
        now: NOW + 10,
      });
    expect(await reset("rg_stale")).toBe("conflict");
    expect(await count(db, "keyring_wraps")).toBe(1);
    expect(await reset(RING)).toBe("reset");
    const ring = (await getRing(db, P, S))!;
    expect(ring).toMatchObject({
      ringId: RING2,
      epoch: 2,
      rootKid: "k2",
      recoverySet: false,
    });
    expect(ring.previous).toEqual({
      ringId: RING,
      kid: "k1",
      until: NOW + 10 + PREVIOUS_RING_SECONDS,
    });
    expect((await getWrap(db, P, S, "d1"))!.ringId).toBe(RING2);
    expect(await count(db, "keyring_wraps")).toBe(2);
    expect(await purgeExpiredPrevious(db, NOW + 11)).toBe(0);
    expect(
      await purgeExpiredPrevious(db, NOW + 10 + PREVIOUS_RING_SECONDS),
    ).toBe(1);
    expect((await getRing(db, P, S))!.previous).toBeNull();
    expect(await count(db, "keyring_wraps")).toBe(1);
  });
});

describe("core.keyring subject store", () => {
  const ctx = (db: ReturnType<typeof makeTestDb>) => ({
    db,
    env: {} as never,
    now: NOW,
  });

  it("is registered under core.keyring and claims its three tables", () => {
    expect(subjectStoreNames()).toContain("core.keyring");
    expect(keyringStore.tables).toEqual([
      "keyrings",
      "keyring_wraps",
      "keyring_adopted",
    ]);
  });

  it("merge moves a ring to a survivor that has none", async () => {
    const { db } = await create();
    await keyringStore.merge(ctx(db), { product: P, from: S, to: "sub-b" });
    expect(await getRing(db, P, S)).toBeNull();
    expect((await getRing(db, P, "sub-b"))!.ringId).toBe(RING);
    expect(await getWrap(db, P, "sub-b", "d1")).not.toBeNull();
    await keyringStore.merge(ctx(db), { product: P, from: S, to: "sub-b" });
    expect(await count(db, "keyrings")).toBe(1);
  });

  it("merge makes the absorbed ring an unsealed candidate when both have one", async () => {
    const { db } = await create();
    await createRing(db, {
      product: P,
      subject: "sub-b",
      ringId: RING2,
      rootKid: "k2",
      wrap: wrap("d2", { ringId: RING2, kid: "k2" }),
      now: NOW,
    });
    for (let i = 0; i < 2; i++)
      await keyringStore.merge(ctx(db), { product: P, from: S, to: "sub-b" });
    const ring = (await getRing(db, P, "sub-b"))!;
    expect(ring.ringId).toBe(RING2);
    expect(ring.adopted).toEqual([
      { ringId: RING, epoch: 1, kid: "k1", ct: null },
    ]);
    expect(await count(db, "keyrings")).toBe(1);
    // d1's wrap of the absorbed root moved with it; it is not the current ring's wrap.
    expect(await count(db, "keyring_wraps")).toBe(2);
    // A device that holds both roots seals the candidate.
    await addAdopted(
      db,
      P,
      "sub-b",
      { ringId: RING, epoch: 1, kid: "k1", ct: "sealed" },
      NOW,
    );
    expect((await getRing(db, P, "sub-b"))!.adopted[0]!.ct).toBe("sealed");
  });

  it("purges the wraps of an absorbed ring once the candidate is sealed, or after 30 days", async () => {
    const setup = async () => {
      const { db } = await create();
      await createRing(db, {
        product: P,
        subject: "sub-b",
        ringId: RING2,
        rootKid: "k2",
        wrap: wrap("d2", { ringId: RING2, kid: "k2" }),
        now: NOW,
      });
      await keyringStore.merge(ctx(db), { product: P, from: S, to: "sub-b" });
      return db;
    };
    // Unsealed and young: kept. The current ring's wrap is never touched.
    const young = await setup();
    await purgeExpiredPrevious(young, NOW + 10);
    expect(await count(young, "keyring_wraps")).toBe(2);
    // Past 30 days: the absorbed wrap goes, the current one stays.
    await purgeExpiredPrevious(young, NOW + PREVIOUS_RING_SECONDS + 1);
    expect(await count(young, "keyring_wraps")).toBe(1);
    expect(await getWrap(young, P, "sub-b", "d2")).not.toBeNull();
    // Sealed: the absorbed wrap goes at the next sweep.
    const sealed = await setup();
    await addAdopted(
      sealed,
      P,
      "sub-b",
      { ringId: RING, epoch: 1, kid: "k1", ct: "sealed" },
      NOW,
    );
    await purgeExpiredPrevious(sealed, NOW + 10);
    expect(await count(sealed, "keyring_wraps")).toBe(1);
  });

  it("delete removes every row, export lists metadata without sealed values", async () => {
    const { db } = await create();
    await addAdopted(
      db,
      P,
      S,
      { ringId: RING2, epoch: 1, kid: "k2", ct: "adopt-ct" },
      NOW,
    );
    const out = await keyringStore.export!(ctx(db), { product: P, subject: S });
    const json = JSON.stringify(out);
    expect(json).toContain(RING);
    for (const secret of ["ct-d1", "enc-d1", "rec", "adopt-ct"])
      expect(json).not.toContain(`"${secret}"`);
    expect(
      await keyringStore.size!(ctx(db), { product: P, subject: S }),
    ).toBeGreaterThan(0);
    await keyringStore.delete(ctx(db), { product: P, subject: S });
    for (const t of ["keyrings", "keyring_wraps", "keyring_adopted"])
      expect(await count(db, t)).toBe(0);
    expect(
      await keyringStore.export!(ctx(db), { product: P, subject: S }),
    ).toBeNull();
  });

  it("a product's deletion statements clear its rows only", async () => {
    const { db } = await create();
    await createRing(db, {
      product: "other",
      subject: S,
      ringId: RING,
      rootKid: "k1",
      wrap: wrap("d1"),
      now: NOW,
    });
    await db.batch(stmtsDeleteProductKeyrings(P));
    expect(await getRing(db, P, S)).toBeNull();
    expect(await getRing(db, "other", S)).not.toBeNull();
    expect(await count(db, "keyring_wraps")).toBe(1);
  });

  it("another subject's rows are left alone", async () => {
    const { db } = await create();
    await create(db, "sub-b");
    await keyringStore.delete(ctx(db), { product: P, subject: S });
    expect(await getRing(db, P, "sub-b")).not.toBeNull();
  });
});

describe("device lifecycle", () => {
  it("Core always listens", () => {
    expect(hasDeviceChangeListeners()).toBe(true);
  });

  async function seeded() {
    const w = await world();
    await register(w, DEVICE);
    await register(w, DEVICE_2);
    await createRing(w.db, {
      product: P,
      subject: S,
      ringId: RING,
      rootKid: "k1",
      wrap: wrap(DEVICE),
      now: NOW,
    });
    await putWrap(w.db, P, S, wrap(DEVICE_2), NOW);
    return w;
  }

  it("a deauthorized device loses its wraps, the others keep theirs", async () => {
    const w = await seeded();
    await setDeviceStatus(w.db, P, DEVICE, "deauthorized", { now: NOW });
    expect(await getWrap(w.db, P, S, DEVICE)).toBeNull();
    expect(await getWrap(w.db, P, S, DEVICE_2)).not.toBeNull();
  });

  it("an unbound device loses its wraps; a rebind to the same subject keeps them", async () => {
    const w = await seeded();
    await writeDeviceSubject(w.db, P, DEVICE_2, S);
    await writeDeviceSubject(w.db, P, DEVICE_2, S);
    expect(await getWrap(w.db, P, S, DEVICE_2)).not.toBeNull();
    await writeDeviceSubject(w.db, P, DEVICE_2, null);
    expect(await getWrap(w.db, P, S, DEVICE_2)).toBeNull();
    expect(await getWrap(w.db, P, S, DEVICE)).not.toBeNull();
  });

  it("a device bound to another subject loses the old subject's wraps", async () => {
    const w = await seeded();
    await writeDeviceSubject(w.db, P, DEVICE_2, "sub-z");
    expect(await getWrap(w.db, P, S, DEVICE_2)).toBeNull();
  });
});
