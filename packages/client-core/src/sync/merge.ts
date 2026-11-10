// MergeRequest: the one conflict a person or an app is asked to settle (plans/U-08.md §2.2, §2.3,
// §2.4; WIRE-CONTRACT-V5 §11.5). `revision` is the only policy that asks. Two sources feed one
// registry: the cloud-sync machine's record requests (`w:<collection>/<record>`, journalled by the
// machine) and the saves layer's requests (`w:saves/<id>`, memory only: S5).
//
// A request is a live object: its members read the current state, so a host that holds one sees it
// reopen after a failed keep. `keep` never throws; a refusal is `{ok: false, code, reopened}`.

import {
  SYNC_MERGE_CLOSED,
  type CallResult,
  type Json,
  type MachineConflict,
  type MachineConflictSide,
  type RecordRow,
  type SyncEvent,
  type SyncStatus,
} from "../cloud-sync.js";

export type MergeCause = "write" | "accountMerge";
export type MergeChoice = "local" | "remote" | "both" | "value";
export type MergeKeepArg = "local" | "remote" | "both" | { value: Json };
export type MergeHow = MergeChoice | "superseded";

export interface MergeSide {
  /** A record's value; a save's metadata (SAVES-META keys included). */
  value: Json;
  /** Remote: the server's version. Local: the base this copy was written on. */
  version: number | null;
  /** Saves: `metadata.savedAt`; records: null. */
  savedAt: number | null;
  /** Saves: `metadata.deviceLabel`; records: null. */
  device: string | null;
  file: { size: number; format: "whole" | "chunks" } | null;
}

export type MergeOutcome =
  | { ok: true; kept: MergeChoice; version: number | null; copyId?: string }
  | { ok: false; code: string; reopened: boolean };

export interface MergeRequest {
  /** `w:<collection>/<record>` (or `m:<parkId>`); stable while the request is open. */
  readonly id: string;
  readonly cause: MergeCause;
  readonly collection: string;
  /** The plain record id (never sent). */
  readonly record: string;
  /** Null: this account's copy was deleted since (accountMerge only). */
  readonly local: MergeSide | null;
  /** Null: deleted elsewhere. */
  readonly remote: MergeSide | null;
  readonly choices: readonly MergeChoice[];
  /** By `savedAt`; display only. */
  readonly newer: "local" | "remote" | null;
  readonly state: "open" | "applying";
  /** The last keep's failure code. */
  readonly error: string | null;
  keep(choice: MergeKeepArg): Promise<MergeOutcome>;
}

export type MergeEvent =
  | { type: "conflictOpened"; request: MergeRequest }
  | { type: "conflictClosed"; id: string; how: MergeHow };

/** A MergeRequest event on the `cloudSync` stream: ids and names only (S7); the request itself is
 *  in `conflicts()`. */
export type MergeStreamEvent =
  | {
      type: "conflictOpened";
      id: string;
      cause: MergeCause;
      collection: string;
      record: string;
    }
  | { type: "conflictClosed"; id: string; how: MergeHow };

/** A transfer event of the saves on the `cloudSync` stream (`TransferEvent` in
 *  `conformance/parity/enums.json`). */
export type SaveTransferEvent =
  | { type: "transferProgress"; id: string; done: number; total: number }
  | {
      type: "transferDone";
      id: string;
      /** `done`; `cancelled` (a state, not a failure); `conflict` (a MergeRequest holds it: `conflicts()`). */
      state: "done" | "cancelled" | "conflict";
    }
  | { type: "transferFailed"; id: string; code: string };

/** The stream's event for a registry event. */
export function mergeStreamEvent(e: MergeEvent): MergeStreamEvent {
  if (e.type === "conflictClosed") return e;
  const { id, cause, collection, record } = e.request;
  return { type: e.type, id, cause, collection, record };
}

/** A host's status: `local` before it has started, else the machine's with the count of open
 *  requests of both sources (present only above 0). */
export function mergedStatus(host: {
  started: boolean;
  machine: { status(): SyncStatus };
  merge: { count(): number };
}): SyncStatus {
  if (!host.started) return { state: "local", pending: 0 };
  const { conflicts: _machine, ...status } = host.machine.status();
  const open = host.merge.count();
  return open > 0 ? { ...status, conflicts: open } : status;
}

/** A listener may return a choice (or `void`/a promise): a returned choice decides inline. */
export type ConflictListener = (
  request: MergeRequest,
) => MergeKeepArg | void | undefined | Promise<unknown>;

/** The machine as the registry uses it. */
export interface MergeMachine {
  conflicts(): MachineConflict[];
  keep(id: string, choice: MergeKeepArg): CallResult;
  records(collection: string): RecordRow[];
}

/** What a source gives the registry for one request. */
export interface MergeView {
  id: string;
  cause: MergeCause;
  collection: string;
  record: string;
  local: MergeSide | null;
  remote: MergeSide | null;
  choices: readonly MergeChoice[];
  state: "open" | "applying";
  error: string | null;
}

/** The saves layer's side of a request: settles `keep` (the request is `applying` meanwhile). */
export interface MergeBackend {
  keep(choice: MergeKeepArg): Promise<MergeOutcome>;
}

export const mergeChoiceName = (c: MergeKeepArg): MergeChoice =>
  typeof c === "string" ? c : "value";

const closedOutcome = (): MergeOutcome => ({
  ok: false,
  code: SYNC_MERGE_CLOSED,
  reopened: false,
});
const badRequest = (): MergeOutcome => ({
  ok: false,
  code: "bad_request",
  reopened: false,
});

const toSide = (s: MachineConflictSide): MergeSide => ({
  value: s.value,
  version: s.version,
  savedAt: s.savedAt,
  device: s.device,
  file: s.file ? { ...s.file } : null,
});

/** Which copy is newer by `savedAt`; null unless both carry one and they differ. */
function newerOf(
  local: MergeSide | null,
  remote: MergeSide | null,
): "local" | "remote" | null {
  if (local?.savedAt == null || remote?.savedAt == null) return null;
  if (local.savedAt === remote.savedAt) return null;
  return local.savedAt > remote.savedAt ? "local" : "remote";
}

class Request implements MergeRequest {
  view: MergeView;
  /** Set for a closed request; `keep` on it answers `sync-merge-closed`. */
  closed = false;
  constructor(
    view: MergeView,
    private readonly registry: MergeRegistry,
    readonly backend: MergeBackend | null,
  ) {
    this.view = view;
  }
  get id() {
    return this.view.id;
  }
  get cause() {
    return this.view.cause;
  }
  get collection() {
    return this.view.collection;
  }
  get record() {
    return this.view.record;
  }
  get local() {
    return this.view.local;
  }
  get remote() {
    return this.view.remote;
  }
  get choices() {
    return this.view.choices;
  }
  get newer() {
    return newerOf(this.view.local, this.view.remote);
  }
  get state() {
    return this.view.state;
  }
  get error() {
    return this.view.error;
  }
  keep(choice: MergeKeepArg): Promise<MergeOutcome> {
    return this.registry.keepRequest(this, choice);
  }
}

export interface MergeDeps {
  machine?: MergeMachine;
  /** Called once per registry when a request opens and nobody listens (the dev-mode notice). */
  notice?: (request: MergeRequest) => void;
}

interface Pending {
  resolve: (o: MergeOutcome) => void;
}

/** What a host gives the registry it keeps: the machine it holds now and the steps around a keep. */
export interface MergeHost {
  /** The machine the host holds now (a rebuild swaps it), or null before `start()`. */
  held(): MergeMachine | null;
  /** The host's catch-up before a keep. */
  catchUp(): void;
  /** The host's save-and-send after a keep. */
  touch(): unknown;
  /** An answer that stops a keep (a tab that does not write), or null to go on. */
  refuse?(): CallResult | null;
}

/** The registry of one host: it reads whichever machine the host holds, so a rebuild keeps it. */
export function hostMergeRegistry(
  host: MergeHost,
  notice: (request: MergeRequest) => void,
): MergeRegistry {
  return new MergeRegistry({
    machine: {
      conflicts: () => host.held()?.conflicts() ?? [],
      keep: (id, choice) => {
        const refused = host.refuse?.();
        if (refused) return refused;
        host.catchUp();
        const m = host.held();
        if (m === null) throw new Error("Cloud Sync host: start() has not run");
        const r = m.keep(id, choice);
        void host.touch();
        return r;
      },
      records: (c) => host.held()?.records(c) ?? [],
    },
    notice,
  });
}

/** The open requests of one client, from the machine and from the saves layer. */
export class MergeRegistry {
  private readonly machineReqs = new Map<string, Request>();
  private readonly extra = new Map<string, Request>();
  private readonly listeners = new Set<ConflictListener>();
  private readonly watchers = new Set<(e: MergeEvent) => void>();
  private readonly pending = new Map<string, Pending>();
  private noticed = false;

  constructor(private readonly deps: MergeDeps = {}) {}

  /** The open requests in id order. */
  conflicts(): MergeRequest[] {
    this.refresh();
    return this.all();
  }

  /** Listen for requests as they open; the ones already open are replayed. Returns the remover. */
  onConflict(fn: ConflictListener): () => void {
    this.listeners.add(fn);
    this.refresh();
    for (const r of this.all()) if (r.state === "open") this.offer(fn, r);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** `conflictOpened` / `conflictClosed` on the cloudSync stream. Returns the remover. */
  onEvent(fn: (e: MergeEvent) => void): () => void {
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  }

  /** The count of open requests (the status's `conflicts`). */
  count(): number {
    return this.conflicts().length;
  }

  /** `feed` for a host's emit: a listener's failure never reaches the machine. */
  tryFeed(events: readonly SyncEvent[]): void {
    try {
      this.feed(events);
    } catch {
      // A listener's failure never reaches the machine.
    }
  }

  /** The machine's events, after `takeEvents`: opens, closes and settled keeps. */
  feed(events: readonly SyncEvent[]): void {
    for (const e of events) {
      if (e.type === "conflict") this.machineOpened(e.id);
      else if (e.type === "conflictClosed") this.machineClosed(e.id, e.how);
    }
    this.settleFromState();
  }

  // ── the saves layer ──────────────────────────────────────────────────────────────────────

  /** An open saves request by id, or null. */
  find(id: string): MergeRequest | null {
    return this.extra.get(id) ?? null;
  }

  /** Open a request, or reopen the one with that id (its sides and choices replaced). A listener
   *  may decide it inline. */
  open(view: MergeView, backend: MergeBackend): MergeRequest {
    const have = this.extra.get(view.id);
    const r = have ?? new Request(view, this, backend);
    r.view = view;
    this.extra.set(view.id, r);
    this.announce(r);
    return r;
  }

  /** Replace what an open request shows (a later write replaced the local copy; the state moved). */
  update(id: string, view: Partial<MergeView>): void {
    const r = this.extra.get(id);
    if (r) r.view = { ...r.view, ...view };
  }

  /** Tell the listeners again that a saves request is open (a keep conflicted again). */
  reannounce(id: string): void {
    const r = this.extra.get(id);
    if (r) this.announce(r);
  }

  /** Close a saves request. No-op when it is not open. */
  close(id: string, how: MergeHow): void {
    const r = this.extra.get(id);
    if (!r) return;
    this.extra.delete(id);
    r.closed = true;
    this.emit({ type: "conflictClosed", id, how });
  }

  // ── keep ─────────────────────────────────────────────────────────────────────────────────

  /** @internal */
  keepRequest(r: Request, choice: MergeKeepArg): Promise<MergeOutcome> {
    this.refresh();
    if (r.closed) return Promise.resolve(closedOutcome());
    if (r.view.state === "applying") return Promise.resolve(badRequest());
    const name = mergeChoiceName(choice);
    if (!r.view.choices.includes(name)) return Promise.resolve(badRequest());
    if (r.backend) return r.backend.keep(choice);
    return this.keepMachine(r, choice, name);
  }

  private keepMachine(
    r: Request,
    choice: MergeKeepArg,
    name: MergeChoice,
  ): Promise<MergeOutcome> {
    const m = this.deps.machine;
    if (!m) return Promise.resolve(closedOutcome());
    const remoteVersion = r.view.remote?.version ?? null;
    const res = m.keep(r.id, choice);
    if (!res.ok)
      return Promise.resolve({
        ok: false,
        code: res.error,
        reopened: false,
      });
    // `remote` is settled by the machine at once; the closing event arrives with the next batch.
    if (name === "remote") {
      r.closed = true;
      this.machineReqs.delete(r.id);
      return Promise.resolve({
        ok: true,
        kept: "remote",
        version: remoteVersion,
      });
    }
    this.refresh();
    return new Promise<MergeOutcome>((resolve) => {
      this.pending.set(r.id, { resolve });
    });
  }

  // ── machine requests ─────────────────────────────────────────────────────────────────────

  private machineView(c: MachineConflict): MergeView {
    return {
      id: c.id,
      cause: c.cause,
      collection: c.collection,
      record: c.record,
      local: toSide(c.local),
      remote: c.remote ? toSide(c.remote) : null,
      choices: c.choices,
      state: c.state,
      error: c.error,
    };
  }

  /** Bring the machine's requests in line with its state (a request that vanished is closed). */
  private refresh(): void {
    const m = this.deps.machine;
    if (!m) return;
    const live = new Map(m.conflicts().map((c) => [c.id, c]));
    for (const [id, r] of this.machineReqs) {
      const c = live.get(id);
      if (c) r.view = this.machineView(c);
      else {
        r.closed = true;
        this.machineReqs.delete(id);
      }
    }
    for (const [id, c] of live)
      if (!this.machineReqs.has(id))
        this.machineReqs.set(id, new Request(this.machineView(c), this, null));
  }

  private all(): Request[] {
    return [...this.machineReqs.values(), ...this.extra.values()].sort(
      (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  private machineOpened(id: string): void {
    const m = this.deps.machine;
    if (!m) return;
    const c = m.conflicts().find((x) => x.id === id);
    if (!c) return;
    let r = this.machineReqs.get(id);
    if (r) r.view = this.machineView(c);
    else {
      r = new Request(this.machineView(c), this, null);
      this.machineReqs.set(id, r);
    }
    // A keep of this request conflicted again: it reopens for the person.
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      p.resolve({ ok: false, code: "conflict", reopened: true });
    }
    this.announce(r);
  }

  private machineClosed(id: string, how: MergeHow): void {
    const r = this.machineReqs.get(id);
    if (r) {
      r.closed = true;
      this.machineReqs.delete(id);
    }
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      if (how === "superseded") p.resolve(closedOutcome());
      else
        p.resolve({
          ok: true,
          kept: how,
          version: this.versionOf(r?.view.collection, r?.view.record),
        });
    }
    this.emit({ type: "conflictClosed", id, how });
  }

  private versionOf(
    collection: string | undefined,
    record: string | undefined,
  ): number | null {
    const m = this.deps.machine;
    if (!m || collection === undefined || record === undefined) return null;
    return m.records(collection).find((x) => x.id === record)?.version ?? null;
  }

  /** A keep whose set was refused for good reopens the request with the failure code. */
  private settleFromState(): void {
    if (this.pending.size === 0) return;
    this.refresh();
    for (const [id, p] of [...this.pending]) {
      const r = this.machineReqs.get(id);
      if (!r) {
        this.pending.delete(id);
        p.resolve(closedOutcome());
      } else if (r.view.state === "open") {
        this.pending.delete(id);
        p.resolve({
          ok: false,
          code: r.view.error ?? "conflict",
          reopened: true,
        });
      }
    }
  }

  // ── announcing ───────────────────────────────────────────────────────────────────────────

  private announce(r: Request): void {
    this.emit({ type: "conflictOpened", request: r });
    if (this.listeners.size === 0) {
      if (!this.noticed) {
        this.noticed = true;
        try {
          this.deps.notice?.(r);
        } catch {
          // The notice is advice.
        }
      }
      return;
    }
    for (const fn of [...this.listeners]) {
      if (r.view.state !== "open" || r.closed) break;
      this.offer(fn, r);
    }
  }

  /** Hand a request to a listener; a returned choice decides it at once. */
  private offer(fn: ConflictListener, r: Request): void {
    let answer: ReturnType<ConflictListener>;
    try {
      answer = fn(r);
    } catch {
      return; // A listener's failure is its own.
    }
    if (answer === undefined || answer === null) return;
    const isChoice =
      typeof answer === "string" ||
      (typeof answer === "object" &&
        !(answer instanceof Promise) &&
        "value" in (answer as object));
    if (!isChoice) return;
    void this.keepRequest(r, answer as MergeKeepArg).catch(() => undefined);
  }

  private emit(e: MergeEvent): void {
    for (const fn of [...this.watchers]) {
      try {
        fn(e);
      } catch {
        // A listener's failure never reaches the machine.
      }
    }
  }
}
