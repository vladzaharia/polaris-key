// The Cloud Sync reference client state machine (plans/U-01.md §2.3, §2.4, §4.1; S-17 §5.4–§5.6).
//
// Client behaviour, outside the wire contract: the journal reducer, the hybrid logical clock,
// the per-key debounce, conflict rebase, the per-subject partitions and the first-sign-in move.
// `conformance/corpus/v2/sync-scenarios.json` pins it scenario by scenario, and
// `conformance/runners/node/syncScenarios.test.ts` replays every scenario through it; the other
// SDKs' runners replay the same file. WIRE-CONTRACT-V4 §11.5 is the prose form.
//
// The machine does no I/O. It owns a fake-able clock (`advance`), queues the requests it would
// send (`takeRequests`) and the events it would emit (`takeEvents`), and is told what the
// transport answered (`receive`). At most one request is in flight. Retry backoff and the live
// poke are host concerns and are not modelled: a request-level failure waits for the next
// trigger (a commit, `flush`, `network online`, `refresh`, sign-in or relaunch).
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

/** Per-key debounce of `setConfig` (S-17 §5.4). U-05 moves these into `@polaris-key/protocol/sync`. */
export const SYNC_DEBOUNCE_MS = 2000;
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

/** A catalog `config` key with a `user` block, as the client sees it. */
export interface SettingDecl {
  key: string;
  policy: SettingPolicy;
  schema?: ValueSchema;
}

/** A collection (U-09). `resolve` stands in for a developer conflict hook. */
export interface CollectionDecl {
  name: string;
  policy: "revision" | "union";
  resolve?: "keepServer" | "keepLocal";
}

export interface CloudSyncCatalog {
  settings: SettingDecl[];
  collections?: CollectionDecl[];
}

/** The rest of the resolution chain under the `local` slot, and the keys the current signed
 *  config document marks `enforced` or `hidden`. */
export interface CloudSyncDocument {
  values: Record<string, Json>;
  locked?: string[];
}

export type SyncTarget =
  | { setting: string; scope: "user" }
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

/** A journalled mutation: the wire form plus two journal-only marks. */
export interface JournalOp extends WireMutation {
  /** Stamped before the install's first server contact (re-stamped at first contact). */
  preContact?: true;
  /** Moved from the local partition at first sign-in (its losers report `origin: "merge"`). */
  moved?: true;
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
}

type Blocked = null | "account_required" | "unauthorized";

/** Everything that survives a relaunch. */
export interface CloudSyncPersisted {
  subject: string | null;
  partitions: Record<string, Partition>;
  hlc: [number, number];
  offsetMs: number;
  contacted: boolean;
  aliases: Record<string, string>;
  blocked: Blocked;
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
  state: "local" | "idle" | "pending" | "syncing" | "offline" | "blocked";
  pending: number;
  reason?: "account_required" | "unauthorized";
}

export interface SettingState {
  pending: boolean;
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
  };
}

/** The wire form of a journalled mutation (journal-only marks stripped). */
export function wireOf(op: JournalOp): WireMutation {
  const { preContact: _p, moved: _m, ...wire } = op;
  return clone(wire);
}

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

  setConfig(key: string, value: Json): CallResult {
    return this.edit(key, { value: clone(value) });
  }

  clearConfig(key: string): CallResult {
    return this.edit(key, { clear: true });
  }

  /** Commit every debounced edit now and push. */
  flush(): CallResult {
    this.commitAllDrafts();
    this.kick();
    return { ok: true };
  }

  /** A licence or config document fetch succeeded: the only thing that lifts a `/sync` 401. */
  refresh(): CallResult {
    if (this.s.blocked === "unauthorized") {
      this.s.blocked = null;
      this.kick();
    }
    return { ok: true };
  }

  /** Write a `revision` record (compare-and-swap; rule 3). */
  put(collection: string, id: string, value: Json): CallResult {
    const decl = this.collection(collection);
    if (!decl || decl.policy !== "revision")
      return { ok: false, error: "collection-unknown" };
    if (this.s.subject === null) return { ok: false, error: "signed-out" };
    const p = this.active();
    const rk = recordKey(collection, id);
    const target = { record: [collection, id] as [string, string] };
    if (this.inFlightTouches(rk)) {
      p.held[rk] = clone(value);
    } else {
      const queued = p.pending.find(
        (o) => "record" in o.target && recordKey(...o.target.record) === rk,
      );
      if (queued) queued.value = clone(value);
      else
        this.enqueue(p, {
          target,
          op: "set",
          value: clone(value),
          baseVersion: p.records[rk]?.version ?? "*",
        });
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
    for (const key of Object.keys(local.device).sort(byteOrder)) {
      const d = local.device[key]!;
      const decl = this.decl(key);
      const target = { setting: key, scope: "user" as const };
      const marks = {
        moved: true as const,
        ...(d.preContact ? { preContact: true as const } : {}),
      };
      if (d.cleared || decl?.policy !== "merge" || !isObject(d.value)) {
        this.enqueue(
          p,
          d.cleared
            ? { target, op: "clear", editedHlc: d.editedHlc, ...marks }
            : {
                target,
                op: "set",
                value: clone(d.value as Json),
                editedHlc: d.editedHlc,
                ...marks,
              },
        );
      } else {
        for (const member of Object.keys(d.value).sort(byteOrder))
          this.enqueue(p, {
            target,
            op: "setMember",
            member,
            value: clone(d.value[member]),
            editedHlc: d.editedHlc,
            ...marks,
          });
      }
    }
    local.device = {};
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
      p.pending.length + Object.keys(p.held).length > 0
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
    if (
      "error" in res ||
      res.status >= 500 ||
      [400, 413, 429].includes(res.status)
    ) {
      // Request-level failure: nothing was processed and the journal is unchanged (rule 1).
      // The next trigger retries; backoff is the host's.
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
    } else if (res.status === 409) {
      this.clientMismatch(req);
      proceed = true;
    } else if (res.status === 410) {
      const p = this.s.partitions[req.partition];
      if (p) p.cursor = 0;
      this.needSnapshot = true;
      proceed = true;
    } else if (res.status === 200 && isObject(res.body)) {
      this.ok(req, res.body);
      proceed = true;
    }
    if (this.signingOut && this.s.subject !== null) {
      const p = this.active();
      if (!proceed || p.pending.length + Object.keys(p.held).length === 0) {
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
    const decl = this.decl(key);
    if (!decl || this.locked(key)) return doc;
    const layer = this.layer(key);
    if (!layer || layer.value === undefined) return doc;
    if (!valueValid(layer.value, decl.schema)) return doc;
    return { value: clone(layer.value), from: layer.from };
  }

  settingState(key: string): SettingState {
    const decl = this.decl(key);
    const layer = decl ? this.layer(key) : undefined;
    return {
      pending: layer?.pending ?? false,
      invalid:
        !!decl &&
        layer !== undefined &&
        layer.value !== undefined &&
        !valueValid(layer.value, decl.schema),
      locked: this.locked(key),
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
    if (this.network === "offline") return { state: "offline", pending };
    if (this.inFlight) return { state: "syncing", pending };
    return { state: pending > 0 ? "pending" : "idle", pending };
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

  private decl(key: string): SettingDecl | undefined {
    return (
      this.catalog.settings.find((d) => d.key === key) ??
      this.catalog.settings.find((d) => d.key === this.alias(key))
    );
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
    const decl = this.decl(key);
    if (!decl) return undefined;
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
          value = applySettingOp(decl.policy, value, op);
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
          : decl.policy === "merge"
            ? clone(d.value)
            : applySettingOp(decl.policy, value, { op: "set", value: d.value });
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

  private valueMap(): Map<string, Json> {
    const m = new Map<string, Json>();
    for (const d of this.catalog.settings) m.set(d.key, this.get(d.key).value);
    return m;
  }

  private emitChanges(
    before: Map<string, Json>,
    overrides: Map<string, ChangeOrigin>,
    origin: ChangeOrigin,
  ): void {
    const after = this.valueMap();
    const groups = new Map<ChangeOrigin, string[]>();
    for (const [k, v] of after) {
      if (jsonEqual(before.get(k), v)) continue;
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

  private edit(
    key: string,
    change: { value?: Json; clear?: true },
  ): CallResult {
    const decl = this.decl(key);
    if (!decl) return { ok: false, error: "setting-unknown" };
    if (this.locked(key)) return { ok: false, error: "setting-locked" };
    const before = this.valueMap();
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
    const decl = this.decl(key) as SettingDecl;
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
          decl.policy === "merge"
            ? clone(d.value as Json)
            : (applySettingOp(decl.policy, base, {
                op: "set",
                value: d.value,
              }) as Json);
        local.device[key] = { value, editedHlc: d.editedHlc, ...marks };
      }
      return;
    }
    const p = this.active();
    const target = { setting: key, scope: "user" as const };
    if (d.clear) {
      delete this.drafts[key];
      this.enqueue(p, {
        target,
        op: "clear",
        editedHlc: d.editedHlc,
        ...marks,
      });
      return;
    }
    if (decl.policy !== "merge") {
      delete this.drafts[key];
      this.enqueue(p, {
        target,
        op: "set",
        value: clone(d.value as Json),
        editedHlc: d.editedHlc,
        ...marks,
      });
      return;
    }
    // A merge key: diff the new object against the view without this draft, member by member.
    delete this.drafts[key];
    const current = this.layer(key)?.value;
    const cur = isObject(current) ? current : {};
    const next = isObject(d.value) ? d.value : {};
    for (const member of Object.keys(next).sort(byteOrder))
      if (!(member in cur) || !jsonEqual(cur[member], next[member]))
        this.enqueue(p, {
          target,
          op: "setMember",
          member,
          value: clone(next[member]),
          editedHlc: d.editedHlc,
          ...marks,
        });
    for (const member of Object.keys(cur).sort(byteOrder))
      if (!(member in next))
        this.enqueue(p, {
          target,
          op: "removeMember",
          member,
          editedHlc: d.editedHlc,
          ...marks,
        });
  }

  private enqueue(p: Partition, op: Omit<JournalOp, "mutationId">): JournalOp {
    const full = { mutationId: p.nextMutationId, ...op } as JournalOp;
    p.nextMutationId += 1;
    p.pending.push(full);
    return full;
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
    const batch = p.pending.slice(0, SYNC_MAX_MUTATIONS);
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
    const results = Array.isArray(body.results) ? body.results : [];
    for (const r of results) {
      if (!isObject(r) || typeof r.mutationId !== "number") continue;
      const at = p.pending.findIndex(
        (o) =>
          o.mutationId === r.mutationId &&
          req.mutationIds.includes(o.mutationId),
      );
      if (at < 0) continue;
      const [op] = p.pending.splice(at, 1);
      this.result(p, op!, r, overrides);
    }
    // The pull members: a cursor-0 request answers with a snapshot, which replaces ours.
    if (req.cursor === 0 && typeof body.cursor === "number") {
      p.settings = {};
      p.records = {};
    }
    for (const c of Array.isArray(body.changes) ? body.changes : []) {
      if (!isObject(c) || typeof c.version !== "number") continue;
      if (typeof c.setting === "string")
        p.settings[c.setting] = {
          value: clone(c.value ?? null),
          version: c.version,
        };
      else if (Array.isArray(c.record) && c.record.length === 2)
        p.records[recordKey(String(c.record[0]), String(c.record[1]))] = {
          value: clone(c.value ?? null),
          version: c.version,
        };
    }
    for (const t of Array.isArray(body.tombstones) ? body.tombstones : []) {
      if (!isObject(t)) continue;
      if (typeof t.setting === "string") delete p.settings[t.setting];
      else if (Array.isArray(t.record) && t.record.length === 2)
        delete p.records[recordKey(String(t.record[0]), String(t.record[1]))];
    }
    if (typeof body.cursor === "number") p.cursor = body.cursor;
    if (isObject(body.aliases)) {
      const aliases: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.aliases))
        if (typeof v === "string") aliases[k] = v;
      this.s.aliases = aliases;
    }
    this.needSnapshot = false;
    this.pullWanted = body.more === true;
    this.emitChanges(before, overrides, "remote");
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
      const decl = this.decl(key);
      if (op.moved) overrides.set(key, "merge");
      if (status === "ok") {
        if (r.dropped === true) {
          overrides.set(key, "migration");
          for (const d of this.catalog.settings)
            if (this.alias(d.key) === this.alias(key))
              overrides.set(d.key, "migration");
        } else if (decl && typeof r.version === "number") {
          const value = applySettingOp(
            decl.policy,
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
        if (rk in p.held) rebaseOn = server.version;
        else if (decl?.resolve === "keepLocal" && op.op === "set") {
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

/** Relaunch: persist, then restore with the same host options (`lost` drops the journal; the
 *  device binding, `subject`, is device state and survives). */
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
    });
  return new CloudSyncMachine(
    { ...opts, now: machine.now, network: machine.networkState },
    saved,
  );
}
