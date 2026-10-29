/**
 * Core's key ring store (U-36.1; WIRE-CONTRACT-V5 §13.11): the rows behind `/devices/keyring`, and
 * the one writer of `keyrings`, `keyring_wraps` and `keyring_adopted`.
 *
 * The server holds only values it cannot open: a root wrapped to each device (`pkey-sync-wrap/1`),
 * a sealed recovery blob and sealed adoption blobs. This module never inspects those values; the
 * route layer (U-36.2) checks their shape. Three things reach the rows from outside:
 *
 *   - the subject store `core.keyring` (merge, delete, export), listed in `accounts/subjectHooks.ts`;
 *   - the device lifecycle (R-7): a removed or unbound device loses its wraps, a rebound device
 *     loses the wraps of any other subject, and a device whose keys changed loses its wrap so it
 *     fetches one for its new key. Core subscribes to its own event in `devices/lifecycle.ts`;
 *   - the routes (U-36.2, U-36.3), through the functions below.
 */

import type { Db, DbStatement } from "../../db/types.js";
import type {
  SubjectStore,
  SubjectStoreContext,
} from "../accounts/subjectHooks.js";
import type { DeviceChange } from "../devices/lifecycle.js";

/** The registry name (stable: the export document is keyed by it). */
export const KEYRING_STORE = "core.keyring";

/** How long a reset keeps the replaced ring readable (§13.11.4). */
export const PREVIOUS_RING_SECONDS = 30 * 86_400;

export interface Wrap {
  kem: number;
  enc: string;
  ct: string;
}

export interface RingRow {
  ringId: string;
  epoch: number;
  rootKid: string;
  state: string;
  createdAt: number;
  recoverySet: boolean;
  recoveryAt: number | null;
  previous: { ringId: string; kid: string; until: number } | null;
  adopted: AdoptedRow[];
}

export interface AdoptedRow {
  ringId: string;
  epoch: number;
  kid: string;
  /** Null for a merge candidate no device has sealed yet. */
  ct: string | null;
}

export interface WrapRow extends Wrap {
  deviceId: string;
  ringId: string;
  epoch: number;
  kid: string;
  by: string;
  createdAt: number;
}

interface RingDb {
  ring_id: string;
  epoch: number;
  root_kid: string;
  state: string;
  recovery_ct: string | null;
  recovery_at: number | null;
  previous_ring_id: string | null;
  previous_kid: string | null;
  previous_until: number | null;
  created_at: number;
}

interface WrapDb {
  device_id: string;
  ring_id: string;
  epoch: number;
  kid: string;
  kem: string | number;
  enc: string;
  ct: string;
  by_device: string;
  created_at: number;
}

const WRAP_COLS =
  "device_id, ring_id, epoch, kid, kem, enc, ct, by_device, created_at";

/** Rows written before the integer form hold "x25519"; the column is TEXT, so 32 reads back "32". */
const kemOf = (v: string | number): number => (v === "x25519" ? 32 : Number(v));

const toWrap = (r: WrapDb): WrapRow => ({
  deviceId: r.device_id,
  ringId: r.ring_id,
  epoch: r.epoch,
  kid: r.kid,
  kem: kemOf(r.kem),
  enc: r.enc,
  ct: r.ct,
  by: r.by_device,
  createdAt: r.created_at,
});

/** Run a batch and answer each statement's changed-row count. */
async function changes(db: Db, stmts: DbStatement[]): Promise<number[]> {
  if (db.batchChanges) return db.batchChanges(stmts);
  const out: number[] = [];
  for (const s of stmts) out.push(await db.runChanges(s.sql, ...s.params));
  return out;
}

const insertWrap = (
  product: string,
  subject: string,
  w: WrapInput,
  now: number,
): DbStatement => ({
  sql: `INSERT OR IGNORE INTO keyring_wraps
          (product, subject, device_id, ring_id, epoch, kid, kem, enc, ct, by_device, created_at)
        SELECT ?, ?, ?, ring_id, epoch, ?, ?, ?, ?, ?, ?
          FROM keyrings WHERE product = ? AND subject = ? AND ring_id = ? AND epoch = ?`,
  params: [
    product,
    subject,
    w.deviceId,
    w.kid,
    w.kem,
    w.enc,
    w.ct,
    w.by,
    now,
    product,
    subject,
    w.ringId,
    w.epoch,
  ],
});

export interface WrapInput extends Wrap {
  deviceId: string;
  ringId: string;
  epoch: number;
  kid: string;
  /** The device that made the wrap. */
  by: string;
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────

/** The subject's ring for a product, with its adopted roots, or null. */
export async function getRing(
  db: Db,
  product: string,
  subject: string,
): Promise<RingRow | null> {
  const r = await db.first<RingDb>(
    `SELECT ring_id, epoch, root_kid, state, recovery_ct, recovery_at,
            previous_ring_id, previous_kid, previous_until, created_at
       FROM keyrings WHERE product = ? AND subject = ?`,
    product,
    subject,
  );
  if (!r) return null;
  const adopted = await db.all<{
    ring_id: string;
    epoch: number;
    kid: string;
    ct: string | null;
  }>(
    `SELECT ring_id, epoch, kid, ct FROM keyring_adopted
      WHERE product = ? AND subject = ? ORDER BY created_at, ring_id`,
    product,
    subject,
  );
  return {
    ringId: r.ring_id,
    epoch: r.epoch,
    rootKid: r.root_kid,
    state: r.state,
    createdAt: r.created_at,
    recoverySet: r.recovery_ct !== null,
    recoveryAt: r.recovery_at,
    previous:
      r.previous_ring_id !== null &&
      r.previous_kid !== null &&
      r.previous_until !== null
        ? {
            ringId: r.previous_ring_id,
            kid: r.previous_kid,
            until: r.previous_until,
          }
        : null,
    adopted: adopted.map((a) => ({
      ringId: a.ring_id,
      epoch: a.epoch,
      kid: a.kid,
      ct: a.ct,
    })),
  };
}

/** A device's wrap of the subject's current ring root, or null. */
export async function getWrap(
  db: Db,
  product: string,
  subject: string,
  deviceId: string,
): Promise<WrapRow | null> {
  const r = await db.first<WrapDb>(
    `SELECT ${WRAP_COLS} FROM keyring_wraps w
      WHERE product = ? AND subject = ? AND device_id = ?
        AND (ring_id, epoch) = (SELECT ring_id, epoch FROM keyrings WHERE product = ? AND subject = ?)`,
    product,
    subject,
    deviceId,
    product,
    subject,
  );
  return r ? toWrap(r) : null;
}

/** A device that holds a wrap of the current ring root: its label (or none) and when it got it. */
export interface RingDevice {
  label: string | null;
  createdAt: number;
}

/**
 * The devices that hold a wrap of the subject's current ring root, oldest first, with each
 * device's label (Core owns `devices`, so the join is here). Nothing of the wrap itself, and no
 * device id, leaves: the console shows which devices can open the data, not how.
 */
export async function listWraps(
  db: Db,
  product: string,
  subject: string,
): Promise<RingDevice[]> {
  const rows = await db.all<{ label: string | null; created_at: number }>(
    `SELECT d.label AS label, w.created_at AS created_at
       FROM keyring_wraps w
       LEFT JOIN devices d ON d.product = w.product AND d.device_id = w.device_id
      WHERE w.product = ? AND w.subject = ?
        AND (w.ring_id, w.epoch) = (SELECT ring_id, epoch FROM keyrings WHERE product = ? AND subject = ?)
      ORDER BY w.created_at, w.device_id`,
    product,
    subject,
    product,
    subject,
  );
  return rows.map((r) => ({ label: r.label, createdAt: r.created_at }));
}

/** The sealed recovery blob of the current ring, with the ring's epoch and kid, or null. */
export async function getRecovery(
  db: Db,
  product: string,
  subject: string,
): Promise<{ ct: string; epoch: number; kid: string } | null> {
  const r = await db.first<{
    recovery_ct: string | null;
    epoch: number;
    root_kid: string;
  }>(
    "SELECT recovery_ct, epoch, root_kid FROM keyrings WHERE product = ? AND subject = ?",
    product,
    subject,
  );
  return r && r.recovery_ct !== null
    ? { ct: r.recovery_ct, epoch: r.epoch, kid: r.root_kid }
    : null;
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────────

export interface CreateRingInput {
  product: string;
  subject: string;
  ringId: string;
  epoch?: number;
  rootKid: string;
  /** The creating device's own wrap. */
  wrap: WrapInput;
  recoveryCt?: string | null;
  now: number;
}

/**
 * Create the subject's ring and its first wrap in one batch. `conflict` when a ring exists (it
 * never replaces one: a reset does, through {@link resetRing}); then nothing is written.
 */
export async function createRing(
  db: Db,
  a: CreateRingInput,
): Promise<"created" | "conflict"> {
  const epoch = a.epoch ?? 1;
  const [n] = await changes(db, [
    {
      sql: `INSERT OR IGNORE INTO keyrings
              (product, subject, ring_id, epoch, root_kid, state, recovery_ct, recovery_at,
               created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      params: [
        a.product,
        a.subject,
        a.ringId,
        epoch,
        a.rootKid,
        a.recoveryCt ?? null,
        a.recoveryCt ? a.now : null,
        a.wrap.by,
        a.now,
        a.now,
      ],
    },
    // Conditional on the ring row naming this ring and epoch, so a refused create leaves no wrap.
    insertWrap(
      a.product,
      a.subject,
      { ...a.wrap, ringId: a.ringId, epoch },
      a.now,
    ),
  ]);
  return n === 0 ? "conflict" : "created";
}

/**
 * Store a device's wrap of the current ring root. Create-only: `exists` when the device already
 * holds a wrap for that ring and epoch, `no_ring` when the subject has no such ring.
 */
export async function putWrap(
  db: Db,
  product: string,
  subject: string,
  w: WrapInput,
  now: number,
): Promise<"created" | "exists" | "no_ring"> {
  const ring = await db.first<{ one: number }>(
    "SELECT 1 AS one FROM keyrings WHERE product = ? AND subject = ? AND ring_id = ? AND epoch = ?",
    product,
    subject,
    w.ringId,
    w.epoch,
  );
  if (!ring) return "no_ring";
  const [n] = await changes(db, [insertWrap(product, subject, w, now)]);
  return n === 0 ? "exists" : "created";
}

/** Remove a device's wraps for the subject (the device's own `DELETE`). */
export async function deleteWrap(
  db: Db,
  product: string,
  subject: string,
  deviceId: string,
): Promise<void> {
  await db.run(
    "DELETE FROM keyring_wraps WHERE product = ? AND subject = ? AND device_id = ?",
    product,
    subject,
    deviceId,
  );
}

/**
 * Replace the sealed recovery blob of the current ring. False when the subject has no ring, or,
 * with `guard`, when the ring is no longer at that epoch and `kid` (checked in the same statement,
 * so a reset between the caller's read and this write cannot take a blob sealed for the old root).
 */
export async function setRecovery(
  db: Db,
  product: string,
  subject: string,
  ct: string,
  now: number,
  guard?: { epoch: number; kid: string },
): Promise<boolean> {
  const n = await db.runChanges(
    `UPDATE keyrings SET recovery_ct = ?, recovery_at = ?, updated_at = ?
      WHERE product = ? AND subject = ?${guard ? " AND epoch = ? AND root_kid = ?" : ""}`,
    ct,
    now,
    now,
    product,
    subject,
    ...(guard ? [guard.epoch, guard.kid] : []),
  );
  return n > 0;
}

/**
 * Record a root sealed under the current one. Idempotent per (ring, epoch): a candidate left by a
 * merge (`ct` null) is completed, a sealed one is left as it is. False when the subject has no ring.
 */
export async function addAdopted(
  db: Db,
  product: string,
  subject: string,
  a: { ringId: string; epoch: number; kid: string; ct: string },
  now: number,
): Promise<boolean> {
  const ring = await db.first<{ one: number }>(
    "SELECT 1 AS one FROM keyrings WHERE product = ? AND subject = ?",
    product,
    subject,
  );
  if (!ring) return false;
  await db.batch([
    {
      sql: `INSERT OR IGNORE INTO keyring_adopted (product, subject, ring_id, epoch, kid, ct, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [product, subject, a.ringId, a.epoch, a.kid, a.ct, now],
    },
    {
      sql: `UPDATE keyring_adopted SET ct = ?
             WHERE product = ? AND subject = ? AND ring_id = ? AND epoch = ? AND kid = ? AND ct IS NULL`,
      params: [a.ct, product, subject, a.ringId, a.epoch, a.kid],
    },
  ]);
  return true;
}

export interface ResetRingInput {
  product: string;
  subject: string;
  /** The ring the caller saw; the reset applies only while it is still the current one. */
  expectedRingId: string;
  ringId: string;
  epoch: number;
  rootKid: string;
  wrap: WrapInput;
  recoveryCt?: string | null;
  now: number;
}

/**
 * Replace the ring with a new one (a manual reset, §13.11.6). The old ring stays as `previous`
 * for 30 days and its wraps stay with it, so a device that holds that root can adopt it.
 * `conflict` when the current ring is no longer `expectedRingId`; nothing is written then.
 */
export async function resetRing(
  db: Db,
  a: ResetRingInput,
): Promise<"reset" | "conflict"> {
  const [n] = await changes(db, [
    {
      sql: `UPDATE keyrings
               SET previous_ring_id = ring_id, previous_kid = root_kid, previous_until = ?,
                   ring_id = ?, epoch = ?, root_kid = ?, state = 'active',
                   recovery_ct = ?, recovery_at = ?, created_by = ?, created_at = ?, updated_at = ?
             WHERE product = ? AND subject = ? AND ring_id = ?`,
      params: [
        a.now + PREVIOUS_RING_SECONDS,
        a.ringId,
        a.epoch,
        a.rootKid,
        a.recoveryCt ?? null,
        a.recoveryCt ? a.now : null,
        a.wrap.by,
        a.now,
        a.now,
        a.product,
        a.subject,
        a.expectedRingId,
      ],
    },
    insertWrap(
      a.product,
      a.subject,
      { ...a.wrap, ringId: a.ringId, epoch: a.epoch },
      a.now,
    ),
  ]);
  return n === 0 ? "conflict" : "reset";
}

/**
 * Forget the replaced rings whose 30 days passed: their wraps, and the `previous` marker. Also the
 * wraps of absorbed rings (see below). Returns
 * how many rings it cleared. The nightly sweep runs it (`scheduled.ts`, step `keyringPrevious`).
 */
export async function purgeExpiredPrevious(
  db: Db,
  now: number,
): Promise<number> {
  await db.run(
    `DELETE FROM keyring_wraps
      WHERE (product, subject, ring_id) IN (
        SELECT product, subject, previous_ring_id FROM keyrings
         WHERE previous_ring_id IS NOT NULL AND previous_until <= ?)`,
    now,
  );
  // Wraps a merge moved over from an absorbed subject open a ring that is neither current nor
  // previous: they are never served. They go when the candidate is resolved (sealed under the
  // current root) or after the same 30 days.
  await db.run(
    `DELETE FROM keyring_wraps
      WHERE (product, subject, ring_id, epoch) IN (
        SELECT a.product, a.subject, a.ring_id, a.epoch FROM keyring_adopted a
         WHERE (a.ct IS NOT NULL OR a.created_at + ? <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM keyrings k
              WHERE k.product = a.product AND k.subject = a.subject
                AND (k.ring_id = a.ring_id OR k.previous_ring_id = a.ring_id)))`,
    PREVIOUS_RING_SECONDS,
    now,
  );
  return db.runChanges(
    `UPDATE keyrings
        SET previous_ring_id = NULL, previous_kid = NULL, previous_until = NULL
      WHERE previous_ring_id IS NOT NULL AND previous_until <= ?`,
    now,
  );
}

// ── The device lifecycle (R-7) ──────────────────────────────────────────────────────────────

/**
 * Core's own listener on the device lifecycle: a removed or unbound device loses its wraps, a
 * device bound to a subject loses the wraps of any other subject, and a device whose keys changed
 * loses its wrap so it fetches one for the new key. Bookkeeping only (it cannot refuse the
 * write), so the cheap statements run for every product whatever its services.
 */
export async function onDeviceChange(
  db: Db,
  event: DeviceChange,
): Promise<void> {
  switch (event.kind) {
    case "removed":
    case "unbound":
    case "keys":
      await db.run(
        "DELETE FROM keyring_wraps WHERE product = ? AND device_id = ?",
        event.product,
        event.deviceId,
      );
      return;
    case "bound":
      if (!event.subject) return;
      await db.run(
        "DELETE FROM keyring_wraps WHERE product = ? AND device_id = ? AND subject <> ?",
        event.product,
        event.deviceId,
        event.subject,
      );
  }
}

/** A deleted product keeps no ring, wrap or recovery blob (crypto-shredding, T11). */
export function stmtsDeleteProductKeyrings(product: string): DbStatement[] {
  return ["keyring_wraps", "keyring_adopted", "keyrings"].map((t) => ({
    sql: `DELETE FROM ${t} WHERE product = ?`,
    params: [product],
  }));
}

// ── The subject store `core.keyring` ────────────────────────────────────────────────────────

export const keyringStore: SubjectStore = {
  tables: ["keyrings", "keyring_wraps", "keyring_adopted"],

  /**
   * The absorbed subject's ring becomes an `adopted` candidate (§13.11.4): the server cannot seal
   * it, so a device that holds both roots does. When the survivor has no ring the absorbed one
   * moves over whole. Wraps move with the ring they open. Idempotent: a retry finds nothing
   * under `from`.
   */
  async merge({ db, now }: SubjectStoreContext, { product, from, to }) {
    const ring = await db.first<{
      ring_id: string;
      epoch: number;
      root_kid: string;
    }>(
      "SELECT ring_id, epoch, root_kid FROM keyrings WHERE product = ? AND subject = ?",
      product,
      from,
    );
    const stmts: DbStatement[] = [];
    // Only the wraps of the absorbed current ring move over; a wrap for its previous ring (or an
    // older one) opens a root the survivor has no use for, so it goes with the subject.
    stmts.push({
      sql: `DELETE FROM keyring_wraps WHERE product = ? AND subject = ? AND ring_id <> ?`,
      params: [product, from, ring ? ring.ring_id : ""],
    });
    if (ring) {
      const survivor = await db.first<{ one: number }>(
        "SELECT 1 AS one FROM keyrings WHERE product = ? AND subject = ?",
        product,
        to,
      );
      if (!survivor) {
        stmts.push({
          sql: "UPDATE keyrings SET subject = ? WHERE product = ? AND subject = ?",
          params: [to, product, from],
        });
      } else {
        stmts.push(
          {
            sql: `INSERT OR IGNORE INTO keyring_adopted (product, subject, ring_id, epoch, kid, ct, created_at)
                  VALUES (?, ?, ?, ?, ?, NULL, ?)`,
            params: [product, to, ring.ring_id, ring.epoch, ring.root_kid, now],
          },
          {
            sql: "DELETE FROM keyrings WHERE product = ? AND subject = ?",
            params: [product, from],
          },
        );
      }
    }
    stmts.push(
      {
        sql: "UPDATE OR IGNORE keyring_wraps SET subject = ? WHERE product = ? AND subject = ?",
        params: [to, product, from],
      },
      {
        sql: "UPDATE OR IGNORE keyring_adopted SET subject = ? WHERE product = ? AND subject = ?",
        params: [to, product, from],
      },
      {
        sql: "DELETE FROM keyring_wraps WHERE product = ? AND subject = ?",
        params: [product, from],
      },
      {
        sql: "DELETE FROM keyring_adopted WHERE product = ? AND subject = ?",
        params: [product, from],
      },
    );
    await db.batch(stmts);
  },

  /** The last key material on the server goes (crypto-shredding, T11). */
  async delete({ db }, { product, subject }) {
    await db.batch(
      ["keyring_wraps", "keyring_adopted", "keyrings"].map((t) => ({
        sql: `DELETE FROM ${t} WHERE product = ? AND subject = ?`,
        params: [product, subject],
      })),
    );
  },

  /** What the server holds, without the sealed values: they open nowhere but on a device. */
  async export({ db }, { product, subject }) {
    const ring = await getRing(db, product, subject);
    const wraps = await db.all<WrapDb>(
      `SELECT ${WRAP_COLS} FROM keyring_wraps WHERE product = ? AND subject = ?
        ORDER BY created_at, device_id`,
      product,
      subject,
    );
    if (!ring && wraps.length === 0) return null;
    return {
      ring: ring && {
        ringId: ring.ringId,
        epoch: ring.epoch,
        rootKid: ring.rootKid,
        state: ring.state,
        createdAt: ring.createdAt,
        recovery: { set: ring.recoverySet, at: ring.recoveryAt },
        previous: ring.previous,
        adopted: ring.adopted.map((a) => ({
          ringId: a.ringId,
          epoch: a.epoch,
          kid: a.kid,
          sealed: a.ct !== null,
        })),
      },
      wraps: wraps.map((w) => ({
        deviceId: w.device_id,
        ringId: w.ring_id,
        epoch: w.epoch,
        kid: w.kid,
        by: w.by_device,
        createdAt: w.created_at,
      })),
    };
  },

  async size({ db }, { product, subject }) {
    const r = await db.first<{ n: number | null }>(
      `SELECT
         COALESCE((SELECT SUM(LENGTH(ct) + LENGTH(enc)) FROM keyring_wraps WHERE product = ? AND subject = ?), 0)
       + COALESCE((SELECT SUM(LENGTH(COALESCE(ct, ''))) FROM keyring_adopted WHERE product = ? AND subject = ?), 0)
       + COALESCE((SELECT SUM(LENGTH(COALESCE(recovery_ct, ''))) FROM keyrings WHERE product = ? AND subject = ?), 0)
       AS n`,
      ...[product, subject, product, subject, product, subject],
    );
    return r?.n ?? 0;
  },
};
