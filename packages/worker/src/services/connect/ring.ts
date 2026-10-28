/**
 * The roster of a person's devices for one product (plans/CC-01-cloud-connect.md §2.3, §2.4;
 * WIRE-CONTRACT-V5 §15.3, §15.4): the members, the epoch that names a set of them, the discovery
 * key (K_disc) that goes with the epoch, and the signed `pkey-ring+jws` and `pkey-peer+jws`.
 *
 * ── MEMBERS ──────────────────────────────────────────────────────────────────────────────────
 *
 * The members are the devices bound to the subject, authorized, and holding keys
 * (`accountDeviceKeys`; `seatsHeld` when the licence service is on). The subject is the caller's
 * own (`resolveSyncPrincipal`): no route takes a subject or an account id from the request.
 *
 * ── EPOCH AND K_DISC ─────────────────────────────────────────────────────────────────────────
 *
 * `members_hash` is a SHA-256 over the members' `deviceId.signKey.agreeKey` lines. When it differs
 * from the stored one the epoch rises by one, a new K_disc is drawn, and the old one is kept as
 * `prev_disc_key` for 24 hours (not after a leave). The device lifecycle listener
 * (`ringListener.ts`) is the primary path: it runs `currentRing` as soon as a device is removed,
 * unbound, bound elsewhere or changes its keys. The comparison on every read stays as a backstop.
 * The update is conditional on the epoch it read, so two requests racing a bump make one bump.
 * Each bump writes one `connect.ring.bump` audit row: the reason and the new epoch, no key.
 *
 * ── LIFETIME ─────────────────────────────────────────────────────────────────────────────────
 *
 * A roster lives `RING_SECONDS` and a certificate `PEER_CERT_SECONDS`, from the request's `now`.
 * `signDoc` refuses a roster whose span is outside 1..RING_SECONDS (`core/signing.ts`).
 */

import { ISSUER } from "@polaris-key/protocol/core";
import {
  MAX_RING_DEVICES,
  PEER_CERT_SECONDS,
  PEER_CERT_TYP,
  RING_SECONDS,
  RING_TYP,
} from "@polaris-key/protocol/connect";
import type { Db } from "../../db/types.js";
import type { AccountDeviceKeys } from "../../core/devices/keys.js";
import { actorColumns, appendAudit, SYSTEM_ACTORS } from "../../core/audit.js";
import { signDoc } from "../../core/signing.js";
import { sha256Hex } from "../../platform/hash.js";
import { randomToken } from "../../platform/random.js";

/** How long the key before the last bump is still delivered, in seconds. */
export const PREV_DISC_KEY_SECONDS = 86_400;

export interface RingRow {
  product: string;
  subject: string;
  epoch: number;
  members_hash: string;
  member_ids: string;
  disc_key: string;
  prev_disc_key: string | null;
  prev_epoch: number | null;
  bumped_at: number;
}

const byDeviceId = (
  a: { deviceId: string },
  b: { deviceId: string },
): number => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);

/** The members in roster order (by `deviceId`, code-unit order: ids are ASCII). */
export function sortMembers(
  members: readonly AccountDeviceKeys[],
): AccountDeviceKeys[] {
  return [...members].sort(byDeviceId);
}

/** A hash of the roster's content: the set of devices and their two keys, nothing else. */
export async function membersHash(
  members: readonly AccountDeviceKeys[],
): Promise<string> {
  const lines = sortMembers(members).map(
    (m) => `${m.deviceId}.${m.signKey}.${m.agreeKey}`,
  );
  return sha256Hex(`pkey-ring/1\n${lines.join("\n")}`);
}

export async function getRing(
  db: Db,
  product: string,
  subject: string,
): Promise<RingRow | null> {
  return db.first<RingRow>(
    "SELECT * FROM connect_rings WHERE product = ? AND subject = ?",
    product,
    subject,
  );
}

/** The set holds more devices than a roster may (`MAX_RING_DEVICES`); checked before any bump. */
export class RingTooLargeError extends Error {
  constructor() {
    super("connect: more devices than a roster holds");
    this.name = "RingTooLargeError";
  }
}

const idsOf = (members: readonly AccountDeviceKeys[]): string =>
  sortMembers(members)
    .map((m) => m.deviceId)
    .join("\n");

/** True when a device in the stored epoch is not among the current members. */
function someoneLeft(stored: string, members: readonly AccountDeviceKeys[]) {
  if (stored === "") return false;
  const now = new Set(members.map((m) => m.deviceId));
  return stored.split("\n").some((id) => !now.has(id));
}

/** Why a ring moved: a read that found the members changed, a lifecycle event, or an account merge. */
export type BumpReason =
  | "read"
  | "removed"
  | "unbound"
  | "bound"
  | "keys"
  | "merge";

/** The `connect.ring.bump` audit row: the reason and the epoch. It names no key. */
async function auditBump(
  db: Db,
  product: string,
  subject: string,
  epoch: number,
  reason: BumpReason = "read",
  left: number,
  now: number,
): Promise<void> {
  await appendAudit(db, {
    product,
    at: now,
    ...actorColumns(SYSTEM_ACTORS.platform),
    action: "connect.ring.bump",
    target_kind: "connectRing",
    target_id: subject,
    summary: `Roster moved to epoch ${epoch} (${reason}).`,
    reason,
    after_json: JSON.stringify({ epoch, left: left === 1 }),
  });
}

/**
 * The subject's current ring row and the members it was computed for, created on the first read
 * and bumped when the members changed. `load` reads the members; it is called again after every
 * lost race, so a roster is never signed from a member list the row has moved past. The bump is
 * conditional on the epoch AND the hash it read. When a device left, the previous key is not kept:
 * the leaver no longer gets the 24-hour window. Never lowers an epoch.
 */
export async function currentRing(
  db: Db,
  product: string,
  subject: string,
  load: () => Promise<AccountDeviceKeys[]>,
  now: number,
  opts: { reason?: BumpReason; force?: boolean } = {},
): Promise<{ row: RingRow; members: AccountDeviceKeys[]; bumped: boolean }> {
  let force = opts.force === true;
  let bumped = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const members = await load();
    if (members.length > MAX_RING_DEVICES) throw new RingTooLargeError();
    const hash = await membersHash(members);
    const row = await getRing(db, product, subject);
    if (!row) {
      await db.run(
        `INSERT INTO connect_rings
           (product, subject, epoch, members_hash, member_ids, disc_key, prev_disc_key, prev_epoch, bumped_at)
         VALUES (?, ?, 1, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT (product, subject) DO NOTHING`,
        product,
        subject,
        hash,
        idsOf(members),
        randomToken(32),
        now,
      );
      continue;
    }
    if (row.members_hash === hash && !force) return { row, members, bumped };
    // A forced bump is tried once: if it lost the race, the winner's bump already moved the epoch.
    force = false;
    const left = someoneLeft(row.member_ids, members) ? 1 : 0;
    const changed = await db.runChanges(
      `UPDATE connect_rings
          SET epoch = epoch + 1, members_hash = ?, member_ids = ?,
              prev_disc_key = CASE WHEN ? = 1 THEN NULL ELSE disc_key END,
              prev_epoch = CASE WHEN ? = 1 THEN NULL ELSE epoch END,
              disc_key = ?, bumped_at = ?
        WHERE product = ? AND subject = ? AND epoch = ? AND members_hash = ?`,
      hash,
      idsOf(members),
      left,
      left,
      randomToken(32),
      now,
      product,
      subject,
      row.epoch,
      row.members_hash,
    );
    if (changed > 0) {
      bumped = true;
      await auditBump(
        db,
        product,
        subject,
        row.epoch + 1,
        opts.reason,
        left,
        now,
      );
    }
  }
  throw new Error("connect: the ring kept changing under the read");
}

/**
 * The discovery keys to deliver, newest first: the current one, and the previous one for 24 hours
 * after a bump. A device advertises under the first only (§15.4).
 */
export function discKeys(row: RingRow, now: number): string[] {
  const keys = [row.disc_key];
  if (row.prev_disc_key !== null && now - row.bumped_at < PREV_DISC_KEY_SECONDS)
    keys.push(row.prev_disc_key);
  return keys;
}

interface Signer {
  key: string;
  kid: string;
}

/** The `pkey-ring+jws` for the members at the row's epoch. Throws `StrictJsonError` when the
 *  set is not one a verifier would accept (more than 128 devices). */
export function signRoster(
  signer: Signer,
  product: string,
  subject: string,
  row: Pick<RingRow, "epoch">,
  members: readonly AccountDeviceKeys[],
  now: number,
): Promise<string> {
  return signDoc(
    {
      iss: ISSUER,
      aud: product,
      sub: subject,
      epoch: row.epoch,
      issuedAt: now,
      expiresAt: now + RING_SECONDS,
      devices: sortMembers(members).map((m) => ({
        deviceId: m.deviceId,
        signKey: m.signKey,
        agreeKey: m.agreeKey,
      })),
    },
    signer.key,
    signer.kid,
    RING_TYP,
  );
}

/** The `pkey-peer+jws` for one member, at the ring's epoch. */
export function signPeerCert(
  signer: Signer,
  product: string,
  subject: string,
  member: AccountDeviceKeys,
  ringEpoch: number,
  now: number,
): Promise<string> {
  return signDoc(
    {
      iss: ISSUER,
      aud: product,
      sub: subject,
      deviceId: member.deviceId,
      signKey: member.signKey,
      agreeKey: member.agreeKey,
      ringEpoch,
      issuedAt: now,
      expiresAt: now + PEER_CERT_SECONDS,
    },
    signer.key,
    signer.kid,
    PEER_CERT_TYP,
  );
}
