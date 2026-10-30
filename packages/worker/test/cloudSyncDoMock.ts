/// <reference types="@cloudflare/workers-types" />
import Database from "better-sqlite3";
import type { Env } from "../src/platform/env.js";
import {
  CloudSyncDO,
  type CloudSyncDoOptions,
} from "../src/services/sync/do/cloudSyncDo.js";
import { SqlStore } from "../src/services/sync/do/sqlStore.js";

// A Durable Object SQLite storage over better-sqlite3, and an in-memory DurableObjectNamespace that
// runs the REAL CloudSyncDO class against it (as `updateHealthMock.ts` does for its class). The
// `SqlStorage` surface is the part the class and its store use: `exec` (bindings, a cursor with
// `toArray`, `one`, `next`, `raw`, iteration, `columnNames`, `rowsRead`, `rowsWritten`) and
// `databaseSize`; the storage adds `transactionSync` (nesting by savepoint, rolled back when the
// callback throws), `deleteAll` (which, like the real one, leaves an alarm set), the alarm
// accessors, and `getCurrentBookmark`-free semantics. Each object's fetches are serialised, which
// models the input gate.

type Bind = string | number | null | ArrayBuffer;

class CursorMock<T extends Record<string, unknown>> {
  private i = 0;
  readonly columnNames: string[];
  constructor(
    private readonly rows: T[],
    cols: string[],
    readonly rowsRead: number,
    readonly rowsWritten: number,
  ) {
    this.columnNames = cols;
  }
  toArray(): T[] {
    return this.rows.slice();
  }
  one(): T {
    if (this.rows.length !== 1)
      throw new Error(
        `one(): expected exactly one row, got ${this.rows.length}`,
      );
    return this.rows[0] as T;
  }
  next(): IteratorResult<T> {
    const r = this.rows[this.i++];
    return r === undefined
      ? { done: true, value: undefined }
      : { done: false, value: r };
  }
  raw(): IterableIterator<unknown[]> {
    return this.rows.map((r) => Object.values(r))[Symbol.iterator]();
  }
  [Symbol.iterator](): IterableIterator<T> {
    return this.rows[Symbol.iterator]();
  }
}

export class SqlStorageMock {
  readonly db: Database.Database;
  /** Every statement executed, for the "parameterised" assertions. */
  readonly log: { query: string; bindings: Bind[] }[] = [];
  rowsRead = 0;
  rowsWritten = 0;
  private depth = 0;

  constructor(db?: Database.Database) {
    this.db = db ?? new Database(":memory:");
  }

  exec<T extends Record<string, unknown>>(query: string, ...bindings: Bind[]) {
    this.log.push({ query, bindings });
    for (const b of bindings)
      if (typeof b === "boolean" || b === undefined)
        throw new Error(
          "SqlStorage: a binding must be string, number, null or ArrayBuffer",
        );
    // The real exec runs a multi-statement string when it has no bindings.
    if (
      bindings.length === 0 &&
      query.trim().replace(/;\s*$/, "").includes(";")
    ) {
      this.db.exec(query);
      return new CursorMock<T>([], [], 0, 0);
    }
    const stmt = this.db.prepare(query);
    // The runtime takes an ArrayBuffer for a BLOB; better-sqlite3 takes a Buffer.
    const bound = bindings.map((b) =>
      b instanceof ArrayBuffer ? Buffer.from(b) : b,
    );
    if (stmt.reader) {
      const rows = stmt.all(...bound) as T[];
      this.rowsRead += rows.length;
      return new CursorMock<T>(
        rows,
        stmt.columns().map((c) => c.name),
        rows.length,
        0,
      );
    }
    const info = stmt.run(...bound);
    this.rowsWritten += info.changes;
    return new CursorMock<T>([], [], 0, info.changes);
  }

  get databaseSize(): number {
    return (
      (this.db.pragma("page_count", { simple: true }) as number) *
      (this.db.pragma("page_size", { simple: true }) as number)
    );
  }

  transactionSync<T>(fn: () => T): T {
    const name = `sp${this.depth++}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      if (out instanceof Promise)
        throw new Error("transactionSync: callback must be synchronous");
      this.db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }

  /** Drops every table, as `storage.deleteAll()` empties a SQLite-backed object. */
  dropAll(): void {
    const names = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[];
    for (const { name } of names) this.db.exec(`DROP TABLE "${name}"`);
  }
}

export class DoStorageMock {
  readonly sql = new SqlStorageMock();
  alarm: number | null = null;

  transactionSync<T>(fn: () => T): T {
    return this.sql.transactionSync(fn);
  }
  async deleteAll(): Promise<void> {
    // Real behaviour: the alarm survives deleteAll; the caller deletes it first.
    this.sql.dropAll();
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(at: number | Date): Promise<void> {
    this.alarm = typeof at === "number" ? at : at.getTime();
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

/** A fresh `SqlStore` over its own database, schema made (the unit the parity suites drive). */
export function freshSqlStore(): { store: SqlStore; storage: DoStorageMock } {
  const storage = new DoStorageMock();
  const store = new SqlStore(
    storage as unknown as ConstructorParameters<typeof SqlStore>[0],
  );
  store.prepare(true);
  return { store, storage };
}

export class CloudSyncNamespaceMock {
  constructor(
    private readonly opts: CloudSyncDoOptions = {},
    /** The environment each object is built with (its `SYNC_FILES` is read on every call). */
    private readonly env: Env = {} as Env,
  ) {}
  readonly instances = new Map<
    string,
    { obj: CloudSyncDO; storage: DoStorageMock }
  >();
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Object names called, in order. */
  readonly calls: string[] = [];

  idFromName(name: string): DurableObjectId {
    return { name } as unknown as DurableObjectId;
  }

  instance(name: string) {
    let inst = this.instances.get(name);
    if (!inst) {
      const storage = new DoStorageMock();
      inst = {
        storage,
        obj: new CloudSyncDO(
          {
            storage,
            // The real one holds other events back until the callback settles; here the
            // namespace already runs one operation at a time per object.
            blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
          } as unknown as DurableObjectState,
          this.env,
          this.opts,
        ),
      };
      this.instances.set(name, inst);
    }
    return inst;
  }

  /** Fires the object's alarm as the runtime does: cleared first, then `alarm()`, serialised. */
  async fireAlarm(name: string): Promise<void> {
    const inst = this.instance(name);
    const run = async () => {
      inst.storage.alarm = null;
      await inst.obj.alarm();
    };
    const prior = this.tails.get(name) ?? Promise.resolve();
    const result = prior.then(run, run);
    this.tails.set(
      name,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  get(id: DurableObjectId) {
    const name = (id as unknown as { name: string }).name;
    return {
      fetch: (input: string, init?: RequestInit): Promise<Response> => {
        this.calls.push(name);
        const target = this.instance(name).obj;
        const run = () => target.fetch(new Request(input, init));
        const prior = this.tails.get(name) ?? Promise.resolve();
        const result = prior.then(run, run);
        this.tails.set(
          name,
          result.then(
            () => undefined,
            () => undefined,
          ),
        );
        return result;
      },
    };
  }
}

export const asCloudSyncNamespace = (
  m: CloudSyncNamespaceMock,
): DurableObjectNamespace => m as unknown as DurableObjectNamespace;

/**
 * What an erased object still holds: null when it has no schema at all, else the meta keys it
 * keeps (an erased object keeps only its pin and the erasure time) and its data row counts.
 */
export function erasureLeftovers(
  m: CloudSyncNamespaceMock,
  name: string,
): { meta: string[]; rows: number[] } | null {
  const db = m.instance(name).storage.sql.db;
  const has = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'meta'")
    .get();
  if (!has) return null;
  const count = (t: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return {
    meta: (
      db.prepare("SELECT key FROM meta ORDER BY key").all() as { key: string }[]
    ).map((r) => r.key),
    rows: [
      "settings",
      "tombstones",
      "setting_members",
      "clients",
      "records",
      "record_fields",
      "set_elements",
      "parked_records",
      "files",
      "uploads",
      "upload_parts",
      "ssec_keys",
    ].map(count),
  };
}

/** Row counts of the named tables of one object's database, in order. */
export function rowCounts(storage: DoStorageMock, tables: string[]): number[] {
  return tables.map(
    (t) =>
      (
        storage.sql.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as {
          n: number;
        }
      ).n,
  );
}

/** The leftovers of a freshly erased object. */
export const ERASED_LEFTOVERS = {
  meta: ["erased_at", "product", "schema_version", "subject"],
  rows: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};
