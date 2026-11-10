// @pkey-feature sync.conflict
// `useConflicts()` (U-08.4): the open MergeRequests follow the adapter's events, the hook is a
// listener of its own, and `keep` settles a request and refreshes the list. `useCloudSync()`
// carries `cloudEmpty`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MergeOutcome, MergeRequest } from "@polaris-key/client-core/sync";

import { PolarisContext } from "../src/react/context.js";
import { useConflicts } from "../src/react/useConflicts.js";
import { useCloudSync } from "../src/react/useCloudSync.js";

afterEach(cleanup);

function fakeClient() {
  let open: MergeRequest[] = [];
  let empty: boolean | null = null;
  const events = new Set<(e: unknown[]) => void>();
  const status = new Set<() => void>();
  const keep = vi.fn(
    async (..._a: unknown[]): Promise<MergeOutcome> => ({
      ok: true,
      kept: "local",
      version: 4,
    }),
  );
  const listeners = new Set<unknown>();
  const client = {
    unsupported: null,
    status: () => ({
      state: "synced" as const,
      pending: 0,
      ...(open.length ? { conflicts: open.length } : {}),
    }),
    conflicts: () => open,
    cloudEmpty: () => empty,
    onConflict: (fn: unknown) => (
      listeners.add(fn),
      () => listeners.delete(fn)
    ),
    onEvents: (fn: (e: unknown[]) => void) => (
      events.add(fn),
      () => events.delete(fn)
    ),
    onStatus: (fn: () => void) => (status.add(fn), () => status.delete(fn)),
    saves: { onTransfers: () => () => undefined },
  };
  const request = {
    id: "w:notes/a",
    cause: "write",
    collection: "notes",
    record: "a",
    local: { value: "mine" },
    remote: { value: "theirs" },
    choices: ["local", "remote", "value"],
    state: "open",
    keep,
  } as unknown as MergeRequest;
  return {
    client,
    request,
    keep,
    listeners,
    open: (r: MergeRequest[]) => {
      open = r;
      events.forEach((f) => f([{ type: "conflictOpened" }]));
    },
    setEmpty: (v: boolean | null) => {
      empty = v;
      status.forEach((f) => f());
    },
  };
}

const wrap =
  (client: unknown) =>
  ({ children }: { children: ReactNode }) => (
    <PolarisContext.Provider
      value={{ adapter: { cloudSync: client } as never }}
    >
      {children}
    </PolarisContext.Provider>
  );

describe("useConflicts", () => {
  it("lists the open requests as they open, and is a listener while mounted", async () => {
    const f = fakeClient();
    const { result, unmount } = renderHook(() => useConflicts(), {
      wrapper: wrap(f.client),
    });
    expect(result.current.conflicts).toEqual([]);
    expect(f.listeners.size).toBe(1);
    act(() => f.open([f.request]));
    await waitFor(() => expect(result.current.conflicts).toEqual([f.request]));
    unmount();
    expect(f.listeners.size).toBe(0);
  });

  it("keep settles the request and reads the list again", async () => {
    const f = fakeClient();
    const { result } = renderHook(() => useConflicts(), {
      wrapper: wrap(f.client),
    });
    act(() => f.open([f.request]));
    await waitFor(() => expect(result.current.conflicts).toHaveLength(1));
    f.open([]);
    let out: MergeOutcome | undefined;
    await act(async () => {
      out = await result.current.keep(f.request, "local");
    });
    expect(f.keep).toHaveBeenCalledWith("local");
    expect(out).toMatchObject({ ok: true, kept: "local" });
    expect(result.current.conflicts).toEqual([]);
  });
});

describe("useCloudSync", () => {
  it("carries cloudEmpty", async () => {
    const f = fakeClient();
    const { result } = renderHook(() => useCloudSync(), {
      wrapper: wrap(f.client),
    });
    expect(result.current.cloudEmpty).toBeNull();
    act(() => f.setEmpty(true));
    await waitFor(() => expect(result.current.cloudEmpty).toBe(true));
  });
});
