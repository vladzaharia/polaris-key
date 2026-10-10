// The Cloud Sync reference client state machine (plans/U-01.md §2.3, §2.4, §4.1, amended by
// plans/U-01b.md §2.5 and its Revision 2; S-17 §5.4–§5.6).
//
// Client behaviour, outside the wire contract: the journal reducer, the hybrid logical clock,
// the per-key debounce, conflict rebase, the per-subject partitions, the first-sign-in move, the
// setting routes (synced, local, locked, refused, and open settings), the one-time import of the
// legacy `config.local` store, the paused state and the parked rejections.
// `conformance/corpus/v2/sync-scenarios.json` pins it scenario by scenario, and
// `conformance/runners/node/syncScenarios.test.ts` replays every scenario through it; the other
// SDKs' runners replay the same file. WIRE-CONTRACT-V4 §11.5 is the prose form.
//
// The machine does no I/O and imports no catalog: the host derives the setting routes with
// `@polaris-key/catalog`'s `syncedSettings` and passes them in. It owns a fake-able clock
// (`advance`), queues the requests it would send (`takeRequests`) and the events it would emit
// (`takeEvents`), and is told what the transport answered (`receive`). At most one request is in
// flight. Retry backoff (including `Retry-After` on `writes_paused`) and the live poke are host
// concerns and are not modelled: a request-level failure waits for the next trigger (a commit,
// `flush`, `network online`, `refresh`, sign-in or relaunch).
//
// Nothing here touches licence state. No module reachable from `gate.ts`, `store.ts` or
// `verify.ts` imports this one (`test/cloudSyncIsolation.test.ts`, T5).

/** A JSON value. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };

/** Per-key debounce of `set` (S-17 §5.4). U-05 moves these into `@polaris-key/protocol/sync`. */
export const SYNC_DEBOUNCE_MS = 2000;
/** The most canonical-JSON bytes one setting value may take (D3); a larger `set` is `bad_request`. */
export const SYNC_MAX_VALUE_BYTES = 8192;
/** The clock every imported `config.local` value carries: any cloud value or tombstone beats it. */
export const SYNC_IMPORT_HLC = "000000000000:0000";
/** How long `signOut` waits for its flush before reporting what stayed unsynced (rule 5). */
export const SYNC_SIGNOUT_FLUSH_MS = 5000;
/** Days a signed-out partition keeps its pending operations (rule 5). */
export const SYNC_PENDING_DAYS = 30;
/** The most mutations one push carries. */
export const SYNC_MAX_MUTATIONS = 100;
/** The future-skew clamp, and the pre-contact re-stamp threshold (rule 8, S-17 §5.5). */
export const SYNC_MAX_CLOCK_SKEW_MS = 300_000;
/** `^[0-9a-f]{12}:[0-9a-f]{4}$`: 48-bit milliseconds, a 16-bit counter. */
export const SYNC_HLC_PATTERN = /^[0-9a-f]{12}:[0-9a-f]{4}$/;
/** One per (install, partition); 128 random bits. */
export const SYNC_CLIENT_ID_PATTERN = /^c_[A-Za-z0-9_-]{22}$/;

/** The partition of a device nobody has signed in on (`owner: "local"`). */
export const LOCAL_PARTITION = "local";

const DAY_MS = 86_400_000;

export type SettingPolicy = "lastWrite" | "max" | "min" | "merge";

/** The value-schema subset the scenarios use. */
export interface ValueSchema {
  type: "number" | "integer" | "string" | "boolean" | "object";
  minimum?: number;
  maximum?: number;
  enum?: Json[];
}

/**
 * How the client treats one declared catalog key (`@polaris-key/catalog`'s `syncedSettings`).
 * `synced`: pushed with its scope and resolved by its policy. `local`: kept on the device in
 * `deviceLocal`, never pushed. `locked`: the catalog locks it (`managed_by_admin`). `refused`: a
 * `secret` or `flag` (`bad_request`). A key with no route is an OPEN setting: `user` scope,
 * `lastWrite`, schema-less (D3).
 */
export type SettingRoute =
  | {
      key: string;
      route: "synced";
      scope: "user" | "platform";
      policy: SettingPolicy;
      schema?: ValueSchema;
    }
  | { key: string; route: "local" | "locked" | "refused" };

/** The one conflict vocabulary, as a record collection uses it (plans/U-01b.md §2.2). */
export type CollectionPolicy =
  | "revision"
  | "union"
  | "lastWrite"
  | "max"
  | "min"
  | "merge";

/** A collection (U-09). `field` is the number property a `max`/`min` collection compares (the
 *  server applies it). `resolve` stands in for a developer conflict hook on a `revision` one. */
export interface CollectionDecl {
  name: string;
  policy: CollectionPolicy;
  field?: string;
  resolve?: "keepServer" | "keepLocal";
}

export interface CloudSyncCatalog {
  settings: SettingRoute[];
  collections?: CollectionDecl[];
}

/** The rest of the resolution chain under the `local` slot, and the keys the current signed
 *  config document marks `enforced` or `hidden`. */
export interface CloudSyncDocument {
  values: Record<string, Json>;
  locked?: string[];
}

export type SyncTarget =
  | { setting: string; scope: "user" | "platform" }
  | { record: [string, string] };

export type SyncOpName =
  | "set"
  | "clear"
  | "setMember"
  | "removeMember"
  | "add"
  | "remove";

/** A mutation as the push body carries it. */
export interface WireMutation {
  mutationId: number;
  target: SyncTarget;
  op: SyncOpName;
  value?: Json;
  member?: string;
  element?: Json;
  observedSeq?: number;
  editedHlc?: string;
  baseVersion?: number | "*";
}

/** Why a setting mutation waits on the device instead of being sent (plans/U-01b.md R5). */
export type ParkReason = "quota" | "entitlement";

/** A journalled mutation: the wire form plus the journal-only marks. */
export interface JournalOp extends WireMutation {
  /** Stamped before the install's first server contact (re-stamped at first contact). */
  preContact?: true;
  /** Moved from the local partition at first sign-in (its losers report `origin: "merge"`). */
  moved?: true;
  /** Refused with `quota_exceeded` or `entitlement_required`: kept, still read, not sent, and
   *  re-sent as a new mutation (same `editedHlc`) when the quota grows or at sign-in. */
  parked?: ParkReason;
}

/** A setting held in the local partition. */
export interface DeviceSetting {
  value?: Json;
  cleared?: true;
  editedHlc: string;
  preContact?: true;
}

interface Versioned {
  value: Json;
  version: number;
}

interface Partition {
  clientId: string | null;
  nextMutationId: number;
  cursor: number;
  pending: JournalOp[];
  /** Rule 3: the latest local edit of a record whose CAS is in flight, by `collection/id`. */
  held: Record<string, Json>;
  /** The cloud snapshot (subject partitions), by server key. */
  settings: Record<string, Versioned>;
  records: Record<string, Versioned>;
  /** The local partition's own values. */
  device: Record<string, DeviceSetting>;
  signedOutAt: number | null;
  /** The last `quota.bytes − usage.bytes` a 200 carried; a larger one re-sends quota-parked ops. */
  headroom: number | null;
}

type Blocked =
  | null
  | "account_required"
  | "unauthorized"
  | "attestation"
  | "forbidden";

/** Everything that survives a relaunch. */
export interface CloudSyncPersisted {
  subject: string | null;
  partitions: Record<string, Partition>;
  hlc: [number, number];
  offsetMs: number;
  contacted: boolean;
  aliases: Record<string, string>;
  blocked: Blocked;
  /** `local`-route values: the SDK's `config.local` store. Never moved, never pushed. */
  deviceLocal: Record<string, Json>;
  /** Whether `importLocal` has run on this install. */
  imported: boolean;
}

export interface CloudSyncOptions {
  product: string;
  catalog: CloudSyncCatalog;
  document: CloudSyncDocument;
  now: number;
  offsetMs?: number;
  contacted?: boolean;
  subject?: string | null;
  network?: "online" | "offline";
  onSignOut?: "clear" | "keep";
  /** The host's `config.local` store, for a machine built with no persisted state. */
  deviceLocal?: Record<string, Json>;
  /** `importLocal` already ran on this install. */
  imported?: boolean;
  /** The random source for new `clientId`s. */
  newClientId: () => string;
}

export type SyncRequest =
  | { method: "POST"; path: string; body: Json }
  | { method: "GET"; path: string };

export type SyncResponse =
  | { status: number; body?: Json }
  | { error: "transport" };

export type ChangeOrigin = "local" | "remote" | "merge" | "migration";

export type SyncEvent =
  | { type: "change"; keys: string[]; origin: ChangeOrigin }
  | { type: "rejected"; mutationId: number; code: string }
  | {
      type: "signedOut";
      reason: "signOut" | "accountRequired" | "subjectChanged";
      unsynced: number;
    }
  | { type: "unsyncedData"; count: number }
  | { type: "signInOffered"; signInUrl: string | null };

export type ValueFrom = "pending" | "cloud" | "device" | "document";

export interface EffectiveValue {
  value: Json;
  from: ValueFrom;
}

export interface SyncStatus {
  state:
    | "local"
    | "idle"
    | "pending"
    | "syncing"
    | "offline"
    | "paused"
    | "blocked";
  pending: number;
  /** Why it is blocked, or why parked edits wait (`quota`, `entitlement`). */
  reason?:
    | "account_required"
    | "unauthorized"
    | "attestation"
    | "forbidden"
    | ParkReason;
}

export interface SettingState {
  /** `local` with no principal or for a `local` key; `pending` while a draft or journal operation
   *  (a parked one included) exists; `synced` otherwise. */
  sync: "local" | "pending" | "synced";
  invalid: boolean;
  locked: boolean;
}

export type CallResult = { ok: true } | { ok: false; error: string };

interface Draft {
  value?: Json;
  clear?: true;
  editedHlc: string;
  preContact?: true;
  due: number;
}

interface InFlight {
  kind: "push" | "pull";
  partition: string;
  cursor: number;
  mutationIds: number[];
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

const clone = <T>(v: T): T =>
  v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);

function isObject(v: unknown): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural equality over JSON values (object member order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => k in b && jsonEqual(a[k], b[k]));
  }
  return false;
}

const byteOrder = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Canonical JSON: object members in byte order, no whitespace. */
function canonicalJson(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort(byteOrder)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k] as Json)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** The UTF-8 length of a value's canonical JSON (the 8 KiB setting bound, D3). */
export function jsonBytes(v: Json): number {
  return new TextEncoder().encode(canonicalJson(v)).length;
}

export function formatHlc(physicalMs: number, counter: number): string {
  if (
    !Number.isSafeInteger(physicalMs) ||
    physicalMs < 0 ||
    physicalMs > 0xffff_ffff_ffff
  )
    throw new RangeError(`HLC physical part out of range: ${physicalMs}`);
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffff)
    throw new RangeError(`HLC counter out of range: ${counter}`);
  return `${physicalMs.toString(16).padStart(12, "0")}:${counter
    .toString(16)
    .padStart(4, "0")}`;
}

export function parseHlc(hlc: string): [number, number] {
  if (!SYNC_HLC_PATTERN.test(hlc)) throw new Error(`not an HLC: ${hlc}`);
  return [parseInt(hlc.slice(0, 12), 16), parseInt(hlc.slice(13), 16)];
}

/** Whether `value` satisfies the schema subset (absent schema: anything). */
export function valueValid(
  value: Json,
  schema: ValueSchema | undefined,
): boolean {
  if (!schema) return true;
  switch (schema.type) {
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (schema.type === "integer" && !Number.isInteger(value)) return false;
      if (schema.minimum !== undefined && value < schema.minimum) return false;
      if (schema.maximum !== undefined && value > schema.maximum) return false;
      break;
    case "string":
      if (typeof value !== "string") return false;
      break;
    case "boolean":
      if (typeof value !== "boolean") return false;
      break;
    case "object":
      if (!isObject(value)) return false;
      break;
  }
  return !schema.enum || schema.enum.some((e) => jsonEqual(e, value));
}

/** One setting operation applied to a value under the key's policy. `undefined` is "no value". */
export function applySettingOp(
  policy: SettingPolicy,
  base: Json | undefined,
  op: Pick<WireMutation, "op" | "value" | "member">,
): Json | undefined {
  switch (op.op) {
    case "clear":
      return undefined;
    case "set": {
      const v = op.value as Json;
      if (
        (policy === "max" || policy === "min") &&
        typeof base === "number" &&
        typeof v === "number"
      )
        return policy === "max" ? Math.max(base, v) : Math.min(base, v);
      return clone(v);
    }
    case "setMember": {
      const o = isObject(base) ? { ...base } : {};
      o[op.member as string] = clone(op.value as Json);
      return o;
    }
    case "removeMember": {
      const o = isObject(base) ? { ...base } : {};
      delete o[op.member as string];
      return o;
    }
    default:
      return base;
  }
}

function applyRecordOp(
  base: Json | undefined,
  op: JournalOp,
): Json | undefined {
  switch (op.op) {
    case "set":
      return clone(op.value as Json);
    case "setMember":
    case "removeMember":
      return applySettingOp("merge", base, op);
    case "add": {
      const arr = Array.isArray(base) ? [...base] : [];
      if (!arr.some((x) => jsonEqual(x, op.element)))
        arr.push(clone(op.element as Json));
      return arr;
    }
    case "remove":
      return (Array.isArray(base) ? base : []).filter(
        (x) => !jsonEqual(x, op.element),
      );
    default:
      return base;
  }
}

const recordKey = (c: string, id: string): string => `${c}/${id}`;

function newPartition(clientId: string | null): Partition {
  return {
    clientId,
    nextMutationId: 1,
    cursor: 0,
    pending: [],
    held: {},
    settings: {},
    records: {},
    device: {},
    signedOutAt: null,
    headroom: null,
  };
}

/** The wire form of a journalled mutation (journal-only marks stripped). */
export function wireOf(op: JournalOp): WireMutation {
  const { preContact: _p, moved: _m, parked: _k, ...wire } = op;
  return clone(wire);
}

/** The rejection codes that park a setting edit instead of reverting it (R5). */
const PARKING: Readonly<Record<string, ParkReason>> = {
  quota_exceeded: "quota",
  entitlement_required: "entitlement",
};

const errorCode = (body: Json | undefined): unknown =>
  isObject(body) && isObject(body.error) ? body.error.code : undefined;

// ── the machine ─────────────────────────────────────────────────────────────────────────────

export class CloudSyncMachine {
  private readonly product: string;
  private readonly catalog: CloudSyncCatalog;
  private readonly document: CloudSyncDocument;
  private readonly onSignOutPolicy: "clear" | "keep";
  private readonly newClientId: () => string;

  private s: CloudSyncPersisted;
  private nowMs: number;
  private network: "online" | "offline";
  private drafts: Record<string, Draft> = {};
  private inFlight: InFlight | null = null;
  private signingOut: { deadline: number; discard: boolean } | null = null;
  private needSnapshot = false;
  private pullWanted = false;
  /** A push got `503 writes_paused`; the next 200 push clears it (R4). Not persisted. */
  private paused = false;
  private outbox: SyncRequest[] = [];
  private events: SyncEvent[] = [];

  constructor(opts: CloudSyncOptions, persisted?: CloudSyncPersisted) {
    this.product = opts.product;
    this.catalog = opts.catalog;
    this.document = opts.document;
    this.onSignOutPolicy = opts.onSignOut ?? "clear";
    this.newClientId = opts.newClientId;
    this.nowMs = opts.now;
    this.network = opts.network ?? "online";
    this.s = persisted
      ? clone(persisted)
      : {
          subject: opts.subject ?? null,
          partitions: { [LOCAL_PARTITION]: newPartition(null) },
          hlc: [0, 0],
          offsetMs: opts.offsetMs ?? 0,
          contacted: opts.contacted ?? false,
          aliases: {},
          blocked: null,
          deviceLocal: clone(opts.deviceLocal ?? {}),
          imported: opts.imported ?? false,
        };
    this.s.partitions[LOCAL_PARTITION] ??= newPartition(null);
    if (this.s.subject !== null) this.partitionFor(this.s.subject);
    this.expirePartitions();
    this.pullWanted = true;
    this.kick();
  }

  // ── host surface ──────────────────────────────────────────────────────────────────────────

  get now(): number {
    return this.nowMs;
  }

  get networkState(): "online" | "offline" {
    return this.network;
  }

  /** What survives a relaunch (the drafts are committed first, as the exit flush does). */
  persist(): CloudSyncPersisted {
    this.commitAllDrafts();
    return clone(this.s);
  }

  takeRequests(): SyncRequest[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  takeEvents(): SyncEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ── SDK calls ─────────────────────────────────────────────────────────────────────────────

  /** `config.set` while Cloud Sync is on. */
  set(key: string, value: Json): CallResult {
    return this.edit(key, { value: clone(value) });
  }

  /** `config.clear` while Cloud Sync is on. */
  clear(key: string): CallResult {
    return this.edit(key, { clear: true });
  }

  /**
   * Once per install, with the legacy `config.local` contents (§2.5 "Import"). Synced and
   * undeclared keys enter at the HLC floor, so a newer cloud value always wins; `local` keys stay
   * on the device; locked, refused, invalid and over-size values are not imported (they stay in
   * `config.local`, read as today and never synced). A second call does nothing.
   */
  importLocal(values: Record<string, Json>): CallResult {
    if (this.s.imported) return { ok: true };
    this.s.imported = true;
    const before = this.valueMap();
    const local = this.s.partitions[LOCAL_PARTITION]!;
    for (const key of Object.keys(values).sort(byteOrder)) {
      const value = values[key] as Json;
      const r = this.route(key);
      if (r?.route === "locked" || r?.route === "refused") continue;
      if (r?.route === "synced" && !valueValid(value, r.schema)) continue;
      if (jsonBytes(value) > SYNC_MAX_VALUE_BYTES) continue;
      if (r?.route === "local") {
        if (!(key in this.s.deviceLocal))
          this.s.deviceLocal[key] = clone(value);
        continue;
      }
      if (this.s.subject === null) {
        if (!(key in local.device))
          local.device[key] = {
            value: clone(value),
            editedHlc: SYNC_IMPORT_HLC,
          };
        continue;
      }
      this.enqueueSetting(this.active(), key, value, SYNC_IMPORT_HLC, {
        moved: true,
      });
    }
    this.emitChanges(before, new Map(), "local");
    this.kick();
    return { ok: true };
  }

  /** Commit every debounced edit now and push. */
  flush(): CallResult {
    this.commitAllDrafts();
    this.kick();
    return { ok: true };
  }

  /** A licence or config document fetch succeeded: the only thing that lifts a `/sync` 401 or a
   *  non-`account_required` 403. */
  refresh(): CallResult {
    if (
      this.s.blocked === "unauthorized" ||
      this.s.blocked === "attestation" ||
      this.s.blocked === "forbidden"
    ) {
      this.s.blocked = null;
      this.kick();
    }
    return { ok: true };
  }

  /** Write a record: compare-and-swap for `revision` (rule 3), a stamped `set` for `lastWrite`,
   *  `max` and `min`, member operations for `merge`. */
  put(collection: string, id: string, value: Json): CallResult {
    const decl = this.collection(collection);
    if (!decl || decl.policy === "union")
      return { ok: false, error: "collection-unknown" };
    if (this.s.subject === null) return { ok: false, error: "signed-out" };
    const p = this.active();
    const rk = recordKey(collection, id);
    const target = { record: [collection, id] as [string, string] };
    const isRecord = (o: JournalOp): boolean =>
      "record" in o.target && recordKey(...o.target.record) === rk;
    if (decl.policy === "revision") {
      if (this.inFlightTouches(rk)) {
        p.held[rk] = clone(value);
      } else {
        const queued = p.pending.find(isRecord);
        if (queued) queued.value = clone(value);
        else
          this.enqueue(p, {
            target,
            op: "set",
            value: clone(value),
            baseVersion: p.records[rk]?.version ?? "*",
          });
      }
    } else {
      const editedHlc = this.tickHlc();
      const marks = this.s.contacted ? {} : { preContact: true as const };
      if (decl.policy === "merge") {
        const current = this.record(collection, id)?.value;
        const cur = isObject(current) ? current : {};
        const next = isObject(value) ? value : {};
        for (const member of Object.keys(next).sort(byteOrder))
          if (!(member in cur) || !jsonEqual(cur[member], next[member]))
            this.enqueue(p, {
              target,
              op: "setMember",
              member,
              value: clone(next[member] as Json),
              editedHlc,
              ...marks,
            });
        for (const member of Object.keys(cur).sort(byteOrder))
          if (!(member in next))
            this.enqueue(p, {
              target,
              op: "removeMember",
              member,
              editedHlc,
              ...marks,
            });
      } else {
        const queued = this.inFlightTouches(rk)
          ? undefined
          : p.pending.find((o) => isRecord(o) && o.op === "set");
        if (queued) {
          queued.value = clone(value);
          queued.editedHlc = editedHlc;
        } else
          this.enqueue(p, {
            target,
            op: "set",
            value: clone(value),
            editedHlc,
            ...marks,
          });
      }
    }
    this.kick();
    return { ok: true };
  }

  /** Add to a `union` record (an OR-set). */
  add(collection: string, id: string, element: Json): CallResult {
    return this.unionOp(collection, id, element, "add");
  }

  /** Remove from a `union` record, observed at the current cursor. */
  remove(collection: string, id: string, element: Json): CallResult {
    return this.unionOp(collection, id, element, "remove");
  }

  signIn(subject: string): CallResult {
    if (this.s.subject === subject) return { ok: true };
    if (this.s.subject !== null) this.leave("signOut", false);
    this.commitAllDrafts();
    const before = this.valueMap();
    this.s.blocked = null;
    this.signingOut = null;
    this.expirePartitions();
    const p = this.partitionFor(subject);
    p.signedOutAt = null;
    const local = this.s.partitions[LOCAL_PARTITION]!;
    const moving = Object.keys(local.device)
      .filter((key) => this.syncs(key))
      .sort(byteOrder);
    // A sign-in change re-sends every parked edit (R5), except one a moved local edit replaces.
    for (const key of moving) this.dropParkedByLocalEdit(p, key);
    this.unpark(p, () => true);
    for (const key of moving) {
      const d = local.device[key]!;
      const marks = {
        moved: true as const,
        ...(d.preContact ? { preContact: true as const } : {}),
      };
      if (d.cleared)
        this.enqueue(p, {
          target: this.targetOf(key),
          op: "clear",
          editedHlc: d.editedHlc,
          ...marks,
        });
      else this.enqueueSetting(p, key, d.value as Json, d.editedHlc, marks);
      delete local.device[key];
    }
    this.s.subject = subject;
    this.pullWanted = true;
    this.needSnapshot = false;
    this.emitChanges(before, new Map(), "remote");
    this.kick();
    return { ok: true };
  }

  signOut(opts: { discardUnsynced?: boolean } = {}): CallResult {
    if (this.s.subject === null) return { ok: true };
    this.commitAllDrafts();
    const discard = opts.discardUnsynced ?? false;
    const p = this.active();
    if (
      !discard &&
      this.network === "online" &&
      this.s.blocked === null &&
      this.sendable(p) > 0
    ) {
      this.signingOut = {
        deadline: this.nowMs + SYNC_SIGNOUT_FLUSH_MS,
        discard,
      };
      this.kick();
    } else {
      this.leave("signOut", discard);
    }
    return { ok: true };
  }

  setNetwork(state: "online" | "offline"): void {
    if (state === "offline" && this.inFlight)
      throw new Error("network: a request is in flight; respond first");
    this.network = state;
    if (state === "online") {
      this.pullWanted = true;
      this.kick();
    }
  }

  /** Move the clock, firing debounce commits and the sign-out flush deadline in time order. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let next: number | null = null;
      for (const d of Object.values(this.drafts))
        if (d.due <= target && (next === null || d.due < next)) next = d.due;
      if (
        this.signingOut &&
        this.signingOut.deadline <= target &&
        (next === null || this.signingOut.deadline < next)
      )
        next = this.signingOut.deadline;
      if (next === null) break;
      this.nowMs = next;
      if (this.signingOut && this.signingOut.deadline === next) {
        const discard = this.signingOut.discard;
        this.abandonInFlight();
        this.leave("signOut", discard);
        continue;
      }
      const due = Object.keys(this.drafts)
        .filter((k) => this.drafts[k]!.due === next)
        .sort(byteOrder);
      for (const k of due) this.commitDraft(k);
      this.kick();
    }
    this.nowMs = target;
  }

  /** The transport's answer to the request in flight. */
  receive(res: SyncResponse): void {
    const req = this.inFlight;
    if (!req) throw new Error("respond: no request is in flight");
    this.inFlight = null;
    let proceed = false;
    if ("error" in res) {
      // Request-level failure: nothing was processed and the journal is unchanged (rule 1).
      // The next trigger retries; backoff is the host's.
    } else if (
      res.status === 503 &&
      req.kind === "push" &&
      errorCode(res.body) === "writes_paused"
    ) {
      // R4: the operator paused writes. The journal is unchanged (rule 1), pulls still work,
      // and the next trigger retries (the host's backoff honours Retry-After).
      this.paused = true;
    } else if (res.status >= 500 || [400, 413, 429].includes(res.status)) {
      // Request-level failure, as above.
    } else if (res.status === 401) {
      this.s.blocked = "unauthorized";
    } else if (res.status === 403) {
      const err =
        isObject(res.body) && isObject(res.body.error) ? res.body.error : {};
      if (err.code === "account_required") {
        const url = typeof err.signInUrl === "string" ? err.signInUrl : null;
        this.leave("accountRequired", false);
        this.s.blocked = "account_required";
        this.events.push({ type: "signInOffered", signInUrl: url });
        return;
      }
      // The journal is kept; a document refresh lifts either block.
      this.s.blocked =
        err.code === "attestation_required" ? "attestation" : "forbidden";
    } else if (res.status === 409) {
      this.clientMismatch(req);
      proceed = true;
    } else if (res.status === 410) {
      const p = this.s.partitions[req.partition];
      if (p) p.cursor = 0;
      this.needSnapshot = true;
      proceed = true;
    } else if (res.status === 200 && isObject(res.body)) {
      if (req.kind === "push") this.paused = false;
      this.ok(req, res.body);
      proceed = true;
    }
    if (this.signingOut && this.s.subject !== null) {
      const p = this.active();
      if (!proceed || this.sendable(p) === 0) {
        this.leave("signOut", this.signingOut.discard);
        return;
      }
    }
    if (proceed) this.kick();
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────

  get(key: string): EffectiveValue {
    const docValue = this.document.values[key] ?? null;
    const doc: EffectiveValue = { value: clone(docValue), from: "document" };
    const r = this.route(key);
    // A lock beats the person's own choice, the `local` slot included.
    if (this.locked(key) || r?.route === "locked" || r?.route === "refused")
      return doc;
    if (r?.route === "local")
      return key in this.s.deviceLocal
        ? { value: clone(this.s.deviceLocal[key] as Json), from: "device" }
        : doc;
    const layer = this.layer(key);
    if (!layer || layer.value === undefined) return doc;
    if (!valueValid(layer.value, this.schemaOf(key))) return doc;
    return { value: clone(layer.value), from: layer.from };
  }

  settingState(key: string): SettingState {
    const r = this.route(key);
    const layer = this.syncs(key) ? this.layer(key) : undefined;
    return {
      sync:
        this.s.subject === null || r?.route === "local"
          ? "local"
          : layer?.pending
            ? "pending"
            : "synced",
      invalid:
        layer !== undefined &&
        layer.value !== undefined &&
        !valueValid(layer.value, this.schemaOf(key)),
      locked: this.locked(key) || r?.route === "locked",
    };
  }

  record(collection: string, id: string): EffectiveValue | null {
    if (this.s.subject === null) return null;
    const p = this.active();
    const rk = recordKey(collection, id);
    let value: Json | undefined = p.records[rk]?.value;
    let pending = false;
    for (const op of p.pending)
      if ("record" in op.target && recordKey(...op.target.record) === rk) {
        value = applyRecordOp(value, op);
        pending = true;
      }
    if (rk in p.held) {
      value = clone(p.held[rk]);
      pending = true;
    }
    if (value === undefined) return null;
    return { value: clone(value), from: pending ? "pending" : "cloud" };
  }

  status(): SyncStatus {
    const pending = this.pendingCount();
    if (this.s.blocked)
      return { state: "blocked", pending, reason: this.s.blocked };
    if (this.s.subject === null) return { state: "local", pending };
    const parked = this.parkedReason();
    const at = (state: SyncStatus["state"]): SyncStatus =>
      parked ? { state, pending, reason: parked } : { state, pending };
    if (this.network === "offline") return at("offline");
    if (this.inFlight) return at("syncing");
    if (this.paused) return at("paused");
    return at(pending > 0 ? "pending" : "idle");
  }

  /** The journal, normalised: what every SDK's journal must hold, whatever its encoding. */
  journal(): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const name of Object.keys(this.s.partitions).sort(byteOrder)) {
      const p = this.s.partitions[name]!;
      if (name === LOCAL_PARTITION) {
        if (Object.keys(p.device).length > 0)
          out[name] = { settings: clone(p.device) as unknown as Json };
        continue;
      }
      const view: Record<string, Json> = {
        clientId: p.clientId,
        nextMutationId: p.nextMutationId,
        cursor: p.cursor,
        pending: clone(p.pending) as unknown as Json,
      };
      if (Object.keys(p.held).length > 0) view.held = clone(p.held);
      out[name] = view;
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────

  /** The key's route (an old name resolves through the pull's aliases); `undefined`: open. */
  private route(key: string): SettingRoute | undefined {
    return (
      this.catalog.settings.find((d) => d.key === key) ??
      this.catalog.settings.find((d) => d.key === this.alias(key))
    );
  }

  /** Whether the key travels through the journal: a synced key or an open setting. */
  private syncs(key: string): boolean {
    const r = this.route(key);
    return r === undefined || r.route === "synced";
  }

  private policyOf(key: string): SettingPolicy {
    const r = this.route(key);
    return r?.route === "synced" ? r.policy : "lastWrite";
  }

  private schemaOf(key: string): ValueSchema | undefined {
    const r = this.route(key);
    return r?.route === "synced" ? r.schema : undefined;
  }

  /** A synced key is pushed with its route's scope, an open setting with `user`. */
  private targetOf(key: string): SyncTarget {
    const r = this.route(key);
    return { setting: key, scope: r?.route === "synced" ? r.scope : "user" };
  }

  private collection(name: string): CollectionDecl | undefined {
    return this.catalog.collections?.find((c) => c.name === name);
  }

  private alias(key: string): string {
    return this.s.aliases[key] ?? key;
  }

  private locked(key: string): boolean {
    return this.document.locked?.includes(key) ?? false;
  }

  private active(): Partition {
    return this.partitionFor(this.s.subject ?? LOCAL_PARTITION);
  }

  private partitionFor(name: string): Partition {
    let p = this.s.partitions[name];
    if (!p) {
      p = newPartition(name === LOCAL_PARTITION ? null : this.freshClientId());
      this.s.partitions[name] = p;
    }
    return p;
  }

  private freshClientId(): string {
    const id = this.newClientId();
    if (!SYNC_CLIENT_ID_PATTERN.test(id))
      throw new Error(`bad clientId: ${id}`);
    return id;
  }

  private pendingCount(): number {
    const drafts = Object.keys(this.drafts).length;
    if (this.s.subject === null) return drafts;
    const p = this.active();
    return drafts + p.pending.length + Object.keys(p.held).length;
  }

  /** What a push can still carry: every journalled operation that is not parked, plus held. */
  private sendable(p: Partition): number {
    return (
      p.pending.filter((o) => !o.parked).length + Object.keys(p.held).length
    );
  }

  private parkedReason(): ParkReason | undefined {
    if (this.s.subject === null) return undefined;
    const kinds = new Set(this.active().pending.map((o) => o.parked));
    return kinds.has("quota")
      ? "quota"
      : kinds.has("entitlement")
        ? "entitlement"
        : undefined;
  }

  private tickHlc(): string {
    const physical = this.nowMs + this.s.offsetMs;
    if (physical > this.s.hlc[0]) this.s.hlc = [physical, 0];
    else this.s.hlc = [this.s.hlc[0], this.s.hlc[1] + 1];
    return formatHlc(this.s.hlc[0], this.s.hlc[1]);
  }

  private layer(
    key: string,
  ):
    | { value: Json | undefined; from: ValueFrom; pending: boolean }
    | undefined {
    if (!this.syncs(key)) return undefined;
    const policy = this.policyOf(key);
    const target = this.alias(key);
    const matches = (k: string): boolean => this.alias(k) === target;
    let value: Json | undefined;
    let has = false;
    let pending = false;
    const p = this.active();
    if (this.s.subject !== null) {
      const snap = p.settings[target];
      if (snap) {
        value = clone(snap.value);
        has = true;
      }
      for (const op of p.pending)
        if ("setting" in op.target && matches(op.target.setting)) {
          value = applySettingOp(policy, value, op);
          pending = true;
        }
    } else {
      for (const k of Object.keys(p.device))
        if (matches(k)) {
          const d = p.device[k]!;
          value = d.cleared ? undefined : clone(d.value);
          has = true;
        }
    }
    for (const k of Object.keys(this.drafts))
      if (matches(k)) {
        const d = this.drafts[k]!;
        value = d.clear
          ? undefined
          : policy === "merge"
            ? clone(d.value)
            : applySettingOp(policy, value, { op: "set", value: d.value });
        pending = true;
      }
    if (!has && !pending) return undefined;
    const from: ValueFrom = pending
      ? "pending"
      : this.s.subject !== null
        ? "cloud"
        : "device";
    return { value, from, pending };
  }

  /** Every open setting the device knows of: in the snapshot, the journal or a draft. */
  private openKeys(): string[] {
    const keys = new Set<string>();
    const add = (k: string): void => {
      if (this.route(k) === undefined) keys.add(k);
    };
    if (this.s.subject !== null) {
      const p = this.active();
      for (const k of Object.keys(p.settings)) add(k);
      for (const op of p.pending)
        if ("setting" in op.target) add(op.target.setting);
    } else {
      for (const k of Object.keys(this.s.partitions[LOCAL_PARTITION]!.device))
        add(k);
    }
    for (const k of Object.keys(this.drafts)) add(k);
    return [...keys];
  }

  private valueMap(): Map<string, Json> {
    const m = new Map<string, Json>();
    for (const r of this.catalog.settings)
      if (r.route === "synced" || r.route === "local")
        m.set(r.key, this.get(r.key).value);
    for (const k of this.openKeys()) m.set(k, this.get(k).value);
    return m;
  }

  private emitChanges(
    before: Map<string, Json>,
    overrides: Map<string, ChangeOrigin>,
    origin: ChangeOrigin,
  ): void {
    const after = this.valueMap();
    const groups = new Map<ChangeOrigin, string[]>();
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      // A key known on one side only read as the document's value on the other.
      const was = before.has(k)
        ? before.get(k)
        : (this.document.values[k] ?? null);
      const is = after.has(k) ? after.get(k) : this.get(k).value;
      if (jsonEqual(was, is)) continue;
      const o = overrides.get(k) ?? origin;
      groups.set(o, [...(groups.get(o) ?? []), k]);
    }
    for (const o of ["local", "remote", "merge", "migration"] as const) {
      const keys = groups.get(o);
      if (keys)
        this.events.push({
          type: "change",
          keys: keys.sort(byteOrder),
          origin: o,
        });
    }
  }

  /**
   * `set` and `clear` (§2.5), journalling nothing on a refusal: a declared `secret` or `flag` is
   * `bad_request`; a catalog lock or a lock in the current document is `managed_by_admin`; a value
   * that fails the key's schema, or is over `SYNC_MAX_VALUE_BYTES`, is `bad_request`. A `local`
   * key is written to `deviceLocal`; anything else is drafted, an undeclared key as an open
   * setting.
   */
  private edit(
    key: string,
    change: { value?: Json; clear?: true },
  ): CallResult {
    const r = this.route(key);
    if (r?.route === "refused") return { ok: false, error: "bad_request" };
    if (r?.route === "locked" || this.locked(key))
      return { ok: false, error: "managed_by_admin" };
    if (!change.clear) {
      const value = change.value as Json;
      if (r?.route === "synced" && !valueValid(value, r.schema))
        return { ok: false, error: "bad_request" };
      if (jsonBytes(value) > SYNC_MAX_VALUE_BYTES)
        return { ok: false, error: "bad_request" };
    }
    const before = this.valueMap();
    if (r?.route === "local") {
      if (change.clear) delete this.s.deviceLocal[key];
      else this.s.deviceLocal[key] = clone(change.value as Json);
      this.emitChanges(before, new Map(), "local");
      return { ok: true };
    }
    this.drafts[key] = {
      ...change,
      editedHlc: this.tickHlc(),
      ...(this.s.contacted ? {} : { preContact: true as const }),
      due: this.nowMs + SYNC_DEBOUNCE_MS,
    };
    this.emitChanges(before, new Map(), "local");
    return { ok: true };
  }

  private commitAllDrafts(): void {
    for (const k of Object.keys(this.drafts).sort(byteOrder))
      this.commitDraft(k);
  }

  private commitDraft(key: string): void {
    const d = this.drafts[key];
    if (!d) return;
    const policy = this.policyOf(key);
    const marks = d.preContact ? { preContact: true as const } : {};
    if (this.s.subject === null) {
      // The local partition keeps one value per key, its policy already applied.
      const local = this.s.partitions[LOCAL_PARTITION]!;
      const prior = local.device[key];
      delete this.drafts[key];
      if (d.clear) {
        local.device[key] = { cleared: true, editedHlc: d.editedHlc, ...marks };
      } else {
        const base = prior && !prior.cleared ? prior.value : undefined;
        const value =
          policy === "merge"
            ? clone(d.value as Json)
            : (applySettingOp(policy, base, {
                op: "set",
                value: d.value,
              }) as Json);
        local.device[key] = { value, editedHlc: d.editedHlc, ...marks };
      }
      return;
    }
    const p = this.active();
    delete this.drafts[key];
    this.dropParkedByLocalEdit(p, key);
    if (d.clear) {
      this.enqueue(p, {
        target: this.targetOf(key),
        op: "clear",
        editedHlc: d.editedHlc,
        ...marks,
      });
      return;
    }
    this.enqueueSetting(p, key, d.value as Json, d.editedHlc, marks);
  }

  /**
   * Journal a whole value for `key`: one `set`, or, for a `merge` key, one member operation per
   * member that differs from the current view (the view without this edit).
   */
  private enqueueSetting(
    p: Partition,
    key: string,
    value: Json,
    editedHlc: string,
    marks: { preContact?: true; moved?: true },
  ): void {
    const target = this.targetOf(key);
    if (this.policyOf(key) !== "merge" || !isObject(value)) {
      this.enqueue(p, {
        target,
        op: "set",
        value: clone(value),
        editedHlc,
        ...marks,
      });
      return;
    }
    const current =
      this.s.subject === null ? undefined : this.layer(key)?.value;
    const cur = isObject(current) ? current : {};
    for (const member of Object.keys(value).sort(byteOrder))
      if (!(member in cur) || !jsonEqual(cur[member], value[member]))
        this.enqueue(p, {
          target,
          op: "setMember",
          member,
          value: clone(value[member] as Json),
          editedHlc,
          ...marks,
        });
    for (const member of Object.keys(cur).sort(byteOrder))
      if (!(member in value))
        this.enqueue(p, {
          target,
          op: "removeMember",
          member,
          editedHlc,
          ...marks,
        });
  }

  private enqueue(p: Partition, op: Omit<JournalOp, "mutationId">): JournalOp {
    const full = { mutationId: p.nextMutationId, ...op } as JournalOp;
    p.nextMutationId += 1;
    p.pending.push(full);
    return full;
  }

  /** A newer local edit of a `lastWrite` or `merge` key replaces its parked edits (R5). A `max`
   *  or `min` key keeps them: the server decides by value, so the older edit may still win. */
  private dropParkedByLocalEdit(p: Partition, key: string): void {
    const policy = this.policyOf(key);
    if (policy !== "lastWrite" && policy !== "merge") return;
    const target = this.alias(key);
    p.pending = p.pending.filter(
      (o) =>
        !(
          o.parked &&
          "setting" in o.target &&
          this.alias(o.target.setting) === target
        ),
    );
  }

  /** Re-send parked edits as NEW mutations with their original clock (rule 1: a processed
   *  mutationId is never resent). */
  private unpark(p: Partition, which: (reason: ParkReason) => boolean): void {
    const parked = p.pending.filter((o) => o.parked && which(o.parked));
    if (parked.length === 0) return;
    p.pending = p.pending.filter((o) => !parked.includes(o));
    for (const { mutationId: _id, parked: _k, ...rest } of parked)
      this.enqueue(p, rest);
  }

  private unionOp(
    collection: string,
    id: string,
    element: Json,
    op: "add" | "remove",
  ): CallResult {
    const decl = this.collection(collection);
    if (!decl || decl.policy !== "union")
      return { ok: false, error: "collection-unknown" };
    if (this.s.subject === null) return { ok: false, error: "signed-out" };
    const p = this.active();
    const target = { record: [collection, id] as [string, string] };
    this.enqueue(
      p,
      op === "add"
        ? { target, op, element: clone(element) }
        : { target, op, element: clone(element), observedSeq: p.cursor },
    );
    this.kick();
    return { ok: true };
  }

  private inFlightTouches(rk: string): boolean {
    if (!this.inFlight || this.inFlight.kind !== "push") return false;
    const p = this.s.partitions[this.inFlight.partition];
    return (
      !!p &&
      p.pending.some(
        (o) =>
          this.inFlight!.mutationIds.includes(o.mutationId) &&
          "record" in o.target &&
          recordKey(...o.target.record) === rk,
      )
    );
  }

  /** Send the next request, if one is due and allowed. */
  private kick(): void {
    if (this.inFlight || this.s.subject === null || this.s.blocked) return;
    if (this.network !== "online") return;
    const name = this.s.subject;
    const p = this.active();
    const pullPath = (cursor: number): string =>
      `/${this.product}/sync?cursor=${cursor}&clientId=${p.clientId}`;
    if (!this.s.contacted || this.needSnapshot) {
      const cursor = this.needSnapshot ? 0 : p.cursor;
      this.inFlight = {
        kind: "pull",
        partition: name,
        cursor,
        mutationIds: [],
      };
      this.outbox.push({ method: "GET", path: pullPath(cursor) });
      return;
    }
    const batch = p.pending
      .filter((o) => !o.parked)
      .slice(0, SYNC_MAX_MUTATIONS);
    if (batch.length > 0) {
      this.inFlight = {
        kind: "push",
        partition: name,
        cursor: p.cursor,
        mutationIds: batch.map((o) => o.mutationId),
      };
      this.outbox.push({
        method: "POST",
        path: `/${this.product}/sync/ops`,
        body: {
          clientId: p.clientId,
          cursor: p.cursor,
          atomic: false,
          mutations: batch.map(wireOf) as unknown as Json,
        },
      });
      return;
    }
    if (this.signingOut) {
      this.leave("signOut", this.signingOut.discard);
      return;
    }
    if (this.pullWanted) {
      this.inFlight = {
        kind: "pull",
        partition: name,
        cursor: p.cursor,
        mutationIds: [],
      };
      this.outbox.push({ method: "GET", path: pullPath(p.cursor) });
    }
  }

  private abandonInFlight(): void {
    this.inFlight = null;
  }

  private clientMismatch(req: InFlight): void {
    // Rule 4: the server bound this clientId to another device. Regenerate and renumber; none
    // of these mutations was processed under the new id.
    const p = this.s.partitions[req.partition];
    if (!p) return;
    p.clientId = this.freshClientId();
    p.nextMutationId = 1;
    const ops = p.pending;
    p.pending = [];
    for (const { mutationId: _id, ...rest } of ops) this.enqueue(p, rest);
  }

  private firstContact(serverNow: number): void {
    this.s.offsetMs = serverNow - this.nowMs;
    if (this.s.contacted) return;
    this.s.contacted = true;
    const offset = this.s.offsetMs;
    const restamp = Math.abs(offset) > SYNC_MAX_CLOCK_SKEW_MS;
    const shift = (h: string): string => {
      const [ms, c] = parseHlc(h);
      return formatHlc(ms + offset, c);
    };
    for (const p of Object.values(this.s.partitions)) {
      for (const op of p.pending)
        if (op.preContact) {
          if (restamp && op.editedHlc) op.editedHlc = shift(op.editedHlc);
          delete op.preContact;
        }
      for (const d of Object.values(p.device))
        if (d.preContact) {
          if (restamp) d.editedHlc = shift(d.editedHlc);
          delete d.preContact;
        }
    }
    for (const d of Object.values(this.drafts))
      if (d.preContact) {
        if (restamp) d.editedHlc = shift(d.editedHlc);
        delete d.preContact;
      }
    if (restamp && this.s.hlc[0] > 0)
      this.s.hlc = [this.s.hlc[0] + offset, this.s.hlc[1]];
  }

  private ok(req: InFlight, body: { [k: string]: Json }): void {
    if (typeof body.serverNow === "number") this.firstContact(body.serverNow);
    if (req.partition !== this.s.subject) return;
    if (typeof body.subject === "string" && body.subject !== req.partition) {
      this.leave("subjectChanged", false);
      return;
    }
    const p = this.active();
    const before = this.valueMap();
    const overrides = new Map<string, ChangeOrigin>();
    const batch = p.pending.filter((o) =>
      req.mutationIds.includes(o.mutationId),
    );
    const parkedNow: JournalOp[] = [];
    const results = Array.isArray(body.results) ? body.results : [];
    for (const r of results) {
      if (!isObject(r) || typeof r.mutationId !== "number") continue;
      const at = p.pending.findIndex(
        (o) =>
          o.mutationId === r.mutationId &&
          req.mutationIds.includes(o.mutationId),
      );
      if (at < 0) continue;
      const op = p.pending[at]!;
      const park =
        r.status === "rejected" && "setting" in op.target
          ? PARKING[String(r.code)]
          : undefined;
      if (park) {
        // R5: a retryable refusal keeps the edit on the device, still read, until it can land.
        op.parked = park;
        parkedNow.push(op);
        continue;
      }
      p.pending.splice(at, 1);
      this.result(p, op, r, overrides);
    }
    // A parked edit that a later edit of the same value already replaces is dropped.
    for (const op of parkedNow)
      if (
        [...batch, ...p.pending].some(
          (q) => q !== op && q.mutationId > op.mutationId && sameValue(op, q),
        )
      )
        p.pending = p.pending.filter((o) => o !== op);
    // The pull members: a cursor-0 request answers with a snapshot, which replaces ours.
    if (req.cursor === 0 && typeof body.cursor === "number") {
      p.settings = {};
      p.records = {};
    }
    for (const c of Array.isArray(body.changes) ? body.changes : []) {
      if (!isObject(c) || typeof c.version !== "number") continue;
      if (typeof c.setting === "string") {
        p.settings[c.setting] = {
          value: clone(c.value ?? null),
          version: c.version,
        };
        this.dropParkedByRemote(p, c.setting, c.editedHlc);
      } else if (Array.isArray(c.record) && c.record.length === 2)
        p.records[recordKey(String(c.record[0]), String(c.record[1]))] = {
          value: clone(c.value ?? null),
          version: c.version,
        };
    }
    for (const t of Array.isArray(body.tombstones) ? body.tombstones : []) {
      if (!isObject(t)) continue;
      if (typeof t.setting === "string") {
        delete p.settings[t.setting];
        this.dropParkedByRemote(p, t.setting, t.editedHlc);
      } else if (Array.isArray(t.record) && t.record.length === 2)
        delete p.records[recordKey(String(t.record[0]), String(t.record[1]))];
    }
    if (typeof body.cursor === "number") p.cursor = body.cursor;
    if (isObject(body.aliases)) {
      const aliases: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.aliases))
        if (typeof v === "string") aliases[k] = v;
      this.s.aliases = aliases;
    }
    // R5: more room than the last response showed re-sends the quota-parked edits.
    const quota = isObject(body.quota) ? body.quota.bytes : undefined;
    const usage = isObject(body.usage) ? body.usage.bytes : undefined;
    if (typeof quota === "number" && typeof usage === "number") {
      const headroom = quota - usage;
      if (p.headroom !== null && headroom > p.headroom)
        this.unpark(p, (reason) => reason === "quota");
      p.headroom = headroom;
    }
    this.needSnapshot = false;
    this.pullWanted = body.more === true;
    this.emitChanges(before, overrides, "remote");
  }

  /** A newer remote value of a `lastWrite` key replaces its parked `set` or `clear` (R5). */
  private dropParkedByRemote(
    p: Partition,
    serverKey: string,
    editedHlc: Json | undefined,
  ): void {
    if (typeof editedHlc !== "string") return;
    p.pending = p.pending.filter(
      (o) =>
        !(
          o.parked &&
          "setting" in o.target &&
          (o.op === "set" || o.op === "clear") &&
          this.alias(o.target.setting) === serverKey &&
          this.policyOf(o.target.setting) === "lastWrite" &&
          o.editedHlc !== undefined &&
          o.editedHlc < editedHlc
        ),
    );
  }

  private result(
    p: Partition,
    op: JournalOp,
    r: { [k: string]: Json },
    overrides: Map<string, ChangeOrigin>,
  ): void {
    const status = r.status;
    if ("setting" in op.target) {
      const key = op.target.setting;
      const serverKey =
        typeof r.renamedTo === "string" ? r.renamedTo : this.alias(key);
      if (op.moved) overrides.set(key, "merge");
      if (status === "ok") {
        if (r.dropped === true) {
          overrides.set(key, "migration");
          for (const d of this.catalog.settings)
            if (this.alias(d.key) === this.alias(key))
              overrides.set(d.key, "migration");
        } else if (typeof r.version === "number") {
          const value = applySettingOp(
            this.policyOf(key),
            p.settings[serverKey]?.value,
            op,
          );
          if (value === undefined) delete p.settings[serverKey];
          else p.settings[serverKey] = { value, version: r.version };
        }
      } else if (status === "conflict" && isObject(r.server)) {
        // Q6: a stale write loses to the server copy, and nothing is enqueued.
        const server = r.server;
        if (typeof server.version === "number")
          p.settings[serverKey] = {
            value: clone(server.value ?? null),
            version: server.version,
          };
      } else if (status === "rejected") {
        // A terminal refusal: the value reverts to the snapshot and the app is told.
        this.events.push({
          type: "rejected",
          mutationId: op.mutationId,
          code: String(r.code),
        });
      }
      return;
    }
    // A record.
    const [c, id] = op.target.record;
    const rk = recordKey(c, id);
    const decl = this.collection(c);
    let rebaseOn: number | "*" | null = null;
    let rebaseValue: Json | undefined;
    if (status === "ok" && typeof r.version === "number") {
      const value = applyRecordOp(p.records[rk]?.value, op);
      if (value !== undefined) p.records[rk] = { value, version: r.version };
      if (rk in p.held) rebaseOn = r.version;
    } else if (status === "conflict" && isObject(r.server)) {
      const server = r.server;
      if (typeof server.version === "number") {
        p.records[rk] = {
          value: clone(server.value ?? null),
          version: server.version,
        };
        // Rule 2: the resolution is a NEW mutation on the server's version; N is never resent.
        // Only `revision` resolves on the device; every other policy took the server's copy.
        if (rk in p.held) rebaseOn = server.version;
        else if (
          decl?.policy === "revision" &&
          decl.resolve === "keepLocal" &&
          op.op === "set"
        ) {
          rebaseOn = server.version;
          rebaseValue = op.value;
        }
      }
    } else {
      if (status === "rejected")
        this.events.push({
          type: "rejected",
          mutationId: op.mutationId,
          code: String(r.code),
        });
      if (rk in p.held) rebaseOn = p.records[rk]?.version ?? "*";
    }
    if (rebaseOn !== null) {
      const value = rk in p.held ? p.held[rk] : (rebaseValue as Json);
      delete p.held[rk];
      this.enqueue(p, {
        target: { record: [c, id] },
        op: "set",
        value: clone(value),
        baseVersion: rebaseOn,
      });
    }
  }

  /** Sign-out, and every principal change handled like it (rule 5, plans/U-01.md §2.4). */
  private leave(
    reason: "signOut" | "accountRequired" | "subjectChanged",
    discard: boolean,
  ): void {
    const name = this.s.subject;
    if (name === null) return;
    this.commitAllDrafts();
    const before = this.valueMap();
    const p = this.active();
    const unsynced = p.pending.length + Object.keys(p.held).length;
    if (discard) {
      p.pending = [];
      p.held = {};
    }
    if (this.onSignOutPolicy === "clear" || reason !== "signOut") {
      p.settings = {};
      p.records = {};
      p.cursor = 0;
    }
    p.signedOutAt = this.nowMs;
    this.s.subject = null;
    this.signingOut = null;
    this.inFlight = null;
    this.needSnapshot = false;
    this.pullWanted = false;
    this.events.push({ type: "signedOut", reason, unsynced });
    if (unsynced > 0 && !discard)
      this.events.push({ type: "unsyncedData", count: unsynced });
    this.emitChanges(before, new Map(), "remote");
  }

  private expirePartitions(): void {
    for (const [name, p] of Object.entries(this.s.partitions)) {
      if (name === LOCAL_PARTITION || name === this.s.subject) continue;
      if (
        p.signedOutAt !== null &&
        this.nowMs - p.signedOutAt >= SYNC_PENDING_DAYS * DAY_MS
      )
        delete this.s.partitions[name];
    }
  }
}

/** Whether two setting operations write the same value: the same key, and the same member
 *  unless one of them writes the whole value. */
function sameValue(a: JournalOp, b: JournalOp): boolean {
  if (!("setting" in a.target) || !("setting" in b.target)) return false;
  if (a.target.setting !== b.target.setting) return false;
  const whole = (o: JournalOp): boolean => o.op === "set" || o.op === "clear";
  return whole(a) || whole(b) || a.member === b.member;
}

/** Relaunch: persist, then restore with the same host options (`lost` drops the journal; the
 *  device binding, `subject`, is device state and survives, and so does the `config.local` store
 *  behind `deviceLocal`). */
export function relaunch(
  machine: CloudSyncMachine,
  opts: CloudSyncOptions,
  journal: "kept" | "lost" = "kept",
): CloudSyncMachine {
  const saved = machine.persist();
  if (journal === "lost")
    return new CloudSyncMachine({
      ...opts,
      now: machine.now,
      network: machine.networkState,
      offsetMs: 0,
      contacted: false,
      subject: saved.subject,
      deviceLocal: saved.deviceLocal,
      imported: saved.imported,
    });
  return new CloudSyncMachine(
    { ...opts, now: machine.now, network: machine.networkState },
    saved,
  );
}
