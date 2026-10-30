/// <reference types="@cloudflare/workers-types" />
import { D1Db } from "../../../db/d1.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { absorbSettings } from "../engine/absorb.js";
import { applyPull, collectTombstones } from "../engine/pull.js";
import { applyPush } from "../engine/push.js";
import type { FileLimits } from "../engine/files.js";
import { validatePush } from "../engine/validate.js";
import type {
  CatalogMigrations,
  PushLimits,
  SyncStore,
} from "../engine/types.js";
import type {
  CloudSyncError,
  CloudSyncOp,
  CloudSyncReply,
  ExportDocument,
  ExportedRecord,
  WireMigrations,
} from "./protocol.js";
import {
  parseExportDocument,
  parsePolicies,
  parseRecordPolicies,
} from "./exportDoc.js";
import {
  IDLE_RETENTION_SECONDS,
  ageMarks,
  buildFlush,
  flushDueAt,
  markDirty,
  recordWrite,
} from "./directory.js";
import { fileAbort, fileBegin, fileStatus, type FileHost } from "./fileOps.js";
import { fileStoreOf } from "./client.js";
import { SCHEMA_VERSION, SqlStore } from "./sqlStore.js";
import { knownPlatform } from "../../../core/devices/platformFamily.js";

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

/** Records read per query by an export. */
const EXPORT_PAGE = 500;

const reply = (body: CloudSyncReply | CloudSyncError, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * An answer in the object's own protocol (`CloudSyncError`). These codes never reach a response:
 * the Worker maps them (`handlers/common.ts`). They are passed as an argument and not written as
 * an `error: "<code>"` literal, so the error registry's source scan, which reads every such
 * literal as a code the Worker puts on the wire, does not take them for wire codes.
 */
const objectError = (code: CloudSyncError["error"], status: number): Response =>
  reply({ error: code }, status);

const isName = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256;

const isLimits = (v: unknown): v is PushLimits =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as PushLimits).quotaBytes === "number" &&
  Number.isFinite((v as PushLimits).quotaBytes) &&
  (v as PushLimits).quotaBytes >= 0 &&
  ((v as PushLimits).productOverCeiling === undefined ||
    typeof (v as PushLimits).productOverCeiling === "boolean") &&
  ((v as PushLimits).usersAtCeiling === undefined ||
    typeof (v as PushLimits).usersAtCeiling === "boolean");

const isFileLimits = (v: unknown): v is FileLimits =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as FileLimits).quotaBytes === "number" &&
  Number.isFinite((v as FileLimits).quotaBytes) &&
  ((v as FileLimits).productOverCeiling === undefined ||
    typeof (v as FileLimits).productOverCeiling === "boolean") &&
  ((v as FileLimits).usersAtCeiling === undefined ||
    typeof (v as FileLimits).usersAtCeiling === "boolean");

function migrationsOf(
  w: WireMigrations | undefined,
): CatalogMigrations | undefined {
  if (!w) return undefined;
  return { renamedTo: new Map(w.renamedTo), dropped: new Set(w.dropped) };
}

/** An absorbed object's marker lives this long (a retried merge settles against it), then goes.
 *  The race it covers is seconds; once the merge is done the marker is the only record linking
 *  the two pseudonymous ids, so it does not outlive the day. */
export const ABSORBED_RETENTION_MS = 86_400_000;
/** An erased object's marker lives this long: a push already in flight at the erasure lands
 *  within seconds, and the marker refuses it. Then the object goes. */
export const ERASED_RETENTION_MS = 86_400_000;
/** The D1 batch gets this long inside the alarm's concurrency block (well under the 30 s limit). */
export const FLUSH_TIMEOUT_MS = 10_000;

/** Seams for tests; production passes none. */
export interface CloudSyncDoOptions {
  /**
   * The D1 handle the alarm writes (default: the `DB` binding). It can do nothing but batch; the
   * changed-row count of the flush says whether the product is still live.
   */
  db?: () => Pick<Db, "batch" | "batchChanges">;
  /** The clock in milliseconds (default `Date.now`). */
  now?: () => number;
  /** The flush's D1 timeout (default `FLUSH_TIMEOUT_MS`). */
  flushTimeoutMs?: number;
}

export class CloudSyncDO implements DurableObject {
  private readonly store: SqlStore;
  private readonly now: () => number;
  private readonly db: () => Pick<Db, "batch" | "batchChanges">;
  private readonly flushTimeoutMs: number;
  /** The file store, when the Worker has one (`SYNC_FILES`); read per call, never cached. */
  private readonly bucket: () => R2Bucket | undefined;

  constructor(
    private readonly ctx: DurableObjectState,
    env: Env,
    opts: CloudSyncDoOptions = {},
  ) {
    this.bucket = () => fileStoreOf(env);
    this.now = opts.now ?? Date.now;
    this.store = new SqlStore(ctx.storage, () => Math.floor(this.now() / 1000));
    this.db = opts.db ?? (() => new D1Db(env.DB));
    this.flushTimeoutMs = opts.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;
  }

  /**
   * The alarm (see the header). A clean object does nothing. A D1 failure or timeout throws, so
   * the runtime retries with backoff; the object stays owed until D1 took the batch, and the
   * batch is idempotent (`buildFlush`). The runtime gives up after a few retries: the object is
   * then still dirty with no alarm set, and the next accepted write schedules one again
   * (`scheduleFlush` sets an alarm whenever none is pending).
   *
   * An absorbed object (account merge) does no housekeeping and no flush: it only waits out its
   * marker's retention, then erases itself.
   */
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.migrateIfBehind();
      const pin = this.pinned();
      if (!pin || this.store.schemaVersion() !== SCHEMA_VERSION) return;
      const nowMs = this.now();
      const erasedAt = this.store.getMeta("erased_at");
      if (erasedAt !== undefined) {
        const due = Number(erasedAt) + ERASED_RETENTION_MS;
        if (nowMs >= due) await this.eraseSelf();
        else if ((await this.ctx.storage.getAlarm()) === null)
          await this.ctx.storage.setAlarm(due);
        return;
      }
      const absorbedAt = this.store.getMeta("absorbed_at");
      if (this.store.getMeta("absorbed_into") !== undefined) {
        const due = Number(absorbedAt ?? 0) + ABSORBED_RETENTION_MS;
        if (nowMs >= due) {
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.deleteAll();
          this.store.reset();
        } else if ((await this.ctx.storage.getAlarm()) === null) {
          await this.ctx.storage.setAlarm(due);
        }
        return;
      }
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
      this.ctx.storage.transactionSync(() => flush.begin());
      const handle = this.db();
      // The directory upsert is the batch's last statement and writes a row only while the
      // product is live (`LIVE`), so its changed-row count is how the object learns the product
      // was erased without ever reading D1: it then erases itself, so a push that landed on a
      // stale view of the purge flag leaves nothing no purge run can reach (SR-2 B2).
      let live = true;
      if (handle.batchChanges) {
        const changes = await this.withTimeout(
          handle.batchChanges(flush.statements),
        );
        live = (changes[changes.length - 1] ?? 1) > 0;
      } else {
        await this.withTimeout(handle.batch(flush.statements));
      }
      if (!live) {
        await this.eraseSelf();
        return;
      }
      this.ctx.storage.transactionSync(() => flush.commit(nowMs));
      // Writes that landed between retries are owed to the next window.
      await this.scheduleFlush();
    });
  }

  /** Drops the alarm, then every row (`deleteAll` does not clear an alarm), then the cached schema state. */
  private async eraseSelf(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.store.reset();
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("cloud sync: the directory flush timed out")),
        this.flushTimeoutMs,
      );
    });
    try {
      return await Promise.race([p, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Schedules the flush if one is due and none is already set. Best effort: the write it follows
   * is committed, so a failing `setAlarm` is logged and never fails the request. The object stays
   * dirty and the next write (or alarm retry) schedules again.
   */
  private async scheduleFlush(): Promise<void> {
    try {
      const at = flushDueAt(this.store, this.now());
      if (at === null) return;
      if ((await this.ctx.storage.getAlarm()) !== null) return;
      await this.ctx.storage.setAlarm(at);
    } catch {
      // No logging in src (R12): the push has committed, and the next accepted write reschedules.
    }
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
    // Whatever an alarm or an earlier request left in the meter is not this operation's.
    this.store.takeMeter();
    if (!op || !isName(op.product) || !isName(op.subject))
      return reply({ error: "bad_request" }, 400);

    // A schema from a newer build must not be touched by this one.
    if (this.store.schemaVersion() > SCHEMA_VERSION)
      return objectError("unsupported_schema", 500);
    const pin = this.pinned();
    if (pin && (pin.product !== op.product || pin.subject !== op.subject))
      return objectError("pin_mismatch", 403);
    // An absorbed object (account merge) takes no write; only an erasure (`deleteAll`) and the
    // merge's own repeat delete get through. Reads answer empty.
    if (
      (this.store.getMeta("absorbed_into") !== undefined ||
        this.store.getMeta("erased_at") !== undefined) &&
      (op.op === "push" || op.op === "absorb" || op.op === "fileBegin")
    )
      return objectError("absorbed", 410);

    switch (op.op) {
      case "push":
        return this.push(op);
      case "pull":
        return this.pull(op);
      case "fileBegin":
      case "fileStatus":
      case "fileAbort":
        return this.fileOp(op);
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
        return reply({
          op: "exportAll",
          // An absorbed object has nothing left to export: a retried merge finds it settled.
          document:
            this.store.getMeta("absorbed_into") !== undefined ||
            this.store.getMeta("erased_at") !== undefined
              ? null
              : this.exportAll(op),
        });
      case "absorb":
        return this.absorb(op);
      case "deleteAll":
        return this.deleteAll(op);
      default:
        return reply({ error: "bad_request" }, 400);
    }
  }

  /** The file operations (`fileOps.ts`): their shape is checked here, their work is there. */
  private async fileOp(
    op: Extract<CloudSyncOp, { op: "fileBegin" | "fileStatus" | "fileAbort" }>,
  ): Promise<Response> {
    const named =
      isName(op.collection) &&
      isName(op.recordId) &&
      (op.op === "fileBegin"
        ? isName(op.uploadId) && isName(op.deviceId)
        : isName(op.uploadId)) &&
      typeof op.serverNow === "number";
    if (!named) return reply({ error: "bad_request" }, 400);
    const host: FileHost = {
      store: this.store,
      ctx: this.ctx,
      bucket: this.bucket(),
    };
    if (op.op === "fileBegin") {
      const r = op.request;
      if (
        !r ||
        typeof r.size !== "number" ||
        !Number.isSafeInteger(r.size) ||
        r.size < 0 ||
        typeof r.sha256 !== "string" ||
        !(op.mode === "single" || op.mode === "multipart") ||
        !isFileLimits(op.limits) ||
        typeof op.maxRecords !== "number"
      )
        return reply({ error: "bad_request" }, 400);
      const out = await fileBegin(host, op);
      return reply(out.body, out.status);
    }
    const out =
      op.op === "fileStatus"
        ? await fileStatus(host, op)
        : await fileAbort(host, op);
    return reply(out.body, out.status);
  }

  /**
   * Erasure, or the merge's delete of an absorbed object. The merge passes the exported `seq` and
   * write count, and the object goes only while both still hold: a write that landed since stays,
   * and the merge absorbs again (a client binding or a conflict-only push moves the write count,
   * not `seq`: SR-1 N2). A merge delete leaves a marker (`absorbed_into`, `absorbed_at`) and the
   * pin, which refuse every later write with `410 absorbed` instead of letting a late write build
   * an orphan the survivor never sees (SR-1 N3). The marker holds no setting and no value, only
   * the subject the object was folded into. A plain `deleteAll` is the erasure: it leaves no data, only the pin and an
   * `erased_at` marker that refuses writes for a day.
   */
  private async deleteAll(
    op: Extract<CloudSyncOp, { op: "deleteAll" }>,
  ): Promise<Response> {
    const merge = op.absorbedInto !== undefined;
    if (merge) {
      if (
        !isName(op.absorbedInto) ||
        typeof op.ifSeq !== "number" ||
        typeof op.ifWrites !== "number"
      )
        return reply({ error: "bad_request" }, 400);
      // Already marked: a retry (or a crash between the marker and the wipe) finishes the wipe
      // below; the data cannot have changed since, because a marked object takes no write.
      if (this.store.getMeta("absorbed_into") === undefined) {
        if (
          this.store.currentSeq() !== op.ifSeq ||
          this.store.writeCount() !== op.ifWrites
        )
          return reply({ op: "deleteAll", deleted: false });
        // The marker goes in FIRST, in the object's own transaction: from this point it refuses
        // every write, and a reset between here and the wipe leaves a marked object, never an
        // unmarked empty one that a late push could rebuild into an orphan.
        this.writeMarker(op);
      }
      // The cleanup alarm is set BEFORE the wipe, so a marker never exists without an alarm that
      // erases it. A failed `setAlarm` is a retryable failure
      // (the merge retries the delete) and not a marker that lives forever. The due time comes
      // from the FIRST `absorbed_at`, so a retried merge does not push the cleanup out.
      const absorbedAt = Number(
        this.store.getMeta("absorbed_at") ?? this.now(),
      );
      const due = absorbedAt + ABSORBED_RETENTION_MS;
      try {
        await this.ctx.storage.setAlarm(due);
      } catch {
        return objectError("unavailable", 503);
      }
      await this.ctx.storage.deleteAll();
      this.store.reset();
      this.writeMarker(op, absorbedAt);
      // A SQLite-backed `deleteAll` also drops the alarm (workerd), so it is set once more now
      // that the marker is back. A failure is retryable: the retry finds the marker, wipes again
      // and sets both again, so the marker never outlives its erasure.
      try {
        await this.ctx.storage.setAlarm(due);
      } catch {
        return objectError("unavailable", 503);
      }
      return reply({ op: "deleteAll", deleted: true });
    }
    // The erasure: everything goes, and a marker (the pin and a time, no data) stays for a day, so
    // a push that was already on its way refuses instead of rebuilding the object. The cleanup
    // alarm goes first, so a marker never exists without one; a failure is retryable.
    await this.eraseSelf();
    const at = this.now();
    try {
      await this.ctx.storage.setAlarm(at + ERASED_RETENTION_MS);
    } catch {
      return objectError("unavailable", 503);
    }
    this.ctx.storage.transactionSync(() => {
      this.store.prepare(true);
      this.store.setMeta("product", op.product);
      this.store.setMeta("subject", op.subject);
      this.store.setMeta("erased_at", String(at));
    });
    return reply({ op: "deleteAll", deleted: true });
  }

  /** The absorbed marker and the pin it hangs on; keeps the first `absorbed_at` of a retry. */
  private writeMarker(
    op: Extract<CloudSyncOp, { op: "deleteAll" }>,
    absorbedAt?: number,
  ): void {
    this.ctx.storage.transactionSync(() => {
      this.store.prepare(true);
      this.store.setMeta("product", op.product);
      this.store.setMeta("subject", op.subject);
      this.store.setMeta("absorbed_into", op.absorbedInto as string);
      if (this.store.getMeta("absorbed_at") === undefined)
        this.store.setMeta("absorbed_at", String(absorbedAt ?? this.now()));
    });
  }

  /** Reads migrate an existing older schema but never create one. */
  private migrateIfBehind(): void {
    this.store.prepare(false);
  }

  private async push(
    op: Extract<CloudSyncOp, { op: "push" }>,
  ): Promise<Response> {
    // The Worker always sends the device's family and the resolved limits (SR-1 N1): a push
    // without either is a bug in the caller, never "no quota" and never a family-less platform row.
    if (
      !isName(op.deviceId) ||
      !isName(op.family) ||
      !isLimits(op.limits) ||
      (op.tierId !== undefined && !isName(op.tierId)) ||
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
        meter: this.store.takeMeter(),
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
        family: op.family,
        limits: op.limits,
        ...(op.migrations ? { migrations: migrationsOf(op.migrations) } : {}),
        request: op.request,
        classified: op.classified,
        serverNow: op.serverNow,
      });
      // An exchange the engine accepted: the directory and the day's counters follow (U-05.9).
      // An exchange that was all duplicates or all refused changed nothing: it is neither a sync
      // nor a reason to flush.
      if (out.ok && (out.counts.accepted > 0 || out.counts.conflicts > 0))
        recordWrite(this.store, {
          nowMs: this.now(),
          quotaBytes: op.limits.quotaBytes,
          tierId: op.tierId,
          // The directory column is a closed set: anything outside it is dropped, not stored.
          platform: knownPlatform(op.platform) ?? undefined,
          syncs: 1,
          conflicts: out.counts.conflicts,
        });
      return out;
    });
    if (outcome.ok) await this.scheduleFlush();
    return reply({ op: "push", outcome, meter: this.store.takeMeter() });
  }

  /**
   * Account merge, survivor side (U-05.8): join the absorbed subject's export into this object in
   * one transaction (the schema and pin included, so an object is never half-made). The join is
   * idempotent (`engine/absorb.ts`), so a retry writes nothing. Nothing is refused for budget or
   * quota (L8). Marks the directory dirty when anything changed (U-05.9 reads the flag).
   * `policies` is whatever the caller passes; the merge hook passes none yet, so a `max` or `min`
   * key joins by `lastWrite` until U-05.13 hands over the catalog's policies (THREAT-MODEL).
   */
  private async absorb(
    op: Extract<CloudSyncOp, { op: "absorb" }>,
  ): Promise<Response> {
    const doc = op.document;
    const parsed = parseExportDocument(doc);
    const policies = parsePolicies(op.policies);
    const recordPolicies = parseRecordPolicies(op.recordPolicies);
    // The same product, and another person: an absorb of oneself would delete one's own data.
    if (
      !parsed ||
      policies === null ||
      recordPolicies === null ||
      doc.product !== op.product ||
      doc.subject === op.subject ||
      !isName(doc.subject)
    )
      return reply({ error: "bad_request" }, 400);
    if (
      parsed.settings.length === 0 &&
      parsed.records.length === 0 &&
      parsed.parked.length === 0 &&
      parsed.clients.length === 0
    )
      return reply({
        op: "absorb",
        changed: 0,
        meter: this.store.takeMeter(),
      });
    let changed = 0;
    let skipped = 0;
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
            records: parsed.records,
            parked: parsed.parked,
            fromSubject: doc.subject,
            ...(parsed.encryptionSince !== undefined
              ? { encryptionSince: parsed.encryptionSince }
              : {}),
            now: Math.floor(this.now() / 1000),
            ...(policies ? { policies } : {}),
            ...(recordPolicies ? { recordPolicies } : {}),
          }),
        );
        changed = out.rows + out.clients;
        skipped = out.skipped;
        if (changed > 0) markDirty(this.store);
      });
    } catch (e) {
      // A rolled-back first write took the tables with it; forget the cached probe.
      this.store.reset();
      throw e;
    }
    if (changed > 0) await this.scheduleFlush();
    return reply({
      op: "absorb",
      changed,
      ...(skipped > 0 ? { skipped } : {}),
      meter: this.store.takeMeter(),
    });
  }

  private pull(op: Extract<CloudSyncOp, { op: "pull" }>): Response {
    if (
      !isName(op.deviceId) ||
      !isName(op.family) ||
      (op.encryption !== undefined &&
        op.encryption !== "e2e" &&
        op.encryption !== "server")
    )
      return reply({ error: "bad_request" }, 400);
    this.migrateIfBehind();
    const outcome = applyPull(this.store, {
      ...(op.cursor !== undefined ? { cursor: op.cursor } : {}),
      ...(op.clientId ? { clientId: op.clientId } : {}),
      deviceId: op.deviceId,
      family: op.family,
      ...(op.encryption === "e2e" ? { e2e: true } : {}),
    });
    return reply({ op: "pull", outcome, meter: this.store.takeMeter() });
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
      writes: this.store.writeCount(),
      watermark: this.store.getWatermark(),
      ...(this.store.getEncryptionSince() !== undefined
        ? { encryptionSince: this.store.getEncryptionSince() as number }
        : {}),
      usage: this.store.getUsage(),
      settings: this.store.settingsAfter(0).map(({ members, ...row }) => ({
        ...row,
        ...(members ? { members: [...members] } : {}),
      })),
      ...this.exportRecords(),
      clients: this.store.clients(),
    };
  }

  /** The records and parked copies, as JSON, read a page at a time. Absent keys when there are none. */
  private exportRecords(): Pick<ExportDocument, "records" | "parked"> {
    const records: ExportedRecord[] = [];
    for (let after = 0; ; ) {
      const page = this.store.recordsPageAfter(after, EXPORT_PAGE);
      for (const { fields, elements, ...row } of page)
        records.push({
          ...row,
          ...(fields ? { fields: [...fields] } : {}),
          ...(elements ? { elements: [...elements] } : {}),
        });
      if (page.length < EXPORT_PAGE) break;
      after = page[page.length - 1]?.version ?? Number.MAX_SAFE_INTEGER;
    }
    const parked = this.store
      .parkedRecords()
      .map(({ fields, elements, ...row }) => ({
        ...row,
        ...(fields ? { fields: [...fields] } : {}),
        ...(elements ? { elements: [...elements] } : {}),
      }));
    return {
      ...(records.length > 0 ? { records } : {}),
      ...(parked.length > 0 ? { parked } : {}),
    };
  }
}
