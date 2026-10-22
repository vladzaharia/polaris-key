/// <reference types="@cloudflare/workers-types" />
import { D1Db } from "../../../db/d1.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { absorbSettings } from "../engine/absorb.js";
import { applyPull, collectTombstones } from "../engine/pull.js";
import { applyPush } from "../engine/push.js";
import { validatePush } from "../engine/validate.js";
import type { CatalogMigrations, SyncStore } from "../engine/types.js";
import type {
  CloudSyncError,
  CloudSyncOp,
  CloudSyncReply,
  ExportDocument,
  WireMigrations,
} from "./protocol.js";
import { parseExportDocument, parsePolicies } from "./exportDoc.js";
import {
  IDLE_RETENTION_SECONDS,
  ageMarks,
  buildFlush,
  flushDueAt,
  markDirty,
  recordWrite,
} from "./directory.js";
import { SCHEMA_VERSION, SqlStore } from "./sqlStore.js";

// One person's Cloud Sync store for one product (U-05.6; plans/U-05-slices.md §2). The Worker
// classifies a push (catalog, quota, pause, trust) and this object applies it with the engine's
// rules over its own SQLite database; it never reads the catalog, settings, licences or D1.
//
// Isolation (SR-1). The object is addressed by `idFromName(product:subject)` in `do/client.ts`
// (U-05.7), and every request also carries the pair. The first write pins it into `meta`; after
// that a request for any other product or subject is refused before anything is read, so a
// misrouted call can neither read nor write another person's data. There is exactly one person's
// data in a database, so `exportAll` is that person's and nobody else's.
//
// Lazy: a pull, a usage read or an export on an object that was never written touches no table
// (it answers empty); the first push creates the schema, in one transaction with the pin.
// Operations are serialised by the storage input gate, and a push runs in `transactionSync`.
//
// The directory (U-05.9, `do/directory.ts`). A write marks the object dirty and an alarm flushes
// the D1 directory row and the day's counters: the first write at once, later ones at most every
// 15 minutes. The same alarm expires idle client bindings and collects old tombstones. The alarm
// runs under `blockConcurrencyWhile`, so a `deleteAll` cannot interleave with its D1 await; and
// it returns at once for an object without a pin (nothing recreates a row after `deleteAll`).

const reply = (body: CloudSyncReply | CloudSyncError, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const isName = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256;

function migrationsOf(
  w: WireMigrations | undefined,
): CatalogMigrations | undefined {
  if (!w) return undefined;
  return { renamedTo: new Map(w.renamedTo), dropped: new Set(w.dropped) };
}

/** Seams for tests; production passes none. */
export interface CloudSyncDoOptions {
  /** The D1 handle the alarm writes (default: the `DB` binding). */
  db?: () => Db;
  /** The clock in milliseconds (default `Date.now`). */
  now?: () => number;
}

export class CloudSyncDO implements DurableObject {
  private readonly store: SqlStore;
  private readonly now: () => number;
  private readonly db: () => Db;

  constructor(
    private readonly ctx: DurableObjectState,
    env: Env,
    opts: CloudSyncDoOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.store = new SqlStore(ctx.storage, () => Math.floor(this.now() / 1000));
    this.db = opts.db ?? (() => new D1Db(env.DB));
  }

  /**
   * The flush alarm (see the header). Idempotent: a clean object does nothing. A D1 failure
   * throws, so the runtime retries the alarm with backoff; the object stays dirty until D1 took
   * the batch.
   */
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const pin = this.pinned();
      if (!pin || this.store.schemaVersion() !== SCHEMA_VERSION) return;
      const nowMs = this.now();
      // Local housekeeping first: it cannot fail on D1, and it runs even when a flush is due.
      this.ctx.storage.transactionSync(() => {
        const marks = ageMarks(this.store, nowMs, this.store.currentSeq());
        if (marks.throughSeq > 0)
          collectTombstones(this.store, marks.throughSeq);
        this.store.expireClients(
          Math.floor(nowMs / 1000) - IDLE_RETENTION_SECONDS,
        );
      });
      const flush = buildFlush(this.store, pin, this.store.getUsage(), nowMs);
      if (!flush) return;
      await this.db().batch(flush.statements);
      this.ctx.storage.transactionSync(() => flush.commit(nowMs));
    });
  }

  /** Schedules the flush if one is due and none is already set. */
  private async scheduleFlush(): Promise<void> {
    const at = flushDueAt(this.store, this.now());
    if (at === null) return;
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(at);
  }

  private pinned(): { product: string; subject: string } | null {
    const product = this.store.getMeta("product");
    const subject = this.store.getMeta("subject");
    return product !== undefined && subject !== undefined
      ? { product, subject }
      : null;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return reply({ error: "bad_request" }, 405);
    let op: CloudSyncOp;
    try {
      op = (await request.json()) as CloudSyncOp;
    } catch {
      return reply({ error: "bad_request" }, 400);
    }
    if (!op || !isName(op.product) || !isName(op.subject))
      return reply({ error: "bad_request" }, 400);

    // A schema from a newer build must not be touched by this one.
    if (this.store.schemaVersion() > SCHEMA_VERSION)
      return reply({ error: "unsupported_schema" }, 500);
    const pin = this.pinned();
    if (pin && (pin.product !== op.product || pin.subject !== op.subject))
      return reply({ error: "pin_mismatch" }, 403);

    switch (op.op) {
      case "push":
        return this.push(op);
      case "pull":
        return this.pull(op);
      case "usage": {
        this.migrateIfBehind();
        return reply({
          op: "usage",
          usage: this.store.getUsage(),
          seq: this.store.currentSeq(),
          empty: this.store.isEmpty(),
        });
      }
      case "exportAll":
        return reply({ op: "exportAll", document: this.exportAll(op) });
      case "absorb":
        return this.absorb(op);
      case "deleteAll": {
        // An absorbed object is deleted only while it is the one that was exported (U-05.8): a
        // write that landed since stays, and the merge absorbs again. No `ifSeq` is an erasure.
        if (op.ifSeq !== undefined && this.store.currentSeq() !== op.ifSeq)
          return reply({ op: "deleteAll", deleted: false });
        // deleteAll does not clear an alarm; the order here is the point (no wake-up on a ghost).
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.store.reset();
        return reply({ op: "deleteAll", deleted: true });
      }
      default:
        return reply({ error: "bad_request" }, 400);
    }
  }

  /** Reads migrate an existing older schema but never create one. */
  private migrateIfBehind(): void {
    this.store.prepare(false);
  }

  private async push(
    op: Extract<CloudSyncOp, { op: "push" }>,
  ): Promise<Response> {
    if (
      !isName(op.deviceId) ||
      typeof op.serverNow !== "number" ||
      !Array.isArray(op.classified)
    )
      return reply({ error: "bad_request" }, 400);
    const shape = validatePush(op.request);
    // A malformed batch is the engine's own request-level answer and creates nothing.
    if (!shape.ok)
      return reply({
        op: "push",
        outcome: { ok: false, error: "bad_request", reason: shape.reason },
      });
    if (op.classified.length !== shape.request.mutations.length)
      return reply({ error: "bad_request" }, 400);
    // The first write: make the schema and pin the pair together, so an object is never half-made.
    this.ctx.storage.transactionSync(() => {
      this.store.prepare(true);
      if (!this.pinned()) {
        this.store.setMeta("product", op.product);
        this.store.setMeta("subject", op.subject);
      }
    });
    const outcome = this.store.transaction(() => {
      const out = applyPush(this.store as SyncStore, {
        deviceId: op.deviceId,
        ...(op.family ? { family: op.family } : {}),
        ...(op.limits ? { limits: op.limits } : {}),
        ...(op.migrations ? { migrations: migrationsOf(op.migrations) } : {}),
        request: op.request,
        classified: op.classified,
        serverNow: op.serverNow,
      });
      // An exchange the engine accepted: the directory and the day's counters follow (U-05.9).
      if (out.ok)
        recordWrite(this.store, {
          nowMs: this.now(),
          quotaBytes: op.limits?.quotaBytes ?? 0,
          tierId: op.tierId,
          platform: op.family,
          syncs: 1,
          conflicts: out.counts.conflicts,
        });
      return out;
    });
    if (outcome.ok) await this.scheduleFlush();
    return reply({ op: "push", outcome });
  }

  /**
   * Account merge, survivor side (U-05.8): join the absorbed subject's export into this object in
   * one transaction (the schema and pin included, so an object is never half-made). The join is
   * idempotent (`engine/absorb.ts`), so a retry writes nothing. Nothing is refused for budget or
   * quota (L8). Marks the directory dirty when anything changed (U-05.9 reads the flag).
   */
  private async absorb(
    op: Extract<CloudSyncOp, { op: "absorb" }>,
  ): Promise<Response> {
    const doc = op.document;
    const parsed = parseExportDocument(doc);
    const policies = parsePolicies(op.policies);
    // The same product, and another person: an absorb of oneself would delete one's own data.
    if (
      !parsed ||
      policies === null ||
      doc.product !== op.product ||
      doc.subject === op.subject ||
      !isName(doc.subject)
    )
      return reply({ error: "bad_request" }, 400);
    if (parsed.settings.length === 0 && parsed.clients.length === 0)
      return reply({ op: "absorb", changed: 0 });
    let changed = 0;
    try {
      this.ctx.storage.transactionSync(() => {
        this.store.prepare(true);
        if (!this.pinned()) {
          this.store.setMeta("product", op.product);
          this.store.setMeta("subject", op.subject);
        }
        const out = this.store.transaction(() =>
          absorbSettings(this.store as SyncStore, {
            settings: parsed.settings,
            clients: parsed.clients,
            ...(policies ? { policies } : {}),
          }),
        );
        changed = out.rows + out.clients;
        if (changed > 0) markDirty(this.store);
      });
    } catch (e) {
      // A rolled-back first write took the tables with it; forget the cached probe.
      this.store.reset();
      throw e;
    }
    if (changed > 0) await this.scheduleFlush();
    return reply({ op: "absorb", changed });
  }

  private pull(op: Extract<CloudSyncOp, { op: "pull" }>): Response {
    if (!isName(op.deviceId) || !isName(op.family))
      return reply({ error: "bad_request" }, 400);
    this.migrateIfBehind();
    const outcome = applyPull(this.store, {
      ...(op.cursor !== undefined ? { cursor: op.cursor } : {}),
      ...(op.clientId ? { clientId: op.clientId } : {}),
      deviceId: op.deviceId,
      family: op.family,
    });
    return reply({ op: "pull", outcome });
  }

  private exportAll(op: {
    product: string;
    subject: string;
  }): ExportDocument | null {
    this.migrateIfBehind();
    if (!this.pinned()) return null;
    return {
      product: op.product,
      subject: op.subject,
      seq: this.store.currentSeq(),
      watermark: this.store.getWatermark(),
      usage: this.store.getUsage(),
      settings: this.store.settingsAfter(0).map(({ members, ...row }) => ({
        ...row,
        ...(members ? { members: [...members] } : {}),
      })),
      clients: this.store.clients(),
    };
  }
}
