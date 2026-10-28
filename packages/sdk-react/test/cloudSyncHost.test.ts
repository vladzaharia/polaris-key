// @vitest-environment node
//
// @pkey-feature sync.e2e
//
// U-20.2: the browser Cloud Sync host, client-core's `CloudSyncMachine` driven over a bearer
// request, with the browser host codec on both sides, against a small fake of the Worker's /sync
// routes. It mirrors sdk-node's cloudSyncHost and cloudSyncSettings security cases (every
// SEC-SYNC-HOST fix) and adds the browser's own: the IndexedDB-shaped record never written over a
// higher one, one writer tab through Web Locks, `change` fanned out between tabs, a `pagehide`
// flush, and the typed unsupported on the other transports.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import {
  deriveKid,
  webCryptoSyncPort as P,
} from "@polaris-key/client-core/sync";
import type { SyncEvent } from "@polaris-key/client-core/cloud-sync";
import { readCappedText } from "../src/browser/boundedBody.js";
import { fetchCatalog } from "../src/browser/catalog.js";
import { ringCodec } from "../src/browser/ring/codec.js";
import {
  importRootHandle,
  memoryRootVault,
  ringKeysOf,
} from "../src/browser/ring/rootVault.js";
import {
  BrowserCloudSyncHost,
  PURGE_WAIT_MS,
  CATALOG_REFETCH_MS,
  vetted,
  type BrowserSyncHostDeps,
  type CloudSyncHostOptions,
} from "../src/browser/cloudSync/host.js";
import { memoryConnectState } from "../src/browser/connect/state.js";
import {
  parseSyncState,
  removeSyncState,
  type SyncStateStore,
} from "../src/browser/cloudSync/store.js";
import { isSyncPath } from "../src/browser/cloudSync/transport.js";
import {
  joinWriterElection,
  parseTabMessage,
  type TabChannel,
  type TabMessage,
} from "../src/browser/cloudSync/writer.js";
import { UnsupportedError } from "../src/core/caps.js";
import { lazyCloudSync, unsupportedCloudSync } from "../src/core/cloudSync.js";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import { LocalAdapter } from "../src/local/localAdapter.js";
import { makeFakeBridge, okBridgeState } from "./fixtures.js";

const PRODUCT = "djdl";
const SUBJECT = "ps_aqofwJ_4zDBMy1_W857ARg";
const RAW = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const hexOf = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
type Body = Record<string, unknown>;

const entry = (key: string, user: object = {}) => ({
  key,
  kind: "config",
  category: "ui",
  label: key,
  description: key,
  schema: { type: "string" },
  user: { sync: "user", conflict: "lastWrite", ...user },
});
const CATALOG = (version: number) => ({
  schemaVersion: version,
  entries: [entry("theme")],
});

const ROOM = {
  usage: { files: 0, records: 0, settings: 0, bytes: 0 },
  quota: { files: true, bytes: 2 ** 28 },
};

// ── A fake of the Worker's /sync routes ──────────────────────────────────────────────────────

interface Seen {
  method: string;
  path: string;
  body: Body | undefined;
  keepalive: boolean;
}

class World {
  seen: Seen[] = [];
  schemaFetches = 0;
  schema: unknown = CATALOG(1);
  pull: () => Response | Body = () => this.body();
  version = 100;
  push: (body: Body) => Response | Body = (body) =>
    this.body({
      results: (body.mutations as Array<{ mutationId: number }>).map((m) => ({
        mutationId: m.mutationId,
        status: "ok",
        version: ++this.version,
      })),
    });

  body(over: Body = {}): Body {
    return {
      subject: SUBJECT,
      serverNow: 1_700_000_000_000,
      cursor: 0,
      more: false,
      lastMutationId: 0,
      catalogVersion: 1,
      aliases: {},
      ...ROOM,
      encryption: "e2e",
      encryptionSince: 1,
      changes: [],
      tombstones: [],
      ...over,
    };
  }

  get reqs(): Seen[] {
    return this.seen;
  }

  /** `BearerSession.ringRequest`: a path relative to the product. */
  request = async (
    path: string,
    init: { method: string; body?: string; keepalive?: boolean },
  ): Promise<Response> => {
    const url = new URL(`https://k.test/${PRODUCT}/${path}`);
    const body = init.body ? (JSON.parse(init.body) as Body) : undefined;
    this.seen.push({
      method: init.method,
      path: url.pathname + url.search,
      body,
      keepalive: init.keepalive === true,
    });
    const j = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s });
    const wrap = (r: Response | Body) => (r instanceof Response ? r : j(r));
    if (url.pathname === `/${PRODUCT}/sync` && init.method === "GET")
      return wrap(this.pull());
    if (url.pathname === `/${PRODUCT}/sync/ops` && init.method === "POST")
      return wrap(this.push(body!));
    return j({}, 404);
  };
}

// ── Web Locks, channels and the record, shared between tabs ──────────────────────────────────

class FakeLocks {
  private held = new Set<string>();
  private queues = new Map<string, Array<() => void>>();
  request(
    name: string,
    a: unknown,
    b?: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown> {
    const opts = (typeof a === "function" ? {} : a) as {
      ifAvailable?: boolean;
    };
    const fn = (typeof a === "function" ? a : b) as (
      lock: unknown,
    ) => Promise<unknown> | unknown;
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.held.add(name);
        try {
          resolve(await fn({ name }));
        } catch (e) {
          reject(e);
        } finally {
          this.held.delete(name);
          this.queues.get(name)?.shift()?.();
        }
      };
      if (!this.held.has(name)) void run();
      else if (opts.ifAvailable) {
        Promise.resolve(fn(null)).then(resolve, reject);
      } else {
        const q = this.queues.get(name) ?? [];
        q.push(() => void run());
        this.queues.set(name, q);
      }
    });
  }
}

class Hub {
  private members = new Set<{ deliver: (m: TabMessage) => void }>();
  private deaf = new Set<{ deliver: (m: TabMessage) => void }>();
  /** Make the first member deaf (a frozen writer): it keeps the lock but hears nothing. */
  closeAll(_host: unknown): void {
    const first = [...this.members][0]!;
    this.deaf.add(first);
  }
  channel(): TabChannel {
    const handlers: Array<(m: TabMessage) => void> = [];
    const me = { deliver: (m: TabMessage) => handlers.forEach((h) => h(m)) };
    this.members.add(me);
    return {
      post: (m) => {
        const copy = structuredClone(m);
        for (const o of this.members)
          if (o !== me && !this.deaf.has(o))
            setTimeout(() => o.deliver(copy), 0);
      },
      onMessage: (fn) => void handlers.push(fn),
      close: () => void this.members.delete(me),
    };
  }
}

/** The key ring a tab sees: a real codec over a non-extractable root in a memory vault. */
async function makeRing(root: Uint8Array = RAW) {
  const vault = memoryRootVault();
  const record = {
    v: 1 as const,
    ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
    epoch: 1,
    kid: hexOf(await deriveKid(P, root)),
    key: await importRootHandle(root),
  };
  await vault.put(record);
  let held = true;
  const subs = new Set<() => void>();
  const codec = ringCodec({
    hasRoot: () => held,
    ringKeys: async () => {
      const rec = await vault.get();
      return rec ? ringKeysOf(rec, P) : null;
    },
  });
  const notify = () => subs.forEach((s) => s());
  return {
    hasRoot: () => held,
    subscribe: (l: () => void) => (subs.add(l), () => subs.delete(l)),
    codec: () => (held ? codec : null),
    forget: vi.fn(async () => {
      held = false;
      await vault.clear();
      notify();
    }),
    lock: () => {
      held = false;
      notify();
    },
    unlock: async () => {
      await vault.put(record);
      held = true;
      notify();
    },
    sealCt: async (name: string, value: string) =>
      base64UrlEncodeBytes(await codec.seal("$settings", name, value)),
  };
}
type Ring = Awaited<ReturnType<typeof makeRing>>;

class Page {
  handlers = new Map<string, Set<() => void>>();
  on(type: "pagehide" | "pageshow", fn: () => void) {
    const s = this.handlers.get(type) ?? new Set();
    s.add(fn);
    this.handlers.set(type, s);
    return () => void s.delete(fn);
  }
  fire(type: "pagehide" | "pageshow") {
    this.handlers.get(type)?.forEach((f) => f());
  }
}

/** What the tabs of one browser share. */
class Browser {
  locks = new FakeLocks();
  hub = new Hub();
  store: SyncStateStore = memoryConnectState();
  hosts: BrowserCloudSyncHost[] = [];

  async tab(
    w: World,
    over: {
      ring?: Ring;
      opts?: CloudSyncHostOptions;
      deps?: Partial<BrowserSyncHostDeps>;
      page?: Page;
    } = {},
  ) {
    const ring = over.ring ?? (await makeRing());
    const host = new BrowserCloudSyncHost(
      {
        product: PRODUCT,
        request: w.request,
        ring,
        discovery: () => null,
        fetchSchema: async () => {
          w.schemaFetches++;
          return w.schema as never;
        },
        document: () => ({ values: {} }),
        enabled: () => true,
        store: this.store,
        locks: this.locks,
        writerLock: "pkey-sync-writer:test",
        stateLock: "pkey-sync-state:test",
        channel: this.hub.channel(),
        ...(over.page ? { page: over.page } : {}),
        ...over.deps,
      },
      over.opts ?? { catalog: CATALOG(1) as never, encryption: "e2e" },
    );
    this.hosts.push(host);
    return { host, ring };
  }

  async close() {
    for (const h of this.hosts) await h.close();
  }
}

/** One tab, started, with the root held and `SUBJECT` signed in. */
async function live(w: World, b = new Browser()) {
  const t = await b.tab(w);
  await t.host.start();
  t.host.machine.signIn(SUBJECT);
  await t.host.touch();
  return { ...t, b };
}

const change = (over: Body): Body => ({
  setting: "theme",
  scope: "user",
  version: 5,
  editedHlc: "0199c82cc000:0000",
  updatedBy: "c_AAAAAAAAAAAAAAAAAAAAAA",
  ...over,
});

const record = async (b: Browser) => {
  const raw = await b.store.get();
  return raw === null ? null : parseSyncState(raw, PRODUCT);
};

// ── The ring gates every request (S3) ────────────────────────────────────────────────────────

describe("browser cloud sync host: the ring gates every request (S3)", () => {
  it("a locked ring sends nothing, edits stay on the device, and an unlock sends them sealed", async () => {
    const w = new World();
    const b = new Browser();
    const ring = await makeRing();
    ring.lock();
    const { host } = await b.tab(w, { ring });
    await host.start();
    host.machine.signIn(SUBJECT);
    await host.set("theme", "dark");
    await host.flush(1000);
    expect(w.reqs).toEqual([]);
    expect(host.machine.status()).toMatchObject({
      state: "locked",
      reason: "keyring",
    });
    expect(host.machine.get("theme").value).toBe("dark");

    await ring.unlock();
    await host.touch();
    const push = w.reqs.find((r) => r.method === "POST");
    expect(push).toBeDefined();
    const m = (push!.body!.mutations as Array<Body>)[0]!;
    expect(m).toHaveProperty("ct");
    expect(m).not.toHaveProperty("value");
    expect(JSON.stringify(push!.body)).not.toContain("dark");
    await b.close();
  });

  it("an open key leaves blinded and never in the clear", async () => {
    const w = new World();
    const { host, b } = await live(w);
    await host.set("notes-private", "x");
    await host.flush(1000);
    const push = w.reqs.find((r) => r.method === "POST")!;
    const m = (
      push.body!.mutations as Array<{ target: { setting: string } }>
    )[0]!;
    expect(m.target.setting).not.toContain("notes");
    expect(JSON.stringify(push.body)).not.toContain("notes-private");
    await b.close();
  });

  it("a ring locked while a pull is in flight drops the answer and the cursor stays (S10)", async () => {
    const w = new World();
    const b = new Browser();
    const t = await b.tab(w);
    await t.host.start();
    w.pull = () => {
      t.ring.lock();
      return w.body({ cursor: 7 });
    };
    t.host.machine.signIn(SUBJECT);
    await t.host.touch();
    expect(t.host.machine.persist().partitions[SUBJECT]!.cursor).toBe(0);
    await b.close();
  });

  it("a lazy ring whose engine has not loaded (no codec) sends nothing", async () => {
    const w = new World();
    const b = new Browser();
    const ring = await makeRing();
    const lazy = { ...ring, codec: () => null };
    const { host } = await b.tab(w, { ring: lazy as never });
    await host.start();
    host.machine.signIn(SUBJECT);
    await host.set("theme", "dark");
    await host.flush(1000);
    expect(w.reqs).toEqual([]);
    await b.close();
  });
});

// ── What a Worker serves is not trusted (S1, S10) ────────────────────────────────────────────

describe("browser cloud sync host: what a Worker serves is not trusted (S1, S10)", () => {
  it("ignores a forged sealed flag on a plaintext row", async () => {
    const w = new World();
    w.pull = () =>
      w.body({
        cursor: 5,
        encryptionSince: 3,
        changes: [
          change({ value: "evil", sealed: true, invalid: false, seq: 1 }),
        ],
      });
    const { host, b } = await live(w);
    expect(host.machine.settingState("theme").invalid).toBe(true);
    expect(host.machine.get("theme").value).not.toBe("evil");
    await b.close();
  });

  it("reads a plaintext row below encryptionSince as legacy data, and one at or above it as invalid", async () => {
    const w = new World();
    w.pull = () =>
      w.body({
        cursor: 2,
        encryptionSince: 4,
        changes: [change({ value: "legacy", version: 2 })],
      });
    const a = await live(w);
    expect(a.host.machine.settingState("theme").invalid).toBe(false);
    expect(a.host.machine.get("theme").value).toBe("legacy");
    await a.b.close();

    const w2 = new World();
    w2.pull = () =>
      w2.body({
        cursor: 6,
        encryptionSince: 4,
        changes: [change({ value: "late", version: 6 })],
      });
    const c = await live(w2);
    expect(c.host.machine.settingState("theme").invalid).toBe(true);
    await c.b.close();
  });

  it("opens a sealed row, and marks an unopenable ct invalid", async () => {
    const w = new World();
    const b = new Browser();
    const t = await b.tab(w);
    const good = await t.ring.sealCt("theme", "dark");
    w.pull = () =>
      w.body({ cursor: 5, changes: [change({ ct: good, version: 5 })] });
    await t.host.start();
    t.host.machine.signIn(SUBJECT);
    await t.host.touch();
    expect(t.host.machine.get("theme").value).toBe("dark");
    await b.close();

    const w2 = new World();
    w2.pull = () =>
      w2.body({ cursor: 5, changes: [change({ ct: "AAAA", version: 5 })] });
    const bad = await live(w2);
    expect(bad.host.machine.settingState("theme").invalid).toBe(true);
    await bad.b.close();
  });

  it("opens a conflict's server copy against the mutation's own setting", async () => {
    const run = async (which: "theirs" | "other") => {
      const w = new World();
      const b = new Browser();
      const t = await b.tab(w);
      const copy = await t.ring.sealCt(
        which === "theirs" ? "theme" : "other",
        which === "theirs" ? "theirs" : "swapped",
      );
      w.pull = () => w.body({ cursor: 5 });
      w.push = (body) => {
        const [m] = body.mutations as Array<{ mutationId: number }>;
        return w.body({
          cursor: 5,
          results: [
            {
              mutationId: m!.mutationId,
              status: "conflict",
              server: change({ ct: copy, version: 9 }),
            },
          ],
        });
      };
      await t.host.start();
      t.host.machine.signIn(SUBJECT);
      await t.host.touch();
      await t.host.set("theme", "mine");
      await t.host.flush(1000);
      const out = {
        invalid: t.host.machine.settingState("theme").invalid,
        value: t.host.machine.get("theme").value,
      };
      await b.close();
      return out;
    };
    expect(await run("theirs")).toEqual({ invalid: false, value: "theirs" });
    // A copy sealed for another setting is not the mutation's: it reads as invalid.
    expect((await run("other")).invalid).toBe(true);
  });

  it("a duplicate mutationId in results cannot overwrite the conflict verdict with a forged copy", async () => {
    const w = new World();
    const b = new Browser();
    const t = await b.tab(w);
    const theirs = await t.ring.sealCt("theme", "theirs");
    w.pull = () => w.body({ cursor: 5 });
    w.push = (body) => {
      const [m] = body.mutations as Array<{ mutationId: number }>;
      return w.body({
        cursor: 5,
        results: [
          {
            mutationId: m!.mutationId,
            status: "conflict",
            server: change({ ct: theirs, version: 9 }),
          },
          {
            mutationId: m!.mutationId,
            status: "conflict",
            server: change({ value: "forged", version: 9 }),
          },
        ],
      });
    };
    await t.host.start();
    t.host.machine.signIn(SUBJECT);
    await t.host.touch();
    await t.host.set("theme", "mine");
    await t.host.flush(1000);
    expect(t.host.machine.get("theme").value).not.toBe("forged");
    await b.close();
  });

  it("served aliases and renamedTo never reach the machine; only the app's do", async () => {
    const w = new World();
    const b = new Browser();
    const t = await b.tab(w);
    const sealedA = await t.ring.sealCt("a", "va");
    w.pull = () =>
      w.body({
        cursor: 5,
        aliases: { a: "theme" },
        changes: [change({ setting: "a", ct: sealedA, version: 5 })],
      });
    await t.host.start();
    t.host.machine.signIn(SUBJECT);
    await t.host.touch();
    expect(t.host.machine.persist().aliases).toEqual({});
    expect(t.host.machine.get("theme").value).not.toBe("va");
    await b.close();
  });
});

// ── Mode, catalog and state ──────────────────────────────────────────────────────────────────

describe("browser cloud sync host: mode, catalog and state", () => {
  it("a Worker that answers in server mode is not read when the app requires e2e", async () => {
    const w = new World();
    w.pull = () =>
      w.body({
        encryption: "server",
        cursor: 3,
        changes: [change({ value: "plain", version: 3 })],
      });
    const { host, b } = await live(w);
    expect(host.machine.status()).toMatchObject({
      state: "unsupported",
      code: "sync-encryption-pinned",
    });
    expect(host.machine.get("theme").value).not.toBe("plain");
    await b.close();
  });

  it("fetches the catalog once when none is held or compiled, and again only after the refetch window", async () => {
    const w = new World();
    const b = new Browser();
    const clock = { t: 1_700_000_000_000 };
    const { host } = await b.tab(w, {
      opts: { encryption: "e2e" },
      deps: { clock: { now: () => clock.t } },
    });
    await host.start();
    expect(w.schemaFetches).toBe(1);
    w.schema = CATALOG(2);
    w.pull = () => w.body({ catalogVersion: 2 });
    host.machine.signIn(SUBJECT);
    await host.touch();
    // A Worker alternating versions cannot make the client fetch on every pull.
    expect(w.schemaFetches).toBe(1);
    clock.t += CATALOG_REFETCH_MS + 1;
    host.machine.setNetwork("online");
    await host.touch();
    expect(w.schemaFetches).toBe(2);
    // A version it does not serve is not asked for again, window or not.
    w.pull = () => w.body({ catalogVersion: 3 });
    clock.t += CATALOG_REFETCH_MS + 1;
    host.machine.setNetwork("online");
    await host.touch();
    const after = w.schemaFetches;
    clock.t += CATALOG_REFETCH_MS + 1;
    host.machine.setNetwork("online");
    await host.touch();
    expect(w.schemaFetches).toBe(after);
    // With no mirror the served catalog is held beside the journal.
    expect((await record(b))!.catalog).toMatchObject({ schemaVersion: 2 });
    await b.close();
  });

  it("the compiled mirror is authoritative: a served catalog only adds keys, and bad keys are dropped", async () => {
    const w = new World();
    w.schema = {
      schemaVersion: 2,
      entries: [
        entry("theme", { sync: "local" }),
        entry("extra", { sync: "local" }),
        entry("bad key!", { sync: "local" }),
      ],
    };
    const { host, b } = await live(w);
    w.pull = () => w.body({ catalogVersion: 2 });
    host.machine.setNetwork("online");
    await host.touch();
    await host.touch();
    const m = host.machine;
    m.set("theme", "dark");
    m.set("extra", "x");
    expect(m.settingState("theme").sync).not.toBe("local");
    expect(m.settingState("extra").sync).toBe("local");
    await host.flush(1000);
    const keys = (await record(b))!.catalog!.entries.map((e) => e.key);
    expect(keys).not.toContain("bad key!");
    await b.close();
  });

  it("a served catalog is vetted: pattern, 1024 entries, 1 MiB, one entry per key", () => {
    expect(
      vetted({ schemaVersion: 1, entries: [entry("a"), entry("a")] }),
    ).toMatchObject({ entries: [{ key: "a" }] });
    expect(
      vetted({ schemaVersion: 1, entries: [entry("bad key!")] }),
    ).toMatchObject({
      entries: [],
    });
    const many = Array.from({ length: 1025 }, (_, i) => entry(`k${i}`));
    expect(vetted({ schemaVersion: 1, entries: many })).toBeNull();
    const fat = { ...entry("fat"), description: "x".repeat(1024 * 1024) };
    expect(vetted({ schemaVersion: 1, entries: [fat] })).toBeNull();
    expect(vetted(null)).toBeNull();
    expect(vetted({ schemaVersion: "1", entries: [] })).toBeNull();
  });

  it("with no mirror a served catalog cannot reclassify an open setting the person already uses", async () => {
    const w = new World();
    const b = new Browser();
    const clock = { t: 1_700_000_000_000 };
    const { host } = await b.tab(w, {
      opts: { encryption: "e2e" },
      deps: { clock: { now: () => clock.t } },
    });
    await host.start();
    host.machine.signIn(SUBJECT);
    await host.touch();
    await host.set("notes", "mine");
    await host.flush(1000);
    w.schema = {
      schemaVersion: 2,
      entries: [
        entry("notes", { sync: "local" }),
        entry("fresh", { sync: "local" }),
      ],
    };
    w.pull = () => w.body({ catalogVersion: 2 });
    clock.t += CATALOG_REFETCH_MS + 1;
    host.machine.setNetwork("online");
    await host.touch();
    expect(w.schemaFetches).toBe(2);
    expect(host.machine.settingState("notes").sync).not.toBe("local");
    expect(host.machine.settingState("fresh").sync).toBe("local");
    await b.close();
  });

  it("junk names a Worker serves cannot push the person's open keys out of the tombstone map", async () => {
    const w = new World();
    const { host, b } = await live(w);
    await host.set("notes-private", "x");
    await host.flush(1000);
    w.pull = () =>
      w.body({
        cursor: 9,
        encryptionSince: 100,
        changes: Array.from({ length: 5000 }, (_, i) =>
          change({ setting: `junk${i}`, value: i, version: i + 1 }),
        ),
      });
    host.machine.setNetwork("online");
    await host.touch();
    await host.flush(1000);
    const keys = (await record(b))!.openKeys;
    expect(keys).toContain("notes-private");
    expect(keys.filter((k) => k.startsWith("junk"))).toEqual([]);
    await b.close();
  });

  it("writes one record with the journal in it, and the journal survives a relaunch", async () => {
    const w = new World();
    const a = await live(w);
    await a.host.set("theme", "dark");
    a.ring.lock();
    await a.host.flush(1000);
    const saved = await record(a.b);
    expect(saved!.product).toBe(PRODUCT);
    expect(saved!.rev).toBeGreaterThan(0);
    expect(Object.keys(saved!.persisted!.partitions)).toContain(SUBJECT);
    await a.host.close();

    const t = await a.b.tab(new World());
    await t.host.start();
    expect(t.host.machine.get("theme").value).toBe("dark");
    await a.b.close();
  });

  it("a record of another product or a malformed one reads as none", () => {
    expect(parseSyncState("not json", PRODUCT)).toBeNull();
    expect(
      parseSyncState(
        JSON.stringify({ schema: "pkey.cloudsync.v1", product: "x", rev: 1 }),
        PRODUCT,
      ),
    ).toBeNull();
    expect(
      parseSyncState(
        JSON.stringify({
          schema: "pkey.cloudsync.v1",
          product: PRODUCT,
          rev: -1,
        }),
        PRODUCT,
      ),
    ).toBeNull();
  });
});

// ── Leaving the principal purges the record (S6, SEC-SYNC-HOST 7) ────────────────────────────

describe("browser cloud sync host: leaving the principal deletes the synced data (S6)", () => {
  it("purge() deletes the record, forgets in memory, and does not write it back", async () => {
    const w = new World();
    const { host, b } = await live(w);
    await host.set("theme", "dark");
    await host.flush(1000);
    expect(await b.store.get()).not.toBeNull();
    await host.purge();
    expect(await b.store.get()).toBeNull();
    expect(host.machine.get("theme").value).not.toBe("dark");
    await host.flush(1000);
    await host.close();
    expect(await b.store.get()).toBeNull();
  });

  it("S-2: a purge returns within its bound while a request never answers", async () => {
    const w = new World();
    const b = new Browser();
    const never = (() => new Promise<Response>(() => undefined)) as never;
    const { host } = await b.tab(w, { deps: { request: never } });
    await host.start();
    host.machine.signIn(SUBJECT);
    void host.touch();
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    await host.purge();
    // The request's own limit is 15 s; the purge does not wait for it.
    expect(Date.now() - t0).toBeLessThan(PURGE_WAIT_MS * 2 + 500);
    expect(await b.store.get()).toBeNull();
    // No close: it would wait for the stuck request's own limit.
  }, 10_000);

  it("a request queued for one person is never sent under another's token", async () => {
    const w = new World();
    const b = new Browser();
    const now = { current: SUBJECT as string | null };
    const { host } = await b.tab(w, { deps: { subject: () => now.current } });
    await host.start();
    host.machine.signIn(SUBJECT);
    host.bindSubject(SUBJECT);
    await host.touch();
    const before = w.seen.length;
    await host.set("theme", "P1-VALUE");
    // The token is the next person's before the debounce tick or the flush runs.
    now.current = "P2";
    await host.flush(1000);
    expect(
      w.seen.slice(before).some((r) => JSON.stringify(r).includes("P1-VALUE")),
    ).toBe(false);
    expect(w.seen.slice(before)).toEqual([]);
    await b.close();
  });

  it("account_required drops the ring and the record", async () => {
    const w = new World();
    const { host, ring, b } = await live(w);
    w.push = () =>
      new Response(JSON.stringify({ error: { code: "account_required" } }), {
        status: 403,
      });
    const events: SyncEvent[] = [];
    host.onEvents((e) => events.push(...e));
    await host.set("theme", "dark");
    await host.flush(1000);
    expect(ring.forget).toHaveBeenCalled();
    expect(ring.hasRoot()).toBe(false);
    expect(await b.store.get()).toBeNull();
    expect(events.some((e) => e.type === "signedOut")).toBe(true);
    await b.close();
  });

  it("a machine sign-out drops the ring and the record, the root first", async () => {
    const w = new World();
    const { host, ring, b } = await live(w);
    await host.set("theme", "dark");
    await host.flush(1000);
    host.machine.signOut();
    await host.touch();
    await host.flush(1000);
    expect(ring.forget).toHaveBeenCalledTimes(1);
    expect(await b.store.get()).toBeNull();
    await b.close();
  });

  it("a forget that fails is logged away and the record still goes", async () => {
    const w = new World();
    const log = vi.fn();
    const b = new Browser();
    const ring = await makeRing();
    ring.forget.mockRejectedValueOnce(new Error("pin"));
    const { host } = await b.tab(w, { ring, deps: { log } });
    await host.start();
    host.machine.signIn(SUBJECT);
    await host.set("theme", "dark");
    await host.flush(1000);
    host.machine.signOut();
    await host.touch();
    await host.flush(1000);
    expect(log).toHaveBeenCalled();
    expect(await b.store.get()).toBeNull();
    await b.close();
  });

  it("a purge that cannot delete reaches the caller; nothing held means nothing to fail", async () => {
    const stuck: SyncStateStore = {
      persistence: "durable",
      get: async () => "{}",
      put: async () => undefined,
      clear: async () => undefined,
    };
    await expect(removeSyncState(stuck)).rejects.toThrow(
      /could not be deleted/,
    );
    const absent: SyncStateStore = {
      ...memoryConnectState(),
      mayHold: async () => false,
      clear: async () => {
        throw new Error("must not touch an absent database");
      },
    };
    await expect(removeSyncState(absent)).resolves.toBeUndefined();
    await expect(
      removeSyncState(memoryConnectState()),
    ).resolves.toBeUndefined();
  });

  it("the lazy client purges the record without loading the host, and creates nothing when none exists", async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const idb = new IDBFactory();
    const g = globalThis as { indexedDB?: IDBFactory };
    const prior = g.indexedDB;
    g.indexedDB = idb;
    try {
      const load = vi.fn();
      const c = lazyCloudSync({
        load,
        enabled: () => true,
        dbName: "pkey-sync-x",
      });
      expect(c.status()).toEqual({ state: "local", pending: 0 });
      // Nothing was ever stored: no database is created to look.
      await c.purge();
      expect((await idb.databases()).map((d) => d.name)).toEqual([]);
      const { indexedDbConnectState } =
        await import("../src/browser/connect/state.js");
      const rec = indexedDbConnectState("pkey-sync-x", idb);
      await rec.put("{}");
      await c.purge();
      expect(await rec.get()).toBeNull();
      expect(load).not.toHaveBeenCalled();
    } finally {
      g.indexedDB = prior;
    }
  });

  it("a product without the Sync service answers the typed N/A", async () => {
    const c = lazyCloudSync({
      load: vi.fn(),
      enabled: () => false,
      dbName: "pkey-sync-x",
    });
    expect(() => c.status()).toThrow(UnsupportedError);
    await expect(c.flush()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(c.host()).rejects.toMatchObject({ reason: "product" });
  });
});

// ── Tabs ─────────────────────────────────────────────────────────────────────────────────────

describe("browser cloud sync host: one writer tab", () => {
  it("only the writer sends and writes; a follower follows the record and hears the change", async () => {
    const w = new World();
    const b = new Browser();
    const ring = await makeRing();
    const a = await b.tab(w, { ring });
    const f = await b.tab(w, { ring });
    await a.host.start();
    await f.host.start();
    expect(a.host.isWriter).toBe(true);
    expect(f.host.isWriter).toBe(false);
    a.host.machine.signIn(SUBJECT);
    await a.host.touch();
    const heard: SyncEvent[] = [];
    f.host.onEvents((e) => heard.push(...e));
    w.pull = () => w.body({ cursor: 1 });
    const before = w.reqs.length;
    await f.host.touch();
    expect(w.reqs.length).toBe(before);

    // The writer's edit (the ring is locked, so the journal keeps it): the follower hears
    // `change`, then follows the stored record.
    a.ring.lock();
    await a.host.set("theme", "dark");
    await a.host.flush(1000);
    await vi.waitFor(() =>
      expect(f.host.machine.get("theme").value).toBe("dark"),
    );
    expect(
      heard.some((e) => e.type === "change" && e.keys.includes("theme")),
    ).toBe(true);
    await b.close();
  });

  it("a follower's edit is handed to the writer, which applies and sends it", async () => {
    const w = new World();
    const b = new Browser();
    const ring = await makeRing();
    const a = await b.tab(w, { ring });
    const f = await b.tab(w, { ring });
    await a.host.start();
    await f.host.start();
    a.host.machine.signIn(SUBJECT);
    await a.host.touch();
    expect(await f.host.set("theme", "from-follower")).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(a.host.machine.get("theme").value).toBe("from-follower"),
    );
    await a.host.flush(1000);
    expect(w.reqs.some((r) => r.method === "POST")).toBe(true);
    await b.close();
  });

  it("when the writer's tab goes, the next tab re-reads the record and carries on from it", async () => {
    const w = new World();
    const b = new Browser();
    const ring = await makeRing();
    const a = await b.tab(w, { ring });
    const f = await b.tab(w, { ring });
    await a.host.start();
    await f.host.start();
    a.host.machine.signIn(SUBJECT);
    a.ring.lock();
    await a.host.set("theme", "dark");
    await a.host.flush(1000);
    const rev = (await record(b))!.rev;
    await a.host.close();
    await vi.waitFor(() => expect(f.host.isWriter).toBe(true));

    // It was built from the record the old writer left, not from its own older copy.
    await vi.waitFor(() =>
      expect(f.host.machine.get("theme").value).toBe("dark"),
    );
    await f.host.flush(1000);
    expect((await record(b))!.rev).toBeGreaterThanOrEqual(rev);
    await b.close();
  });

  it("never writes a lower state: a record with a higher rev is adopted, not replaced", async () => {
    const w = new World();
    const { host, b } = await live(w);
    await host.set("theme", "mine");
    await host.flush(1000);
    const cur = (await record(b))!;
    // Another writer got in (the lock failed us) and stored a higher state.
    await b.store.put(
      JSON.stringify({ ...cur, rev: cur.rev + 5, openKeys: ["from-other"] }),
    );
    await host.set("theme", "later");
    await host.flush(1000);
    const after = (await record(b))!;
    // Adopted, then written on top: never below the record that was there.
    expect(after.rev).toBeGreaterThanOrEqual(cur.rev + 5);
    expect(after.openKeys).toEqual(["from-other"]);
    await b.close();
  });

  it("a record purged in another tab is not written back by a writer that missed the message", async () => {
    const w = new World();
    const { host, b } = await live(w);
    await host.set("theme", "dark");
    await host.flush(1000);
    await b.store.clear();
    await host.set("theme", "again");
    await host.flush(1000);
    expect(await b.store.get()).toBeNull();
    await b.close();
  });

  it("a purge in one tab is followed by the others", async () => {
    const w = new World();
    const b = new Browser();
    const ring = await makeRing();
    const a = await b.tab(w, { ring });
    const f = await b.tab(w, { ring });
    await a.host.start();
    await f.host.start();
    a.host.machine.signIn(SUBJECT);
    a.ring.lock();
    await a.host.set("theme", "dark");
    await a.host.flush(1000);
    await vi.waitFor(() =>
      expect(f.host.machine.get("theme").value).toBe("dark"),
    );
    await f.host.purge();
    await vi.waitFor(() =>
      expect(a.host.machine.get("theme").value).not.toBe("dark"),
    );
    await a.host.flush(1000);
    expect(await b.store.get()).toBeNull();
    await b.close();
  });

  it("the election: the first tab writes, the second queues and is promoted on release", async () => {
    const locks = new FakeLocks();
    const promoted = vi.fn();
    const one = joinWriterElection(locks, "n", () => undefined);
    const two = joinWriterElection(locks, "n", promoted);
    expect(await one.decided).toBe(true);
    expect(await two.decided).toBe(false);
    expect(two.isWriter).toBe(false);
    one.release();
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));
    expect(two.isWriter).toBe(true);
    two.release();
    expect(two.isWriter).toBe(false);
  });

  it("tab messages are checked against a strict shape", () => {
    expect(parseTabMessage({ t: "state", rev: 3 })).toEqual({
      t: "state",
      rev: 3,
    });
    expect(parseTabMessage({ t: "state", rev: -1 })).toBeNull();
    expect(
      parseTabMessage({ t: "change", keys: ["a"], origin: "x" }),
    ).toBeNull();
    expect(
      parseTabMessage({ t: "change", keys: [1], origin: "local" }),
    ).toBeNull();
    expect(
      parseTabMessage({
        t: "edit",
        id: 1,
        op: "set",
        key: "bad key",
        value: 1,
      }),
    ).toBeNull();
    expect(
      parseTabMessage({ t: "edit", id: 1, op: "set", key: "a" }),
    ).toBeNull();
    expect(
      parseTabMessage({ t: "edit", id: 1, op: "set", key: "a", value: 1 }),
    ).toEqual({ t: "edit", id: 1, op: "set", key: "a", value: 1 });
    // An edit without an id cannot be confirmed: refused.
    expect(parseTabMessage({ t: "edit", op: "clear", key: "a" })).toBeNull();
    expect(
      parseTabMessage({ t: "edit", id: 2, op: "clear", key: "a" }),
    ).toEqual({ t: "edit", id: 2, op: "clear", key: "a" });
    expect(parseTabMessage({ t: "ack", id: 2 })).toEqual({ t: "ack", id: 2 });
    expect(parseTabMessage({ t: "ack", id: "2" })).toBeNull();
    expect(parseTabMessage("purge")).toBeNull();
    expect(parseTabMessage({ t: "nope" })).toBeNull();
  });

  it("a message with a forged shape does nothing", async () => {
    const w = new World();
    const { host, b } = await live(w);
    expect(host.isWriter).toBe(true);
    // A request to the host from the channel is parsed before it is used (writer.ts); the host's
    // own paths never see the malformed ones.
    expect(
      parseTabMessage({ t: "edit", id: 1, op: "set", key: "../x", value: 1 }),
    ).toBeNull();
    await b.close();
  });
});

// ── SEC-HOST2: purge races, promotion window, confirmable edits, the placeholder root ────────

describe("browser cloud sync host: SEC-HOST2 fixes", () => {
  it("B-1: a purge message during the writer's first pump is not written back by its save", async () => {
    const w = new World();
    const b = new Browser();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let started: () => void = () => undefined;
    const inFlight = new Promise<void>((r) => (started = r));
    const ring = await makeRing();
    const a = await b.tab(w, {
      ring,
      deps: {
        request: async (path, init) => {
          started();
          await gate;
          return w.request(path, init);
        },
      },
    });
    const f = await b.tab(w, { ring });
    await a.host.start();
    await f.host.start();
    a.host.machine.signIn(SUBJECT);
    const pump = a.host.touch();
    await inFlight;
    // The person signs out in the follower tab while the writer's first pull is in flight.
    await f.host.purge();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await pump;
    await a.host.flush(1000);
    expect(await b.store.get()).toBeNull();
    await b.close();
  });

  it("S5: a purge while a save is in flight leaves rev 0, and the next sign-in saves its own state", async () => {
    const w = new World();
    const b = new Browser();
    const slow = { on: false };
    const real = b.store.put.bind(b.store);
    b.store.put = async (t) => {
      if (slow.on) await new Promise((r) => setTimeout(r, 30));
      return real(t);
    };
    const { host } = await b.tab(w);
    await host.start();
    host.machine.signIn(SUBJECT);
    await host.set("theme", "one");
    await host.flush(1000);
    slow.on = true;
    const saving = host.flush(1000);
    await new Promise((r) => setTimeout(r, 5));
    await host.purge();
    await saving;
    expect(await b.store.get()).toBeNull();
    slow.on = false;
    host.resume();
    host.machine.signIn(SUBJECT);
    await host.set("theme", "two");
    await host.flush(1000);
    // Its own first save after the purge is a save, not a purge to follow.
    const rec = await record(b);
    expect(rec).not.toBeNull();
    expect(host.isWriter).toBe(true);
    await b.close();
  });

  it("S6: a purge from a tab where the host never ran tells the other tabs", async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const g = globalThis as { indexedDB?: IDBFactory };
    const prior = g.indexedDB;
    g.indexedDB = new IDBFactory();
    const heard: unknown[] = [];
    const listener = new BroadcastChannel("pkey-sync-x");
    listener.onmessage = (e) => heard.push(e.data);
    try {
      const c = lazyCloudSync({
        load: vi.fn(),
        enabled: () => true,
        dbName: "pkey-sync-x",
      });
      await c.purge();
      await vi.waitFor(() => expect(heard).toContainEqual({ t: "purge" }));
    } finally {
      listener.close();
      g.indexedDB = prior;
    }
  });

  it("S7: a tab just promoted is not the writer until it has read the record, and keeps an edit made meanwhile", async () => {
    const w = new World();
    const b = new Browser();
    const ring = await makeRing();
    const a = await b.tab(w, { ring });
    const f = await b.tab(w, { ring });
    await a.host.start();
    await f.host.start();
    a.host.machine.signIn(SUBJECT);
    ring.lock();
    await a.host.set("theme", "old");
    await a.host.flush(1000);
    // The promotion's read of the record is slow.
    const real = b.store.get.bind(b.store);
    let slow = true;
    b.store.get = async () => {
      if (slow) await new Promise((r) => setTimeout(r, 60));
      return real();
    };
    await a.host.close();
    await new Promise((r) => setTimeout(r, 15));
    expect(f.host.isWriter).toBe(false);
    await f.host.set("theme", "mine");
    slow = false;
    await vi.waitFor(() => expect(f.host.isWriter).toBe(true));
    // Read from the record (the old writer's state), then the kept edit on top of it.
    expect(f.host.machine.get("theme").value).toBe("mine");
    expect(f.host.machine.persist().partitions[SUBJECT]!.pending.length).toBe(
      2,
    );
    await b.close();
  });

  it("S7: a follower's edit is kept until the writer confirms it, and replayed if the follower is promoted", async () => {
    const w = new World();
    const b = new Browser();
    const ring = await makeRing();
    const a = await b.tab(w, { ring });
    const f = await b.tab(w, { ring });
    await a.host.start();
    await f.host.start();
    a.host.machine.signIn(SUBJECT);
    ring.lock();
    // The writer is deaf (frozen): its channel is closed, but it still holds the lock.
    b.hub.closeAll(a.host);
    await f.host.set("theme", "from-follower");
    await new Promise((r) => setTimeout(r, 10));
    expect(a.host.machine.get("theme").value).not.toBe("from-follower");
    await a.host.close();
    await vi.waitFor(() => expect(f.host.isWriter).toBe(true));
    expect(f.host.machine.get("theme").value).toBe("from-follower");
    await b.close();
  });

  it("S7: an edit the writer applies reaches its machine and is confirmed over the channel", async () => {
    const w = new World();
    const b = new Browser();
    const ring = await makeRing();
    const a = await b.tab(w, { ring });
    const f = await b.tab(w, { ring });
    await a.host.start();
    await f.host.start();
    a.host.machine.signIn(SUBJECT);
    ring.lock();
    await f.host.set("theme", "confirmed");
    await vi.waitFor(() =>
      expect(a.host.machine.get("theme").value).toBe("confirmed"),
    );
    await b.close();
  });

  it("S4: a copy of the placeholder root throws instead of deriving from zeros", async () => {
    const vault = memoryRootVault();
    await vault.put({
      v: 1,
      ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
      epoch: 1,
      kid: hexOf(await deriveKid(P, RAW)),
      key: await importRootHandle(RAW),
    });
    const rec = (await vault.get())!;
    const keys = ringKeysOf(rec, P);
    await keys.withRoot(async (p, root) => {
      const salt = new Uint8Array(32);
      const info = new TextEncoder().encode("x");
      // The sentinel itself runs on the handle.
      expect((await p.hkdf(root, salt, info, 32)).length).toBe(32);
      // A copy would run on 32 zero bytes: refused.
      await expect(
        p.hkdf(Uint8Array.from(root), salt, info, 32),
      ).rejects.toThrow(/placeholder root/);
      await expect(p.hkdf(root.slice(), salt, info, 32)).rejects.toThrow(
        /placeholder root/,
      );
      // A real 32-byte input is not the placeholder.
      expect((await p.hkdf(Uint8Array.from(RAW), salt, info, 32)).length).toBe(
        32,
      );
    });
  });
});

// ── pagehide ─────────────────────────────────────────────────────────────────────────────────

describe("browser cloud sync host: pagehide", () => {
  it("saves the journal and sends what is waiting with keepalive; pageshow lifts it", async () => {
    const w = new World();
    const b = new Browser();
    const page = new Page();
    const { host } = await b.tab(w, { page });
    await host.start();
    host.machine.signIn(SUBJECT);
    await host.touch();
    await host.set("theme", "dark");
    page.fire("pagehide");
    await vi.waitFor(() =>
      expect(w.reqs.some((r) => r.method === "POST" && r.keepalive)).toBe(true),
    );
    await vi.waitFor(async () => expect(await record(b)).not.toBeNull());
    page.fire("pageshow");
    w.seen = [];
    await host.set("theme", "light");
    await host.flush(1000);
    expect(w.reqs.filter((r) => r.keepalive)).toEqual([]);
    await b.close();
  });

  it("a follower does nothing on pagehide", async () => {
    const w = new World();
    const b = new Browser();
    const page = new Page();
    await (await b.tab(w)).host.start();
    const f = await b.tab(w, { page });
    await f.host.start();
    page.fire("pagehide");
    await new Promise((r) => setTimeout(r, 20));
    expect(w.reqs).toEqual([]);
    await b.close();
  });
});

// ── The transport and bounded bodies ─────────────────────────────────────────────────────────

describe("browser cloud sync host: transport and bounded bodies", () => {
  it("sends only to the machine's two sync routes", () => {
    expect(isSyncPath(PRODUCT, "/djdl/sync/ops")).toBe(true);
    expect(isSyncPath(PRODUCT, "/djdl/sync?cursor=3&limit=100")).toBe(true);
    expect(isSyncPath(PRODUCT, "/djdl/sync/../license")).toBe(false);
    expect(isSyncPath(PRODUCT, "/other/sync/ops")).toBe(false);
    expect(isSyncPath(PRODUCT, "/djdl/sync?x=<script>")).toBe(false);
    expect(isSyncPath(PRODUCT, "https://evil.test/djdl/sync/ops")).toBe(false);
  });

  const stream = (chunks: Uint8Array[], headers: Record<string, string> = {}) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const x of chunks) c.enqueue(x);
          c.close();
        },
      }),
      { headers },
    );

  it("counts bytes, not string length", async () => {
    const euro = new TextEncoder().encode("€€€€");
    expect(await readCappedText(stream([euro]), 12)).toBe("€".repeat(4));
    expect(await readCappedText(stream([euro]), 11)).toBeNull();
  });

  it("refuses on content-length without reading, and aborts a stream that outgrows its cap", async () => {
    const big = new Response("x", {
      headers: { "content-length": "999999999" },
    });
    expect(await readCappedText(big)).toBeNull();
    let pulled = 0;
    const endless = new Response(
      new ReadableStream({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(1024));
        },
      }),
    );
    expect(await readCappedText(endless, 4096)).toBeNull();
    expect(pulled).toBeLessThan(20);
  });

  it("an oversized answer is a transport failure: the cursor stays", async () => {
    const w = new World();
    w.pull = () =>
      new Response("{}", { headers: { "content-length": String(2 ** 30) } });
    const { host, b } = await live(w);
    expect(host.machine.persist().partitions[SUBJECT]?.cursor ?? 0).toBe(0);
    await b.close();
  });

  it("fetchCatalog answers null for an oversized catalog and for a streamed one past the cap", async () => {
    const fetchImpl = (async () =>
      new Response("{}", {
        headers: { "content-length": String(2 ** 30) },
      })) as typeof fetch;
    expect(
      await fetchCatalog({
        baseUrl: "https://k.test",
        product: PRODUCT,
        fetchImpl,
      }),
    ).toBeNull();
    const ok = (async () =>
      new Response(JSON.stringify(CATALOG(1)))) as typeof fetch;
    expect(
      await fetchCatalog({
        baseUrl: "https://k.test",
        product: PRODUCT,
        fetchImpl: ok,
      }),
    ).toMatchObject({ schemaVersion: 1 });
  });
});

// ── Unsupported where it cannot run (D-6) ────────────────────────────────────────────────────

describe("browser cloud sync host: the typed unsupported", () => {
  it("answers on the cookie shape, the desktop bridge and the local adapter, never a missing method", async () => {
    const cookie = unsupportedCloudSync("runtime", "cookie");
    expect(cookie.unsupported).toMatchObject({
      supported: false,
      feature: "sync.settings",
      reason: "runtime",
    });
    await expect(cookie.host()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(cookie.flush()).rejects.toBeInstanceOf(UnsupportedError);
    expect(() => cookie.status()).toThrow(UnsupportedError);
    await expect(cookie.purge()).resolves.toBeUndefined();

    const desktop = new DesktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
    });
    expect(desktop.cloudSync.unsupported).toMatchObject({
      feature: "sync.settings",
      reason: "version",
    });
    await expect(desktop.cloudSync.host()).rejects.toBeInstanceOf(
      UnsupportedError,
    );

    const local = new LocalAdapter({ productSlug: PRODUCT });
    expect(local.cloudSync.unsupported).toMatchObject({
      feature: "sync.settings",
      reason: "runtime",
    });
  });
});

// ── Isolation ────────────────────────────────────────────────────────────────────────────────

describe("browser cloud sync host: isolation", () => {
  const SRC = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "ui-core",
    "src",
    "browser",
    "sdk",
  );
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [join(dir, e.name)]
          : [],
    );

  it("the host loads only by dynamic import, and only the adapter asks for it", () => {
    const inCloudSync = `${SRC}/browser/cloudSync/`;
    const importers = sources(SRC)
      .filter((f) => !f.startsWith(inCloudSync))
      .filter((f) =>
        /["'][^"']*cloudSync\/(host|store|writer|transport)\.js["']/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => f.slice(SRC.length + 1));
    expect(importers).toEqual([
      "browser/browserAdapter.ts",
      "core/cloudSync.ts",
    ]);
    // Neither file takes a value from it statically.
    for (const f of importers) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src).not.toMatch(
        /^import (?!type)[^;]*from\s+["'][^"']*cloudSync\/(host|store|writer|transport)\.js["']/m,
      );
    }
  });
});
