/**
 * Core's subject hooks (I-05; plans/I-04.md §6.2): the clearing hook for the device binding, the
 * licence-ownership revocation hook, and the registry through which every store of account ×
 * product data hears about merges and deletions.
 *
 * Identity calls these; Config (U-03) and Cloud Sync (U-05) register into the registry. Because
 * all of it is Core, neither of them imports Identity and Identity imports neither (rule 6).
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { revokeAllRegistryTokens } from "../registry/registryTokens.js";
import { mirrorTokenSubject } from "./accountSubjects.js";
import { retireDeviceBinding, writeDeviceSubject } from "../devices.js";

// ── The registry of account × product data ──────────────────────────────────────────────────

/** What a hook gets besides its arguments. */
export interface SubjectStoreContext {
  db: Db;
  env: Env;
  now: number;
}

/**
 * A store keyed by pairwise subject (managed config overrides, Cloud Sync data, later the layer 2
 * app profile). Every such store registers once, at module load, under a stable name.
 */
export interface SubjectStore {
  /** Re-key `from`'s data to `to` for one product (an account merge, D21). A collision (both
   *  hold data) is the store's to resolve and must never silently overwrite (S-16 §5.1). Runs
   *  BEFORE, and outside, the merge's atomic D1 batch, so it must be idempotent: a merge whose
   *  batch failed is retried and calls it again with the same arguments. */
  merge(
    ctx: SubjectStoreContext,
    args: { product: string; from: string; to: string },
  ): Promise<void>;
  /** Delete the subject's data for one product (per-product removal, account deletion). Called
   *  BEFORE the subject row goes, so the store can still resolve what it holds. */
  delete(
    ctx: SubjectStoreContext,
    args: { product: string; subject: string },
  ): Promise<void>;
  /** The subject's data for one product, for a per-product export. Optional in the type until
   *  I-11 calls it; the registry guard (`test/subjectStores.test.ts`) requires it of every store
   *  that declares a table or a Durable Object class (plans/U-01.md §6.1). */
  export?(
    ctx: SubjectStoreContext,
    args: { product: string; subject: string },
  ): Promise<unknown>;
  /** How many bytes the subject's data for one product takes (the console Users page's account ×
   *  product data size, I-12). Optional: a store without it counts as 0. */
  size?(
    ctx: SubjectStoreContext,
    args: { product: string; subject: string },
  ): Promise<number>;
  /** U-02: the D1 tables this store keeps keyed by pairwise subject. The registry guard fails
   *  for any table with a subject column that no store claims and that is not Identity's own. */
  tables?: readonly string[];
  /** U-02: the Durable Object classes this store names by subject (Cloud Sync's
   *  `idFromName("<product>:<subject>")`). The guard fails for an unclassified class. */
  durableObjects?: readonly string[];
}

const STORES = new Map<string, SubjectStore>();

/**
 * Register a subject-keyed store. Names are unique: registering one twice is a programming error
 * (two modules claiming one table), so it throws rather than silently replacing the first.
 * `test/subjectStores.test.ts` (U-02) fails when a subject-keyed table or Durable Object class
 * has no registration, or a registration lacks `merge`, `delete` or `export`.
 */
export function registerSubjectStore(name: string, store: SubjectStore): void {
  if (STORES.has(name)) {
    throw new Error(`subject store "${name}" is already registered`);
  }
  STORES.set(name, store);
}

/** Remove a registration (tests only: the registry is module state). */
export function unregisterSubjectStore(name: string): void {
  STORES.delete(name);
}

/** The registered stores by name, sorted (for the registry guard test). */
export function subjectStores(): Array<[string, SubjectStore]> {
  return subjectStoreNames().map((n) => [n, STORES.get(n)!]);
}

/** The registered store names, sorted (for the guard test and diagnostics). */
export function subjectStoreNames(): string[] {
  return [...STORES.keys()].sort();
}

/** Run every store's `merge` for one product, in name order. */
export async function runSubjectMerge(
  ctx: SubjectStoreContext,
  args: { product: string; from: string; to: string },
): Promise<void> {
  for (const name of subjectStoreNames()) {
    await STORES.get(name)!.merge(ctx, args);
  }
}

/** Run every store's `delete` for one product, in name order. */
export async function runSubjectDelete(
  ctx: SubjectStoreContext,
  args: { product: string; subject: string },
): Promise<void> {
  for (const name of subjectStoreNames()) {
    await STORES.get(name)!.delete(ctx, args);
  }
}

/**
 * Like {@link runSubjectDelete}, but fault-isolated per store (SEC-PRV-1): every store gets its
 * turn even when an earlier one threw, and the failures come back by store name instead of
 * aborting the run. Account erasure uses it so one failing store cannot leave the others
 * undeleted, and so the retry knows which store to run again. A store's `delete` is idempotent.
 */
export async function runSubjectDeleteIsolated(
  ctx: SubjectStoreContext,
  args: { product: string; subject: string },
): Promise<Array<{ store: string; error: unknown }>> {
  const failures: Array<{ store: string; error: unknown }> = [];
  for (const name of subjectStoreNames()) {
    try {
      await STORES.get(name)!.delete(ctx, args);
    } catch (error) {
      failures.push({ store: name, error });
    }
  }
  return failures;
}

/**
 * Every store's export for one product, keyed by store name (the console's per-subject export,
 * I-12; the portal's per-product export, I-11). A store without `export` is listed as `null`, so
 * the export says the store exists and holds nothing it can hand out.
 */
export async function runSubjectExport(
  ctx: SubjectStoreContext,
  args: { product: string; subject: string },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const name of subjectStoreNames()) {
    const store = STORES.get(name)!;
    out[name] = store.export ? await store.export(ctx, args) : null;
  }
  return out;
}

/** The subject's data size for one product, per store and in total (bytes). */
export async function subjectDataSize(
  ctx: SubjectStoreContext,
  args: { product: string; subject: string },
): Promise<{ total: number; stores: Array<{ name: string; bytes: number }> }> {
  const stores: Array<{ name: string; bytes: number }> = [];
  let total = 0;
  for (const name of subjectStoreNames()) {
    const store = STORES.get(name)!;
    const bytes = store.size ? Math.max(0, await store.size(ctx, args)) : 0;
    stores.push({ name, bytes });
    total += bytes;
  }
  return { total, stores };
}

// ── The clearing hook ───────────────────────────────────────────────────────────────────────

/**
 * Why a binding is cleared. Plain licence DETACH is deliberately absent: detaching a licence from
 * the account does not sign the device out (S-17 §5.8 item 2; corrects S-16 §5.1's table).
 */
export type ClearReason =
  | "signout"
  | "signout_everywhere"
  | "account_disabled"
  | "account_deleted"
  | "product_removed"
  | "relinked"
  /** PX-W17: the product's Identity service was turned off. Every binding of the product goes;
   *  no seat is ever released for this reason, whatever `bound_by` says. */
  | "identity_disabled"
  /** PX-W12: an account join was undone and the device's subject changed hands; it binds again
   *  at its next sign-in. No seat is released. */
  | "merge_undone";

/** Which devices a clear reaches. */
export type ClearScope =
  | { kind: "device"; product: string; deviceId: string }
  | { kind: "subject"; product: string; subject: string }
  | { kind: "account"; accountId: string }
  | { kind: "license"; product: string; licenseId: string }
  /** PX-W17: every bound device of one product (Identity turned off). */
  | { kind: "product"; product: string };

interface BoundDevice {
  product: string;
  device_id: string;
  token_hash: string | null;
  license_id: string;
  subject: string;
  bound_by: string | null;
  status: string;
}

async function boundDevices(db: Db, scope: ClearScope): Promise<BoundDevice[]> {
  const cols =
    "d.product, d.device_id, d.token_hash, d.license_id, d.subject, d.bound_by, d.status";
  switch (scope.kind) {
    case "device":
      return db.all<BoundDevice>(
        `SELECT ${cols} FROM devices d
          WHERE d.product = ? AND d.device_id = ? AND d.subject IS NOT NULL`,
        scope.product,
        scope.deviceId,
      );
    case "subject":
      // The subject itself and every alias that resolves to it (a device bound before a merge).
      return db.all<BoundDevice>(
        `SELECT ${cols} FROM devices d
          WHERE d.product = ? AND d.subject IS NOT NULL
            AND (d.subject = ? OR d.subject IN (
              SELECT alias FROM account_product_subject_aliases WHERE product = ? AND subject = ?))`,
        scope.product,
        scope.subject,
        scope.product,
        scope.subject,
      );
    case "account":
      return db.all<BoundDevice>(
        `SELECT ${cols} FROM devices d
           JOIN account_product_subjects s ON s.product = d.product
          WHERE s.account_id = ? AND d.subject IS NOT NULL
            AND (d.subject = s.subject OR d.subject IN (
              SELECT alias FROM account_product_subject_aliases a
               WHERE a.product = s.product AND a.subject = s.subject))`,
        scope.accountId,
      );
    case "license":
      return db.all<BoundDevice>(
        `SELECT ${cols} FROM devices d
          WHERE d.product = ? AND d.license_id = ? AND d.subject IS NOT NULL`,
        scope.product,
        scope.licenseId,
      );
    case "product":
      return db.all<BoundDevice>(
        `SELECT ${cols} FROM devices d
          WHERE d.product = ? AND d.subject IS NOT NULL`,
        scope.product,
      );
  }
}

/**
 * The clearing hook: drop the device binding (`devices.subject`) on every device in `scope`, and
 * its KV mirror. Sign-out (and sign out everywhere) also RELEASES a device, deauthorizing it, when
 * it was bound by the sign-in (`bound_by = 'signin'`) and runs a licence of the signed-out account
 * (plans/I-04.md §8 Q3); every other device keeps its licence and token and only loses the
 * binding. Answers how many bindings were cleared and which devices were released.
 */
export async function clearDeviceSubjects(
  db: Db,
  env: Env,
  scope: ClearScope,
  reason: ClearReason,
): Promise<{ cleared: number; released: string[] }> {
  const devices = await boundDevices(db, scope);
  const released: string[] = [];
  for (const d of devices) {
    await writeDeviceSubject(db, d.product, d.device_id, null);
    if (
      (reason === "signout" || reason === "signout_everywhere") &&
      d.bound_by === "signin" &&
      d.status === "authorized" &&
      d.license_id !== "" &&
      (await licenseOwnedBySubjectAccount(db, d))
    ) {
      await retireDeviceBinding(env, db, d.product, d.device_id, d.token_hash);
      released.push(`${d.product}:${d.device_id}`);
      continue;
    }
    await mirrorTokenSubject(env, d.product, d.token_hash, null);
  }
  return { cleared: devices.length, released };
}

/** Does the device's licence belong to the account its (possibly aliased) subject names? */
async function licenseOwnedBySubjectAccount(
  db: Db,
  d: BoundDevice,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one
       FROM licenses l
       JOIN account_product_subjects s ON s.account_id = l.account_id AND s.product = l.product
      WHERE l.product = ? AND l.id = ?
        AND (s.subject = ? OR s.subject = (
          SELECT subject FROM account_product_subject_aliases WHERE product = ? AND alias = ?))`,
    d.product,
    d.license_id,
    d.subject,
    d.product,
    d.subject,
  );
  return row !== null;
}

// ── The licence-ownership hook ──────────────────────────────────────────────────────────────

/** Why an account stopped owning a licence. */
export type OwnershipEndReason = "detached" | "relinked" | "account_deleted";

/**
 * An account stopped owning a licence (its owner detached it, a developer relinked it, or the
 * account was deleted). F-21: every live registry token that account minted bound to this licence
 * is revoked, so a credential never outlives the ownership that justified it. I-11 extends this
 * hook as its surfaces need; it is the one place the consequence of losing a licence is decided.
 */
export async function onLicenseOwnershipEnded(
  db: Db,
  _env: Env,
  args: {
    product: string;
    licenseId: string;
    accountId: string;
    reason: OwnershipEndReason;
    now: number;
  },
): Promise<{ revokedTokens: number }> {
  const revokedTokens = await revokeAllRegistryTokens(
    db,
    args.product,
    `portal:${args.accountId}`,
    args.reason === "account_deleted" ? "account_deleted" : "link_removed",
    args.now,
    { licenseId: args.licenseId, portalAccountId: args.accountId },
  );
  return { revokedTokens };
}
