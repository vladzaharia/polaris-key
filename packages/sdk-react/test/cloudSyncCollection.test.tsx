// @vitest-environment jsdom
//
// @pkey-feature sync.records
//
// U-46: `adapter.cloudSync.collection(name)` and `useCollection(name)` over the real browser host
// (server mode): the catalog's collections reach the machine, the verbs become wire operations,
// a refusal sends nothing, a pulled record re-renders the hook, a rebuild of the machine keeps
// the watch, a tab that is not the writer cannot write, and the other transports answer the typed
// unsupported.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  BrowserCloudSyncApi,
  clientOf,
  importMarker,
} from "../src/browser/cloudSync/api.js";
import { BrowserCloudSyncHost } from "../src/browser/cloudSync/host.js";
import { NotWriterError } from "../src/browser/cloudSync/collection.js";
import { memoryConnectState } from "../src/browser/connect/state.js";
import type {
  TabChannel,
  TabMessage,
} from "../src/browser/cloudSync/writer.js";
import { UnsupportedError } from "../src/core/caps.js";
import { lazyCloudSync, unsupportedCloudSync } from "../src/core/cloudSync.js";
import { LocalConfigEngine } from "../src/core/localConfig.js";
import { initialState } from "../src/core/types.js";
import { servicesFromList } from "../src/core/index.js";
import { withOverrides } from "../src/core/adapter.js";
import { createStore } from "../src/core/store.js";
import { PolarisContext } from "../src/react/context.js";
import { useCollection } from "../src/react/useCollection.js";
import type { PolarisAdapter } from "../src/core/index.js";
import { Hub, Locks, SUBJECT, World } from "./cloudSyncWorld.js";

afterEach(cleanup);

const PRODUCT = "djdl";
const CATALOG = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    collections: [
      { name: "prefs", conflict: "merge" },
      { name: "tags", conflict: "union" },
      { name: "notes.*", conflict: "lastWrite" },
    ],
  },
};

async function rig(
  locksOf?: Locks,
  doc: { values: Record<string, never> } = { values: {} },
) {
  const w = new World();
  const locks = locksOf ?? new Locks();
  const hub = new Hub();
  const ring = {
    hasRoot: () => false,
    subscribe: () => () => undefined,
    codec: () => null,
    forget: async () => undefined,
  };
  const host = new BrowserCloudSyncHost(
    {
      product: PRODUCT,
      request: (path, init) => w.request(path, init),
      ring,
      discovery: () => null,
      fetchSchema: async () => CATALOG as never,
      document: () => doc,
      enabled: () => true,
      store: memoryConnectState(),
      locks,
      writerLock: "w",
      stateLock: "s",
      channel: hub.channel(),
    },
    { catalog: CATALOG as never, encryption: "server" },
  );
  const store = createStore(
    initialState("browser", servicesFromList(["config", "sync"]), {}),
  );
  const config = new LocalConfigEngine({
    backend: {
      read: () => ({}),
      write: async () => undefined,
      persistent: () => true,
    },
    hostOverrides: {},
    snapshot: () => store.get(),
    subscribe: (cb) => store.subscribe(cb),
    applyOverrides: (m) => store.set((s) => withOverrides(s, m)),
    fetchSchema: async () => null,
    catalog: null,
  });
  const api = new BrowserCloudSyncApi({
    host,
    keyring: ring,
    config,
    subject: async () => SUBJECT,
    marker: importMarker("m", {
      getItem: () => null,
      setItem: () => undefined,
    }),
    signInOrigin: "https://k.test",
  });
  await host.start();
  await api.attach();
  return { w, host, api, client: clientOf(api, host, {} as never), locks, hub };
}

describe("cloudSync.collection", () => {
  it("sends field operations for a merge update, refuses wrong verbs without sending", async () => {
    const { w, host, client } = await rig();
    const before = w.pushes.length;
    const prefs = await client.collection("prefs");
    expect(
      prefs.update("main", { set: { volume: 3 }, remove: ["old"] }),
    ).toEqual({ ok: true });
    expect(prefs.get("main")).toEqual({
      value: { volume: 3 },
      from: "pending",
    });
    expect(prefs.put("main", 1)).toEqual({
      ok: false,
      error: "op_invalid_for_policy",
    });
    const nope = await client.collection("nope");
    expect(nope.put("a", 1)).toEqual({
      ok: false,
      error: "collection_unknown",
    });
    const notes = await client.collection("notes.work");
    expect(notes.put("n1", { t: "x" })).toEqual({ ok: true });
    await host.flush();
    const ops = w.pushes
      .slice(before)
      .flatMap((b) => b.mutations as Array<Record<string, unknown>>)
      .map((m) => [m.op, m.field]);
    expect(ops.sort()).toEqual(
      [
        ["removeField", "old"],
        ["set", undefined],
        ["setField", "volume"],
      ].sort(),
    );
    await host.close();
  });

  it("keeps the watch when the machine is rebuilt", async () => {
    const doc = { values: {} as Record<string, never> };
    const { w, host, client } = await rig(undefined, doc);
    const prefs = await client.collection("prefs");
    const seen: unknown[] = [];
    prefs.on((e) => seen.push(e));
    const old = host.machine;
    // A changed document rebuilds the machine at the next pump.
    (doc.values as Record<string, unknown>).x = 1;
    host.noteDocumentRefreshed();
    await host.touch();
    expect(host.machine).not.toBe(old);
    w.pull = () =>
      w.body({
        cursor: 5,
        changes: [{ record: ["prefs", "main"], version: 5, value: { a: 1 } }],
      });
    host.machine.setNetwork("online");
    await host.touch();
    expect(seen).toContainEqual({
      type: "change",
      ids: ["main"],
      origin: "remote",
    });
    expect(prefs.get("main")).toEqual({ value: { a: 1 }, from: "cloud" });
    await host.close();
  });

  it("a tab that is not the writer reads but cannot write", async () => {
    const first = await rig();
    const second = await rig(first.locks);
    expect(second.host.isWriter).toBe(false);
    const prefs = await second.client.collection("prefs");
    expect(() => prefs.update("main", { set: { a: 1 } })).toThrow(
      NotWriterError,
    );
    expect(prefs.ids()).toEqual([]);
    await first.host.close();
    await second.host.close();
  });
});

describe("useCollection", () => {
  it("refuses what cannot be sealed, and two hooks on one collection do not silence each other", async () => {
    const { w, host, client } = await rig();
    const adapter = { cloudSync: client } as unknown as PolarisAdapter;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PolarisContext.Provider value={{ adapter } as never}>
        {children}
      </PolarisContext.Provider>
    );
    const a = renderHook(() => useCollection("prefs"), { wrapper });
    const b = renderHook(() => useCollection("prefs"), { wrapper });
    await waitFor(() => expect(a.result.current.handle).not.toBeNull());
    await waitFor(() => expect(b.result.current.handle).not.toBeNull());
    const before = w.pushes.length;
    expect(
      a.result.current.handle!.update("m\u0000", { set: { v: 1 } }),
    ).toEqual({ ok: false, error: "value_invalid" });
    expect(
      a.result.current.handle!.update("main", { set: { v: Number.NaN } }),
    ).toEqual({ ok: false, error: "value_invalid" });
    await host.flush();
    expect(w.pushes.length).toBe(before);
    b.unmount();
    act(() => {
      a.result.current.handle!.update("main", { set: { v: 1 } });
    });
    await waitFor(() => expect(a.result.current.ids).toEqual(["main"]));
    await host.close();
  });

  it("re-renders on a pulled record and on this device's edit", async () => {
    const { w, host, client } = await rig();
    const adapter = { cloudSync: client } as unknown as PolarisAdapter;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PolarisContext.Provider value={{ adapter } as never}>
        {children}
      </PolarisContext.Provider>
    );
    const { result } = renderHook(() => useCollection("prefs"), { wrapper });
    await waitFor(() => expect(result.current.handle).not.toBeNull());
    expect(result.current.ids).toEqual([]);
    act(() => {
      result.current.handle!.update("main", { set: { v: 1 } });
    });
    await waitFor(() => expect(result.current.ids).toEqual(["main"]));
    expect(result.current.get("main")?.value).toEqual({ v: 1 });
    w.pull = () =>
      w.body({
        cursor: 9,
        changes: [
          { record: ["prefs", "main"], version: 8, value: { v: 1 } },
          { record: ["prefs", "zed"], version: 9, value: { z: 1 } },
        ],
      });
    host.machine.setNetwork("online");
    await act(async () => {
      await host.touch();
    });
    await waitFor(() => expect(result.current.ids).toEqual(["main", "zed"]));
    await host.close();
  });

  it("reports why it is unavailable on a transport without Cloud Sync", async () => {
    const adapter = {
      cloudSync: unsupportedCloudSync("runtime", "no device token"),
    } as unknown as PolarisAdapter;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PolarisContext.Provider value={{ adapter } as never}>
        {children}
      </PolarisContext.Provider>
    );
    const { result } = renderHook(() => useCollection("prefs"), { wrapper });
    expect(result.current.unsupported).toMatchObject({
      feature: "sync.records",
      reason: "runtime",
    });
    expect(result.current.handle).toBeNull();
  });
});

describe("the typed unsupported", () => {
  it("answers sync.records on the stub and on a product without the Sync service", async () => {
    await expect(
      unsupportedCloudSync("runtime", "x").collection("a"),
    ).rejects.toMatchObject({
      feature: "sync.records",
      reason: "runtime",
    });
    const lazy = lazyCloudSync({
      load: async () => {
        throw new Error("no");
      },
      enabled: () => false,
      dbName: "d",
    });
    const err = await lazy.collection("a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect(err).toMatchObject({ feature: "sync.records", reason: "product" });
  });
});
