/**
 * THE PLAY EDIT LEASE (A-18e; notes/S-15 §5.3, THREAT-MODEL control (e)).
 *
 * Google Play's only write path is an EDIT. A service account may hold one open edit, and a new
 * edit, a commit or a Console change invalidates every other open one. Before this lease, three
 * callers opened edits on their own schedule: P5-03's poller (one per tick), its controls (one per
 * press) and A-16's `?tracks=1` lister (one per app). A provisioning run that uploads twenty
 * images inside one edit would have been silently invalidated by the next poll tick.
 *
 * So EVERY Play caller that opens an edit first takes this lease on the package, and a caller
 * that finds it held opens nothing:
 *
 *   | Purpose        | Who                                         | TTL   | When it is held          |
 *   | -------------- | ------------------------------------------- | ----- | ------------------------ |
 *   | `provisioning` | the storefront adapter (`storefront.ts`)    | 10 m  | renewed by long uploads  |
 *   | `import`       | A-18c's listing import (read-only edit)     | 5 m   |                          |
 *   | `poll`         | P5-03's tick (`poll.ts`)                    | 2 m   | the tick is SKIPPED      |
 *   | `control`      | P5-03's controls and the vitals auto-halt   | 2 m   | 409 `edit_lease_held`    |
 *   | `lister`       | A-16's `?tracks=1` (`platform.ts`)          | 1 m   | that app shows "busy"    |
 *
 * The lease lives in D1 (`store_edit_leases`, migration 0068), not KV: acquisition must be
 * atomic, and KV has no compare-and-set. It is one upsert whose update applies only over an
 * expired row (`runChanges` answers 1 for the winner), so two racing callers cannot both hold it.
 * A crashed holder blocks nobody for longer than its TTL; only the holder (by its random id) may
 * renew or release it. The TTLs are minutes; Google's own edit expiry (`expiryTimeSeconds`) has no
 * documented duration, so A-18k measures it live (S-15 §12) before the TTLs are tuned.
 *
 * The lease is per PACKAGE (the brief's unit, and the unit edits are scoped to). The `holder`,
 * `purpose` and `actor` columns name a caller kind and an admin `sub`, never a credential.
 */

import type { Db } from "../../../../core/platform.js";

/** The storefront the lease table row belongs to (the adapter id). */
export const PLAY_LEASE_STORE = "google-play";

export type PlayLeasePurpose =
  | "provisioning"
  | "import"
  | "poll"
  | "control"
  | "lister";

/** Seconds each kind of holder keeps the lease before it must renew (see the file comment). */
export const PLAY_LEASE_TTL: Readonly<Record<PlayLeasePurpose, number>> = {
  provisioning: 600,
  import: 300,
  poll: 120,
  control: 120,
  lister: 60,
};

/** A held lease. Keep it to renew or release. */
export interface PlayEditLease {
  readonly packageName: string;
  readonly holder: string;
  readonly purpose: PlayLeasePurpose;
  expiresAt: number;
}

/** Someone else holds the lease: who (a caller kind) and until when. */
export interface PlayLeaseHeld {
  readonly held: true;
  readonly purpose: PlayLeasePurpose;
  readonly expiresAt: number;
}

/** Thrown by `withPlayEditLease` callers that turn a held lease into a failure. */
export class PlayEditLeaseHeld extends Error {
  constructor(
    readonly purpose: PlayLeasePurpose,
    readonly expiresAt: number,
  ) {
    super(
      `Google Play edit lease is held by ${purpose} until ${new Date(
        expiresAt * 1000,
      ).toISOString()}`,
    );
    this.name = "PlayEditLeaseHeld";
  }
}

export interface AcquireOptions {
  packageName: string;
  purpose: PlayLeasePurpose;
  /** `admin:<sub>`, `connector:play`, `connector:play-vitals`. */
  actor: string;
  now: number;
  /** Override the purpose's TTL (seconds, at least 30). */
  ttl?: number;
}

const ACTOR = /^[a-z][a-z0-9-]*:\S{1,200}$/;

/**
 * Take the lease on `packageName`, or answer who holds it. One statement: the insert wins over no
 * row, the update wins only over an expired one; anything else leaves the row unchanged.
 */
export async function acquirePlayEditLease(
  db: Db,
  o: AcquireOptions,
): Promise<PlayEditLease | PlayLeaseHeld> {
  if (!ACTOR.test(o.actor)) throw new Error("invalid lease actor");
  const ttl = Math.max(30, Math.floor(o.ttl ?? PLAY_LEASE_TTL[o.purpose]));
  const holder = crypto.randomUUID();
  const expiresAt = o.now + ttl;
  const won = await db.runChanges(
    `INSERT INTO store_edit_leases (store, app, holder, purpose, actor, acquired_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (store, app) DO UPDATE SET
       holder = excluded.holder, purpose = excluded.purpose, actor = excluded.actor,
       acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
     WHERE store_edit_leases.expires_at <= excluded.acquired_at`,
    PLAY_LEASE_STORE,
    o.packageName,
    holder,
    o.purpose,
    o.actor,
    o.now,
    expiresAt,
  );
  if (won === 1)
    return {
      packageName: o.packageName,
      holder,
      purpose: o.purpose,
      expiresAt,
    };
  const row = await readPlayEditLease(db, o.packageName, o.now);
  // The holder released it between our statement and this read: say it was held (a caller
  // retries on its next tick or press; nothing is opened on a guess).
  return {
    held: true,
    purpose: row?.purpose ?? o.purpose,
    expiresAt: row?.expiresAt ?? o.now,
  };
}

/** The live lease on a package, or null (no row, or an expired one). */
export async function readPlayEditLease(
  db: Db,
  packageName: string,
  now: number,
): Promise<{ purpose: PlayLeasePurpose; expiresAt: number } | null> {
  const row = await db.first<{ purpose: PlayLeasePurpose; expires_at: number }>(
    `SELECT purpose, expires_at FROM store_edit_leases
      WHERE store = ? AND app = ? AND expires_at > ?`,
    PLAY_LEASE_STORE,
    packageName,
    now,
  );
  return row ? { purpose: row.purpose, expiresAt: row.expires_at } : null;
}

/**
 * Extend a held lease (a long upload, the next step of a provisioning plan). False when it has
 * expired or been taken over: the caller must stop, because its edit may no longer be the only one.
 */
export async function renewPlayEditLease(
  db: Db,
  lease: PlayEditLease,
  now: number,
  ttl = PLAY_LEASE_TTL[lease.purpose],
): Promise<boolean> {
  const expiresAt = now + Math.max(30, Math.floor(ttl));
  const changed = await db.runChanges(
    `UPDATE store_edit_leases SET expires_at = ?
      WHERE store = ? AND app = ? AND holder = ? AND expires_at > ?`,
    expiresAt,
    PLAY_LEASE_STORE,
    lease.packageName,
    lease.holder,
    now,
  );
  if (changed === 1) lease.expiresAt = expiresAt;
  return changed === 1;
}

/** Give the lease back (only the holder's own row; idempotent). */
export async function releasePlayEditLease(
  db: Db,
  lease: PlayEditLease,
): Promise<void> {
  await db.run(
    "DELETE FROM store_edit_leases WHERE store = ? AND app = ? AND holder = ?",
    PLAY_LEASE_STORE,
    lease.packageName,
    lease.holder,
  );
}

export function isLeaseHeld(
  v: PlayEditLease | PlayLeaseHeld,
): v is PlayLeaseHeld {
  return (v as PlayLeaseHeld).held === true;
}

/**
 * Run `fn` holding the lease, releasing it afterwards whatever happened. Answers `fn`'s value, or
 * the `PlayLeaseHeld` answer without calling `fn` when someone else holds it.
 */
export async function withPlayEditLease<T>(
  db: Db,
  o: AcquireOptions,
  fn: (lease: PlayEditLease) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; held: PlayLeaseHeld }> {
  const lease = await acquirePlayEditLease(db, o);
  if (isLeaseHeld(lease)) return { ok: false, held: lease };
  try {
    return { ok: true, value: await fn(lease) };
  } finally {
    await releasePlayEditLease(db, lease);
  }
}
