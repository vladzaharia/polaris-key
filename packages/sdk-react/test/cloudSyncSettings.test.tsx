// @vitest-environment jsdom
//
// @pkey-feature sync.settings
//
// U-20.3: the React Cloud Sync settings API over the real browser host, in server mode (the key
// ring and its codec are tested in cloudSyncHost.test.ts): `config.set` routed through the machine
// while a person is signed in, `setting(key).sync()`, the `onConfigChange` origin, the one-time
// import with its own marker, the pre-sign-out flush, the sign-in offer after `account_required`,
// the tabs following each other's sign-in, and the hooks `useSetting` and `useCloudSync`.

import { browserAdapter } from "../src/browser/browserAdapter.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { JSONValue } from "@polaris-key/protocol/core";
import type { SyncEvent } from "@polaris-key/client-core/cloud-sync";
import {
  BrowserCloudSyncApi,
  clientOf,
  importMarker,
} from "../src/browser/cloudSync/api.js";
import { BrowserCloudSyncHost } from "../src/browser/cloudSync/host.js";
import { memoryConnectState } from "../src/browser/connect/state.js";
import type {
  TabChannel,
  TabMessage,
} from "../src/browser/cloudSync/writer.js";
import { safeSignInUrl } from "../src/browser/cloudSync/api.js";
import { sendSync } from "../src/browser/cloudSync/transport.js";
import { lazyCloudSync, unsupportedCloudSync } from "../src/core/cloudSync.js";
import {
  LocalConfigEngine,
  type ConfigChange,
} from "../src/core/localConfig.js";
import { initialState } from "../src/core/types.js";
import { servicesFromList } from "../src/core/index.js";
import { withOverrides } from "../src/core/adapter.js";
import { createStore } from "../src/core/store.js";
import { PolarisContext } from "../src/react/context.js";
import { useCloudSync, useSetting } from "../src/react/useCloudSync.js";
import type { PolarisAdapter } from "../src/core/index.js";

afterEach(cleanup);

const PRODUCT = "djdl";
const SUBJECT = "ps_aqofwJ_4zDBMy1_W857ARg";
const OTHER = "ps_bbbbbbbbbbbbbbbbbbbbbb";
const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "theme",
      kind: "config",
      category: "ui",
      label: "theme",
      description: "theme",
      schema: { type: "string" },
      user: { sync: "user", conflict: "lastWrite" },
    },
  ],
};
type Body = Record<string, unknown>;

class World {
  pushes: Body[] = [];
  /** The token each request carried, and its body. */
  tokens: Array<{ token: string; body: string }> = [];
  version = 100;
  pull: () => Body = () => this.body();
  push: (b: Body) => Response | Body = (b) => ({
    results: (b.mutations as Array<{ mutationId: number }>).map((m) => ({
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
      usage: { files: 0, records: 0, settings: 0, bytes: 0 },
      quota: { files: true, bytes: 2 ** 28 },
      encryption: "server",
      encryptionSince: 1,
      changes: [],
      tombstones: [],
      ...over,
    };
  }
  request = async (
    path: string,
    init: { method: string; body?: string },
  ): Promise<Response> => {
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s });
    const wrap = (r: Response | Body) => (r instanceof Response ? r : json(r));
    if (path.startsWith("sync/ops") && init.method === "POST") {
      const body = JSON.parse(init.body!) as Body;
      this.pushes.push(body);
      return wrap(this.push(body));
    }
    if (path.startsWith("sync") && init.method === "GET")
      return wrap(this.pull());
    return json({}, 404);
  };
}

class Locks {
  private held = new Set<string>();
  private queues = new Map<string, Array<() => void>>();
  request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    const opts = (typeof a === "function" ? {} : a) as {
      ifAvailable?: boolean;
    };
    const fn = (typeof a === "function" ? a : b) as (
      l: unknown,
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
      else if (opts.ifAvailable)
        Promise.resolve(fn(null)).then(resolve, reject);
      else {
        const q = this.queues.get(name) ?? [];
        q.push(() => void run());
        this.queues.set(name, q);
      }
    });
  }
}

class Hub {
  private members = new Set<{ deliver: (m: TabMessage) => void }>();
  channel(): TabChannel {
    const handlers: Array<(m: TabMessage) => void> = [];
    const me = { deliver: (m: TabMessage) => handlers.forEach((h) => h(m)) };
    this.members.add(me);
    return {
      post: (m) => {
        const copy = structuredClone(m);
        for (const o of this.members)
          if (o !== me) setTimeout(() => o.deliver(copy), 0);
      },
      onMessage: (fn) => void handlers.push(fn),
      close: () => void this.members.delete(me),
    };
  }
}

/** What the tabs of one browser share. */
class Browser {
  locks = new Locks();
  hub = new Hub();
  store = memoryConnectState();
  marker = new Map<string, string>();
  tabs: Array<{ host: BrowserCloudSyncHost }> = [];
}

/** One tab: the real host and API under a real config engine. `who` is the session's person. */
async function tab(
  w: World,
  b: Browser,
  who: { current: string | null | undefined; token?: string },
  seed: Record<string, JSONValue> = {},
) {
  const ring = {
    hasRoot: () => false,
    subscribe: () => () => undefined,
    codec: () => null,
    forget: vi.fn(async () => undefined),
  };
  const log = vi.fn();
  const host = new BrowserCloudSyncHost(
    {
      product: PRODUCT,
      request: (path, init) => {
        w.tokens.push({ token: who.token ?? "P1", body: init.body ?? "" });
        return w.request(path, init);
      },
      ring,
      discovery: () => null,
      fetchSchema: async () => CATALOG as never,
      document: () => ({ values: {} }),
      enabled: () => true,
      store: b.store,
      locks: b.locks,
      writerLock: "w",
      stateLock: "s",
      channel: b.hub.channel(),
      log,
    },
    { catalog: CATALOG as never, encryption: "server" },
  );
  const store = createStore(
    initialState("browser", servicesFromList(["config", "sync"]), seed),
  );
  let persisted = { ...seed };
  const config = new LocalConfigEngine({
    backend: {
      read: () => persisted,
      write: async (next) => {
        persisted = next;
      },
      persistent: () => true,
    },
    hostOverrides: {},
    snapshot: () => store.get(),
    subscribe: (cb) => store.subscribe(cb),
    applyOverrides: (m) => store.set((s) => withOverrides(s, m)),
    fetchSchema: async () => null,
    catalog: null,
  });
  const marker = importMarker("m", {
    getItem: (k) => b.marker.get(k) ?? null,
    setItem: (k, v) => void b.marker.set(k, v),
  });
  const api = new BrowserCloudSyncApi({
    host,
    keyring: ring,
    config,
    subject: async () => who.current,
    marker,
    log,
    signInOrigin: "https://k.test",
  });
  const events: SyncEvent[] = [];
  api.onEvents((e) => events.push(...e));
  const changes: ConfigChange[] = [];
  config.onConfigChange("*", (c) => changes.push(c));
  b.tabs.push({ host });
  return { host, api, config, ring, events, changes, log, store };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("config through the machine", () => {
  it("routes set through Cloud Sync once a person is signed in, with the origin and the sync state", async () => {
    const w = new World();
    const who = { current: SUBJECT as string | null | undefined };
    const t = await tab(w, new Browser(), who);
    expect(t.config.setting("theme").sync()).toBe("local");
    await t.api.attach();
    expect(t.config.setting("theme").sync()).toBe("synced");
    await t.config.set("theme", "dark");
    expect(t.config.setting("theme").get("x")).toBe("dark");
    expect(t.config.setting("theme").sync()).toBe("pending");
    expect(t.changes.map((c) => [c.key, c.origin])).toEqual([
      ["theme", "local"],
    ]);
    await t.api.flush();
    expect(t.config.setting("theme").sync()).toBe("synced");
    expect(w.pushes).toHaveLength(1);
    // A second report for the same value never comes.
    expect(t.changes).toHaveLength(1);
    await t.host.close();
  });

  it("reports a pulled value as a remote change and clears it again on sign-out", async () => {
    const w = new World();
    w.pull = () =>
      w.body({
        cursor: 3,
        changes: [
          {
            setting: "theme",
            scope: "user",
            version: 3,
            editedHlc: "0199c82cc000:0000",
            updatedBy: "c_AAAAAAAAAAAAAAAAAAAAAA",
            value: "from-cloud",
          },
        ],
      });
    const who = { current: SUBJECT as string | null | undefined };
    const t = await tab(w, new Browser(), who);
    await t.api.attach();
    expect(t.config.setting("theme").get("x")).toBe("from-cloud");
    expect(t.changes.at(-1)).toMatchObject({ key: "theme", origin: "remote" });
    await t.api.beforeSignOut();
    expect(t.config.setting("theme").get("x")).toBe("x");
    expect(t.config.setting("theme").sync()).toBe("local");
    await t.host.close();
  });

  it("refuses what the machine refuses, in Node's codes", async () => {
    const w = new World();
    const t = await tab(w, new Browser(), { current: SUBJECT });
    await t.api.attach();
    await expect(t.config.set("theme", 5 as never)).rejects.toMatchObject({
      code: "bad_request",
    });
    await t.host.close();
  });
});

describe("the identity wiring", () => {
  it("offers the device-local values once per install, even after a purge", async () => {
    const w = new World();
    const b = new Browser();
    const who = { current: SUBJECT as string | null | undefined };
    const t = await tab(w, b, who, { theme: "legacy" });
    await t.api.attach();
    await t.api.flush();
    expect(JSON.stringify(w.pushes)).toContain("legacy");
    const first = w.pushes.length;
    // Sign out (purge resets the machine's own flag), then another person signs in.
    await t.api.beforeSignOut();
    await t.api.identity({ kind: "signedIn", subject: OTHER });
    await t.api.flush();
    expect(w.pushes.length).toBe(first);
    expect(b.marker.get("m")).toBe("1");
    await t.host.close();
  });

  it("an unreadable subject is not a sign-out", async () => {
    const w = new World();
    const b = new Browser();
    const who = { current: SUBJECT as string | null | undefined };
    const t = await tab(w, b, who);
    await t.api.attach();
    await t.config.set("theme", "dark");

    who.current = undefined;
    await t.api.identity({ kind: "signedIn", subject: SUBJECT });
    await t.host.close();
    const again = await tab(w, b, who);
    await again.api.attach();
    expect(again.config.setting("theme").get("x")).toBe("dark");
    expect(again.ring.forget).not.toHaveBeenCalled();
    await again.host.close();
  });

  it("sends what is waiting before it signs out, then forgets the ring and the record", async () => {
    const w = new World();
    const b = new Browser();
    const t = await tab(w, b, { current: SUBJECT });
    await t.api.attach();
    await t.config.set("theme", "dark");
    expect(w.pushes).toHaveLength(0);
    await t.api.beforeSignOut();
    expect(w.pushes).toHaveLength(1);
    expect(t.ring.forget).toHaveBeenCalled();
    expect(await b.store.get()).toBeNull();
    expect(t.api.status().state).toBe("local");
    await t.host.close();
  });

  it("account_required forgets first, then offers the sign-in", async () => {
    const w = new World();
    const b = new Browser();
    const t = await tab(w, b, { current: SUBJECT });
    await t.api.attach();
    w.push = () =>
      new Response(
        JSON.stringify({
          error: { code: "account_required", signInUrl: "https://k.test/in" },
        }),
        { status: 403 },
      );
    await t.config.set("theme", "dark");
    await t.api.flush();
    expect(t.ring.forget).toHaveBeenCalled();
    expect(await b.store.get()).toBeNull();
    const kinds = t.events.map((e) => e.type);
    expect(kinds.indexOf("signedOut")).toBeLessThan(
      kinds.indexOf("signInOffered"),
    );
    expect(t.events.find((e) => e.type === "signInOffered")).toEqual({
      type: "signInOffered",
      signInUrl: "https://k.test/in",
    });
    await t.host.close();
  });

  it("never puts a value in an event or a log line", async () => {
    const w = new World();
    const t = await tab(w, new Browser(), { current: SUBJECT });
    await t.api.attach();
    await t.config.set("theme", "SECRET-VALUE");
    await t.api.flush();
    await t.api.beforeSignOut();
    expect(JSON.stringify(t.events)).not.toContain("SECRET-VALUE");
    expect(JSON.stringify(t.log.mock.calls)).not.toContain("SECRET-VALUE");
    await t.host.close();
  });

  it("another tab's sign-in reaches the writer through the principal message", async () => {
    const w = new World();
    const b = new Browser();
    const who = { current: null as string | null | undefined };
    const writer = await tab(w, b, who);
    await writer.api.attach();
    expect(writer.config.setting("theme").sync()).toBe("local");
    const follower = await tab(w, b, who);
    await follower.api.attach();
    who.current = SUBJECT;
    await follower.api.identity({ kind: "signedIn", subject: SUBJECT });
    await settle();
    await settle();
    expect(writer.api.status().state).not.toBe("local");
    expect(writer.config.setting("theme").sync()).toBe("synced");
    await writer.host.close();
    await follower.host.close();
  });
});

describe("SEC-HOST3", () => {
  it("B-1: an offline boot (no discovery) is not a sign-out", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      auth: "bearer",
      autoStart: false,
      trust: { pinnedKeys: {} },
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    const syncSubject = (
      adapter as unknown as { syncSubject(): Promise<unknown> }
    ).syncSubject;
    const owner = { bearer: { hasToken: true }, discovery_: null };
    expect(await syncSubject.call(owner)).toBeUndefined();
    // A discovery with no account endpoint is a real "no account".
    expect(
      await syncSubject.call({ ...owner, discovery_: { product: "acme" } }),
    ).toBeNull();
  });

  it("B-2: a change of person never sends the first person's edits under the new token", async () => {
    const w = new World();
    const b = new Browser();
    const who = {
      current: SUBJECT as string | null | undefined,
      token: "P1",
    };
    const t = await tab(w, b, who);
    await t.api.attach();
    await t.config.set("theme", "P1-VALUE");
    expect(t.config.setting("theme").get("x")).toBe("P1-VALUE");
    const before = w.tokens.length;
    // The session now holds the second person's token.
    who.token = "P2";
    who.current = OTHER;
    const switching = t.api.identity({ kind: "signedIn", subject: OTHER });
    await switching;
    const sent = w.tokens.slice(before).filter((r) => r.token === "P2");
    expect(sent.some((r) => r.body.includes("P1-VALUE"))).toBe(false);
    expect(w.pushes.some((p) => JSON.stringify(p).includes("P1-VALUE"))).toBe(
      false,
    );
    // The new person reads none of the first person's values, and the old ring is gone.
    expect(t.config.setting("theme").get("x")).toBe("x");
    expect(t.ring.forget).toHaveBeenCalled();
    await t.host.close();
  });

  it("S-3: a follower whose record another tab purged follows, and signs in again", async () => {
    const w = new World();
    const b = new Browser();
    const who = { current: SUBJECT as string | null | undefined };
    const writer = await tab(w, b, who);
    await writer.api.attach();
    const follower = await tab(w, b, who);
    await follower.api.attach();
    await writer.host.purge();
    await settle();
    await settle();
    who.current = null;
    await follower.api.identity({ kind: "signedOut" });
    who.current = SUBJECT;
    await follower.api.identity({ kind: "signedIn", subject: SUBJECT });
    expect(follower.host.machine.persist().subject).toBe(SUBJECT);
    await writer.host.close();
    await follower.host.close();
  });

  it("S-4: a sign-in URL is a path or https on the Worker's origin, else null", () => {
    const o = "https://k.test";
    expect(safeSignInUrl("javascript:alert(1)", o)).toBeNull();
    expect(safeSignInUrl("data:text/html,x", o)).toBeNull();
    expect(safeSignInUrl("https://evil.test/in", o)).toBeNull();
    expect(safeSignInUrl("http://k.test/in", o)).toBeNull();
    expect(safeSignInUrl("//evil.test/in", o)).toBeNull();
    expect(safeSignInUrl("https://k.test/in", o)).toBe("https://k.test/in");
    expect(safeSignInUrl("/signin", o)).toBe("/signin");
    expect(safeSignInUrl(null, o)).toBeNull();
  });

  it("S-4: a hostile signInUrl never reaches the app", async () => {
    const w = new World();
    const t = await tab(w, new Browser(), { current: SUBJECT });
    await t.api.attach();
    w.push = () =>
      new Response(
        JSON.stringify({
          error: { code: "account_required", signInUrl: "javascript:alert(1)" },
        }),
        { status: 403 },
      );
    await t.config.set("theme", "dark");
    await t.api.flush();
    expect(t.events.find((e) => e.type === "signInOffered")).toEqual({
      type: "signInOffered",
      signInUrl: null,
    });
    await t.host.close();
  });

  it("N-1: a voluntary sign-out is not an offer", async () => {
    const w = new World();
    const t = await tab(w, new Browser(), { current: SUBJECT });
    await t.api.attach();
    await t.api.beforeSignOut();
    await settle();
    expect(t.events.some((e) => e.type === "signInOffered")).toBe(false);
    await t.host.close();
  });

  it("S-2: a request that never answers is no answer, and a purge does not wait for it", async () => {
    const hung = () => new Promise<Response>(() => undefined);
    const res = await sendSync(
      "djdl",
      hung,
      { method: "GET", path: "/djdl/sync?cursor=0" },
      false,
      20,
    );
    expect(res).toEqual({ error: "transport" });
  });

  it("S-1: a signed-out note loads nothing where Cloud Sync never ran", async () => {
    const load = vi.fn();
    const c = lazyCloudSync({ enabled: () => true, dbName: "x", load });
    await c.identity({ kind: "signedOut" });
    expect(load).not.toHaveBeenCalled();
  });
});

describe("the lazy client", () => {
  it("loads nothing for beforeSignOut, and answers the typed N/A elsewhere", async () => {
    const load = vi.fn();
    const c = lazyCloudSync({ enabled: () => true, dbName: "x", load });
    await c.beforeSignOut();
    expect(load).not.toHaveBeenCalled();
    const u = unsupportedCloudSync("runtime", "no");
    await expect(u.attach()).resolves.toBeUndefined();
    expect(() => u.status()).toThrow();
  });

  it("forwards status changes from the loaded client", async () => {
    const w = new World();
    const t = await tab(w, new Browser(), { current: SUBJECT });
    const client = clientOf(t.api, t.host);
    const lazy = lazyCloudSync({
      enabled: () => true,
      dbName: "x",
      load: async () => client,
    });
    const seen = vi.fn();
    lazy.onStatus(seen);
    await lazy.attach();
    await t.config.set("theme", "dark");
    await lazy.flush();
    expect(seen).toHaveBeenCalled();
    await t.host.close();
  });
});

describe("useSetting and useCloudSync", () => {
  it("follows the setting's sync state and the status, and surfaces the offer", async () => {
    const w = new World();
    const b = new Browser();
    const t = await tab(w, b, { current: SUBJECT });
    const client = clientOf(t.api, t.host);
    const adapter = {
      cloudSync: client,
      config: t.config,
      getConfigSource: () => "local",
      state: () => t.store.get(),
      subscribe: (cb: () => void) => t.store.subscribe(cb),
      getState: () => t.store.get(),
    } as unknown as PolarisAdapter;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PolarisContext.Provider value={{ adapter }}>
        {children}
      </PolarisContext.Provider>
    );
    const sync = renderHook(() => useCloudSync(), { wrapper });
    expect(sync.result.current.status.state).toBe("local");
    await act(async () => {
      await client.attach();
    });
    await waitFor(() => expect(sync.result.current.status.state).toBe("idle"));
    await act(async () => {
      await t.config.set("theme", "dark");
    });
    expect(t.config.setting("theme").sync()).toBe("pending");
    await act(async () => {
      await sync.result.current.flush();
    });
    expect(t.config.setting("theme").sync()).toBe("synced");
    w.push = () =>
      new Response(JSON.stringify({ error: { code: "account_required" } }), {
        status: 403,
      });
    await act(async () => {
      await t.config.set("theme", "light");
      await sync.result.current.flush();
    });
    await waitFor(() =>
      expect(sync.result.current.offer).toEqual({ signInUrl: null }),
    );
    act(() => sync.result.current.dismissOffer());
    expect(sync.result.current.offer).toBeNull();
    expect(typeof useSetting).toBe("function");
    await t.host.close();
  });

  it("every setting stays local where Cloud Sync cannot run", async () => {
    const c = unsupportedCloudSync("runtime", "cookie page");
    const adapter = { cloudSync: c } as unknown as PolarisAdapter;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PolarisContext.Provider value={{ adapter }}>
        {children}
      </PolarisContext.Provider>
    );
    const { result } = renderHook(() => useCloudSync(), { wrapper });
    expect(result.current.unsupported).toMatchObject({ reason: "runtime" });
    expect(result.current.status).toEqual({ state: "local", pending: 0 });
  });
});
