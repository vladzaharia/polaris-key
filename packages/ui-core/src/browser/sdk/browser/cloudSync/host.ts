// The browser Cloud Sync host (U-20.2): the React counterpart of sdk-node's `cloudSync/host.ts`
// (U-06.2), the second production host of client-core's `CloudSyncMachine`. The machine does no
// I/O; this module is everything around it:
//
//   - one machine per tab, built from app code (`cloudSync.encryption`, default "e2e"), the
//     discovery `services.sync` member, the key ring (`bindRingToMachine`) and the product catalog;
//   - the catalog is the app's compiled mirror, authoritative for every key it names; a catalog
//     the Worker served is vetted and only adds keys that are neither in the mirror nor open;
//   - every request the machine queues goes through the bearer transport, and in E2E mode through
//     client-core's host codec (`sealPush` / `openPull`) on the way out and in;
//   - the journal is one IndexedDB record (`store.ts`), written only by the writer tab, under a
//     Web Lock, never over a higher `rev` (`writer.ts`); other tabs follow it and fan `change` out;
//   - a real-clock timer drives `advance`; `pagehide` saves and flushes, bounded.
//
// Rules this host keeps (plans/U-sync-clients-slices.md section 9, and every SEC-SYNC-HOST fix):
//   S1  `OpenedBody` is the codec's own result; the served body's `sealed` / `invalid` / `seq` are
//       stripped by `openPull`, never read here.
//   S2  The mode is app code's. The Worker's discovery and bodies only let the machine detect a
//       downgrade; the served catalog's `cloudSync.encryption` is dropped from the routes.
//   S3  A locked ring sends nothing and reads nothing: no request is made while the codec is
//       locked, and this host never adds a GET of its own.
//   S6  Sign-out, deactivation and `account_required` delete the record and forget the ring.
//   S7  The root is not here; the codec reads it from the ring's vault on each call.
//   S10 An answer that cannot be opened is dropped without advancing the cursor.
//   SEC-SYNC-HOST 4  the mirror is authoritative; a served catalog is vetted (key pattern, 1024
//       entries, 1 MiB), never persisted over the mirror, and never reclassifies an open key.
//   SEC-SYNC-HOST 5  responses are read under a streaming 8 MiB byte cap (`transport.ts`).
//   SEC-SYNC-HOST 6  open keys come only from rows this host opened and from own mutations.
//   SEC-SYNC-HOST 7  the record is purged with the ring; a purge that fails is thrown.
//   SEC-SYNC-HOST 8  the catalog is fetched again at most every 5 minutes, counted in the budget.
//
// Nothing in the licence path imports this module: `core/cloudSync.ts` loads it on first use.

import {
  CloudSyncMachine,
  SYNC_SIGNOUT_FLUSH_MS,
  type CallResult,
  type CloudSyncCatalog,
  type CloudSyncDocument,
  type EncryptionMode,
  type Json,
  type OpenedBody,
  type SettingRoute,
  type SyncEvent,
  type SyncRequest,
  type SyncResponse,
  type WireMutation,
} from "@polaris-key/client-core/cloud-sync";
import {
  openPull,
  sealPush,
  type HostCodec,
} from "@polaris-key/client-core/sync";
import { syncedSettings, type ProductCatalog } from "@polaris-key/catalog";
import { SYNC_KEY_PATTERN } from "../../constants.generated.js";
import { bindRingToMachine, type KeyringClient } from "../../core/keyring.js";
import {
  OPEN_KEYS_MAX,
  emptySyncState,
  isCatalogShape,
  parseSyncState,
  removeSyncState,
  SYNC_STATE_SCHEMA,
  type SyncStateRecord,
  type SyncStateStore,
} from "./store.js";
import { sendSync, type ProductRequest } from "./transport.js";
import {
  joinWriterElection,
  type TabChannel,
  type TabMessage,
  type WriterRole,
} from "./writer.js";

/** What app code sets (`BrowserAdapterOptions.cloudSync`). Never read from the Worker. */
export interface CloudSyncHostOptions {
  /** The product's mode. Default `"e2e"`. An app that says `"server"` still refuses to talk to a
   *  Worker it has seen speak E2E (the machine's pin). */
  encryption?: EncryptionMode;
  /** The catalog compiled into the app (`pkey mirror`): authoritative for every key it names. */
  catalog?: ProductCatalog;
  /** Renames the app declares (old name to current name). Never taken from a served body. */
  aliases?: Readonly<Record<string, string>>;
}

/** The Web Locks the host runs under. */
export interface HostLocks {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    fn: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
  request(
    name: string,
    fn: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

/** What the host needs of the page; each is a function so the host holds no stale copy. */
export interface BrowserSyncHostDeps {
  product: string;
  request: ProductRequest;
  ring: Pick<KeyringClient, "hasRoot" | "subscribe" | "codec" | "forget">;
  /** The loaded discovery document's `services.sync`, or null before discovery. */
  discovery: () => { enabled?: unknown; encryption?: unknown } | null;
  /** `GET /config/schema` (diagnostic and unsigned; null on any failure). */
  fetchSchema: () => Promise<ProductCatalog | null>;
  /** The signed config document's values and the keys it locks. */
  document: () => CloudSyncDocument;
  /** The person the session's token is for now, or null when not known. A request queued for
   *  another person is dropped, not sent under this token. */
  subject?: () => string | null;
  /** Whether the product runs the Sync service. */
  enabled: () => boolean;
  store: SyncStateStore;
  locks: HostLocks;
  /** The lock names: the writer's, and the one every read-modify-write of the record runs under. */
  writerLock: string;
  stateLock: string;
  channel: TabChannel;
  /** Diagnostics; never given a value or a secret. */
  log?: (message: string) => void;
  /** Test seams: the clock, and the page events (`pagehide`, `pageshow`). */
  clock?: { now: () => number };
  page?: {
    on(type: "pagehide" | "pageshow", fn: () => void): () => void;
  };
}

/** How often the real-clock timer wakes the machine while it holds work (ms). */
export const TICK_MS = 250;
/** The most exchanges one pump makes, whatever the machine keeps asking for. */
const MAX_EXCHANGES = 64;

/** How long a purge waits for a running pump or save before it goes on. */
export const PURGE_WAIT_MS = 2000;

/** `p`, or nothing after `ms` (the promise itself keeps running). */
async function within(
  p: Promise<unknown> | undefined,
  ms: number,
): Promise<void> {
  if (p === undefined) return;
  let cut: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p,
      new Promise<void>((resolve) => {
        cut = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(cut);
  }
}

const EMPTY_CATALOG: ProductCatalog = { schemaVersion: 0, entries: [] };
const SYNC_KEY = new RegExp(SYNC_KEY_PATTERN);
/** The most entries and bytes of a catalog the host will route by. */
export const MAX_CATALOG_ENTRIES = 1024;
export const MAX_CATALOG_BYTES = 1024 * 1024;
/** A served catalog is fetched again at most this often (the first fetch is free). */
export const CATALOG_REFETCH_MS = 5 * 60_000;
/** The reasons the machine leaves a principal, each of which drops the ring and the record. */
const FORGETTING = new Set(["signOut", "accountRequired", "subjectChanged"]);

/** A catalog fit to route by: the right shape and size, every entry key a valid sync key, and
 *  one entry per key. Null when it is not. */
export function vetted(c: unknown): ProductCatalog | null {
  if (!isCatalogShape(c) || c.entries.length > MAX_CATALOG_ENTRIES) return null;
  let size: number;
  try {
    size = JSON.stringify(c).length;
  } catch {
    return null;
  }
  if (size > MAX_CATALOG_BYTES) return null;
  const seen = new Set<string>();
  const entries = c.entries.filter((e) => {
    const k = (e as { key?: unknown } | null)?.key;
    if (typeof k !== "string" || !SYNC_KEY.test(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const out = { ...c, entries };
  try {
    routesOf(out);
  } catch {
    return null;
  }
  return out;
}

const isObj = (v: unknown): v is { [k: string]: Json } =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The routes of a catalog, without any mode the catalog states (the app decides the mode). */
function routesOf(catalog: ProductCatalog): SettingRoute[] {
  return syncedSettings(catalog).map((r) => {
    const { encryption: _served, ...rest } = r as SettingRoute & {
      encryption?: unknown;
    };
    return rest as SettingRoute;
  });
}

/** An id for a follower's edit, so the writer can confirm it. Not a secret. */
const editId = (): number => Math.floor(Math.random() * 2 ** 52);

function clientId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return `c_${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export class BrowserCloudSyncHost {
  readonly #deps: BrowserSyncHostDeps;
  readonly #opts: CloudSyncHostOptions;
  readonly #listeners = new Set<(events: SyncEvent[]) => void>();
  #role: WriterRole | null = null;
  #machine: CloudSyncMachine | null = null;
  #detach: (() => void) | null = null;
  /** The record's `rev` this tab last read or wrote. */
  #rev = 0;
  #mirror: ProductCatalog | null = null;
  #served: ProductCatalog | null = null;
  #catalog: ProductCatalog = EMPTY_CATALOG;
  #lastFetchAt: number | null = null;
  #used = 0;
  #routes: SettingRoute[] = [];
  #openKeys = new Set<string>();
  #documentJson = "";
  #triedCatalogVersion: number | null = null;
  #rebuildWanted = false;
  #pumping: Promise<void> | null = null;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #starting: Promise<void> | null = null;
  #closed = false;
  /** After a purge the record stays unsaved until a principal signs in again. */
  #purged = false;
  #unloading = false;
  #write: Promise<void> = Promise.resolve();
  /** Set once this tab (holding the writer lock) has read the record into its machine. */
  #writable = false;
  /** A follower's edits the writer has not confirmed (kept, and replayed if this tab is promoted). */
  #outbox = new Map<number, TabMessage & { t: "edit" }>();
  /** Edits that reached a tab which holds the lock but has not read the record yet. */
  #queued: Array<TabMessage & { t: "edit" }> = [];
  #forgetting: Promise<void> = Promise.resolve();
  #offPage: Array<() => void> = [];
  readonly #principal = new Set<() => void>();
  #bound: string | null = null;
  readonly #statusListeners = new Set<() => void>();

  constructor(deps: BrowserSyncHostDeps, opts: CloudSyncHostOptions = {}) {
    this.#deps = deps;
    this.#opts = opts;
  }

  get #now(): number {
    return this.#deps.clock?.now() ?? Date.now();
  }

  /** The machine; throws before `start()`. */
  get machine(): CloudSyncMachine {
    if (this.#machine === null)
      throw new Error("Cloud Sync host: start() has not run");
    return this.#machine;
  }

  get started(): boolean {
    return this.#started && !this.#closed;
  }

  /** Whether this tab is the one that sends and writes: it holds the lock AND has read the record
   *  (a tab just promoted is not the writer until it has, so nothing runs on a stale machine). */
  get isWriter(): boolean {
    return this.#writable && this.#holdsLock;
  }

  get #holdsLock(): boolean {
    return this.#role?.isWriter ?? false;
  }

  /** Subscribe to the machine's events (batches, in order). Returns an unsubscribe function. */
  onEvents(fn: (events: SyncEvent[]) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** The machine's status may have moved (a pump ended, a record was followed or dropped). */
  onStatus(fn: () => void): () => void {
    this.#statusListeners.add(fn);
    return () => this.#statusListeners.delete(fn);
  }

  #noteStatus(): void {
    for (const fn of this.#statusListeners) {
      try {
        fn();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** Settles when the forget a `signedOut` event started (the ring, then the record) is done. */
  forgotten(): Promise<void> {
    return this.#forgetting;
  }

  /** Another tab signed a person in or out. */
  onPrincipal(fn: () => void): () => void {
    this.#principal.add(fn);
    return () => this.#principal.delete(fn);
  }

  /** The person the machine's queued requests belong to (null for none). */
  bindSubject(subject: string | null): void {
    this.#bound = subject;
  }

  /** Tell the other tabs the person changed here. */
  notePrincipal(): void {
    this.#deps.channel.post({ t: "principal" });
  }

  /** The keys the machine can hold a value for: the declared settings and the open ones. */
  knownKeys(): string[] {
    return [...new Set([...this.#routes.map((r) => r.key), ...this.#openKeys])];
  }

  /**
   * Take part in the writer election, load the record and catalog, build the machine and bind it
   * to the key ring. Idempotent. Makes no request unless a catalog has to be fetched (none held
   * and none compiled in) and this tab is the writer.
   */
  start(): Promise<void> {
    return (this.#starting ??= this.#start());
  }

  async #start(): Promise<void> {
    if (this.#closed) return;
    this.#started = true;
    this.#role = joinWriterElection(
      this.#deps.locks,
      this.#deps.writerLock,
      () => void this.#promote(),
    );
    this.#deps.channel.onMessage((m) => void this.#onTab(m));
    await this.#role.decided;
    const rec = await this.#readRecord();
    this.#adopt(rec);
    this.#writable = this.#holdsLock;
    const page = this.#deps.page;
    if (page) {
      this.#offPage.push(
        page.on("pagehide", () => this.#onHide()),
        page.on("pageshow", () => {
          this.#unloading = false;
        }),
      );
    }
    if (this.isWriter) {
      if (rec.catalog === null && this.#opts.catalog === undefined)
        await this.#refetchCatalog(null);
      this.touch();
    }
  }

  /** The record, read inside the state lock (so a purge in another tab has finished). */
  async #readRecord(): Promise<SyncStateRecord> {
    let rec: SyncStateRecord = emptySyncState(this.#deps.product);
    await this.#withStateLock(async () => {
      const raw = await this.#deps.store.get().catch(() => null);
      rec =
        (raw === null ? null : parseSyncState(raw, this.#deps.product)) ?? rec;
    });
    return rec;
  }

  #withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#deps.locks
        .request(this.#deps.stateLock, async () => {
          try {
            resolve(await fn());
          } catch (e) {
            reject(e);
          }
        })
        .catch(reject);
    });
  }

  /** Build the machine from a record this tab just read. */
  #adopt(rec: SyncStateRecord): void {
    this.#rev = rec.rev;
    this.#openKeys = new Set(rec.openKeys);
    this.#mirror = vetted(this.#opts.catalog);
    this.#served = vetted(rec.catalog);
    this.#build(rec.persisted);
  }

  /** The writer went: this tab was next in the queue. It re-reads the record before it writes. */
  async #promote(): Promise<void> {
    if (this.#closed) return;
    this.#purged = false;
    await this.#pumping?.catch(() => undefined);
    const rec = await this.#readRecord();
    this.#adopt(rec);
    // Now the writer. Edits that arrived meanwhile, and this tab's own unconfirmed ones, run first.
    this.#writable = true;
    const edits = [...this.#queued, ...this.#outbox.values()];
    this.#queued = [];
    this.#outbox.clear();
    for (const e of edits) this.#applyEdit(e);
    this.touch();
  }

  #applyEdit(m: TabMessage & { t: "edit" }): void {
    this.catchUp();
    if (m.op === "set") this.machine.set(m.key, m.value);
    else this.machine.clear(m.key);
  }

  /**
   * The routes' catalog: the mirror as it is, plus served entries only for keys the mirror does
   * not name and the person's own open settings do not use. The Worker's catalog never changes a
   * route the app compiled in, and never turns an open setting into a declared one.
   */
  #effective(): ProductCatalog {
    const mirror = this.#mirror;
    const served = this.#served;
    const taken = new Set(mirror?.entries.map((e) => e.key));
    const extra = (served?.entries ?? []).filter(
      (e) => !taken.has(e.key) && !this.#openKeys.has(e.key),
    );
    return {
      ...(mirror ?? served ?? EMPTY_CATALOG),
      schemaVersion: served?.schemaVersion ?? mirror?.schemaVersion ?? 0,
      entries: [...(mirror?.entries ?? []), ...extra],
    };
  }

  /** (Re)build the machine from the journal, the catalog and the document. */
  #build(persisted: SyncStateRecord["persisted"]): void {
    this.#detach?.();
    this.#catalog = this.#effective();
    this.#routes = routesOf(this.#catalog);
    const catalog: CloudSyncCatalog = { settings: this.#routes };
    const document = this.#deps.document();
    this.#documentJson = JSON.stringify(document);
    const m = new CloudSyncMachine(
      {
        product: this.#deps.product,
        catalog,
        document,
        now: this.#now,
        encryption: this.#opts.encryption ?? "e2e",
        hasRoot: this.#deps.ring.hasRoot(),
        newClientId: clientId,
      },
      persisted ?? undefined,
    );
    this.#machine = m;
    this.#applyDiscovery(m);
    this.#detach = bindRingToMachine(this.#deps.ring, m);
  }

  #applyDiscovery(m: CloudSyncMachine): void {
    const sync = this.#deps.discovery();
    if (sync === null || sync.enabled !== true) return;
    const e = sync.encryption;
    m.setDiscovery(e === "e2e" || e === "server" ? { encryption: e } : {});
  }

  /** Discovery just loaded: tell the machine what `services.sync` says. */
  noteDiscovery(): void {
    if (this.#machine === null) return;
    this.#applyDiscovery(this.#machine);
    this.touch();
  }

  /** The signed config document refreshed: lift a block, and rebuild if the document changed. */
  noteDocumentRefreshed(): void {
    if (this.#machine === null) return;
    this.#machine.refresh();
    if (JSON.stringify(this.#deps.document()) !== this.#documentJson)
      this.#rebuildWanted = true;
    this.touch();
  }

  /** Bring the machine's clock to the real one, so an edit made now is stamped and debounced from
   *  now (the machine only moves when told). */
  catchUp(): void {
    if (this.#machine === null) return;
    const dt = this.#now - this.#machine.now;
    if (dt > 0) this.#machine.advance(dt);
  }

  // ── Edits ────────────────────────────────────────────────────────────────────────────────

  /** `config.set` for a synced key. The writer applies it; a follower hands it to the writer over
   *  the channel and answers `ok` (the writer's refusal, if any, is the machine's own). */
  async set(key: string, value: Json): Promise<CallResult> {
    if (!this.isWriter) {
      this.#handOver({ t: "edit", id: editId(), op: "set", key, value });
      return { ok: true };
    }
    this.catchUp();
    const r = this.machine.set(key, value);
    await this.touch();
    return r;
  }

  async clear(key: string): Promise<CallResult> {
    if (!this.isWriter) {
      this.#handOver({ t: "edit", id: editId(), op: "clear", key });
      return { ok: true };
    }
    this.catchUp();
    const r = this.machine.clear(key);
    await this.touch();
    return r;
  }

  /**
   * An edit made where this tab is not the writer. A tab that holds the lock but has not read the
   * record yet keeps it for itself. A follower posts it and keeps it until the writer confirms it
   * (`ack`), and replays it if it is promoted first. Limit: while the writer is frozen and no tab
   * is promoted the edit waits in this tab's memory only (at most 256 are kept).
   */
  #handOver(m: TabMessage & { t: "edit" }): void {
    if (this.#holdsLock) {
      this.#queued.push(m);
      return;
    }
    if (this.#outbox.size >= 256)
      this.#outbox.delete(this.#outbox.keys().next().value as number);
    this.#outbox.set(m.id, m);
    this.#deps.channel.post(m);
  }

  // ── The pump ─────────────────────────────────────────────────────────────────────────────

  /** Run the machine now: advance its clock, exchange every queued request, save. Never throws.
   *  A follower sends nothing. */
  touch(): Promise<void> {
    if (!this.started || !this.isWriter || !this.#deps.enabled())
      return Promise.resolve();
    if (this.#pumping !== null) {
      this.#again = true;
      return this.#pumping;
    }
    this.#pumping = this.#run();
    return this.#pumping;
  }

  /**
   * Pump, and pump again while a `touch()` arrived during the last one. The check and the release
   * of `#pumping` happen with no await between them, so a wake-up is either seen here or starts a
   * run of its own. Never throws.
   */
  async #run(): Promise<void> {
    try {
      for (let i = 0; i < 4; i++) {
        await this.#pump();
        if (!this.#again) break;
      }
    } catch {
      // A failed pump leaves the journal as it was; the next trigger tries again.
    } finally {
      this.#pumping = null;
      this.#arm();
      this.#noteStatus();
    }
  }

  async #pump(): Promise<void> {
    this.#used = 0;
    do {
      this.#again = false;
      if (this.#rebuildWanted) await this.#rebuild();
      const m = this.machine;
      const dt = this.#now - m.now;
      if (dt > 0) m.advance(dt);
      for (
        let reqs = m.takeRequests();
        reqs.length > 0 && this.#used < MAX_EXCHANGES;
        reqs = m.takeRequests()
      ) {
        for (const req of reqs) {
          this.#used++;
          await this.#exchange(req);
        }
      }
      this.#emit();
    } while (this.#again && this.#used < MAX_EXCHANGES);
    // Saving commits the debounced edits (`persist()`), so a pump that exchanged nothing leaves
    // the record alone and an edit keeps its debounce window.
    if (this.#used > 0) await this.#save();
  }

  /** One request: seal it (E2E), send it, open the answer, hand both to the machine. */
  async #exchange(req: SyncRequest): Promise<void> {
    const m = this.machine;
    const bound = this.#bound;
    const codec: HostCodec | null = this.#deps.ring.codec();
    const e2e = m.encryptionMode() === "e2e";
    // S3: a locked ring sends nothing, a pull included.
    if (e2e && (codec === null || codec.locked))
      return m.receive({ error: "transport" });

    let wire: SyncRequest = req;
    let mutations: ReadonlyArray<WireMutation> | undefined;
    if (req.method === "POST") {
      mutations = isObj(req.body)
        ? (req.body.mutations as unknown as WireMutation[])
        : undefined;
      this.#noteOpenKeys(mutations);
      if (e2e) {
        try {
          wire = {
            method: "POST",
            path: req.path,
            body: await sealPush(req.body, codec!, this.#routes),
          };
        } catch {
          // Locked, or a mutation that cannot be sealed: nothing is sent.
          return m.receive({ error: "transport" });
        }
      }
    }

    // Queued for one person: if the token is another person's now, nothing is sent.
    const now = this.#deps.subject?.() ?? null;
    if (bound !== null && now !== null && now !== bound)
      return m.receive({ error: "transport" });
    const res = await sendSync(
      this.#deps.product,
      this.#deps.request,
      wire,
      this.#unloading,
    );
    if (!e2e || !("status" in res) || res.status !== 200 || !isObj(res.body)) {
      // Server mode, an error answer, or no answer: the machine reads it as it is.
      if (e2e && "status" in res && res.status === 200)
        return m.receive({ error: "transport" });
      return m.receive(res);
    }
    let opened;
    try {
      opened = await openPull(res.body, codec!, {
        ...(mutations !== undefined ? { mutations } : {}),
        ...(this.#opts.aliases !== undefined
          ? { aliases: this.#opts.aliases }
          : {}),
        openKeys: this.#openKeys,
      });
    } catch {
      // Locked since the request left: the answer is dropped and the cursor stays.
      return m.receive({ error: "transport" });
    }
    this.#noteOpenedKeys(opened.body, opened.opened);
    const answer: SyncResponse = { status: 200, body: opened.body };
    m.receive(answer, opened.opened);
    await this.#maybeRefetch(opened.body);
  }

  /** A pull that names another `catalogVersion` than the catalog held: fetch it again, once. */
  async #maybeRefetch(body: Json): Promise<void> {
    if (!isObj(body) || typeof body.catalogVersion !== "number") return;
    const v = body.catalogVersion;
    if (v === this.#catalog.schemaVersion || v === this.#triedCatalogVersion)
      return;
    await this.#refetchCatalog(v);
  }

  async #refetchCatalog(version: number | null): Promise<void> {
    const now = this.#now;
    // Rate-limited, and counted in the pump's budget like any other request.
    if (
      this.#used >= MAX_EXCHANGES ||
      (this.#lastFetchAt !== null &&
        now - this.#lastFetchAt < CATALOG_REFETCH_MS)
    )
      return;
    this.#lastFetchAt = now;
    this.#triedCatalogVersion = version;
    this.#used++;
    const fetched = vetted(await this.#deps.fetchSchema().catch(() => null));
    if (fetched === null) return;
    if (JSON.stringify(fetched) === JSON.stringify(this.#served)) return;
    const before = JSON.stringify(routesOf(this.#catalog));
    this.#served = fetched;
    // Rebuild only when the routes the machine uses would change.
    if (JSON.stringify(routesOf(this.#effective())) === before) {
      this.#catalog = this.#effective();
      return;
    }
    this.#rebuildWanted = true;
    this.#again = true;
  }

  /** New catalog or document: the machine is rebuilt from its own journal (never mid-request). */
  async #rebuild(): Promise<void> {
    this.#rebuildWanted = false;
    const old = this.machine;
    const persisted = old.persist();
    this.#emitFrom(old);
    this.#build(persisted);
    await this.#save(persisted);
  }

  #noteOpenKeys(mutations: ReadonlyArray<WireMutation> | undefined): void {
    const declared = new Set(this.#routes.map((r) => r.key));
    for (const mu of mutations ?? [])
      if ("setting" in mu.target && !declared.has(mu.target.setting))
        this.#addOpenKey(mu.target.setting);
  }

  /** Names from rows this host opened (`sealed`): a served name, an unopened row or a plaintext
   *  row never enters the set, so a Worker cannot fill it to push real names out. */
  #noteOpenedKeys(body: Json, opened: OpenedBody): void {
    if (!isObj(body) || !Array.isArray(body.changes)) return;
    const declared = new Set(this.#routes.map((r) => r.key));
    body.changes.forEach((c, i) => {
      if (
        opened.changes?.[i]?.sealed === true &&
        isObj(c) &&
        typeof c.setting === "string" &&
        !declared.has(c.setting)
      )
        this.#addOpenKey(c.setting);
    });
  }

  #addOpenKey(name: string): void {
    this.#openKeys.delete(name);
    this.#openKeys.add(name);
    while (this.#openKeys.size > OPEN_KEYS_MAX)
      this.#openKeys.delete(this.#openKeys.values().next().value as string);
  }

  // ── Events ───────────────────────────────────────────────────────────────────────────────

  #emit(): void {
    this.#emitFrom(this.machine);
  }

  #emitFrom(m: CloudSyncMachine): void {
    const events = m.takeEvents();
    if (events.length === 0) return;
    // A tab that left the principal drops the ring and the record, whichever tab asked.
    if (
      events.some((e) => e.type === "signedOut" && FORGETTING.has(e.reason))
    ) {
      this.#forgetting = this.#forgetting.then(() => this.#forgetAll());
    }
    this.#fan(events);
  }

  #fan(events: SyncEvent[]): void {
    for (const e of events)
      if (e.type === "change")
        this.#deps.channel.post({
          t: "change",
          keys: e.keys,
          origin: e.origin,
        });
    for (const fn of this.#listeners) {
      try {
        fn(events);
      } catch {
        // A listener's failure never reaches the machine.
      }
    }
  }

  /** Drop the ring (the root first), then the record. Each is tried whatever the other did; a
   *  failure is logged and never thrown. */
  async #forgetAll(): Promise<void> {
    const ring = this.#deps.ring.forget().catch(() => {
      // The root is already gone (`forget` locks first); only the pin failed to go.
      this.#deps.log?.("cloud sync: the key ring pin could not be removed");
    });
    const data = this.purge().catch(() => {
      this.#deps.log?.("cloud sync: the synced data could not be deleted");
    });
    await Promise.all([ring, data]);
  }

  // ── Other tabs ───────────────────────────────────────────────────────────────────────────

  async #onTab(m: TabMessage): Promise<void> {
    if (!this.started) return;
    switch (m.t) {
      case "edit":
        if (this.#holdsLock && !this.#writable) this.#queued.push(m);
        else if (this.isWriter) {
          this.#applyEdit(m);
          this.#deps.channel.post({ t: "ack", id: m.id });
          await this.touch();
        }
        return;
      case "ack":
        this.#outbox.delete(m.id);
        return;
      case "principal":
        for (const fn of this.#principal) {
          try {
            fn();
          } catch {
            // A listener's failure is its own.
          }
        }
        return;
      case "purge":
        // Synchronously, before anything awaits: a save the writer's running pump is about to
        // make must already find the record purged (SEC-HOST2 B-1).
        this.#purged = true;
        this.#rev = 0;
        this.#openKeys = new Set();
        this.#outbox.clear();
        this.#queued = [];
        if (this.isWriter) await this.#pumping?.catch(() => undefined);
        this.#drop();
        // The person is gone here too: the API asks the session who it is now.
        for (const fn of this.#principal) {
          try {
            fn();
          } catch {
            // A listener's failure is its own.
          }
        }
        return;
      case "state":
        // The writer stored a newer record: follow it. A writer never follows (it wrote it).
        if (this.isWriter || m.rev <= this.#rev) return;
        this.#purged = false;
        await this.#follow();
        return;
      case "change":
        if (this.isWriter) return;
        await this.#follow();
        this.#fan2([{ type: "change", keys: m.keys, origin: m.origin }]);
        return;
    }
  }

  /** A follower reads the record into its machine. A tab that took the lock while the read was
   *  in flight is being promoted (or is the writer): its own machine is not replaced by a read
   *  that began before it was the writer. */
  async #follow(): Promise<void> {
    const rec = await this.#readRecord();
    if (!this.#holdsLock) this.#adopt(rec);
    this.#noteStatus();
  }

  /** Listeners only: a change another tab already announced is not announced again. */
  #fan2(events: SyncEvent[]): void {
    for (const fn of this.#listeners) {
      try {
        fn(events);
      } catch {
        // A listener's failure never reaches the machine.
      }
    }
  }

  /** The record is gone: forget it in memory too. */
  #drop(): void {
    this.#purged = true;
    this.#rev = 0;
    this.#openKeys = new Set();
    this.#clearTimer();
    this.#build(null);
    this.machine.importLocal({});
    this.machine.takeEvents();
    this.#noteStatus();
  }

  // ── Persistence ──────────────────────────────────────────────────────────────────────────

  /**
   * Persist the journal (the writer only). Inside the state lock the record is read again: it is
   * written only if it still is the one this tab last saw. A higher `rev` means another writer got
   * in (the lock failed us), so this tab adopts that record instead of writing a lower state; a
   * missing record after we had written one means a purge, which we follow.
   */
  #save(persisted?: SyncStateRecord["persisted"]): Promise<void> {
    if (this.#purged || !this.isWriter) return Promise.resolve();
    const journal = persisted ?? this.machine.persist();
    const next = this.#write.then(() => this.#saveNow(journal));
    this.#write = next.catch(() => undefined);
    return next;
  }

  async #saveNow(journal: SyncStateRecord["persisted"]): Promise<void> {
    if (this.#purged || !this.isWriter) return;
    try {
      await this.#withStateLock(async () => {
        const raw = await this.#deps.store.get();
        const cur =
          raw === null ? null : parseSyncState(raw, this.#deps.product);
        // A purge message may have landed while we waited for the lock or the read.
        if (this.#purged) return;
        if (raw !== null && cur === null) {
          // A record that is not ours is never replaced.
          return;
        }
        if (cur !== null && cur.rev > this.#rev) {
          this.#adopt(cur);
          return;
        }
        if (cur === null && this.#rev > 0) {
          this.#drop();
          return;
        }
        const rec: SyncStateRecord = {
          schema: SYNC_STATE_SCHEMA,
          product: this.#deps.product,
          rev: this.#rev + 1,
          persisted: journal,
          catalog: this.#served,
          openKeys: [...this.#openKeys],
        };
        if (this.#purged) return;
        await this.#deps.store.put(JSON.stringify(rec));
        this.#rev = rec.rev;
        this.#deps.channel.post({ t: "state", rev: rec.rev });
      });
    } catch {
      // A store that fails keeps the journal in memory; the next save tries again.
    }
  }

  // ── Timer, flush, purge, close ───────────────────────────────────────────────────────────

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** The real-clock timer: wake while the machine holds work (an edit waiting out its debounce, a
   *  request to retry, a sign-out flush). */
  #arm(): void {
    if (
      this.#timer !== null ||
      this.#closed ||
      this.#machine === null ||
      !this.isWriter
    )
      return;
    const s = this.#machine.status();
    const busy =
      s.pending > 0 &&
      (s.state === "pending" || s.state === "syncing" || s.state === "paused");
    if (!busy) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.touch();
    }, TICK_MS);
  }

  /** `pagehide`: save the journal at once, then send what is waiting with `keepalive`. */
  #onHide(): void {
    if (!this.isWriter) return;
    this.#unloading = true;
    void this.#save();
    void this.flush(SYNC_SIGNOUT_FLUSH_MS);
  }

  /** A principal signed in: the record is saved again. */
  resume(): void {
    this.#purged = false;
  }

  /** Offer the legacy local values to the machine (the machine runs it once per install). */
  importLocal(values: Record<string, Json>): CallResult {
    if (!this.isWriter) return { ok: true };
    return this.machine.importLocal(values);
  }

  /**
   * Forget the person's synced data (S6): the machine is rebuilt empty and the record, which holds
   * the opened snapshot in the clear, is deleted. Nothing is saved again until `resume()`. Throws
   * only if the record could not be removed; the in-memory data is gone either way. Other tabs are
   * told.
   */
  async purge(): Promise<void> {
    this.#purged = true;
    this.#openKeys = new Set();
    this.#outbox.clear();
    this.#queued = [];
    this.#clearTimer();
    if (this.started) {
      // A hung request must not hold the purge: wait a short while, then go on. The pump's own
      // save is skipped (`#purged`), so nothing is written back (SEC-HOST3 S-2).
      await within(
        this.#pumping?.catch(() => undefined),
        PURGE_WAIT_MS,
      );
      // A save already inside the lock lands before this resolves; only then is `#rev` zeroed, so
      // the next sign-in does not read its own first save as a purge (SEC-HOST2 S5).
      await within(this.#write, PURGE_WAIT_MS);
      this.#rev = 0;
      this.#openKeys = new Set();
      this.#emitFrom(this.machine);
      this.#build(null);
      this.machine.importLocal({});
      this.machine.takeEvents();
    }
    this.#rev = 0;
    try {
      await this.#withStateLock(() => removeSyncState(this.#deps.store));
    } finally {
      this.#deps.channel.post({ t: "purge" });
      this.#noteStatus();
    }
  }

  /** Send what is waiting and save, giving up (the journal is kept) after `maxMs`. A follower has
   *  nothing to send. */
  async flush(maxMs: number = SYNC_SIGNOUT_FLUSH_MS): Promise<void> {
    await this.#forgetting;
    if (!this.started || !this.isWriter) return;
    this.machine.flush();
    let cut: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      cut = setTimeout(resolve, maxMs);
    });
    try {
      await Promise.race([this.touch(), limit]);
    } finally {
      clearTimeout(cut);
    }
    // A forget this pump started (the person left) is finished before the journal is saved again.
    await this.#forgetting;
    await this.#save();
  }

  /** Stop the timer and the page hooks; save the journal and leave the writer election. Safe to
   *  call more than once. */
  async close(): Promise<void> {
    if (this.#closed) return;
    const was = this.started;
    this.#clearTimer();
    for (const off of this.#offPage) off();
    this.#offPage = [];
    this.#detach?.();
    this.#detach = null;
    if (was && this.#machine !== null) {
      await this.#pumping?.catch(() => undefined);
      await this.#save();
    }
    this.#closed = true;
    this.#role?.release();
    this.#deps.channel.close();
  }
}
