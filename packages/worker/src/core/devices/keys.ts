// Device keys (CC-03.1, plans/CC-01-cloud-connect.md §2.8): the two public keys a device registers
// against its `devices` row, an Ed25519 `signKey` and an X25519 `agreeKey`. This module is the only
// writer of `device_keys`. The route (CC-03.2), the lifecycle event (CC-03.3) and the proof vectors
// (CC-03.4) build on it.

import {
  base64UrlDecode,
  ed25519Prechecks,
  isCanonicalB64url,
} from "@polaris-key/jws";
import type { Db, DbStatement } from "../../db/types.js";
import { hexEncode, utf8Encode, toArrayBuffer } from "../../platform/bytes.js";

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

/**
 * The X25519 low-order points (RFC 7748 §6.1, as libsodium blocks them), lowercase hex. An
 * `agreeKey` equal to one gives an all-zero shared secret whatever the peer's private key is.
 * CC-05 moves the list into the corpus (`noise-vectors.json`); until then this is the one copy.
 */
const X25519_LOW_ORDER: readonly string[] = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];

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
  return !X25519_LOW_ORDER.includes(hexEncode(key));
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

/**
 * The devices bound to a subject that have keys: what Cloud Sync wraps the root key to. Bound means
 * `devices.subject` is the subject, authorized means `status = 'authorized'`. With `seatsHeld` (the
 * licence service is on) a device whose seat and token were released (`releaseDormantSeats`) is left
 * out; with the service off a seat is never held, so the caller leaves it unset.
 * Sorted by `device_id` so two callers see one order.
 */
export async function accountDeviceKeys(
  db: Db,
  product: string,
  subject: string,
  opts: { seatsHeld?: boolean } = {},
): Promise<AccountDeviceKeys[]> {
  const rows = await db.all<{
    device_id: string;
    sign_key: string;
    agree_key: string;
    key_seq: number;
  }>(
    `SELECT k.device_id, k.sign_key, k.agree_key, k.key_seq
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
  return rows.map((r) => ({
    deviceId: r.device_id,
    signKey: r.sign_key,
    agreeKey: r.agree_key,
    keySeq: r.key_seq,
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
               WHERE product = ? AND device_id = ?`,
        params: [keys.signKey, keys.agreeKey, now, product, deviceId],
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
  try {
    await db.batch([
      write,
      {
        sql: `INSERT INTO device_key_floor (product, device_id, key_seq, pop_at)
              SELECT product, device_id, key_seq, ? FROM device_keys WHERE product = ? AND device_id = ?
              ON CONFLICT (product, device_id) DO UPDATE SET key_seq = excluded.key_seq,
                pop_at = COALESCE(excluded.pop_at, device_key_floor.pop_at)`,
        params: [popAt ?? null, product, deviceId],
      },
    ]);
  } catch (e) {
    // A concurrent registration took the `agreeKey` between the read above and this write.
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw new DeviceKeysConflictError();
    }
    throw e;
  }
  const after = await getDeviceKeys(db, product, deviceId);
  return {
    keySeq: after?.key_seq ?? (current?.key_seq ?? 0) + 1,
    changed: true,
    rotated: current !== null,
  };
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

// ── Proof of possession (`pkey-proof/1`, purpose `keys`) ─────────────────────────────────────

/** The proof's skew window, in seconds either side of now. */
export const KEY_POP_SKEW_SECONDS = 300;

const LINE_FIELD = /^[\x21-\x7e]+$/; // no space, no newline, no control byte

export interface KeyPopInput extends DeviceKeyPair {
  product: string;
  deviceId: string;
  issuedAt: number;
  /** The 64-byte Ed25519 signature, base64url. */
  sig: string;
  now: number;
}

/** The bytes a `keys` proof signs: `pkey-proof/1`, purpose, slug, device, value, `-`, joined by LF. */
export function keyPopMessage(
  input: Omit<KeyPopInput, "sig" | "now">,
): Uint8Array | null {
  const { product, deviceId, signKey, agreeKey, issuedAt } = input;
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  if (!LINE_FIELD.test(product) || !LINE_FIELD.test(deviceId)) return null;
  const value = `${signKey}.${agreeKey}.${issuedAt}`;
  if (!LINE_FIELD.test(value)) return null;
  return utf8Encode(
    ["pkey-proof/1", "keys", product, deviceId, value, "-"].join("\n"),
  );
}

/**
 * Verify that the holder of `signKey` made this registration: both keys valid, `|issuedAt - now|`
 * within the window, and a strict Ed25519 signature by `signKey` over the `keys` proof lines. It
 * answers true or false and never says which check failed.
 */
export async function verifyKeyPop(input: KeyPopInput): Promise<boolean> {
  if (!validateDeviceKeys(input)) return false;
  if (Math.abs(input.issuedAt - input.now) > KEY_POP_SKEW_SECONDS) return false;
  const message = keyPopMessage(input);
  if (!message) return false;
  if (input.sig.length !== 86 || !isCanonicalB64url(input.sig)) return false;
  const sig = base64UrlDecode(input.sig);
  const pub = base64UrlDecode(input.signKey);
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
