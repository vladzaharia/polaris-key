// Device keys (CC-03.1, plans/CC-01-cloud-connect.md §2.8): the two public keys a device registers
// against its `devices` row, an Ed25519 `signKey` and an X25519 `agreeKey`. This module is the only
// writer of `device_keys`. The route (CC-03.2), the lifecycle event (CC-03.3) and the proof
// (`proof.ts`, CC-03.4) build on it.

import {
  base64UrlDecode,
  ed25519Prechecks,
  isCanonicalB64url,
  isX25519LowOrder,
} from "@polaris-key/jws";
import type { Db, DbStatement } from "../../db/types.js";
import { resolveSyncPrincipal } from "../accounts/accountSubjects.js";
import { getLicense } from "../licensing/store.js";
import { licenseUsable } from "../devices.js";
import { toArrayBuffer } from "../../platform/bytes.js";

export interface DeviceKeysRow {
  product: string;
  device_id: string;
  sign_key: string;
  agree_key: string;
  key_seq: number;
  created_at: number;
  rotated_at: number | null;
}

export interface DeviceKeyPair {
  signKey: string;
  agreeKey: string;
}

/** A registered device with its keys, as Cloud Sync wraps to it. */
export interface AccountDeviceKeys extends DeviceKeyPair {
  deviceId: string;
  keySeq: number;
}

/** Another device already holds this `agreeKey` for the product. */
export class DeviceKeysConflictError extends Error {
  constructor() {
    super("device_keys: agreeKey is held by another device");
    this.name = "DeviceKeysConflictError";
  }
}

/** A key is not what the wire allows (shape, canonical form, small order). */
export class DeviceKeysInvalidError extends Error {
  constructor() {
    super("device_keys: invalid key");
    this.name = "DeviceKeysInvalidError";
  }
}

// ── Key checks (V5 §15.2 step 4, applied to both keys) ───────────────────────────────────────

/** Canonical base64url of exactly 32 bytes, or null. */
function raw32(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length !== 43 || !isCanonicalB64url(s)) {
    return null;
  }
  const bytes = base64UrlDecode(s);
  return bytes.length === 32 ? bytes : null;
}

/** A signature whose own `R` and `S` pass V5 §1.1 (R is the base point's encoding, S is 0), so
 *  `ed25519Prechecks` decides on the key alone. */
const PASSING_SIG: Uint8Array = (() => {
  const sig = new Uint8Array(64);
  sig.fill(0x66, 0, 32);
  sig[0] = 0x58;
  return sig;
})();

/** `signKey`: canonical, 32 bytes, and passing V5 §1.1 checks 2 and 3 (a point of small order never
 *  verifies a proof). */
export function isValidSignKey(s: unknown): boolean {
  const key = raw32(s);
  return key !== null && ed25519Prechecks(key, PASSING_SIG);
}

/**
 * True for the one spelling an X25519 library emits: bit 255 clear and u < p (p = 2^255 - 19).
 * X25519 masks bit 255 and reduces u mod p, so every other spelling of a key is the same key under a
 * different string. The issuer refuses them (a registration, a signed certificate or roster); the
 * verifiers stay lenient (V5 §15.2).
 */
export function isCanonicalX25519(key: Uint8Array): boolean {
  if (key.length !== 32 || (key[31]! & 0x80) !== 0) return false;
  if (key[31] !== 0x7f || key[0]! < 0xed) return true;
  for (let i = 1; i < 31; i++) if (key[i] !== 0xff) return true;
  return false; // 2^255 - 19 .. 2^255 - 1
}

/** `agreeKey`: canonical base64url, 32 bytes, the canonical X25519 spelling, not a low-order point. */
export function isValidAgreeKey(s: unknown): boolean {
  const key = raw32(s);
  if (!key || !isCanonicalX25519(key)) return false;
  return !isX25519LowOrder(key);
}

export function validateDeviceKeys(keys: DeviceKeyPair): boolean {
  return isValidSignKey(keys.signKey) && isValidAgreeKey(keys.agreeKey);
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

export async function getDeviceKeys(
  db: Db,
  product: string,
  deviceId: string,
): Promise<DeviceKeysRow | null> {
  return db.first<DeviceKeysRow>(
    "SELECT * FROM device_keys WHERE product = ? AND device_id = ?",
    product,
    deviceId,
  );
}

/** The device's registered `signKey`, or null when it has none. */
export async function deviceSignKey(
  db: Db,
  product: string,
  deviceId: string,
): Promise<string | null> {
  return (await getDeviceKeys(db, product, deviceId))?.sign_key ?? null;
}

interface MemberRow {
  device_id: string;
  sign_key: string;
  agree_key: string;
  key_seq: number;
  label: string | null;
  platform: string | null;
  last_seen: number;
  created_at: number;
  rotated_at: number | null;
}

export interface MemberOptions {
  /** The licence service is on: a device must also hold a seat and token and a usable licence. */
  seatsHeld?: boolean;
  /** Epoch seconds for the licence check; defaults to the clock. */
  now?: number;
}

/**
 * The devices that hold keys and whose principal is `subject`: exactly those for which
 * `resolveSyncPrincipal` answers this subject (authorized, bound, licence not floating and not
 * removed from the account's library). With `seatsHeld` (the licence service is on) a device whose
 * seat and token were released (`releaseDormantSeats`) or whose licence is not usable (disabled,
 * expired, gone) is left out; with the service off a seat is never held, so the caller leaves it
 * unset. Sorted by `device_id` so two callers see one order. The SQL only narrows the candidates;
 * the principal rule decides.
 */
async function memberRows(
  db: Db,
  product: string,
  subject: string,
  opts: MemberOptions,
): Promise<MemberRow[]> {
  const rows = await db.all<MemberRow & { status: string; license_id: string }>(
    `SELECT k.device_id, k.sign_key, k.agree_key, k.key_seq, k.created_at, k.rotated_at, d.label, d.platform, d.last_seen,
            d.status, d.license_id
       FROM device_keys k
       JOIN devices d ON d.product = k.product AND d.device_id = k.device_id
      WHERE k.product = ? AND d.subject = ? AND d.status = 'authorized'${
        opts.seatsHeld
          ? " AND d.seat_no IS NOT NULL AND d.token_hash IS NOT NULL"
          : ""
      }
      ORDER BY k.device_id`,
    product,
    subject,
  );
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const members: MemberRow[] = [];
  for (const r of rows) {
    const principal = await resolveSyncPrincipal(db, {
      product,
      status: r.status,
      license_id: r.license_id,
      subject,
    });
    if (principal?.subject !== subject) continue;
    if (opts.seatsHeld) {
      const licence = await getLicense(db, product, r.license_id);
      if (!licenseUsable(licence, now)) continue;
    }
    members.push(r);
  }
  return members;
}

/** The members with their keys: what Cloud Sync wraps the root key to and Cloud Connect signs. */
export async function accountDeviceKeys(
  db: Db,
  product: string,
  subject: string,
  opts: MemberOptions = {},
): Promise<AccountDeviceKeys[]> {
  const rows = await memberRows(db, product, subject, opts);
  return rows.map((r) => ({
    deviceId: r.device_id,
    signKey: r.sign_key,
    agreeKey: r.agree_key,
    keySeq: r.key_seq,
  }));
}

/** What the linked-devices list shows of one device: display data only, no key. */
export interface AccountDeviceListing {
  deviceId: string;
  label: string | null;
  platform: string | null;
  lastSeen: number;
  /** When the device's current keys took effect: its last rotation, else first registration. */
  keysSince: number;
}

/** The listing for `accountDeviceKeys`' set (same rule), sorted by `device_id`. */
export async function accountDeviceListing(
  db: Db,
  product: string,
  subject: string,
  opts: MemberOptions = {},
): Promise<AccountDeviceListing[]> {
  const rows = await memberRows(db, product, subject, opts);
  return rows.map((r) => ({
    deviceId: r.device_id,
    label: r.label,
    platform: r.platform,
    lastSeen: r.last_seen,
    keysSince: r.rotated_at ?? r.created_at,
  }));
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────

export interface UpsertResult {
  keySeq: number;
  /** True on first registration and on a rotation; false when both keys were already registered. */
  changed: boolean;
  /** True when a row already existed and its keys changed. */
  rotated: boolean;
}

/**
 * Register or rotate a device's keys. Both keys are always written together. Registering the keys a
 * device already holds changes nothing and keeps `key_seq`; any other write bumps it. `key_seq` and
 * the last accepted proof time live on in `device_key_floor`, which outlasts a deauthorize, so a
 * re-registration continues the count and `keySeq` only increases. `popAt` is the `issuedAt` of the
 * proof behind the write: a change must carry one strictly newer than the last accepted for the
 * device, so a captured proof cannot be replayed. Throws `DeviceKeysInvalidError` for a bad key or a
 * stale proof and `DeviceKeysConflictError` when another device of the product holds the
 * `agreeKey`. Callers own the device check and the rate limit.
 */
export async function upsertDeviceKeys(
  db: Db,
  product: string,
  deviceId: string,
  keys: DeviceKeyPair,
  now: number,
  popAt?: number,
  /**
   * The signing key the caller saw the device hold when it decided to write (`null`: none).
   * When given, a row that holds any other key by now refuses with `DeviceKeysInvalidError`
   * instead of being rotated, and the rotation itself only matches that key.
   */
  heldSignKey?: string | null,
): Promise<UpsertResult> {
  if (!validateDeviceKeys(keys)) throw new DeviceKeysInvalidError();
  const held = await db.first<{ device_id: string }>(
    "SELECT device_id FROM device_keys WHERE product = ? AND agree_key = ?",
    product,
    keys.agreeKey,
  );
  if (held && held.device_id !== deviceId) throw new DeviceKeysConflictError();
  const current = await getDeviceKeys(db, product, deviceId);
  if (
    current &&
    current.sign_key === keys.signKey &&
    current.agree_key === keys.agreeKey
  ) {
    return { keySeq: current.key_seq, changed: false, rotated: false };
  }
  if (
    heldSignKey !== undefined &&
    (current?.sign_key ?? null) !== heldSignKey
  ) {
    throw new DeviceKeysInvalidError();
  }
  const floor = await db.first<{ pop_at: number | null }>(
    "SELECT pop_at FROM device_key_floor WHERE product = ? AND device_id = ?",
    product,
    deviceId,
  );
  if (
    popAt !== undefined &&
    floor?.pop_at !== null &&
    floor?.pop_at !== undefined &&
    popAt <= floor.pop_at
  ) {
    throw new DeviceKeysInvalidError();
  }
  const write: DbStatement = current
    ? {
        sql: `UPDATE device_keys SET sign_key = ?, agree_key = ?, key_seq = key_seq + 1, rotated_at = ?
               WHERE product = ? AND device_id = ? AND sign_key = ?`,
        params: [
          keys.signKey,
          keys.agreeKey,
          now,
          product,
          deviceId,
          current.sign_key,
        ],
      }
    : {
        sql: `INSERT INTO device_keys (product, device_id, sign_key, agree_key, key_seq, created_at, rotated_at)
              VALUES (?, ?, ?, ?,
                COALESCE((SELECT key_seq FROM device_key_floor WHERE product = ? AND device_id = ?), 0) + 1,
                ?, NULL)`,
        params: [
          product,
          deviceId,
          keys.signKey,
          keys.agreeKey,
          product,
          deviceId,
          now,
        ],
      };
  let wrote = true;
  try {
    const stmts: DbStatement[] = [
      write,
      {
        sql: `INSERT INTO device_key_floor (product, device_id, key_seq, pop_at)
              SELECT product, device_id, key_seq, ? FROM device_keys WHERE product = ? AND device_id = ?
              ON CONFLICT (product, device_id) DO UPDATE SET key_seq = excluded.key_seq,
                pop_at = COALESCE(excluded.pop_at, device_key_floor.pop_at)`,
        params: [popAt ?? null, product, deviceId],
      },
    ];
    if (db.batchChanges) wrote = (await db.batchChanges(stmts))[0]! > 0;
    else await db.batch(stmts);
  } catch (e) {
    // A concurrent registration took the `agreeKey` between the read above and this write.
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw new DeviceKeysConflictError();
    }
    throw e;
  }
  const after = await getDeviceKeys(db, product, deviceId);
  // The guarded rotation matched nothing: another write changed the key since the read above.
  if (heldSignKey !== undefined && after?.sign_key !== keys.signKey) {
    throw new DeviceKeysInvalidError();
  }
  // The guarded UPDATE matched nothing (a concurrent change moved the key): nothing was written,
  // so nothing changed and no `keys` event is due.
  if (!wrote) {
    return {
      keySeq: after?.key_seq ?? current?.key_seq ?? 0,
      changed: false,
      rotated: false,
    };
  }
  return {
    keySeq: after?.key_seq ?? (current?.key_seq ?? 0) + 1,
    changed: true,
    rotated: current !== null,
  };
}

/** True when another device of the product already holds this agreement key. */
export async function agreeKeyHeldElsewhere(
  db: Db,
  product: string,
  agreeKey: string,
  deviceId: string,
): Promise<boolean> {
  const held = await db.first<{ device_id: string }>(
    "SELECT device_id FROM device_keys WHERE product = ? AND agree_key = ?",
    product,
    agreeKey,
  );
  return held !== null && held.device_id !== deviceId;
}

/** The delete as a statement, for a batch that removes the device (purge, licence delete). */
export function stmtDeleteDeviceKeys(
  product: string,
  deviceId: string,
): DbStatement {
  return {
    sql: "DELETE FROM device_keys WHERE product = ? AND device_id = ?",
    params: [product, deviceId],
  };
}

/** Drop a device's keys. Safe to call when it has none. */
export async function deleteDeviceKeys(
  db: Db,
  product: string,
  deviceId: string,
): Promise<void> {
  const s = stmtDeleteDeviceKeys(product, deviceId);
  await db.run(s.sql, ...s.params);
}

/** A strict Ed25519 verification (V5 §1.1 prechecks first) of a base64url signature by a raw key. */
export async function verifyEd25519Strict(
  signKey: string,
  sigB64: string,
  message: Uint8Array,
): Promise<boolean> {
  if (sigB64.length !== 86 || !isCanonicalB64url(sigB64)) return false;
  const sig = base64UrlDecode(sigB64);
  const pub = base64UrlDecode(signKey);
  if (sig.length !== 64 || !ed25519Prechecks(pub, sig)) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(pub),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      toArrayBuffer(sig),
      toArrayBuffer(message),
    );
  } catch {
    return false;
  }
}
