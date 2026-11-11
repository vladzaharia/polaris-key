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
import type { CloudSyncEvent } from "../src/core/cloudSync.js";
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
import { IDBFactory } from "fake-indexeddb";
import {
  filesDbName,
  purgeFilesLayer,
} from "../src/browser/cloudSync/filesPurge.js";
import {
  accountRequiredUrl,
  watchingAccountRequired,
  workerOnly,
} from "../src/browser/cloudSync/accountRequired.js";
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
import { Hub, Locks, SUBJECT, World, type Body } from "./cloudSyncWorld.js";

afterEach(cleanup);

const PRODUCT = "djdl";
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
  hostOver: Partial<ConstructorParameters<typeof BrowserCloudSyncHost>[0]> = {},
) {
  const ring = {
    hasRoot: () => false,
    subscribe: () => () => undefined,
    codec: () => null,
    forget: vi.fn(async (): Promise<void> => undefined),
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
      ...hostOver,
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
  const events: CloudSyncEvent[] = [];
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
    // The record stays, blocked and without the person's data (the `account_required` describe).
    expect(t.api.status().state).toBe("blocked");
    expect(await b.store.get()).not.toBeNull();
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
    expect(safeSignInUrl("/signin", o)).toBe("https://k.test/signin");
    expect(safeSignInUrl(null, o)).toBeNull();
    expect(safeSignInUrl("/in", undefined)).toBeNull();
  });

  it("R-1: control characters never turn a path into another host", () => {
    const o = "https://k.test";
    for (const bad of [
      "/\t/evil.test",
      "/\n/evil.test",
      "/\r/evil.test",
      "/ /evil.test",
      "/\u0000/evil.test",
      "\t//evil.test",
      "/a\u0085b",
    ])
      expect(safeSignInUrl(bad, o)).toBeNull();
  });

  it("S-3: a follower whose record another tab purged signs in again without an identity note", async () => {
    const w = new World();
    const b = new Browser();
    const who = { current: SUBJECT as string | null | undefined };
    const writer = await tab(w, b, who);
    await writer.api.attach();
    const follower = await tab(w, b, who);
    await follower.api.attach();
    expect(follower.host.machine.persist().subject).toBe(SUBJECT);
    // The person is unchanged: only the purge message tells the follower its record went.
    await writer.host.purge();
    await settle();
    await settle();
    expect(follower.host.machine.persist().subject).toBe(SUBJECT);
    expect(follower.api.status().state).not.toBe("local");
    await writer.host.close();
    await follower.host.close();
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
    const client = clientOf(
      t.api,
      t.host,
      unsupportedCloudSync("runtime", "test").saves,
    );
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
    const client = clientOf(
      t.api,
      t.host,
      unsupportedCloudSync("runtime", "test").saves,
    );
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

describe("account_required (U-52)", () => {
  /** A writer tab and a follower tab of one browser, both signed in. */
  const tabPair = async () => {
    const w = new World();
    const b = new Browser();
    const who = { current: SUBJECT as string | null | undefined };
    const writer = await tab(w, b, who);
    const follower = await tab(w, b, who);
    await Promise.all([writer.api.attach(), follower.api.attach()]);
    return { writer, follower };
  };
  const refusal = (signInUrl?: string) =>
    new Response(
      JSON.stringify({
        error: {
          code: "account_required",
          ...(signInUrl !== undefined ? { signInUrl } : {}),
        },
      }),
      { status: 403 },
    );
  const refused = async (
    w: World,
    b: Browser,
    url?: string,
    hostOver: Parameters<typeof tab>[4] = {},
  ) => {
    const who = { current: SUBJECT as string | null | undefined };
    const t = await tab(w, b, who, {}, hostOver);
    await t.api.attach();
    w.push = () => refusal(url);
    await t.config.set("theme", "dark");
    await t.api.flush();
    return { t, who };
  };
  const requests = (w: World) => w.tokens.length;
  /** The tabs hear each other, then the writer is not blocked; both close. */
  const writerSettles = async (
    writer: Awaited<ReturnType<typeof tabPair>>["writer"],
    follower: Awaited<ReturnType<typeof tabPair>>["follower"],
  ) => {
    await settle();
    await settle();
    expect(writer.api.status().state).not.toBe("blocked");
    await writer.host.close();
    await follower.host.close();
  };

  it("keeps the record without the person's partition, root or open names, and relaunches blocked", async () => {
    const w = new World();
    const b = new Browser();
    const { t } = await refused(w, b);
    expect(t.api.status()).toMatchObject({
      state: "blocked",
      reason: "account_required",
    });
    const raw = await b.store.get();
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw!);
    expect(saved.persisted.blocked).toBe("account_required");
    expect(saved.persisted.subject).toBeNull();
    expect(saved.openKeys).toEqual([]);
    expect(Object.keys(saved.persisted.partitions)).not.toContain(SUBJECT);
    expect(JSON.stringify(saved)).not.toContain('"dark"');
    expect(saved.refused).toBe(SUBJECT);
    await t.host.close();

    // A relaunch: the session still names the refused subject, and nothing is sent.
    const before = requests(w);
    const again = await tab(w, b, { current: SUBJECT });
    await again.api.attach();
    await again.api.flush();
    expect(again.api.status().state).toBe("blocked");
    expect(requests(w)).toBe(before);
    // An edit made while blocked is the device's own and goes nowhere.
    await again.config.set("theme", "light");
    await again.api.flush();
    expect(requests(w)).toBe(before);
    expect(again.config.setting("theme").get("none")).toBe("light");
    await again.host.close();
  });

  it("a different subject lifts it, and a sign-out forgets the refusal", async () => {
    const w = new World();
    const b = new Browser();
    const { t } = await refused(w, b);
    await t.host.close();

    const other = await tab(w, b, { current: OTHER });
    await other.api.attach();
    expect(other.api.status().state).not.toBe("blocked");
    await other.host.close();

    // The refusal survived that tab's sign-in of another person? No: sign-in cleared it. Start again.
    const w2 = new World();
    const b2 = new Browser();
    const first = await refused(w2, b2);
    await first.t.host.close();
    const who = { current: SUBJECT as string | null | undefined };
    const again = await tab(w2, b2, who);
    await again.api.attach();
    expect(again.api.status().state).toBe("blocked");
    await again.api.identity({ kind: "signedOut" });
    const before = requests(w2);
    await again.api.identity({ kind: "signedIn", subject: SUBJECT });
    expect(requests(w2)).toBeGreaterThan(before);
    expect(again.api.status().state).not.toBe("blocked");
    await again.host.close();
  });

  it("a key-ring or file route reaches the machine through accountRequired()", async () => {
    const w = new World();
    const t = await tab(w, new Browser(), { current: SUBJECT });
    await t.api.attach();
    await t.config.set("theme", "dark");
    await t.api.accountRequired("https://k.test/in", SUBJECT);
    expect(t.api.status().state).toBe("blocked");
    expect(t.ring.forget).toHaveBeenCalled();
    expect(t.events.find((e) => e.type === "signInOffered")).toEqual({
      type: "signInOffered",
      signInUrl: "https://k.test/in",
    });
    // Idempotent: a second answer changes nothing and offers nothing more.
    const offers = t.events.filter((e) => e.type === "signInOffered").length;
    await t.api.accountRequired("https://k.test/in", SUBJECT);
    expect(t.events.filter((e) => e.type === "signInOffered").length).toBe(
      offers,
    );
    await t.host.close();
  });

  it("with no person signed in it does nothing", async () => {
    const t = await tab(new World(), new Browser(), { current: null });
    await t.api.attach();
    await t.api.accountRequired(null, null);
    expect(t.api.status().state).toBe("local");
    expect(t.events).toEqual([]);
    await t.host.close();
  });

  it("a follower tab hands the answer to the writer", async () => {
    const { writer, follower } = await tabPair();
    await follower.api.accountRequired(null, SUBJECT);
    await settle();
    await settle();
    expect(writer.api.status().state).toBe("blocked");
    await writer.host.close();
    await follower.host.close();
  });

  it("a sign-in the person completes in this run lifts the refusal; the replayed session does not", async () => {
    const w = new World();
    const b = new Browser();
    const first = await refused(w, b);
    await first.t.host.close();
    const again = await tab(w, b, { current: SUBJECT });
    await again.api.attach();
    expect(again.api.status().state).toBe("blocked");
    const before = requests(w);
    await again.api.identity({ kind: "signedIn", subject: SUBJECT });
    expect(requests(w)).toBeGreaterThan(before);
    expect(again.api.status().state).not.toBe("blocked");
    await again.host.close();
  });

  it("a sign-in completed in another tab lifts the writer's refusal", async () => {
    const { writer, follower } = await tabPair();
    await writer.api.accountRequired(null, SUBJECT);
    expect(writer.api.status().state).toBe("blocked");
    await follower.api.identity({ kind: "signedIn", subject: SUBJECT });
    await writerSettles(writer, follower);
  });

  it("a pin that could not be removed is saved, retried at start, and holds the sign-in", async () => {
    const w = new World();
    const b = new Browser();
    const who = { current: SUBJECT as string | null | undefined };
    const first = await tab(w, b, who);
    await first.api.attach();
    first.ring.forget.mockRejectedValue(new Error("stuck"));
    w.push = () => refusal();
    await first.config.set("theme", "dark");
    await first.api.flush();
    expect(first.api.status().state).toBe("blocked");
    expect(JSON.parse((await b.store.get())!)).toMatchObject({
      forgetPending: true,
      refused: SUBJECT,
    });
    expect(first.log).toHaveBeenCalledWith(
      "cloud sync: the key ring pin could not be removed",
    );
    await first.host.close();

    // Relaunch, the pin still stuck: the person's sign-in waits.
    const again = await tab(w, b, { current: SUBJECT });
    again.ring.forget.mockRejectedValue(new Error("stuck"));
    await again.api.attach();
    expect(again.ring.forget).toHaveBeenCalled();
    const before = requests(w);
    await again.api.identity({ kind: "signedIn", subject: SUBJECT });
    expect(again.api.status().state).toBe("blocked");
    expect(requests(w)).toBe(before);
    expect(JSON.parse((await b.store.get())!).forgetPending).toBe(true);

    // The pin goes: the next sign-in is accepted and the flag is cleared.
    again.ring.forget.mockResolvedValue(undefined);
    await again.api.identity({ kind: "signedIn", subject: SUBJECT });
    expect(again.api.status().state).not.toBe("blocked");
    expect(JSON.parse((await b.store.get())!).forgetPending).toBe(false);
    await again.host.close();
  });

  it("a pin that goes at once leaves no pending flag", async () => {
    const w = new World();
    const b = new Browser();
    const { t } = await refused(w, b);
    expect(JSON.parse((await b.store.get())!).forgetPending).toBe(false);
    await t.host.close();
  });

  it("a record that cannot be rewritten is removed and the refusal is held in memory", async () => {
    const w = new World();
    const b = new Browser();
    const failing = { on: false };
    const store = {
      ...b.store,
      put: async (text: string) => {
        if (failing.on) throw new Error("quota");
        return b.store.put(text);
      },
    };
    const who = { current: SUBJECT as string | null | undefined };
    const t = await tab(w, b, who, {}, { store });
    await t.api.attach();
    await t.config.set("theme", "dark");
    await t.api.flush();
    expect(await b.store.get()).not.toBeNull();
    failing.on = true;
    w.push = () => refusal();
    await t.config.set("theme", "light");
    await t.api.flush();
    expect(t.api.status().state).toBe("blocked");
    expect(await b.store.get()).toBeNull();
    expect(t.host.refused).toBe(SUBJECT);
    await t.host.close();
  });

  it("blocking deletes the files database even when the saves layer was never built", async () => {
    const idb = new IDBFactory();
    const name = filesDbName("pkey-sync-test");
    await new Promise<void>((done, fail) => {
      const r = idb.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("chunks");
      r.onsuccess = () => {
        r.result.close();
        done();
      };
      r.onerror = () => fail(r.error);
    });
    const has = async () =>
      (await idb.databases()).some((d) => d.name === name);
    expect(await has()).toBe(true);
    const w = new World();
    const b = new Browser();
    const { t } = await refused(w, b, undefined, {
      onPurge: () => purgeFilesLayer(null, "pkey-sync-test", idb),
    });
    expect(t.api.status().state).toBe("blocked");
    expect(await has()).toBe(false);
    await t.host.close();
  });

  it("a built saves layer is closed, and the database is left to it", async () => {
    const idb = new IDBFactory();
    const name = filesDbName("pkey-sync-test");
    await new Promise<void>((done) => {
      const r = idb.open(name, 1);
      r.onsuccess = () => {
        r.result.close();
        done();
      };
    });
    const purge = vi.fn(async () => undefined);
    await purgeFilesLayer({ purge, built: () => true }, "pkey-sync-test", idb);
    expect(purge).toHaveBeenCalled();
    expect((await idb.databases()).some((d) => d.name === name)).toBe(true);
  });

  it("a late answer for the person who has gone does not block the new one", async () => {
    const t = await tab(new World(), new Browser(), { current: SUBJECT });
    await t.api.attach();
    await t.api.identity({ kind: "signedOut" });
    await t.api.identity({ kind: "signedIn", subject: OTHER });
    await t.api.accountRequired("https://k.test/in", SUBJECT);
    expect(t.api.status().state).not.toBe("blocked");
    expect(
      t.events.find(
        (e) => e.type === "signedOut" && e.reason === "accountRequired",
      ),
    ).toBeUndefined();
    await t.host.close();
  });

  it("a follower's hand-off is ignored by a writer that holds another person", async () => {
    const { writer, follower } = await tabPair();
    await writer.api.identity({ kind: "signedIn", subject: OTHER });
    follower.host.accountRequired(null, SUBJECT);
    await writerSettles(writer, follower);
  });

  /** A watched route answered by `answer`; `told` hears each `account_required` URL. */
  const watched = (answer: () => Response, told: unknown[]) =>
    watchingAccountRequired(
      async (_p: string) => answer(),
      (u) => told.push(u),
      { origin: "https://k.test", subject: () => SUBJECT },
    );

  /** `res` as if it had been fetched from `url` after `redirected` redirects. */
  const fetchedFrom = (res: Response, url: string, redirected = false) => {
    Object.defineProperty(res, "url", { value: url });
    Object.defineProperty(res, "redirected", { value: redirected });
    return res;
  };

  describe("counts only from the Worker's own origin", () => {
    const foreign = () =>
      fetchedFrom(refusal("https://k.test/in"), "https://evil.test/r");
    const redirected = () =>
      fetchedFrom(refusal("https://k.test/in"), "https://k.test/r", true);

    it("a 403 from another origin or after a redirect loses its body", async () => {
      for (const make of [foreign, redirected]) {
        const res = await workerOnly(
          async (_p: string) => make(),
          "https://k.test",
        )("x");
        expect(res.status).toBe(403);
        expect(await res.text()).toBe("");
      }
      const own = await workerOnly(
        async (_p: string) => fetchedFrom(refusal("/in"), "https://k.test/r"),
        "https://k.test",
      )("x");
      expect(await accountRequiredUrl(own)).toBe("/in");
      const ok = await workerOnly(
        async (_p: string) => new Response("{}", { status: 200 }),
        "https://k.test",
      )("x");
      expect(ok.status).toBe(200);
    });

    it("the sync transport reads such a 403 as an ordinary one", async () => {
      for (const make of [foreign, redirected]) {
        const answer = await sendSync(
          PRODUCT,
          workerOnly(async () => make(), "https://k.test"),
          { method: "GET", path: `/${PRODUCT}/sync?cursor=0` },
        );
        expect(answer).toEqual({ status: 403 });
      }
    });

    it("a watched route does not tell its owner", async () => {
      const told: unknown[] = [];
      const res = await watched(foreign, told)("devices/keyring");
      expect(res.status).toBe(403);
      expect(told).toEqual([]);
    });

    it("a watched route tells its owner who was signed in when the call started", async () => {
      const told: unknown[] = [];
      let who: string | null = SUBJECT;
      const send = watchingAccountRequired(
        async (_p: string) => {
          who = OTHER;
          return refusal("https://k.test/in");
        },
        (u, s) => told.push([u, s]),
        { origin: "https://k.test", subject: () => who },
      );
      await send("devices/keyring");
      expect(told).toEqual([["https://k.test/in", SUBJECT]]);
    });
  });

  const hostile: Array<[string | undefined, string | null]> = [
    ["https://k.test/signin", "https://k.test/signin"],
    ["/signin?x=1", "https://k.test/signin?x=1"],
    [undefined, null],
    ["https://evil.test/signin", null],
    ["http://k.test/signin", null],
    ["https://k.test.evil.test/signin", null],
    ["https://k.test@evil.test/signin", null],
    ["//evil.test/signin", null],
    ["javascript:alert(1)", null],
    ["https://k.test/sign\nin", null],
  ];
  for (const [given, offered] of hostile)
    it(`the offered URL ${JSON.stringify(given)} reaches the app as ${JSON.stringify(offered)}`, async () => {
      const t = await tab(new World(), new Browser(), { current: SUBJECT });
      await t.api.attach();
      await t.api.accountRequired(given ?? null, SUBJECT);
      expect(t.events.find((e) => e.type === "signInOffered")).toEqual({
        type: "signInOffered",
        signInUrl: offered,
      });
      await t.host.close();
    });

  it("a request in flight when it arrives has its answer dropped", async () => {
    const w = new World();
    const request = w.request;
    let release: (() => void) | null = null;
    let hold = false;
    w.request = async (path, init) => {
      if (hold && path.startsWith("sync/ops")) {
        await new Promise<void>((r) => (release = r));
      }
      return request(path, init);
    };
    const t = await tab(w, new Browser(), { current: SUBJECT });
    await t.api.attach();
    hold = true;
    await t.config.set("theme", "dark");
    const flushing = t.api.flush();
    await waitFor(() => expect(release).not.toBeNull());
    await t.api.accountRequired(null, SUBJECT);
    expect(t.api.status().state).toBe("blocked");
    release!();
    await expect(flushing).resolves.toMatchObject({ state: "blocked" });
    // The answer changed nothing: the person's value is gone with the partition, the device's stays.
    expect(t.api.status().state).toBe("blocked");
    await t.host.close();
  });

  describe("reading the answer off a ring or file route", () => {
    it("takes the code and URL from either error shape, and leaves the body readable", async () => {
      const nested = refusal("https://k.test/in");
      expect(await accountRequiredUrl(nested)).toBe("https://k.test/in");
      expect(await nested.json()).toMatchObject({
        error: { code: "account_required" },
      });
      expect(await accountRequiredUrl(refusal())).toBeNull();
      expect(
        await accountRequiredUrl(
          new Response(
            JSON.stringify({ error: "account_required", signInUrl: "/in" }),
            { status: 403 },
          ),
        ),
      ).toBe("/in");
    });

    it("ignores every other answer", async () => {
      const other = (status: number, code: string) =>
        new Response(JSON.stringify({ error: { code } }), { status });
      expect(await accountRequiredUrl(other(403, "forbidden"))).toBeUndefined();
      expect(
        await accountRequiredUrl(other(401, "account_required")),
      ).toBeUndefined();
      expect(
        await accountRequiredUrl(new Response("nope", { status: 403 })),
      ).toBeUndefined();
      expect(
        await accountRequiredUrl(
          new Response("x".repeat(20_000), { status: 403 }),
        ),
      ).toBeUndefined();
    });

    it("tells its owner before the answer is returned", async () => {
      const told: Array<string | null> = [];
      const send = watched(() => refusal("https://k.test/in"), told);
      const res = await send("devices/keyring");
      expect(res.status).toBe(403);
      expect(told).toEqual(["https://k.test/in"]);
      await watched(
        () => new Response("{}", { status: 200 }),
        told,
      )("devices/keyring");
      expect(told).toHaveLength(1);
    });
  });
});
