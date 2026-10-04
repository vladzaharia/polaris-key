/**
 * The App Store Connect operation ledger (A-17a; notes/S-14 §7.3): idempotent, resumable,
 * audited writes over an API that has no idempotency mechanism of its own.
 *
 * Every A-17 write handler runs ONE step through `performAscWrite`:
 *
 *   1. **Operation key.** The console sends `Idempotency-Key: <uuid>` per user intent; the step's
 *      `op_id` is `sha256(JSON [scope, product, op, naturalKey, idempotencyKey])`.
 *   2. **Ledger row** (`store_operations`, `store = 'app-store'`). A replay of a done `op_id` answers the stored result
 *      without calling Apple; the same key with a different request body is a `conflict` (409).
 *      A `failed`, `ambiguous` or still-`pending` row is retried under the same key, `find` first.
 *   3. **Natural-key read before write.** `find` looks the object up the way Apple's filters
 *      allow (`filter[identifier]`, the deterministic capability id, `filter[versionString]`…).
 *      When the object already satisfies the intent, nothing is sent (`existing`).
 *   4. **The write**, through the gated client (`writeGate.ts`). Apple's 409 is re-checked with
 *      `find` (A-17h: a duplicate bundle id answers 409 `ENTITY_ERROR.ATTRIBUTE.INVALID`; "already
 *      exists" is success). A timeout, a network failure or a 5xx after a write leaves the row
 *      `ambiguous`: the next attempt runs `find` first, as every attempt does.
 *   5. **Re-read and audit.** `reread` takes Apple's answer, not the request's intent; before and
 *      after are projected (`audit.ts`) onto the row, and ONE audit row is written.
 *
 * Multi-step flows are sequences of such steps; their progress is the rows (`listStoreOperations`).
 */

import type { Db } from "../platform.js";
import { hashKey, sha256Hex } from "../../crypto.js";
import type { AdminSession } from "../adminApi.js";
import { AscError, AscWriteDenied, type AscResource } from "./client.js";
import {
  projectAscResource,
  recordAscAudit,
  type AscProjection,
} from "./audit.js";

export type AscOpScope = "team" | "product";
export type AscOpState = "pending" | "done" | "failed" | "ambiguous";

export interface AscOpKey {
  scope: AscOpScope;
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

/**
 * The `store` every A-17 row carries: the ledger is store-agnostic by name (notes/S-15 owner
 * decision 3) and A-18a's storefront adapters add their own values.
 */
export const ASC_STORE = "app-store";

/** One ledger row, as stored. */
export interface StoreOperationRow {
  op_id: string;
  store: string;
  scope: AscOpScope;
  product: string | null;
  op: string;
  natural_key: string;
  state: AscOpState;
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

function validateKey(k: AscOpKey): void {
  if ((k.scope === "team") !== (k.product === null))
    throw new Error("an ASC operation's product must match its scope");
  if (!OP.test(k.op)) throw new Error("invalid ASC operation name");
  if (!isIdempotencyKey(k.idempotencyKey))
    throw new Error("invalid Idempotency-Key");
  if (k.naturalKey === "" || k.naturalKey.length > 512)
    throw new Error("invalid ASC natural key");
  // Testers' emails are not stored at all (S-14 corrections): no email-shaped natural key.
  if (k.naturalKey.includes("@"))
    throw new Error("an ASC natural key must not carry an email");
}

/**
 * A keyed digest of a TestFlight tester's email, for a natural key and a request hash (A-17c; the
 * S-14 corrections: testers' emails are never stored). HMAC-SHA-256 keyed with the deployment's
 * `KEY_HASH_PEPPER` and the intent's `Idempotency-Key`, which is never stored either: the row's
 * value cannot be confirmed by guessing an email. The same email under the same key gives the
 * same digest, so a retried intent replays instead of inviting twice. 32 hex characters.
 */
export async function ascTesterDigest(
  pepper: string | undefined,
  idempotencyKey: string,
  email: string,
): Promise<string> {
  const digest = await hashKey(
    email.trim().toLowerCase(),
    `asc-tester|${pepper ?? ""}|${idempotencyKey}`,
  );
  return digest.slice(0, 32);
}

/** The derived `op_id` (hex SHA-256 of an unambiguous JSON array). */
export function ascOpId(k: AscOpKey): Promise<string> {
  return sha256Hex(
    JSON.stringify([k.scope, k.product, k.op, k.naturalKey, k.idempotencyKey]),
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
export function ascRequestHash(request: unknown): Promise<string> {
  return sha256Hex(canonicalJson(request));
}

export type AscBegin =
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
  key: AscOpKey,
  request: unknown,
  actor: string,
  now: number,
): Promise<AscBegin> {
  validateKey(key);
  const opId = await ascOpId(key);
  const requestHash = await ascRequestHash(request);
  const inserted = await db.runChanges(
    `INSERT OR IGNORE INTO store_operations
       (op_id, store, scope, product, op, natural_key, state, request_hash, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    opId,
    ASC_STORE,
    key.scope,
    key.product,
    key.op,
    key.naturalKey,
    requestHash,
    actor,
    now,
  );
  if (inserted === 1) return { kind: "proceed", opId, resumed: false };
  const row = await getStoreOperation(db, opId);
  if (!row) throw new Error("ASC ledger row vanished");
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

export type AscFinish =
  | {
      state: "done";
      resultIds: Record<string, string>;
      before: AscProjection | null;
      after: AscProjection | null;
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
  f: AscFinish,
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

/** A scope's newest rows (a flow's resumable progress; the console's step list). */
export function listStoreOperations(
  db: Db,
  scope: { scope: "team" } | { scope: "product"; product: string },
  limit = 50,
): Promise<StoreOperationRow[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  return scope.scope === "team"
    ? db.all<StoreOperationRow>(
        `SELECT * FROM store_operations WHERE scope = 'team'
          ORDER BY created_at DESC, op_id DESC LIMIT ?`,
        n,
      )
    : db.all<StoreOperationRow>(
        `SELECT * FROM store_operations WHERE scope = 'product' AND product = ?
          ORDER BY created_at DESC, op_id DESC LIMIT ?`,
        scope.product,
        n,
      );
}

/** Whether a failed write may still have reached Apple (re-read before trying again). */
export function isAmbiguousFailure(e: unknown): boolean {
  if (e instanceof AscWriteDenied) return false; // refused before anything was sent
  if (e instanceof AscError) return e.status >= 500 || e.status === 0;
  return true; // a network failure or timeout after the request left
}

// ── One idempotent step ──────────────────────────────────────────────────────────────────────

export interface AscWriteStep<T extends AscResource = AscResource> {
  key: AscOpKey;
  /** What the request will carry, hashed to detect a reused key (never stored). */
  request: unknown;
  session: AdminSession;
  now: number;
  /** The natural-key read: the object as it is now, or null. */
  find: () => Promise<T | null>;
  /** Whether an existing object already satisfies the intent. Default: it exists. */
  satisfied?: (existing: T) => boolean;
  /** The gated write. Answers the created or changed resource when Apple returns it. */
  write: (existing: T | null) => Promise<AscResource | null>;
  /** Apple's answer after the write. */
  reread: (id: string) => Promise<AscResource | null>;
  /** Apple ids to keep on the row, from the final object. */
  resultIds: (after: AscResource) => Record<string, string>;
  /** The audit summary (display text: no secret, no email). */
  summary: (after: AscResource, outcome: "written" | "existing") => string;
}

export type AscWriteResult =
  | {
      outcome: "written" | "existing";
      opId: string;
      resultIds: Record<string, string>;
      before: AscProjection | null;
      after: AscProjection | null;
    }
  | { outcome: "replayed"; row: StoreOperationRow }
  | { outcome: "conflict"; opId: string };

/**
 * Run one step: ledger, natural-key read, gated write, re-read, audit. Apple's refusal is
 * recorded (`failed` with its status and code, or `ambiguous`) and re-thrown for the handler to
 * map; a gate refusal is recorded `failed` and re-thrown.
 */
export async function performAscWrite<T extends AscResource>(
  db: Db,
  s: AscWriteStep<T>,
): Promise<AscWriteResult> {
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
  // Until the write is attempted nothing has reached Apple: a failed read leaves the row
  // `pending` (resumable under the same key), it is not a failed write.
  let attempted = false;
  try {
    before = await s.find();
    if (before && satisfied(before)) {
      const after = projectAscResource(before);
      const resultIds = s.resultIds(before);
      await finishStoreOperation(
        db,
        opId,
        { state: "done", resultIds, before: after, after },
        s.now,
      );
      return { outcome: "existing", opId, resultIds, before: after, after };
    }
    let written: AscResource | null;
    attempted = true;
    try {
      written = await s.write(before);
    } catch (e) {
      // Apple's conflict answer for "it already exists" (A-17h): look again.
      if (e instanceof AscError && e.status === 409) {
        const found = await s.find();
        if (found && satisfied(found)) {
          const after = projectAscResource(found);
          const resultIds = s.resultIds(found);
          await finishStoreOperation(
            db,
            opId,
            {
              state: "done",
              resultIds,
              before: projectAscResource(before),
              after,
            },
            s.now,
          );
          return {
            outcome: "existing",
            opId,
            resultIds,
            before: projectAscResource(before),
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
    if (!final) throw new AscError(502, "POST", s.key.op);
    const resultIds = s.resultIds(final);
    const beforeP = projectAscResource(before);
    const afterP = projectAscResource(final);
    await finishStoreOperation(
      db,
      opId,
      { state: "done", resultIds, before: beforeP, after: afterP },
      s.now,
    );
    await recordAscAudit(db, {
      scope: s.key.scope,
      product: s.key.product,
      session: s.session,
      now: s.now,
      op: s.key.op,
      target: { kind: "asc", id: final.id },
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
        vendorStatus: e instanceof AscError ? e.status : null,
        vendorCode: e instanceof AscError ? e.code : null,
      },
      s.now,
    );
    throw e;
  }
}
