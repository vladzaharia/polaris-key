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
import {
  isPlayRefusal,
  PlayEditSession,
  type PlayStoreContext,
} from "../src/services/distribution/connectors/play/storefront.js";
import { buildHooks } from "../src/core/hooks.js";
import { loadProductPublic } from "../src/core/products.js";
import { SERVICES } from "../src/mount.js";
import { makeTestDb } from "./helpers.js";
import {
  admin,
  playWorld,
  poll,
  NOW,
  PLAY_PACKAGE,
  SLUG,
} from "./playWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const PKG = "gg.acme.djdl";
/** The lease reads the wall clock itself (no caller `now`): tests move it. */
const at = (t: number) => vi.setSystemTime(t * 1000);

describe("the lease itself", () => {
  it("one holder at a time; a second caller is told who holds it and until when", async () => {
    const db = makeTestDb();
    const a = await acquirePlayEditLease(db, {
      packageName: PKG,
      purpose: "provisioning",
      actor: "admin:u1",
    });
    expect(isLeaseHeld(a)).toBe(false);
    at(NOW + 1);
    const b = await acquirePlayEditLease(db, {
      packageName: PKG,
      purpose: "poll",
      actor: "connector:play",
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
    })) as PlayEditLease;
    at(NOW + 120);
    const next = await acquirePlayEditLease(db, {
      packageName: PKG,
      purpose: "provisioning",
      actor: "admin:u1",
    });
    expect(isLeaseHeld(next)).toBe(false);
    at(NOW + 121);
    expect(await renewPlayEditLease(db, old)).toBe(false);
    await releasePlayEditLease(db, old);
    expect(await readPlayEditLease(db, PKG)).toEqual({
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
    })) as PlayEditLease;
    at(NOW + 500);
    expect(await renewPlayEditLease(db, l)).toBe(true);
    expect(l.expiresAt).toBe(NOW + 1100);
    await releasePlayEditLease(db, l);
    at(NOW + 501);
    expect(await readPlayEditLease(db, PKG)).toBeNull();
    await expect(
      withPlayEditLease(
        db,
        { packageName: PKG, purpose: "import", actor: "admin:u1" },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(await readPlayEditLease(db, PKG)).toBeNull();
  });

  it("refuses an actor that is not a caller kind and id", async () => {
    await expect(
      acquirePlayEditLease(makeTestDb(), {
        packageName: PKG,
        purpose: "poll",
        actor: "nobody",
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
    expect(await readPlayEditLease(w.db, PLAY_PACKAGE)).toBeNull();
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
  it("a poll tick that starts long after its cron fired still holds the lease against the wall clock", async () => {
    // The cron computes one `now` and reuses it for every product and connector, so a later
    // product's Play tick can start minutes after it. Before the fix the poll's lease expired at
    // cronNow + 120, already past by the wall clock, and provisioning took it over mid-tick.
    const w = await playWorld();
    const product = (await loadProductPublic(w.db, SLUG))!;
    const ctx: PlayStoreContext = {
      env: w.env,
      db: w.db,
      product: SLUG,
      hooks: buildHooks(SERVICES, product.services, {
        env: w.env,
        db: w.db,
        product,
        now: NOW,
      }),
      session: {
        sub: "u1",
        name: "Ada",
        email: "ada@example.test",
        groups: ["platform-admins"],
        csrf: "c",
        exp: NOW + 3600,
      },
      now: NOW,
      fetchImpl: w.fetchImpl,
      clock: () => NOW,
    };
    const cronNow = NOW - 300;
    const inner = w.fetchImpl;
    let midTick: Awaited<ReturnType<typeof PlayEditSession.begin>> | null =
      null;
    let pollEditOpen = false;
    let tried = false;
    w.fetchImpl = async (input, init) => {
      const res = await inner(input, init);
      // Right after the poll's edit opens: provisioning tries to begin.
      if (
        !tried &&
        init?.method === "POST" &&
        new URL(input).pathname.endsWith("/edits")
      ) {
        tried = true;
        pollEditOpen = w.fake.openEdits().length === 1;
        midTick = await PlayEditSession.begin(ctx, "provisioning");
      }
      return res;
    };
    const report = await poll(w, cronNow);
    expect(report.failures).toEqual({});
    expect(pollEditOpen).toBe(true);
    expect(midTick).toMatchObject({
      ok: false,
      status: 409,
      reason: "edit_lease_held",
    });
    // The poll released its lease; provisioning now begins.
    w.fetchImpl = inner;
    const after = await PlayEditSession.begin(ctx, "provisioning");
    if (isPlayRefusal(after)) throw new Error(after.message);
    await after.close();
  });
  it("the vitals auto-halt renews the poll's lease first and halts nothing once it was lost", async () => {
    const w = await playWorld();
    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/play/settings",
      {
        vitals: { enabled: true },
      },
    );
    expect(res.status).toBe(200);
    const inner = w.fetchImpl;
    let stolen = false;
    w.fetchImpl = async (input, init) => {
      const r = await inner(input, init);
      // After the last Reporting read, before the halt: the poll's lease expires and another
      // caller takes it (a tick slowed by back-off past its TTL).
      if (
        !stolen &&
        new URL(input).pathname.endsWith("anrRateMetricSet:query")
      ) {
        stolen = true;
        await w.db.run(
          "UPDATE store_edit_leases SET expires_at = ? WHERE app = ?",
          NOW,
          PLAY_PACKAGE,
        );
        expect(
          isLeaseHeld(
            await acquirePlayEditLease(w.db, {
              packageName: PLAY_PACKAGE,
              purpose: "provisioning",
              actor: "admin:u1",
            }),
          ),
        ).toBe(false);
      }
      return r;
    };
    const report = await poll(w);
    expect(stolen).toBe(true);
    expect(JSON.stringify(report)).toContain("edit lease was lost");
    // No halt was opened or committed over the new holder's edit, and its lease is intact.
    expect(w.fake.requests.filter((r) => r.method === "PATCH")).toEqual([]);
    expect(await readPlayEditLease(w.db, PLAY_PACKAGE)).toMatchObject({
      purpose: "provisioning",
    });
  });
});
