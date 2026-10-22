/// <reference types="@cloudflare/workers-types" />
import type { Env } from "../../../platform/env.js";
import { absorbSettings } from "../engine/absorb.js";
import { applyPull } from "../engine/pull.js";
import { applyPush } from "../engine/push.js";
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
  WireMigrations,
} from "./protocol.js";
import { parseExportDocument, parsePolicies } from "./exportDoc.js";
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

const reply = (body: CloudSyncReply | CloudSyncError, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const isName = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256;

const isLimits = (v: unknown): v is PushLimits =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as PushLimits).quotaBytes === "number" &&
  Number.isFinite((v as PushLimits).quotaBytes) &&
  (v as PushLimits).quotaBytes >= 0 &&
  ((v as PushLimits).productOverCeiling === undefined ||
    typeof (v as PushLimits).productOverCeiling === "boolean");

function migrationsOf(
  w: WireMigrations | undefined,
): CatalogMigrations | undefined {
  if (!w) return undefined;
  return { renamedTo: new Map(w.renamedTo), dropped: new Set(w.dropped) };
}

export class CloudSyncDO implements DurableObject {
  private readonly store: SqlStore;

  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {
    this.store = new SqlStore(ctx.storage);
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
    // An absorbed object (account merge) takes no write; only an erasure (`deleteAll`) and the
    // merge's own repeat delete get through. Reads answer empty.
    if (
      this.store.getMeta("absorbed_into") !== undefined &&
      (op.op === "push" || op.op === "absorb")
    )
      return reply({ error: "absorbed" }, 410);

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
        return reply({
          op: "exportAll",
          // An absorbed object has nothing left to export: a retried merge finds it settled.
          document:
            this.store.getMeta("absorbed_into") !== undefined
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

  /**
   * Erasure, or the merge's delete of an absorbed object. The merge passes the exported `seq` and
   * write count, and the object goes only while both still hold: a write that landed since stays,
   * and the merge absorbs again (a client binding or a conflict-only push moves the write count,
   * not `seq`: SR-1 N2). A merge delete leaves a marker (`absorbed_into`, `absorbed_at`) and the
   * pin, which refuse every later write with `410 absorbed` instead of letting a late write build
   * an orphan the survivor never sees (SR-1 N3). The marker holds no setting and no value, only
   * the subject the object was folded into. A plain `deleteAll` is the erasure and leaves nothing.
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
      // Already absorbed: settled, nothing to do.
      if (this.store.getMeta("absorbed_into") !== undefined)
        return reply({ op: "deleteAll", deleted: true });
      if (
        this.store.currentSeq() !== op.ifSeq ||
        this.store.writeCount() !== op.ifWrites
      )
        return reply({ op: "deleteAll", deleted: false });
    }
    // deleteAll does not clear an alarm; the order here is the point (no wake-up on a ghost).
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.store.reset();
    if (merge) {
      this.ctx.storage.transactionSync(() => {
        this.store.prepare(true);
        this.store.setMeta("product", op.product);
        this.store.setMeta("subject", op.subject);
        this.store.setMeta("absorbed_into", op.absorbedInto as string);
        this.store.setMeta("absorbed_at", String(Date.now()));
      });
    }
    return reply({ op: "deleteAll", deleted: true });
  }

  /** Reads migrate an existing older schema but never create one. */
  private migrateIfBehind(): void {
    this.store.prepare(false);
  }

  private push(op: Extract<CloudSyncOp, { op: "push" }>): Response {
    // The Worker always sends the device's family and the resolved limits (SR-1 N1): a push
    // without either is a bug in the caller, never "no quota" and never a family-less platform row.
    if (
      !isName(op.deviceId) ||
      !isName(op.family) ||
      !isLimits(op.limits) ||
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
    const outcome = this.store.transaction(() =>
      applyPush(this.store as SyncStore, {
        deviceId: op.deviceId,
        family: op.family,
        limits: op.limits,
        ...(op.migrations ? { migrations: migrationsOf(op.migrations) } : {}),
        request: op.request,
        classified: op.classified,
        serverNow: op.serverNow,
      }),
    );
    return reply({ op: "push", outcome });
  }

  /**
   * Account merge, survivor side (U-05.8): join the absorbed subject's export into this object in
   * one transaction (the schema and pin included, so an object is never half-made). The join is
   * idempotent (`engine/absorb.ts`), so a retry writes nothing. Nothing is refused for budget or
   * quota (L8). Marks the directory dirty when anything changed (U-05.9 reads the flag).
   * `policies` is whatever the caller passes; the merge hook passes none yet, so a `max` or `min`
   * key joins by `lastWrite` until U-05.13 hands over the catalog's policies (THREAT-MODEL).
   */
  private absorb(op: Extract<CloudSyncOp, { op: "absorb" }>): Response {
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
        if (changed > 0) this.store.setMeta("directory_dirty", "1");
      });
    } catch (e) {
      // A rolled-back first write took the tables with it; forget the cached probe.
      this.store.reset();
      throw e;
    }
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
      writes: this.store.writeCount(),
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
