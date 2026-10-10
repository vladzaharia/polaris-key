/**
 * THE STORE OPERATION LEDGER (A-17a's App Store Connect ledger, generalised by A-18a; notes/S-14
 * §7.3, notes/S-15 §6.3): idempotent, resumable, audited writes over store APIs that have no
 * idempotency mechanism of their own.
 *
 * Every Worker-plane store write runs ONE step through `performStoreWrite`:
 *
 *   1. **Operation key.** The console sends `Idempotency-Key: <uuid>` per user intent; the step's
 *      `op_id` is `sha256(JSON [store, scope, product, op, naturalKey, idempotencyKey])`.
 *   2. **Ledger row** (`store_operations`, `plane = 'worker'`). A replay of a done `op_id` answers
 *      the stored result without calling the store; the same key with a different request body is
 *      a `conflict` (409). A `failed`, `ambiguous` or still-`pending` row is retried under the
 *      same key, `find` first.
 *   3. **Natural-key read before write.** `find` looks the object up the way the store's filters
 *      allow (Apple's `filter[identifier]`, the deterministic capability id, Play's
 *      `edits.listings.get`…). When the object already satisfies the intent, nothing is sent
 *      (`existing`).
 *   4. **The write**, through the adapter's gated client (`gate.ts`). A 409 is re-checked with
 *      `find` (A-17h: a duplicate bundle id answers 409 `ENTITY_ERROR.ATTRIBUTE.INVALID`; "already
 *      exists" is success). A timeout, a network failure or a 5xx after a write leaves the row
 *      `ambiguous`: the next attempt runs `find` first, as every attempt does.
 *   5. **Re-read and audit.** `reread` takes the store's answer, not the request's intent; before
 *      and after are projected (`audit.ts`, by store and type) onto the row, and ONE audit row is
 *      written.
 *
 * Multi-step flows are sequences of such steps; their progress is the rows (`listStoreOperations`).
 * A CI- or PR-plane step's row (`plane = 'ci' | 'pr'`) is written by the publish action's
 * report-back (A-18h), and a deep-linked step's (`deep-link`) by its verifier (A-18j).
 */

import type { Db } from "../../db/types.js";
import { hashKey } from "../../platform/crypto.js";
import { sha256Hex } from "../../platform/hash.js";
import type { AdminSession } from "../console/session.js";
import type { Plane } from "../adapters/contract.js";
import { storefrontAdapter, type StorefrontId } from "./adapter.js";
import type { CiStoreId } from "./ciPlane.js";
import { StoreVendorError, StoreWriteDenied } from "./errors.js";
import {
  projectStoreResource,
  recordStoreAudit,
  type StoreProjection,
  type StoreResource,
} from "./audit.js";

export type StoreOpScope = "team" | "product";
export type StoreOpState = "pending" | "done" | "failed" | "ambiguous";

/** Where a ledger row's step ran: an adapter `Plane`, or a deep-linked step the operator did. */
export type StoreOpPlane = Plane | "deep-link";

/**
 * A ledger row's store: a storefront adapter, or a CI-plane store whose adapter has not landed yet
 * (`steam`, `msstore`; `epic`, which has none: `ciPlane.ts`).
 */
export type StoreLedgerId = StorefrontId | CiStoreId;

export interface StoreOpKey<S extends StoreLedgerId = StorefrontId> {
  /**
   * The storefront adapter the step goes to (a Worker-plane write's), or any CI-plane store for a
   * reported CI step (`StoreOpKey<StoreLedgerId>`). Part of `op_id`.
   */
  store: S;
  scope: StoreOpScope;
  /** The product slug for product scope; null for team scope. */
  product: string | null;
  /** The operation, e.g. `bundle_id.register`. Lower-case dotted. */
  op: string;
  /**
   * What `find` looks up: an identifier, a version string, a group name. Stored raw in
   * `natural_key`, so it must never be personal data: a key containing `@` is refused. A tester
   * (S-14 §7.3 looks testers up by email) passes a keyed digest of the email instead.
   */
  naturalKey: string;
  /** The console's `Idempotency-Key` for this user intent. */
  idempotencyKey: string;
}

/** One ledger row, as stored. */
export interface StoreOperationRow {
  op_id: string;
  store: string;
  scope: StoreOpScope;
  product: string | null;
  op: string;
  natural_key: string;
  state: StoreOpState;
  plane: StoreOpPlane;
  request_hash: string;
  result_ids_json: string | null;
  before_json: string | null;
  after_json: string | null;
  vendor_status: number | null;
  vendor_code: string | null;
  actor: string;
  created_at: number;
  finished_at: number | null;
}

const OP = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,4}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{8,128}$/;

/** Whether a client's `Idempotency-Key` is acceptable (a UUID or similar token). */
export function isIdempotencyKey(v: unknown): v is string {
  return typeof v === "string" && IDEMPOTENCY_KEY.test(v);
}

const STORE = /^[a-z][a-z0-9-]{0,39}$/;

function validateKey(k: StoreOpKey<StoreLedgerId>): void {
  if (!STORE.test(k.store)) throw new Error("invalid store");
  if ((k.scope === "team") !== (k.product === null))
    throw new Error("a store operation's product must match its scope");
  if (!OP.test(k.op)) throw new Error("invalid store operation name");
  if (!isIdempotencyKey(k.idempotencyKey))
    throw new Error("invalid Idempotency-Key");
  if (k.naturalKey === "" || k.naturalKey.length > 512)
    throw new Error("invalid store natural key");
  // Testers' emails are not stored at all (S-14 corrections): no email-shaped natural key.
  if (k.naturalKey.includes("@"))
    throw new Error("a store natural key must not carry an email");
}

/**
 * A keyed digest of a tester's email, for a natural key and a request hash (A-17c, TestFlight;
 * Play's tester lists later; the S-14 corrections: testers' emails are never stored).
 * HMAC-SHA-256 keyed with the store, the deployment's `KEY_HASH_PEPPER` and the intent's
 * `Idempotency-Key`, which is never stored either: the row's value cannot be confirmed by guessing
 * an email. The same email under the same key gives the same digest, so a retried intent replays
 * instead of inviting twice. 32 hex characters. The App Store's salt is A-17c's (`asc-tester`), so
 * its digests are unchanged.
 */
export async function testerDigest(
  store: StorefrontId,
  pepper: string | undefined,
  idempotencyKey: string,
  email: string,
): Promise<string> {
  const digest = await hashKey(
    email.trim().toLowerCase(),
    `${targetKind(store)}-tester|${pepper ?? ""}|${idempotencyKey}`,
  );
  return digest.slice(0, 32);
}

/** The derived `op_id` (hex SHA-256 of an unambiguous JSON array, the store first). */
export function storeOpId(k: StoreOpKey<StoreLedgerId>): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      k.store,
      k.scope,
      k.product,
      k.op,
      k.naturalKey,
      k.idempotencyKey,
    ]),
  );
}

/** JSON with object keys sorted, so equal requests hash equally. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/**
 * The request hash a replay is compared with. Unsalted SHA-256: a caller keeps personal data (a
 * tester's email) out of `request`, or digests it first, so the stored hash cannot be reversed by
 * guessing.
 */
export function storeRequestHash(request: unknown): Promise<string> {
  return sha256Hex(canonicalJson(request));
}

export type StoreBegin =
  /** A fresh row (`pending`), or one not done (`pending` from a crash or a failed read,
   *  `ambiguous`, `failed`): go on, `find` first. */
  | { kind: "proceed"; opId: string; resumed: boolean }
  /** Done: answer the stored row, call nothing. */
  | { kind: "replay"; row: StoreOperationRow }
  /** The same key with a different body. */
  | { kind: "conflict"; opId: string };

/** Open (or find) the ledger row of one step. */
export async function beginStoreOperation(
  db: Db,
  key: StoreOpKey<StoreLedgerId>,
  request: unknown,
  actor: string,
  now: number,
  plane: StoreOpPlane = "worker",
): Promise<StoreBegin> {
  validateKey(key);
  const opId = await storeOpId(key);
  const requestHash = await storeRequestHash(request);
  const inserted = await db.runChanges(
    `INSERT OR IGNORE INTO store_operations
       (op_id, store, scope, product, op, natural_key, state, request_hash, actor, created_at, plane)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    opId,
    key.store,
    key.scope,
    key.product,
    key.op,
    key.naturalKey,
    requestHash,
    actor,
    now,
    plane,
  );
  if (inserted === 1) return { kind: "proceed", opId, resumed: false };
  const row = await getStoreOperation(db, opId);
  if (!row) throw new Error("store ledger row vanished");
  if (row.request_hash !== requestHash) return { kind: "conflict", opId };
  if (row.state === "done") return { kind: "replay", row };
  return { kind: "proceed", opId, resumed: true };
}

export function getStoreOperation(
  db: Db,
  opId: string,
): Promise<StoreOperationRow | null> {
  return db.first<StoreOperationRow>(
    "SELECT * FROM store_operations WHERE op_id = ?",
    opId,
  );
}

export type StoreFinish =
  | {
      state: "done";
      resultIds: Record<string, string>;
      before: StoreProjection | null;
      after: StoreProjection | null;
    }
  | {
      state: "failed" | "ambiguous";
      vendorStatus: number | null;
      vendorCode: string | null;
    };

/** Close a step's row. */
export async function finishStoreOperation(
  db: Db,
  opId: string,
  f: StoreFinish,
  now: number,
): Promise<void> {
  if (f.state === "done")
    await db.run(
      `UPDATE store_operations
          SET state = 'done', result_ids_json = ?, before_json = ?, after_json = ?,
              vendor_status = NULL, vendor_code = NULL, finished_at = ?
        WHERE op_id = ?`,
      JSON.stringify(f.resultIds),
      f.before === null ? null : JSON.stringify(f.before),
      f.after === null ? null : JSON.stringify(f.after),
      now,
      opId,
    );
  else
    await db.run(
      `UPDATE store_operations
          SET state = ?, vendor_status = ?, vendor_code = ?, finished_at = ?
        WHERE op_id = ?`,
      f.state,
      f.vendorStatus,
      f.vendorCode,
      now,
      opId,
    );
}

/**
 * A scope's newest rows (a flow's resumable progress; the console's step list), every store's or
 * one store's.
 */
export function listStoreOperations(
  db: Db,
  scope: { scope: "team" } | { scope: "product"; product: string },
  limit = 50,
  store?: StoreLedgerId,
): Promise<StoreOperationRow[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const byStore = store === undefined ? "" : " AND store = ?";
  const storeArg = store === undefined ? [] : [store];
  return scope.scope === "team"
    ? db.all<StoreOperationRow>(
        `SELECT * FROM store_operations WHERE scope = 'team'${byStore}
          ORDER BY created_at DESC, op_id DESC LIMIT ?`,
        ...storeArg,
        n,
      )
    : db.all<StoreOperationRow>(
        `SELECT * FROM store_operations WHERE scope = 'product' AND product = ?${byStore}
          ORDER BY created_at DESC, op_id DESC LIMIT ?`,
        scope.product,
        ...storeArg,
        n,
      );
}

/** Whether a failed write may still have reached the store (re-read before trying again). */
export function isAmbiguousFailure(e: unknown): boolean {
  if (e instanceof StoreWriteDenied) return false; // refused before anything was sent
  if (e instanceof StoreVendorError) return e.status >= 500 || e.status === 0;
  return true; // a network failure or timeout after the request left
}

// ── One idempotent step ──────────────────────────────────────────────────────────────────────

export interface StoreWriteStep<T extends StoreResource = StoreResource> {
  key: StoreOpKey;
  /** What the request will carry, hashed to detect a reused key (never stored). */
  request: unknown;
  session: AdminSession;
  now: number;
  /** The natural-key read: the object as it is now, or null. */
  find: () => Promise<T | null>;
  /** Whether an existing object already satisfies the intent. Default: it exists. */
  satisfied?: (existing: T) => boolean;
  /** The gated write. Answers the created or changed resource when the store returns it. */
  write: (existing: T | null) => Promise<StoreResource | null>;
  /** The store's answer after the write. */
  reread: (id: string) => Promise<StoreResource | null>;
  /** Store ids to keep on the row, from the final object. */
  resultIds: (after: StoreResource) => Record<string, string>;
  /** The audit summary (display text: no secret, no email). */
  summary: (after: StoreResource, outcome: "written" | "existing") => string;
}

export type StoreWriteResult =
  | {
      outcome: "written" | "existing";
      opId: string;
      resultIds: Record<string, string>;
      before: StoreProjection | null;
      after: StoreProjection | null;
    }
  | { outcome: "replayed"; row: StoreOperationRow }
  | { outcome: "conflict"; opId: string };

/**
 * Run one step: ledger, natural-key read, gated write, re-read, audit. The store's refusal is
 * recorded (`failed` with its status and code, or `ambiguous`) and re-thrown for the handler to
 * map; a gate refusal is recorded `failed` and re-thrown.
 */
export async function performStoreWrite<T extends StoreResource>(
  db: Db,
  s: StoreWriteStep<T>,
): Promise<StoreWriteResult> {
  const begun = await beginStoreOperation(
    db,
    s.key,
    s.request,
    s.session.sub,
    s.now,
  );
  if (begun.kind === "replay") return { outcome: "replayed", row: begun.row };
  if (begun.kind === "conflict")
    return { outcome: "conflict", opId: begun.opId };
  const { opId } = begun;
  const satisfied = s.satisfied ?? (() => true);
  let before: T | null = null;
  const project = (r: StoreResource | null) =>
    projectStoreResource(s.key.store, r);
  // Until the write is attempted nothing has reached the store: a failed read leaves the row
  // `pending` (resumable under the same key), it is not a failed write.
  let attempted = false;
  try {
    before = await s.find();
    if (before && satisfied(before)) {
      const after = project(before);
      const resultIds = s.resultIds(before);
      await finishStoreOperation(
        db,
        opId,
        { state: "done", resultIds, before: after, after },
        s.now,
      );
      return { outcome: "existing", opId, resultIds, before: after, after };
    }
    let written: StoreResource | null;
    attempted = true;
    try {
      written = await s.write(before);
    } catch (e) {
      // The store's conflict answer for "it already exists" (A-17h for Apple): look again.
      if (e instanceof StoreVendorError && e.status === 409) {
        const found = await s.find();
        if (found && satisfied(found)) {
          const after = project(found);
          const resultIds = s.resultIds(found);
          await finishStoreOperation(
            db,
            opId,
            {
              state: "done",
              resultIds,
              before: project(before),
              after,
            },
            s.now,
          );
          return {
            outcome: "existing",
            opId,
            resultIds,
            before: project(before),
            after,
          };
        }
      }
      throw e;
    }
    const id = written?.id ?? before?.id;
    // The write landed: a failed re-read must not turn it into a failure.
    const reread = id ? await s.reread(id).catch(() => null) : null;
    const final = reread ?? written ?? before;
    if (!final)
      throw new StoreVendorError(
        502,
        null,
        `${s.key.store} ${s.key.op}: the write answered nothing to re-read`,
      );
    const resultIds = s.resultIds(final);
    const beforeP = project(before);
    const afterP = project(final);
    await finishStoreOperation(
      db,
      opId,
      { state: "done", resultIds, before: beforeP, after: afterP },
      s.now,
    );
    await recordStoreAudit(db, {
      store: s.key.store,
      scope: s.key.scope,
      product: s.key.product,
      session: s.session,
      now: s.now,
      op: s.key.op,
      target: { kind: targetKind(s.key.store), id: final.id },
      summary: s.summary(final, "written"),
      opId,
      before: beforeP,
      after: afterP,
    });
    return {
      outcome: "written",
      opId,
      resultIds,
      before: beforeP,
      after: afterP,
    };
  } catch (e) {
    if (!attempted) throw e;
    await finishStoreOperation(
      db,
      opId,
      {
        state: isAmbiguousFailure(e) ? "ambiguous" : "failed",
        vendorStatus: e instanceof StoreVendorError ? e.status : null,
        vendorCode: e instanceof StoreVendorError ? e.code : null,
      },
      s.now,
    );
    throw e;
  }
}

/** A store's audit target kind: its adapter's audit action (`asc` for the App Store, as A-17 wrote it). */
function targetKind(store: StoreLedgerId): string {
  return storefrontAdapter(store)?.audit.action ?? store;
}
