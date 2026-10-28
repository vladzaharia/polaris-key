// The Node Cloud Sync host (U-06.2): the first production host of client-core's `CloudSyncMachine`.
// The machine does no I/O; this module is everything around it:
//
//   - one machine per client, built from app code (`cloudSync.encryption`, default "e2e"), the
//     discovery `services.sync` member, the key ring (`keyring.attach`) and the product catalog;
//   - the catalog comes from `/config/schema`, cached beside the journal, with the app's compiled
//     mirror before the first fetch; it is fetched again when a pull's `catalogVersion` differs;
//   - every request the machine queues goes through the transport (bearer, `X-PKey-*`), and in
//     E2E mode through client-core's host codec (`sealPush` / `openPull`) on the way out and in;
//   - the journal is written to `<stateDir>/cloud-sync.json` (0600);
//   - a real-clock timer drives `advance`; `beforeExit` flushes, bounded by `SYNC_SIGNOUT_FLUSH_MS`.
//
// Rules this host keeps (plans/U-sync-clients-slices.md section 9):
//   S1  `OpenedBody` is the codec's own result; the served body's `sealed` / `invalid` / `seq` are
//       stripped by `openPull`, never read here.
//   S2  The mode is app code's. The Worker's discovery and bodies only let the machine detect a
//       downgrade; the served catalog's `cloudSync.encryption` is dropped from the routes.
//   S3  A locked ring sends nothing and reads nothing: no request is made while the codec is
//       locked, and this host never adds a GET of its own.
//   S7  The root is not here; the codec holds it in the keyring's memory.
//   S10 An answer that cannot be opened is dropped without advancing the cursor.
//
// Nothing in the licence path imports this module (`test/cloudSyncHost.test.ts`).

import { randomBytes } from "node:crypto";
import {
  CloudSyncMachine,
  SYNC_SIGNOUT_FLUSH_MS,
  type CloudSyncCatalog,
  type CloudSyncDocument,
  type OpenedBody,
  type EncryptionMode,
  type Json,
  type SettingRoute,
  type SyncEvent,
  type SyncRequest,
  type SyncResponse,
  type WireMutation,
} from "@polaris-key/client-core/cloud-sync";
import { openPull, sealPush } from "@polaris-key/client-core/sync";
import { SYNC_KEY_PATTERN } from "@polaris-key/protocol/sync";
import { syncedSettings, type ProductCatalog } from "@polaris-key/catalog";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";
import type { ProductDiscoveryDocument } from "../discovery.js";
import type { KeyringClient } from "../keyring/client.js";
import {
  CloudSyncStateFile,
  OPEN_KEYS_MAX,
  isCatalogShape,
  type CloudSyncFile,
} from "./state.js";
import { sendSync } from "./transport.js";

/** What app code sets (`PolarisKeyClientOptions.cloudSync`). Never read from the Worker. */
export interface CloudSyncHostOptions {
  /** The product's mode. Default `"e2e"`. An app that says `"server"` still refuses to talk to a
   *  Worker it has seen speak E2E (the machine's pin). */
  encryption?: EncryptionMode;
  /** The catalog compiled into the app (`pkey mirror`): used until `/config/schema` has been
   *  fetched once. */
  catalog?: ProductCatalog;
  /** Renames the app declares (old name to current name). Never taken from a served body. */
  aliases?: Readonly<Record<string, string>>;
}

/** What the host needs from the client; each is a function so the host holds no stale copy. */
export interface CloudSyncHostDeps {
  ctx: CoreContext;
  tokens: TokenManager;
  keyring: KeyringClient;
  /** The loaded discovery document, or null before the first discovery. */
  discovery: () => ProductDiscoveryDocument | null;
  /** `GET /config/schema` (diagnostic and unsigned; null on any failure). */
  fetchSchema: () => Promise<ProductCatalog | null>;
  /** The signed config document's values and the keys it locks. */
  document: () => CloudSyncDocument;
  /** The person the device's session is for now, or null when not known. A request queued for
   *  another person is dropped, not sent under this session's token. */
  subject?: () => Promise<string | null>;
  /** Test seam: the clock and the timer (defaults: `Date.now`, `setTimeout`). */
  clock?: { now: () => number };
}

/** How often the real-clock timer wakes the machine while it holds work (ms). */
export const TICK_MS = 250;
/** The most exchanges one pump makes, whatever the machine keeps asking for. */
const MAX_EXCHANGES = 64;

const EMPTY_CATALOG: ProductCatalog = { schemaVersion: 0, entries: [] };
const SYNC_KEY = new RegExp(SYNC_KEY_PATTERN);
/** The most entries and bytes of a catalog the host will route by. */
export const MAX_CATALOG_ENTRIES = 1024;
export const MAX_CATALOG_BYTES = 1024 * 1024;
/** A served catalog is fetched again at most this often (the first fetch is free). */
export const CATALOG_REFETCH_MS = 5 * 60_000;

/** A catalog fit to route by: the right shape and size, every entry key a valid sync key, and
 *  one entry per key. Null when it is not. */
function vetted(c: unknown): ProductCatalog | null {
  if (!isCatalogShape(c) || c.entries.length > MAX_CATALOG_ENTRIES) return null;
  if (JSON.stringify(c).length > MAX_CATALOG_BYTES) return null;
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

export class CloudSyncHost {
  readonly #deps: CloudSyncHostDeps;
  readonly #opts: CloudSyncHostOptions;
  readonly #file: CloudSyncStateFile;
  readonly #listeners = new Set<(events: SyncEvent[]) => void>();
  #machine: CloudSyncMachine | null = null;
  #detach: (() => void) | null = null;
  /** The catalog compiled into the app: authoritative for every key it names. */
  #mirror: ProductCatalog | null = null;
  /** The last catalog the Worker served: it may only add keys the mirror lacks. */
  #served: ProductCatalog | null = null;
  /** The catalog the machine routes by (`#effective()`). */
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
  #exitHook: (() => void) | null = null;
  #started = false;
  #closed = false;
  /** After a purge the journal stays unsaved until a principal signs in again. */
  #purged = false;
  /** The person the machine's queued requests belong to (null for none). */
  #bound: string | null = null;

  constructor(deps: CloudSyncHostDeps, opts: CloudSyncHostOptions = {}) {
    this.#deps = deps;
    this.#opts = opts;
    this.#file = new CloudSyncStateFile(deps.ctx.dirs.state, deps.ctx.product);
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

  /** Subscribe to the machine's events (batches, in order). Returns an unsubscribe function. */
  onEvents(fn: (events: SyncEvent[]) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Load the saved journal and catalog, build the machine, attach it to the key ring and start
   * the exit flush. Idempotent. Makes no request unless a catalog has to be fetched (none cached
   * and none compiled in).
   */
  async start(): Promise<void> {
    if (this.#started || this.#closed) return;
    this.#started = true;
    const saved = await this.#file.load();
    this.#openKeys = new Set(saved.openKeys);
    this.#mirror = vetted(this.#opts.catalog);
    this.#served = vetted(saved.catalog);
    this.#build(saved.persisted);
    this.#exitHook = () => {
      void this.flush(SYNC_SIGNOUT_FLUSH_MS);
    };
    process.once("beforeExit", this.#exitHook);
    if (saved.catalog === null && this.#opts.catalog === undefined)
      await this.#refetchCatalog(null);
    this.touch();
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
  #build(persisted: CloudSyncFile["persisted"]): void {
    this.#detach?.();
    this.#catalog = this.#effective();
    this.#routes = routesOf(this.#catalog);
    const catalog: CloudSyncCatalog = { settings: this.#routes };
    const document = this.#deps.document();
    this.#documentJson = JSON.stringify(document);
    const m = new CloudSyncMachine(
      {
        product: this.#deps.ctx.product,
        catalog,
        document,
        now: this.#now,
        encryption: this.#opts.encryption ?? "e2e",
        hasRoot: this.#deps.keyring.unlocked,
        newClientId: () => `c_${randomBytes(16).toString("base64url")}`,
      },
      persisted ?? undefined,
    );
    this.#machine = m;
    this.#applyDiscovery(m);
    this.#detach = this.#deps.keyring.attach(m);
  }

  #applyDiscovery(m: CloudSyncMachine): void {
    const doc = this.#deps.discovery();
    if (doc === null) return;
    const sync = doc.services.sync;
    if (sync === undefined || sync.enabled !== true) return;
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

  /** Run the machine now: advance its clock, exchange every queued request, save. Never throws. */
  touch(): Promise<void> {
    if (!this.started || !this.#deps.ctx.enabled("sync"))
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
   * run of its own (it was lost when it landed between the pump's last check and its settling).
   */
  async #run(): Promise<void> {
    try {
      for (let i = 0; i < 4; i++) {
        await this.#pump();
        if (!this.#again) break;
      }
    } finally {
      this.#pumping = null;
      this.#arm();
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
    // the file alone and an edit keeps its debounce window.
    if (this.#used > 0) await this.#save();
  }

  /** Tell the host whose requests the machine now holds (null for none). */
  bindSubject(subject: string | null): void {
    this.#bound = subject;
  }

  /** One request: seal it (E2E), send it, open the answer, hand both to the machine. */
  async #exchange(req: SyncRequest): Promise<void> {
    const m = this.machine;
    const bound = this.#bound;
    const codec = this.#deps.keyring.codec;
    const e2e = m.encryptionMode() === "e2e";
    // S3: a locked ring sends nothing, a pull included.
    if (e2e && codec.locked) return m.receive({ error: "transport" });

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
            body: await sealPush(req.body, codec, this.#routes),
          };
        } catch {
          // Locked, or a mutation that cannot be sealed: nothing is sent.
          return m.receive({ error: "transport" });
        }
      }
    }

    // Queued for one person: if the session is another person's now, nothing is sent.
    const now = (await this.#deps.subject?.().catch(() => null)) ?? null;
    if (bound !== null && now !== null && now !== bound)
      return m.receive({ error: "transport" });
    const res = await sendSync(this.#deps.ctx, this.#deps.tokens, wire);
    if (!e2e || !("status" in res) || res.status !== 200 || !isObj(res.body)) {
      // Server mode, an error answer, or no answer: the machine reads it as it is.
      if (e2e && "status" in res && res.status === 200)
        return m.receive({ error: "transport" });
      return m.receive(res);
    }
    let opened;
    try {
      opened = await openPull(res.body, codec, {
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

  #emit(): void {
    this.#emitFrom(this.machine);
  }

  #emitFrom(m: CloudSyncMachine): void {
    const events = m.takeEvents();
    if (events.length === 0) return;
    for (const fn of this.#listeners) {
      try {
        fn(events);
      } catch {
        // A listener's failure never reaches the machine.
      }
    }
  }

  /** Persist the journal. Committing the debounced edits is what `persist()` does by contract. */
  async #save(persisted?: CloudSyncFile["persisted"]): Promise<void> {
    if (this.#purged) return;
    const file: CloudSyncFile = {
      v: 1,
      product: this.#deps.ctx.product,
      persisted: persisted ?? this.machine.persist(),
      catalog: this.#served,
      openKeys: [...this.#openKeys],
    };
    await this.#file.save(file).catch(() => undefined);
  }

  /** The real-clock timer: wake while the machine holds work (an edit waiting out its debounce, a
   *  request to retry, a sign-out flush). It never keeps the process alive. */
  #arm(): void {
    if (this.#timer !== null || this.#closed || this.#machine === null) return;
    const s = this.#machine.status();
    const busy =
      s.pending > 0 &&
      (s.state === "pending" || s.state === "syncing" || s.state === "paused");
    if (!busy) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.touch();
    }, TICK_MS);
    this.#timer.unref?.();
  }

  /** Offer the legacy `local-config.json` to the machine, once per install. */
  async importLocalOnce(values: Record<string, Json>): Promise<void> {
    const done = await this.#file.imported();
    this.machine.importLocal(done ? {} : values);
    if (!done) await this.#file.markImported().catch(() => undefined);
  }

  /** A principal signed in: the journal is saved again. */
  resume(): void {
    this.#purged = false;
  }

  /**
   * Forget the person's synced data (S6): the machine is rebuilt empty and `cloud-sync.json`,
   * which holds the opened snapshot in the clear, is deleted. Nothing is saved again until
   * `resume()`. Works before `start()` too (the file may predate this process). Throws only if
   * the file could not be removed; the in-memory data is gone either way.
   */
  async purge(): Promise<void> {
    this.#purged = true;
    this.#openKeys = new Set();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.started) {
      await this.#pumping?.catch(() => undefined);
      this.#emitFrom(this.machine);
      this.#build(null);
      this.machine.importLocal({});
    }
    await this.#file.remove();
  }

  /** Send what is waiting and save, giving up (the journal is kept) after `maxMs`. */
  async flush(maxMs: number = SYNC_SIGNOUT_FLUSH_MS): Promise<void> {
    if (!this.started) return;
    this.machine.flush();
    let cut: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      cut = setTimeout(resolve, maxMs);
      cut.unref?.();
    });
    try {
      await Promise.race([this.touch(), limit]);
    } finally {
      clearTimeout(cut);
    }
    await this.#save();
  }

  /** Stop the timer and the exit hook; save the journal. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.#closed) return;
    const was = this.started;
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#exitHook !== null) process.off("beforeExit", this.#exitHook);
    this.#exitHook = null;
    this.#detach?.();
    this.#detach = null;
    if (was && this.#machine !== null) {
      await this.#pumping?.catch(() => undefined);
      await this.#save();
    }
  }
}
