// @pkey-feature sync.saves
//
// `useSaves()` and `useTransfers()` over a stub of `adapter.cloudSync.saves`: the list follows the
// verbs, a typed unsupported is surfaced, and the transfers follow the events and take pause,
// resume and cancel by id.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  SaveOutcome,
  SaveSummary,
  SaveTransfer,
} from "@polaris-key/client-core/sync";
import { UnsupportedError } from "../src/core/caps.js";
import type { BrowserSaves, SaveTransferEvent } from "../src/core/cloudSync.js";
import { unsupportedCloudSync } from "../src/core/cloudSync.js";
import { PolarisContext } from "../src/react/context.js";
import { useSaves, useTransfers } from "../src/react/useSaves.js";

afterEach(cleanup);

const SUMMARY: SaveSummary = {
  id: "slot1",
  version: 2,
  metadata: { n: 1 },
  file: null,
  newerFormat: false,
};

function wrap(cloudSync: unknown) {
  return ({ children }: { children: ReactNode }) => (
    <PolarisContext.Provider value={{ adapter: { cloudSync } as never }}>
      {children}
    </PolarisContext.Provider>
  );
}

describe("useSaves", () => {
  it("lists, and re-lists when a write settles", async () => {
    let rows: SaveSummary[] = [];
    let finish: (o: SaveOutcome) => void = () => undefined;
    const handle = {
      id: "saves:slot1",
      state: "running",
      progress: { done: 0, total: 0 },
      done: new Promise<SaveOutcome>((r) => (finish = r)),
    } as unknown as SaveTransfer;
    const saves = {
      list: vi.fn(async () => rows),
      write: vi.fn(async () => handle),
      transfers: () => [],
      onTransfers: () => () => undefined,
    } as unknown as BrowserSaves;
    const { result } = renderHook(() => useSaves(), {
      wrapper: wrap({
        saves,
        unsupported: null,
        onEvents: () => () => undefined,
      }),
    });
    expect(result.current.saves).toBeNull();
    await act(async () => void (await result.current.list()));
    expect(result.current.saves).toEqual([]);
    await act(async () => {
      await result.current.write("slot1", Uint8Array.of(1), { n: 1 });
      rows = [SUMMARY];
      finish({ state: "cancelled" });
    });
    await waitFor(() => expect(result.current.saves).toEqual([SUMMARY]));
  });

  it("drops the list when the person signs out", async () => {
    let emit: (e: unknown[]) => void = () => undefined;
    const saves = {
      list: vi.fn(async () => [SUMMARY]),
      transfers: () => [],
      onTransfers: () => () => undefined,
    } as unknown as BrowserSaves;
    const { result } = renderHook(() => useSaves(), {
      wrapper: wrap({
        saves,
        unsupported: null,
        onEvents: (l: (e: unknown[]) => void) => ((emit = l), () => undefined),
      }),
    });
    await act(async () => void (await result.current.list()));
    expect(result.current.saves).toEqual([SUMMARY]);
    act(() => emit([{ type: "signedOut", reason: "subjectChanged" }]));
    expect(result.current.saves).toBeNull();
  });

  it("surfaces the typed unsupported where Cloud Sync cannot run", async () => {
    const client = unsupportedCloudSync("runtime", "no sync here");
    const { result } = renderHook(() => useSaves(), { wrapper: wrap(client) });
    expect(result.current.unsupported?.reason).toBe("runtime");
    await act(async () => {
      await expect(result.current.list()).rejects.toBeInstanceOf(
        UnsupportedError,
      );
    });
    expect(result.current.unsupported).toMatchObject({ reason: "runtime" });
  });
});

describe("useTransfers", () => {
  it("follows the transfer events and drives a transfer by id", async () => {
    const listeners = new Set<(e: SaveTransferEvent | null) => void>();
    const pause = vi.fn();
    const resume = vi.fn();
    const cancel = vi.fn(async () => undefined);
    let running: SaveTransfer[] = [];
    const saves = {
      transfers: () => running,
      onTransfers: (l: (e: SaveTransferEvent | null) => void) => (
        listeners.add(l),
        () => listeners.delete(l)
      ),
    } as unknown as BrowserSaves;
    const { result } = renderHook(() => useTransfers(), {
      wrapper: wrap({ saves }),
    });
    expect(result.current.transfers).toEqual([]);
    running = [
      {
        id: "saves:slot1",
        state: "running",
        progress: { done: 5, total: 10 },
        pause,
        resume,
        cancel,
      } as unknown as SaveTransfer,
    ];
    act(() => listeners.forEach((l) => l(null)));
    expect(result.current.transfers).toEqual([
      { id: "saves:slot1", state: "running", progress: { done: 5, total: 10 } },
    ]);
    result.current.pause("saves:slot1");
    result.current.resume("saves:slot1");
    await result.current.cancel("saves:slot1");
    expect([pause, resume, cancel].map((f) => f.mock.calls.length)).toEqual([
      1, 1, 1,
    ]);
    // An id that is not in flight is ignored.
    result.current.pause("nope");
    expect(pause).toHaveBeenCalledTimes(1);
  });
});
