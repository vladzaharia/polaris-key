// The records handle of a Cloud Sync collection (plans/C-26 D-2): `collection(name)` over the
// machine, with the catalog checks made before anything is journalled. A refused call changes
// nothing and sends nothing. The local codes are the registered wire codes (errors.json):
// `collection_unknown` for a name the served catalog does not declare, `op_invalid_for_policy` for
// a verb the collection's policy does not allow, `value_invalid` for a value or name over a cap.

import type {
  CloudSyncMachine,
  CollectionDecl,
  CollectionPolicy,
  EffectiveValue,
  Json,
  RecordOutcome,
  SyncEvent,
} from "../cloud-sync.js";
import {
  SYNC_KEY_PATTERN,
  SYNC_MAX_UNION_ELEMENT_BYTES,
} from "@polaris-key/protocol/sync";
import { isBlindedName } from "./blind.js";
import { canonicalJson } from "./envelope.js";

export type CollectionError =
  | "collection_unknown"
  | "op_invalid_for_policy"
  | "value_invalid"
  | "signed_out";

export type CollectionResult =
  | { ok: true; mutationId?: number }
  | { ok: false; error: CollectionError };

/** What a collection listener is told. `outcome` is a compare-and-set `put`'s result. */
export type CollectionEvent =
  | {
      type: "change";
      ids: string[];
      origin: "local" | "remote" | "merge" | "migration";
    }
  | { type: "outcome"; outcome: RecordOutcome };

export type CollectionListener = (event: CollectionEvent) => void;

export interface CollectionPort {
  machine: CloudSyncMachine;
  /** The machine's events as the host reports them; returns the remover. */
  onEvents(fn: (events: SyncEvent[]) => void): () => void;
  /** Called after a local verb so the host reports the events and wakes its pump. */
  touch?(): void;
}

const encoder = new TextEncoder();
const KEY_RE = new RegExp(SYNC_KEY_PATTERN);

/** Whether the SDK's own canonical JSON can spell `v` (a number or text that cannot be spelled
 *  identically everywhere is never sealed). */
function spellable(v: unknown): boolean {
  try {
    return typeof canonicalJson(v as never) === "string";
  } catch {
    return false;
  }
}

/** A field name the host can seal: non-empty, at most 1 KiB, no U+0000, no lone surrogate. */
function fieldOk(n: string): boolean {
  return (
    n !== "" &&
    !n.includes("\u0000") &&
    encoder.encode(n).length <= MAX_FIELD_BYTES &&
    spellable(n)
  );
}
/** A merge field name: non-empty, at most 1 KiB (§13.3). */
const MAX_FIELD_BYTES = 1024;

const PUT_POLICIES: ReadonlySet<CollectionPolicy> = new Set([
  "lastWrite",
  "max",
  "min",
  "revision",
]);

/** The collections a host gives the machine, from the catalog's resolved declarations: each
 *  member's policy, merge/max/min field and (for `revision`) the keep-server resolution. There is
 *  no implicit collection: a name the catalog does not declare is `collection_unknown`. */
export function collectionDecls(
  resolved: ReadonlyArray<{
    name: string;
    conflict: CollectionPolicy;
    conflictField: string | null;
  }>,
): CollectionDecl[] {
  return resolved.map((r) => ({
    name: r.name,
    policy: r.conflict,
    ...(r.conflictField !== null ? { field: r.conflictField } : {}),
    ...(r.conflict === "revision" ? { resolve: "keepServer" as const } : {}),
  }));
}

/** The handle `cloudSync.collection(name)` returns. */
export class SyncCollection {
  readonly name: string;
  readonly #port: CollectionPort;
  readonly #listeners = new Set<CollectionListener>();
  #unsubscribe: (() => void) | null = null;
  #untap: (() => void) | null = null;
  readonly #tickets = new Set<number>();

  constructor(name: string, port: CollectionPort) {
    this.name = name;
    this.#port = port;
  }

  /** The declaration the served catalog carries, or `undefined`. */
  get policy(): CollectionPolicy | undefined {
    return this.#port.machine.collectionDecl(this.name)?.policy;
  }

  /** The effective value (pending edits over the cloud copy) or `null`. An undeclared name is
   *  `null`; stored JSON comes back untouched, so an unknown field survives (D-4). */
  get(id: string): EffectiveValue | null {
    return this.#decl() ? this.#port.machine.record(this.name, id) : null;
  }

  /** The ids of the records a person holds, in byte order, pending creates included. */
  ids(): string[] {
    const m = this.#port.machine;
    if (!this.#decl()) return [];
    // E2E: a record that holds a file and no value is listed under its wire id; it has no name.
    const e2e = m.encryptionMode() === "e2e";
    return m.recordIds(this.name).filter((id) => !(e2e && isBlindedName(id)));
  }

  /** `lastWrite`, `max`, `min`: a stamped write. `revision`: a write based on the version held,
   *  or on `ifVersion` (a number, or `"*"` to create only) as an exact compare-and-set, whose
   *  outcome goes to the listener as `{ type: "outcome" }`. */
  put(
    id: string,
    value: Json,
    opts: { ifVersion?: number | "*" } = {},
  ): CollectionResult {
    const d = this.#check(id, (p) => PUT_POLICIES.has(p));
    if ("error" in d) return d;
    if (opts.ifVersion !== undefined && d.policy !== "revision")
      return { ok: false, error: "op_invalid_for_policy" };
    if (!this.#sealable(id, [value]))
      return { ok: false, error: "value_invalid" };
    if (opts.ifVersion !== undefined) {
      const r = this.#port.machine.putAt(this.name, id, value, opts.ifVersion);
      if (!r.ok) return this.#fail(r.error);
      this.#track(r.mutationId);
      this.#touch();
      return { ok: true, mutationId: r.mutationId };
    }
    return this.#done(this.#port.machine.put(this.name, id, value));
  }

  /** `merge`: write the named fields and drop the named ones. Others stay as stored. */
  update(
    id: string,
    change: { set?: Record<string, Json>; remove?: string[] },
  ): CollectionResult {
    const d = this.#check(id, (p) => p === "merge");
    if ("error" in d) return d;
    const names = [...Object.keys(change.set ?? {}), ...(change.remove ?? [])];
    if (
      names.length === 0 ||
      new Set(names).size !== names.length ||
      !names.every(fieldOk) ||
      !this.#sealable(id, Object.values(change.set ?? {}))
    )
      return { ok: false, error: "value_invalid" };
    return this.#done(this.#port.machine.update(this.name, id, change));
  }

  /** `union`: add an element (at most 1 KiB of canonical JSON). */
  add(id: string, element: Json): CollectionResult {
    return this.#element(id, element, "add");
  }

  /** `union`: remove an element, observed at the current cursor. */
  remove(id: string, element: Json): CollectionResult {
    return this.#element(id, element, "remove");
  }

  /** Delete the record. For `revision`, `ifVersion` is the compare-and-set base (default: the
   *  version held, else `"*"`). */
  delete(
    id: string,
    opts: { ifVersion?: number | "*" } = {},
  ): CollectionResult {
    const d = this.#check(id, () => true);
    if ("error" in d) return d;
    if (!this.#sealable(id, [])) return { ok: false, error: "value_invalid" };
    if (d.policy === "revision") {
      const base =
        opts.ifVersion ??
        this.#port.machine.records(this.name).find((r) => r.id === id)
          ?.version ??
        "*";
      const r = this.#port.machine.removeAt(this.name, id, base);
      if (!r.ok) return this.#fail(r.error);
      this.#track(r.mutationId);
      this.#touch();
      return { ok: true, mutationId: r.mutationId };
    }
    if (opts.ifVersion !== undefined)
      return { ok: false, error: "op_invalid_for_policy" };
    return this.#done(this.#port.machine.delete(this.name, id));
  }

  /** Changes to this collection, including the ones this device makes. Returns the remover. */
  on(listener: CollectionListener): () => void {
    this.#listeners.add(listener);
    this.#watch();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#unwatch();
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────

  #decl(): CollectionDecl | undefined {
    return this.#port.machine.collectionDecl(this.name);
  }

  #check(
    id: string,
    allowed: (p: CollectionPolicy) => boolean,
  ): CollectionDecl | { ok: false; error: CollectionError } {
    const d = this.#decl();
    if (!d) return { ok: false, error: "collection_unknown" };
    if (!this.#port.machine.signedIn())
      return { ok: false, error: "signed_out" };
    if (!allowed(d.policy))
      return { ok: false, error: "op_invalid_for_policy" };
    return d;
  }

  /** The record id and every value can be sealed: a refused call journals nothing. */
  #sealable(id: string, values: readonly unknown[]): boolean {
    return KEY_RE.test(id) && !isBlindedName(id) && values.every(spellable);
  }

  #element(id: string, element: Json, op: "add" | "remove"): CollectionResult {
    const d = this.#check(id, (p) => p === "union");
    if ("error" in d) return d;
    if (
      !this.#sealable(id, [element]) ||
      encoder.encode(canonicalJson(element as never)).length >
        SYNC_MAX_UNION_ELEMENT_BYTES
    )
      return { ok: false, error: "value_invalid" };
    const m = this.#port.machine;
    return this.#done(
      op === "add"
        ? m.add(this.name, id, element)
        : m.remove(this.name, id, element),
    );
  }

  #done(r: { ok: true } | { ok: false; error: string }): CollectionResult {
    if (!r.ok) return this.#fail(r.error);
    this.#touch();
    return { ok: true };
  }

  #fail(error: string): CollectionResult {
    if (error === "signed-out") return { ok: false, error: "signed_out" };
    return { ok: false, error: "collection_unknown" };
  }

  #touch(): void {
    this.#port.touch?.();
  }

  /** Outcomes are reported to a listener, so a ticket is kept only while one is registered. */
  #track(ticket: number): void {
    if (this.#listeners.size > 0) this.#tickets.add(ticket);
  }

  #watch(): void {
    if (this.#unsubscribe) return;
    const m = this.#port.machine;
    m.watchRecords(this.name, true);
    this.#unsubscribe = this.#port.onEvents((events) => {
      for (const e of events)
        if (e.type === "records" && e.collection === this.name)
          this.#emit({ type: "change", ids: e.ids, origin: e.origin });
    });
    this.#untap = m.tapOutcomes((o) => {
      if (!this.#tickets.has(o.mutationId)) return;
      this.#tickets.delete(o.mutationId);
      this.#emit({ type: "outcome", outcome: o });
    });
  }

  #unwatch(): void {
    this.#unsubscribe?.();
    this.#untap?.();
    this.#unsubscribe = this.#untap = null;
    this.#port.machine.watchRecords(this.name, false);
  }

  #emit(e: CollectionEvent): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(e);
      } catch {
        // A listener's failure never reaches the machine.
      }
    }
  }
}
