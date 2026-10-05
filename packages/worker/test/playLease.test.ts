/**
 * A-18e — the Play edit lease (`connectors/play/lease.ts`; notes/S-15 §5.3): atomic acquisition,
 * expiry, holder-only renew and release, and every Play caller that opens an edit taking it — the
 * poll skips its tick, a console control answers 409, A-16's lister marks the app busy — before
 * any token is minted or edit opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquirePlayEditLease,
  isLeaseHeld,
  readPlayEditLease,
  releasePlayEditLease,
  renewPlayEditLease,
  withPlayEditLease,
  type PlayEditLease,
} from "../src/services/distribution/connectors/play/lease.js";
import { makeTestDb } from "./helpers.js";
import { admin, playWorld, poll, NOW, PLAY_PACKAGE } from "./playWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const PKG = "gg.acme.djdl";

describe("the lease itself", () => {
  it("one holder at a time; a second caller is told who holds it and until when", async () => {
    const db = makeTestDb();
    const a = await acquirePlayEditLease(db, {
      packageName: PKG,
      purpose: "provisioning",
      actor: "admin:u1",
      now: NOW,
    });
    expect(isLeaseHeld(a)).toBe(false);
    const b = await acquirePlayEditLease(db, {
      packageName: PKG,
      purpose: "poll",
      actor: "connector:play",
      now: NOW + 1,
    });
    expect(b).toEqual({
      held: true,
      purpose: "provisioning",
      expiresAt: NOW + 600,
    });
    // Another package is another lease.
    const other = await acquirePlayEditLease(db, {
      packageName: "gg.acme.other",
      purpose: "poll",
      actor: "connector:play",
      now: NOW + 1,
    });
    expect(isLeaseHeld(other)).toBe(false);
  });

  it("concurrent acquisitions: exactly one wins", async () => {
    const db = makeTestDb();
    const all = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        acquirePlayEditLease(db, {
          packageName: PKG,
          purpose: i % 2 ? "poll" : "control",
          actor: "connector:play",
          now: NOW,
        }),
      ),
    );
    expect(all.filter((l) => !isLeaseHeld(l))).toHaveLength(1);
  });

  it("an expired lease is free; the old holder can neither renew nor release the new one", async () => {
    const db = makeTestDb();
    const old = (await acquirePlayEditLease(db, {
      packageName: PKG,
      purpose: "poll",
      actor: "connector:play",
      now: NOW,
    })) as PlayEditLease;
    const next = await acquirePlayEditLease(db, {
      packageName: PKG,
      purpose: "provisioning",
      actor: "admin:u1",
      now: NOW + 120,
    });
    expect(isLeaseHeld(next)).toBe(false);
    expect(await renewPlayEditLease(db, old, NOW + 121)).toBe(false);
    await releasePlayEditLease(db, old);
    expect(await readPlayEditLease(db, PKG, NOW + 121)).toEqual({
      purpose: "provisioning",
      expiresAt: NOW + 720,
    });
  });

  it("the holder renews before expiry and releases; withPlayEditLease releases on a throw", async () => {
    const db = makeTestDb();
    const l = (await acquirePlayEditLease(db, {
      packageName: PKG,
      purpose: "provisioning",
      actor: "admin:u1",
      now: NOW,
    })) as PlayEditLease;
    expect(await renewPlayEditLease(db, l, NOW + 500)).toBe(true);
    expect(l.expiresAt).toBe(NOW + 1100);
    await releasePlayEditLease(db, l);
    expect(await readPlayEditLease(db, PKG, NOW + 501)).toBeNull();
    await expect(
      withPlayEditLease(
        db,
        { packageName: PKG, purpose: "import", actor: "admin:u1", now: NOW },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(await readPlayEditLease(db, PKG, NOW)).toBeNull();
  });

  it("refuses an actor that is not a caller kind and id", async () => {
    await expect(
      acquirePlayEditLease(makeTestDb(), {
        packageName: PKG,
        purpose: "poll",
        actor: "nobody",
        now: NOW,
      }),
    ).rejects.toThrow(/actor/);
  });
});

describe("every Play caller takes it", () => {
  async function holdProvisioning(w: Awaited<ReturnType<typeof playWorld>>) {
    return (await acquirePlayEditLease(w.db, {
      packageName: PLAY_PACKAGE,
      purpose: "provisioning",
      actor: "admin:u1",
      now: NOW,
    })) as PlayEditLease;
  }

  it("the poll skips its tick while provisioning holds the lease: no token, no edit", async () => {
    const w = await playWorld();
    await holdProvisioning(w);
    const report = await poll(w);
    expect(report.failures).toEqual({});
    expect(w.fake.requests).toEqual([]);
    expect(w.fake.tokenRequests).toEqual([]);
  });

  it("the poll releases its own lease, so the next caller is not blocked", async () => {
    const w = await playWorld();
    await poll(w);
    expect(await readPlayEditLease(w.db, PLAY_PACKAGE, NOW)).toBeNull();
  });

  it("a console control answers 409 edit_lease_held before any token or edit", async () => {
    const w = await playWorld();
    await holdProvisioning(w);
    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/play/rollout/halt",
      { track: "production", versionCode: "111" },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "edit_lease_held",
    );
    expect(w.fake.requests).toEqual([]);
    expect(w.fake.tokenRequests).toEqual([]);
  });
});
