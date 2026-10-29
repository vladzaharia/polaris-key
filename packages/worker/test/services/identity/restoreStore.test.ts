/**
 * I-49.4: the silent-restore key store (plans/I-49-slices.md D-1..D-3, D-9). It holds the rules the
 * store owns: keyed lookup and consume (id AND product AND secret hash), use-once, no oracle, no
 * timing leak on a missing row, "current" for the calling device only and under 90 days, the cap of
 * 10, every revocation path regardless of the gate, the origin rule, the operator purge, the
 * 180-day sweep and the subject store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchWith } from "../../../src/dispatch.js";
import {
  notifyDeviceChange,
  type DeviceChangeKind,
} from "../../../src/core/devices/lifecycle.js";
import { setDeviceStatus } from "../../../src/core/devices/store.js";
import { writeDeviceSubject } from "../../../src/core/devices.js";
import {
  runSubjectDelete,
  runSubjectExport,
  runSubjectMerge,
  subjectStoreNames,
} from "../../../src/core/accounts/subjectHooks.js";
import { productDeletionStatements } from "../../../src/core/contributions.js";
import {
  RESTORE_CURRENT_SECONDS,
  RESTORE_IDLE_SECONDS,
  RESTORE_KEY_CAP,
  RESTORE_ORIGIN_SECONDS,
  checkRestoreKey,
  consumeRestoreKey,
  markRestoreOrigin,
  mintRestoreKey,
  purgeProductRestore,
  revokeDeviceRestore,
  revokeSubjectRestore,
  sweepRestoreKeys,
} from "../../../src/services/identity/restore/store.js";
import { NOW, seedProduct } from "../../seed.js";
import {
  A,
  B,
  BASE,
  C,
  SLUG,
  enable,
  ensureBoundDevice,
  world,
  type World,
} from "../connect/connectFixture.js";

const OTHER_PRODUCT = "other";
const SUBJECT_X = "ps_xxxxxxxxxxxxxxxxxxxxxx";

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(() => vi.restoreAllMocks());

const count = async (table = "identity_restore_keys", where = "1 = 1") =>
  (await w.db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
  ))!.n;

async function mint(
  device: string,
  opts: {
    subject?: string;
    boundSubject?: string;
    now?: number;
    product?: string;
  } = {},
) {
  const product = opts.product ?? SLUG;
  const subject = opts.subject ?? w.subject;
  if (!(await w.db.first("SELECT 1 FROM products WHERE slug = ?", product)))
    await seedProduct(w.db, product);
  // The device is signed in as the key's subject unless a test says otherwise.
  const bound = await ensureBoundDevice(w.db, product, device, subject);
  return (await mintRestoreKey(w.env, w.db, {
    product,
    deviceId: device,
    subject,
    boundSubject: opts.boundSubject ?? bound,
    now: opts.now ?? NOW,
  }))!;
}

const redeem = (
  restoreId: string,
  secret: string,
  opts: { now?: number; product?: string } = {},
) =>
  consumeRestoreKey(w.env, w.db, {
    product: opts.product ?? SLUG,
    restoreId,
    secret,
    now: opts.now ?? NOW,
  });

const event = (kind: DeviceChangeKind, deviceId: string, subject?: string) =>
  notifyDeviceChange(
    { db: w.db, env: w.env, now: NOW },
    { product: SLUG, deviceId, kind, ...(subject ? { subject } : {}) },
  );

describe("mint", () => {
  it("returns an id and a secret of the wire shapes, and stores only a hash", async () => {
    const { restoreId, secret } = await mint(A);
    expect(restoreId).toMatch(/^rk_[A-Za-z0-9_-]{22}$/);
    expect(secret).toMatch(/^rs_[A-Za-z0-9_-]{43}$/);
    const row = await w.db.first<Record<string, unknown>>(
      "SELECT * FROM identity_restore_keys",
    );
    expect(row).toMatchObject({
      id: restoreId,
      product: SLUG,
      device_id: A,
      subject: w.subject,
      created_at: NOW,
      checked_at: NOW,
    });
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints nothing for a device that is unbound, deauthorized, bound to another subject or unknown", async () => {
    const attempt = (device: string, boundSubject: string) =>
      mintRestoreKey(w.env, w.db, {
        product: SLUG,
        deviceId: device,
        subject: w.subject,
        boundSubject,
        now: NOW,
      });
    // Control: the device as it is signed in.
    expect(await attempt(A, w.subject)).not.toBeNull();
    expect(await count()).toBe(1);

    // Another subject than the one the device row holds.
    expect(await attempt(A, SUBJECT_X)).toBeNull();
    // The binding cleared by raw SQL, bypassing the listener.
    await w.db.run(
      "UPDATE devices SET subject = NULL WHERE product = ? AND device_id = ?",
      SLUG,
      B,
    );
    expect(await attempt(B, w.subject)).toBeNull();
    // Deauthorized by raw SQL.
    await ensureBoundDevice(w.db, SLUG, C, w.subject);
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = ?",
      SLUG,
      C,
    );
    expect(await attempt(C, w.subject)).toBeNull();
    // No row at all.
    expect(
      await attempt("NOROW00000000000000000000000000Z", w.subject),
    ).toBeNull();
    // The refusals left no row of their own (and A's row went with the refused re-mint).
    expect(await count("identity_restore_keys", `device_id <> '${A}'`)).toBe(0);
  });

  it("replaces this device's row, so one device holds one key", async () => {
    const first = await mint(A);
    const second = await mint(A, { now: NOW + 5 });
    expect(await count()).toBe(1);
    expect(await redeem(first.restoreId, first.secret)).toBeNull();
    expect(await redeem(second.restoreId, second.secret)).not.toBeNull();
  });

  it("keeps at most 10 rows per subject and drops the oldest check first", async () => {
    const devices = Array.from(
      { length: RESTORE_KEY_CAP + 2 },
      (_, i) => `DEV${String(i).padStart(29, "0")}`,
    );
    const minted: Awaited<ReturnType<typeof mint>>[] = [];
    for (const [i, d] of devices.entries())
      minted.push(await mint(d, { now: NOW + i }));
    expect(await count()).toBe(RESTORE_KEY_CAP);
    // The two oldest are gone, the rest stay.
    expect(await redeem(minted[0]!.restoreId, minted[0]!.secret)).toBeNull();
    expect(await redeem(minted[1]!.restoreId, minted[1]!.secret)).toBeNull();
    expect(
      await redeem(minted.at(-1)!.restoreId, minted.at(-1)!.secret),
    ).not.toBeNull();
    // Another subject's rows are not counted against it.
    await mint(A, { subject: SUBJECT_X, now: NOW + 100 });
    expect(await count()).toBe(RESTORE_KEY_CAP);
  });

  it("a check refreshes the order the cap evicts by", async () => {
    const ids: string[] = [];
    const secrets: string[] = [];
    for (let i = 0; i < RESTORE_KEY_CAP; i++) {
      const m = await mint(`DEV${String(i).padStart(29, "0")}`, {
        now: NOW + i,
      });
      ids.push(m.restoreId);
      secrets.push(m.secret);
    }
    // The oldest device checks in; the next oldest is now the one to go.
    expect(
      await checkRestoreKey(w.db, {
        product: SLUG,
        deviceId: `DEV${"0".repeat(29)}`,
        subject: w.subject,
        restoreId: ids[0]!,
        now: NOW + 50,
      }),
    ).toBe(true);
    await mint(A, { now: NOW + 60 });
    expect(await redeem(ids[1]!, secrets[1]!, { now: NOW + 61 })).toBeNull();
    expect(
      await redeem(ids[0]!, secrets[0]!, { now: NOW + 61 }),
    ).not.toBeNull();
  });
});

describe("check (current)", () => {
  const check = (
    restoreId: string,
    over: Partial<Parameters<typeof checkRestoreKey>[1]> = {},
  ) =>
    checkRestoreKey(w.db, {
      product: SLUG,
      deviceId: A,
      subject: w.subject,
      restoreId,
      now: NOW + 10,
      ...over,
    });

  it("is current for the calling device and bumps checked_at", async () => {
    const { restoreId } = await mint(A);
    expect(await check(restoreId)).toBe(true);
    const row = await w.db.first<{ checked_at: number; created_at: number }>(
      "SELECT checked_at, created_at FROM identity_restore_keys",
    );
    expect(row).toEqual({ checked_at: NOW + 10, created_at: NOW });
  });

  it("is not current for another device of the same subject", async () => {
    const { restoreId } = await mint(A);
    expect(await check(restoreId, { deviceId: B })).toBe(false);
    expect(
      (await w.db.first<{ c: number }>(
        "SELECT checked_at AS c FROM identity_restore_keys",
      ))!.c,
    ).toBe(NOW);
  });

  it("is not current for another subject, another product, a bad id or an unknown id", async () => {
    const { restoreId } = await mint(A);
    expect(await check(restoreId, { subject: SUBJECT_X })).toBe(false);
    expect(await check(restoreId, { product: OTHER_PRODUCT })).toBe(false);
    expect(await check("rk_short")).toBe(false);
    expect(await check(`rk_${"A".repeat(22)}`)).toBe(false);
  });

  it("is not current once the secret is 90 days old, so the caller mints again", async () => {
    const { restoreId } = await mint(A);
    expect(
      await check(restoreId, { now: NOW + RESTORE_CURRENT_SECONDS - 1 }),
    ).toBe(true);
    expect(
      await check(restoreId, { now: NOW + RESTORE_CURRENT_SECONDS + 1 }),
    ).toBe(false);
  });
});

describe("consume", () => {
  it("returns the row's subject and device, once", async () => {
    const { restoreId, secret } = await mint(A);
    expect(await redeem(restoreId, secret)).toEqual({
      subject: w.subject,
      deviceId: A,
    });
    expect(await count()).toBe(0);
    expect(await redeem(restoreId, secret)).toBeNull();
  });

  it("a wrong secret is null and does not consume", async () => {
    const { restoreId, secret } = await mint(A);
    const wrong = `rs_${"A".repeat(43)}`;
    expect(await redeem(restoreId, wrong)).toBeNull();
    expect(await count()).toBe(1);
    expect(await redeem(restoreId, secret)).not.toBeNull();
  });

  it("another product's id is null and never consumes the row", async () => {
    const { restoreId, secret } = await mint(A);
    expect(
      await redeem(restoreId, secret, { product: OTHER_PRODUCT }),
    ).toBeNull();
    expect(await count()).toBe(1);
    expect(await redeem(restoreId, secret)).not.toBeNull();
  });

  it("a bad shape, an unknown id and an overlong secret are null", async () => {
    const { restoreId, secret } = await mint(A);
    expect(await redeem("rk_short", secret)).toBeNull();
    expect(await redeem(`rk_${"B".repeat(22)}`, secret)).toBeNull();
    expect(await redeem(restoreId, "rs_short")).toBeNull();
    expect(await redeem(restoreId, `rs_${"A".repeat(500)}`)).toBeNull();
    expect(await count()).toBe(1);
  });

  it("a row idle for 180 days is refused and kept for the sweep", async () => {
    const { restoreId, secret } = await mint(A);
    expect(
      await redeem(restoreId, secret, { now: NOW + RESTORE_IDLE_SECONDS + 1 }),
    ).toBeNull();
    expect(await count()).toBe(1);
  });

  it("hashes the presented secret for a missing row too, as for a wrong secret", async () => {
    // The pepper may be unset in a test env, which hashes with digest; count both primitives.
    const sign = vi.spyOn(crypto.subtle, "sign");
    const digest = vi.spyOn(crypto.subtle, "digest");
    const calls = () => sign.mock.calls.length + digest.mock.calls.length;
    const { restoreId } = await mint(A);
    sign.mockClear();
    digest.mockClear();
    expect(await redeem(restoreId, `rs_${"A".repeat(43)}`)).toBeNull();
    const wrong = calls();
    sign.mockClear();
    digest.mockClear();
    expect(
      await redeem(`rk_${"C".repeat(22)}`, `rs_${"A".repeat(43)}`),
    ).toBeNull();
    expect(wrong).toBeGreaterThan(0);
    expect(calls()).toBe(wrong);
  });

  it("two redeems race and exactly one wins", async () => {
    const { restoreId, secret } = await mint(A);
    const results = await Promise.all([
      redeem(restoreId, secret),
      redeem(restoreId, secret),
      redeem(restoreId, secret),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe("revocation never depends on a gate", () => {
  it("sign-out deletes this device's row in the request, before the answer", async () => {
    const a = await mint(A);
    const b = await mint(B);
    const res = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/signout`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${w.tokens[A]}`,
          "x-pkey-device": A,
        },
      }),
      w.env,
      w.db,
      NOW + 1,
    );
    expect(res.status).toBe(200);
    expect(await redeem(a.restoreId, a.secret)).toBeNull();
    // The other device keeps its key.
    expect(await redeem(b.restoreId, b.secret)).not.toBeNull();
  });

  it("onDeviceChange unbound and removed delete the row with Identity switched off", async () => {
    const a = await mint(A);
    const b = await mint(B);
    await enable(w.db, ["license"]);
    await event("unbound", A, w.subject);
    expect(await redeem(a.restoreId, a.secret)).toBeNull();
    await setDeviceStatus(w.db, SLUG, B, "deauthorized");
    expect(await redeem(b.restoreId, b.secret)).toBeNull();
  });

  it("a real unbind (the device row's subject cleared) deletes the row", async () => {
    const a = await mint(A);
    await writeDeviceSubject(w.db, SLUG, A, null);
    expect(await redeem(a.restoreId, a.secret)).toBeNull();
  });

  it("binding a device to another subject drops the rows it enrolled for the old one", async () => {
    await mint(A);
    await event("bound", A, SUBJECT_X);
    expect(await count()).toBe(0);
    await mint(A);
    await event("bound", A, w.subject);
    expect(await count()).toBe(1);
  });

  it("a key rotation leaves the row alone", async () => {
    await mint(A);
    await event("keys", A, w.subject);
    expect(await count()).toBe(1);
  });

  it("DELETE-style revoke is idempotent and touches only this device", async () => {
    await mint(A);
    await mint(B);
    expect(await revokeDeviceRestore(w.db, SLUG, A)).toBe(1);
    expect(await revokeDeviceRestore(w.db, SLUG, A)).toBe(0);
    expect(await count()).toBe(1);
  });

  it("removing the app from Connected apps (the subject store delete) deletes every row of the subject", async () => {
    const a = await mint(A);
    await mint(B);
    await mint(C, { subject: SUBJECT_X });
    await markRestoreOrigin(w.db, {
      product: SLUG,
      deviceId: B,
      subject: w.subject,
      now: NOW,
    });
    await runSubjectDelete(
      { db: w.db, env: w.env, now: NOW },
      { product: SLUG, subject: w.subject },
    );
    expect(await redeem(a.restoreId, a.secret)).toBeNull();
    expect(await count()).toBe(1);
    expect(await count("identity_restore_origins")).toBe(0);
  });
});

describe("a device that signed in by restore", () => {
  it("removing it deletes ALL restore rows of its subject, and only its subject", async () => {
    await mint(A);
    await mint(C, { now: NOW + 1 });
    const other = await mint("OTHERDEV0000000000000000000000AA", {
      subject: SUBJECT_X,
    });
    await markRestoreOrigin(w.db, {
      product: SLUG,
      deviceId: B,
      subject: w.subject,
      now: NOW,
    });
    await setDeviceStatus(w.db, SLUG, B, "deauthorized");
    expect(
      await count("identity_restore_keys", `subject = '${w.subject}'`),
    ).toBe(0);
    expect(await count("identity_restore_origins")).toBe(0);
    expect(await redeem(other.restoreId, other.secret)).not.toBeNull();
  });

  it("removing an ordinary device deletes its own row only", async () => {
    await mint(A);
    await mint(B);
    await markRestoreOrigin(w.db, {
      product: SLUG,
      deviceId: C,
      subject: w.subject,
      now: NOW,
    });
    await setDeviceStatus(w.db, SLUG, B, "deauthorized");
    expect(await count()).toBe(1);
    expect(await count("identity_restore_origins")).toBe(1);
  });

  it("signing it out forgets the origin but keeps the subject's other keys", async () => {
    await mint(A);
    await markRestoreOrigin(w.db, {
      product: SLUG,
      deviceId: B,
      subject: w.subject,
      now: NOW,
    });
    await event("unbound", B, w.subject);
    expect(await count("identity_restore_origins")).toBe(0);
    expect(await count()).toBe(1);
  });

  it("marking is idempotent and re-keys to the latest subject", async () => {
    for (const subject of [w.subject, SUBJECT_X])
      await markRestoreOrigin(w.db, {
        product: SLUG,
        deviceId: B,
        subject,
        now: NOW,
      });
    expect(await count("identity_restore_origins")).toBe(1);
    expect(
      (await w.db.first<{ subject: string }>(
        "SELECT subject FROM identity_restore_origins",
      ))!.subject,
    ).toBe(SUBJECT_X);
  });
});

describe("operator purge and the sweep", () => {
  it("purges every row and origin mark of one product and no other", async () => {
    await mint(A);
    await mint(B);
    await mint(A, { product: OTHER_PRODUCT });
    await markRestoreOrigin(w.db, {
      product: SLUG,
      deviceId: C,
      subject: w.subject,
      now: NOW,
    });
    expect(await purgeProductRestore(w.db, SLUG)).toBe(2);
    expect(await count("identity_restore_keys", `product = '${SLUG}'`)).toBe(0);
    expect(await count("identity_restore_origins")).toBe(0);
    expect(
      await count("identity_restore_keys", `product = '${OTHER_PRODUCT}'`),
    ).toBe(1);
    expect(await purgeProductRestore(w.db, SLUG)).toBe(0);
  });

  it("the purge writes one audit row that names the actor and the count, no id or secret", async () => {
    const m = await mint(A);
    await purgeProductRestore(w.db, SLUG, {
      actor: { sub: "op", name: "Operator", email: null },
      now: NOW,
    });
    const rows = await w.db.all<Record<string, unknown>>(
      "SELECT * FROM audit WHERE product = ? AND action = 'identity.restore.purge'",
      SLUG,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_sub: "op",
      summary: "Purged 1 restore key(s).",
    });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(m.restoreId);
    expect(text).not.toContain(m.secret);
  });

  it("the 180-day sweep removes idle rows, not checked ones; an origin mark outlives it", async () => {
    await mint(A, { now: NOW });
    await mint(B, { now: NOW + 100 * 86_400 });
    await markRestoreOrigin(w.db, {
      product: SLUG,
      deviceId: C,
      subject: w.subject,
      now: NOW,
    });
    const later = NOW + RESTORE_IDLE_SECONDS + 10;
    expect(await sweepRestoreKeys(w.db, SLUG, later)).toBe(1);
    expect(await count()).toBe(1);
    expect(
      (await w.db.first<{ d: string }>(
        "SELECT device_id AS d FROM identity_restore_keys",
      ))!.d,
    ).toBe(B);
    // The mark stays: a key copied before the restore can still be redeemed for 270 days.
    expect(await count("identity_restore_origins")).toBe(1);
    expect(await sweepRestoreKeys(w.db, SLUG, later)).toBe(0);
  });

  it("an origin mark lives 270 days: a 200-day mark survives the sweep, a 271-day mark goes", async () => {
    expect(RESTORE_ORIGIN_SECONDS).toBe(
      RESTORE_CURRENT_SECONDS + RESTORE_IDLE_SECONDS,
    );
    const mark = (deviceId: string, ageDays: number) =>
      markRestoreOrigin(w.db, {
        product: SLUG,
        deviceId,
        subject: w.subject,
        now: NOW - ageDays * 86_400,
      });
    await mark(A, 200);
    await mark(B, 271);
    expect(await sweepRestoreKeys(w.db, SLUG, NOW)).toBe(1);
    expect(
      (
        await w.db.all<{ d: string }>(
          "SELECT device_id AS d FROM identity_restore_origins",
        )
      ).map((r) => r.d),
    ).toEqual([A]);
  });

  it("revokeSubjectRestore removes rows and marks of the subject", async () => {
    await mint(A);
    await markRestoreOrigin(w.db, {
      product: SLUG,
      deviceId: B,
      subject: w.subject,
      now: NOW,
    });
    expect(await revokeSubjectRestore(w.db, SLUG, w.subject)).toBe(1);
    expect(await count("identity_restore_origins")).toBe(0);
  });
});

describe("the identity.restore subject store", () => {
  it("is registered and lists no hash, secret or id in its export", async () => {
    expect(subjectStoreNames()).toContain("identity.restore");
    const { restoreId } = await mint(A);
    const out = await runSubjectExport(
      { db: w.db, env: w.env, now: NOW },
      { product: SLUG, subject: w.subject },
    );
    expect(out["identity.restore"]).toEqual([
      { createdAt: NOW, checkedAt: NOW },
    ]);
    const text = JSON.stringify(out["identity.restore"]);
    expect(text).not.toContain(restoreId);
    expect(text).not.toContain("secret_hash");
  });

  it("an account merge deletes the absorbed subject's keys and moves its origin marks", async () => {
    await mint(A, { subject: SUBJECT_X });
    await mint(B);
    await markRestoreOrigin(w.db, {
      product: SLUG,
      deviceId: C,
      subject: SUBJECT_X,
      now: NOW,
    });
    await runSubjectMerge(
      { db: w.db, env: w.env, now: NOW },
      { product: SLUG, from: SUBJECT_X, to: w.subject },
    );
    expect(
      await count("identity_restore_keys", `subject = '${SUBJECT_X}'`),
    ).toBe(0);
    expect(await count()).toBe(1);
    expect(
      (await w.db.first<{ subject: string }>(
        "SELECT subject FROM identity_restore_origins",
      ))!.subject,
    ).toBe(w.subject);
  });

  it("product deletion removes the product's rows and marks", async () => {
    const stmts = productDeletionStatements(SLUG, NOW).map((s) => s.sql);
    expect(stmts.some((q) => q.includes("identity_restore_keys"))).toBe(true);
    expect(stmts.some((q) => q.includes("identity_restore_origins"))).toBe(
      true,
    );
  });
});
