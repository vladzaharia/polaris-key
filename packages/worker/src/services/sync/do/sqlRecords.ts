/**
 * The record tables of the Durable Object's SQLite store (U-09.3; schema v3): `records`,
 * `record_fields` and `set_elements`. `SqlStore` owns the schema, the guards (lazy schema, the
 * write check) and the meta; this file only reads and writes the rows, through the two query
 * functions it is handed, so every statement stays parameterised and metered in one place.
 */

import type { SyncJson } from "@polaris-key/protocol/sync";
import type {
  FieldCell,
  ParkedRecord,
  RecordKind,
  RemovedField,
  SetElement,
  Stamp,
  StoredRecord,
} from "../engine/types.js";

/** One row, as the SQL API returns it. */
export type Row = Record<string, SqlStorageValue>;

/** The store's metered query functions. */
export interface SqlQuery {
  all<T extends Row>(q: string, ...b: SqlStorageValue[]): T[];
  run(q: string, ...b: SqlStorageValue[]): void;
}

interface RecordRow extends Row {
  collection: string;
  id: string;
  version: number;
  hlc: string;
  client_id: string;
  value_json: string;
  kind: string;
  deleted: number;
  floor_hlc: string | null;
  floor_client: string | null;
  kid: string | null;
}

interface ParkedRow extends Row {
  collection: string;
  id: string;
  from_subject: string;
  kind: string;
  value_json: string | null;
  fields_json: string | null;
  elements_json: string | null;
  hlc: string;
  client_id: string;
  kid: string | null;
  parked_at: number;
}

interface FieldRow extends Row {
  field: string;
  value_json: string;
  removed: number;
  hlc: string;
  client_id: string;
  kid: string | null;
}

interface RemovedRow extends Row {
  collection: string;
  id: string;
  field: string;
  hlc: string;
  client_id: string;
}

interface ElementRow extends Row {
  element_key: string;
  element_json: string;
  add_tag: number;
  kid: string | null;
}

export type CellRow = Row & {
  value_json: string;
  removed: number;
  hlc: string;
  client_id: string;
  kid?: string | null;
};

/**
 * Takes `name` out of `have` (the rows left in it afterwards are the ones to delete), and says
 * whether the stored row already holds `cell`, so a diff write can skip it.
 */
export function settle(
  have: Map<string, CellRow>,
  name: string,
  json: string,
  cell: { removed: boolean; stamp: Stamp; kid?: string },
): boolean {
  const old = have.get(name);
  have.delete(name);
  return (
    old !== undefined &&
    old.value_json === json &&
    (old.removed === 1) === cell.removed &&
    old.hlc === cell.stamp.hlc &&
    old.client_id === cell.stamp.clientId &&
    (old.kid ?? null) === (cell.kid ?? null)
  );
}

/** Sets the `floor` and `kid` of a settings or records row on `out`, when the columns hold them. */
export function readFloorAndKid(
  out: { floor?: Stamp; kid?: string },
  r: {
    floor_hlc: string | null;
    floor_client: string | null;
    kid: string | null;
  },
): void {
  if (r.floor_hlc !== null && r.floor_client !== null)
    out.floor = { hlc: r.floor_hlc, clientId: r.floor_client };
  if (r.kid !== null) out.kid = r.kid;
}

export class RecordTables {
  constructor(private readonly q: SqlQuery) {}

  read(collection: string, id: string): StoredRecord | undefined {
    const r = this.q.all<RecordRow>(
      `SELECT * FROM records WHERE collection = ? AND id = ?`,
      collection,
      id,
    )[0];
    return r ? this.hydrate(r) : undefined;
  }

  /**
   * Writes the record: one upsert of the row, then its cells (`merge`) or tagged elements
   * (`union`) as a diff against what is stored, so a mutation writes O(mutations) rows however
   * many cells the record holds (the rule `putSetting` keeps).
   */
  write(row: StoredRecord): void {
    this.q.run(
      `INSERT INTO records
         (collection, id, version, hlc, client_id, value_json, kind, deleted, floor_hlc, floor_client, kid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (collection, id) DO UPDATE SET
         version = excluded.version, hlc = excluded.hlc, client_id = excluded.client_id,
         value_json = excluded.value_json, kind = excluded.kind, deleted = excluded.deleted,
         floor_hlc = excluded.floor_hlc, floor_client = excluded.floor_client, kid = excluded.kid`,
      row.collection,
      row.id,
      row.version,
      row.stamp.hlc,
      row.stamp.clientId,
      JSON.stringify(row.value),
      row.kind,
      row.deleted ? 1 : 0,
      row.floor?.hlc ?? null,
      row.floor?.clientId ?? null,
      row.kid ?? null,
    );
    this.writeFields(row);
    this.writeElements(row);
  }

  private writeFields(row: StoredRecord): void {
    const have = new Map<string, FieldRow>();
    for (const f of this.q.all<FieldRow>(
      `SELECT field, value_json, removed, hlc, client_id, kid FROM record_fields
         WHERE collection = ? AND id = ?`,
      row.collection,
      row.id,
    ))
      have.set(f.field, f);
    for (const [name, cell] of row.fields ?? new Map<string, FieldCell>()) {
      const json = JSON.stringify(cell.value);
      if (settle(have, name, json, cell)) continue;
      this.q.run(
        `INSERT INTO record_fields
           (collection, id, field, value_json, removed, hlc, client_id, kid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (collection, id, field) DO UPDATE SET
           value_json = excluded.value_json, removed = excluded.removed,
           hlc = excluded.hlc, client_id = excluded.client_id, kid = excluded.kid`,
        row.collection,
        row.id,
        name,
        json,
        cell.removed ? 1 : 0,
        cell.stamp.hlc,
        cell.stamp.clientId,
        cell.kid ?? null,
      );
    }
    for (const name of have.keys())
      this.q.run(
        `DELETE FROM record_fields WHERE collection = ? AND id = ? AND field = ?`,
        row.collection,
        row.id,
        name,
      );
  }

  private writeElements(row: StoredRecord): void {
    const have = new Map<string, ElementRow>();
    for (const e of this.q.all<ElementRow>(
      `SELECT element_key, element_json, add_tag, kid FROM set_elements
         WHERE collection = ? AND id = ?`,
      row.collection,
      row.id,
    ))
      have.set(`${e.element_key}\u0000${e.add_tag}`, e);
    for (const [key, el] of row.elements ?? new Map<string, SetElement>()) {
      const json = JSON.stringify(el.element);
      for (const tag of el.tags) {
        const ident = `${key}\u0000${tag}`;
        const old = have.get(ident);
        have.delete(ident);
        if (
          old &&
          old.element_json === json &&
          (old.kid ?? null) === (el.kid ?? null)
        )
          continue;
        this.q.run(
          `INSERT OR REPLACE INTO set_elements
             (collection, id, element_key, element_json, add_tag, kid)
           VALUES (?, ?, ?, ?, ?, ?)`,
          row.collection,
          row.id,
          key,
          json,
          tag,
          el.kid ?? null,
        );
      }
    }
    for (const e of have.values())
      this.q.run(
        `DELETE FROM set_elements
           WHERE collection = ? AND id = ? AND element_key = ? AND add_tag = ?`,
        row.collection,
        row.id,
        e.element_key,
        e.add_tag,
      );
  }

  remove(collection: string, id: string): void {
    for (const table of ["records", "record_fields", "set_elements"])
      this.q.run(
        `DELETE FROM ${table} WHERE collection = ? AND id = ?`,
        collection,
        id,
      );
  }

  page(after: number, through: number, limit: number): StoredRecord[] {
    return this.q
      .all<RecordRow>(
        `SELECT * FROM records WHERE version > ? AND version <= ?
         ORDER BY version, collection, id LIMIT ?`,
        after,
        through,
        limit,
      )
      .map((r) => this.hydrate(r));
  }

  liveCount(collection: string): number {
    return Number(
      this.q.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM records WHERE collection = ? AND deleted = 0`,
        collection,
      )[0]?.n ?? 0,
    );
  }

  tombstoneCount(collection?: string): number {
    const n =
      collection === undefined
        ? this.q.all<{ n: number }>(
            `SELECT COUNT(*) AS n FROM records WHERE deleted = 1`,
          )[0]?.n
        : this.q.all<{ n: number }>(
            `SELECT COUNT(*) AS n FROM records WHERE collection = ? AND deleted = 1`,
            collection,
          )[0]?.n;
    return Number(n ?? 0);
  }

  oldestTombstones(limit: number, collection?: string): StoredRecord[] {
    const rows =
      collection === undefined
        ? this.q.all<RecordRow>(
            `SELECT * FROM records WHERE deleted = 1
               ORDER BY hlc, client_id, version LIMIT ?`,
            limit,
          )
        : this.q.all<RecordRow>(
            `SELECT * FROM records WHERE collection = ? AND deleted = 1
               ORDER BY hlc, client_id, version LIMIT ?`,
            collection,
            limit,
          );
    return rows.map((r) => this.hydrate(r));
  }

  removedCount(collection?: string): number {
    const n =
      collection === undefined
        ? this.q.all<{ n: number }>(
            `SELECT COUNT(*) AS n FROM record_fields WHERE removed = 1`,
          )[0]?.n
        : this.q.all<{ n: number }>(
            `SELECT COUNT(*) AS n FROM record_fields WHERE removed = 1 AND collection = ?`,
            collection,
          )[0]?.n;
    return Number(n ?? 0);
  }

  oldestRemoved(limit: number, collection?: string): RemovedField[] {
    const cols = `collection, id, field, hlc, client_id`;
    const order = `ORDER BY hlc, client_id, collection, id, field LIMIT ?`;
    const rows =
      collection === undefined
        ? this.q.all<RemovedRow>(
            `SELECT ${cols} FROM record_fields WHERE removed = 1 ${order}`,
            limit,
          )
        : this.q.all<RemovedRow>(
            `SELECT ${cols} FROM record_fields WHERE removed = 1 AND collection = ? ${order}`,
            collection,
            limit,
          );
    return rows.map((r) => ({
      collection: r.collection,
      id: r.id,
      field: r.field,
      stamp: { hlc: r.hlc, clientId: r.client_id },
    }));
  }

  // ---- parked copies (D3; plans/U-09-slices.md §2.1) ----------------------------------------

  readParked(
    collection: string,
    id: string,
    fromSubject: string,
  ): ParkedRecord | undefined {
    const r = this.q.all<ParkedRow>(
      `SELECT * FROM parked_records WHERE collection = ? AND id = ? AND from_subject = ?`,
      collection,
      id,
      fromSubject,
    )[0];
    return r ? parkedOf(r) : undefined;
  }

  allParked(): ParkedRecord[] {
    return this.q
      .all<ParkedRow>(
        `SELECT * FROM parked_records ORDER BY parked_at, collection, id, from_subject`,
      )
      .map(parkedOf);
  }

  parkedCount(): number {
    return Number(
      this.q.all<{ n: number }>(`SELECT COUNT(*) AS n FROM parked_records`)[0]
        ?.n ?? 0,
    );
  }

  oldestParked(limit: number): ParkedRecord[] {
    return this.q
      .all<ParkedRow>(
        `SELECT * FROM parked_records ORDER BY parked_at, collection, id, from_subject LIMIT ?`,
        limit,
      )
      .map(parkedOf);
  }

  deleteParked(collection: string, id: string, fromSubject: string): void {
    this.q.run(
      `DELETE FROM parked_records WHERE collection = ? AND id = ? AND from_subject = ?`,
      collection,
      id,
      fromSubject,
    );
  }

  writeParked(row: ParkedRecord): void {
    this.q.run(
      `INSERT OR REPLACE INTO parked_records
         (collection, id, from_subject, kind, value_json, fields_json, elements_json,
          hlc, client_id, kid, parked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.collection,
      row.id,
      row.fromSubject,
      row.kind,
      row.kind === "value" ? JSON.stringify(row.value) : null,
      row.fields ? JSON.stringify([...row.fields]) : null,
      row.elements ? JSON.stringify([...row.elements]) : null,
      row.stamp.hlc,
      row.stamp.clientId,
      row.kid ?? null,
      row.parkedAt,
    );
  }

  private hydrate(r: RecordRow): StoredRecord {
    const out: StoredRecord = {
      collection: r.collection,
      id: r.id,
      version: r.version,
      stamp: { hlc: r.hlc, clientId: r.client_id },
      deleted: r.deleted === 1,
      kind: r.kind as RecordKind,
      value: JSON.parse(r.value_json) as SyncJson,
    };
    readFloorAndKid(out, r);
    if (r.kind === "fields") {
      const fields = new Map<string, FieldCell>();
      for (const f of this.q.all<FieldRow>(
        `SELECT field, value_json, removed, hlc, client_id, kid FROM record_fields
           WHERE collection = ? AND id = ? ORDER BY ord`,
        r.collection,
        r.id,
      ))
        fields.set(f.field, {
          value: JSON.parse(f.value_json) as SyncJson,
          removed: f.removed === 1,
          stamp: { hlc: f.hlc, clientId: f.client_id },
          ...(f.kid !== null ? { kid: f.kid } : {}),
        });
      out.fields = fields;
    } else if (r.kind === "set") {
      // By add tag, so the map lists elements in the order of their first surviving add.
      const elements = new Map<string, SetElement>();
      for (const e of this.q.all<ElementRow>(
        `SELECT element_key, element_json, add_tag, kid FROM set_elements
           WHERE collection = ? AND id = ? ORDER BY add_tag, element_key`,
        r.collection,
        r.id,
      )) {
        const have = elements.get(e.element_key);
        if (have) have.tags.push(e.add_tag);
        else
          elements.set(e.element_key, {
            element: JSON.parse(e.element_json) as SyncJson,
            tags: [e.add_tag],
            ...(e.kid !== null ? { kid: e.kid } : {}),
          });
      }
      out.elements = elements;
    }
    return out;
  }
}

function parkedOf(r: ParkedRow): ParkedRecord {
  const out: ParkedRecord = {
    collection: r.collection,
    id: r.id,
    fromSubject: r.from_subject,
    kind: r.kind as RecordKind,
    stamp: { hlc: r.hlc, clientId: r.client_id },
    value:
      r.value_json === null ? null : (JSON.parse(r.value_json) as SyncJson),
    parkedAt: r.parked_at,
  };
  if (r.kid !== null) out.kid = r.kid;
  if (r.fields_json !== null)
    out.fields = new Map(JSON.parse(r.fields_json) as [string, FieldCell][]);
  if (r.elements_json !== null)
    out.elements = new Map(
      JSON.parse(r.elements_json) as [string, SetElement][],
    );
  return out;
}
