// @vitest-environment jsdom
//
// @pkey-feature sync.export
//
// `useCloudSync().export` (U-51.4): the hook forwards the options to the adapter's Cloud Sync
// client and returns what it answers, a rejection reaches the caller whole, and the hook keeps
// neither the Blob nor the sink: its own value holds neither after the call.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { PolarisContext } from "../src/react/context.js";
import { useCloudSync } from "../src/react/useCloudSync.js";
import type { PolarisAdapter } from "../src/core/index.js";
import type { CloudSyncClient } from "../src/core/cloudSync.js";

afterEach(cleanup);

function setup(exportFn: CloudSyncClient["export"]) {
  const client = {
    unsupported: null,
    status: () => ({ state: "idle", pending: 0 }),
    cloudEmpty: () => null,
    onStatus: () => () => undefined,
    onEvents: () => () => undefined,
    export: exportFn,
  } as unknown as CloudSyncClient;
  const adapter = { cloudSync: client } as unknown as PolarisAdapter;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PolarisContext.Provider value={{ adapter }}>
      {children}
    </PolarisContext.Provider>
  );
  return renderHook(() => useCloudSync(), { wrapper });
}

describe("useCloudSync().export", () => {
  it("passes the options through and answers the Blob, keeping nothing", async () => {
    const blob = new Blob(["zip"]);
    const fn = vi.fn(async () => ({
      bytes: 3,
      entries: 7,
      settings: 0,
      records: 0,
      files: 0,
      skipped: [],
      unsynced: 0,
      blob,
    }));
    const hook = setup(fn);
    const ctl = new AbortController();
    const sink = new WritableStream<Uint8Array>();
    let out: Awaited<ReturnType<typeof fn>> | undefined;
    await act(async () => {
      out = (await hook.result.current.export({
        includeRevisions: true,
        signal: ctl.signal,
        sink,
      })) as never;
    });
    expect(out?.blob).toBe(blob);
    expect(fn).toHaveBeenCalledWith({
      includeRevisions: true,
      signal: ctl.signal,
      sink,
    });
    // The hook's own value holds neither the Blob nor the stream.
    expect(JSON.stringify(Object.keys(hook.result.current))).not.toContain(
      "blob",
    );
    expect(Object.values(hook.result.current)).not.toContain(blob);
    expect(Object.values(hook.result.current)).not.toContain(sink);
  });

  it("rejects with what the client rejected with", async () => {
    const hook = setup(async () => {
      throw Object.assign(new Error("no"), { code: "sync-locked" });
    });
    await act(async () => {
      await expect(hook.result.current.export()).rejects.toMatchObject({
        code: "sync-locked",
      });
    });
  });
});
