import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWrites, type WriteSpec } from "../../src/lib/writes.js";

const api = {
  save: vi.fn(async (_id: string) => ({ ok: true })),
  drop: vi.fn(async (_id: string) => ({ ok: true })),
};

const writes = createWrites({
  table: {
    save: {
      label: "save",
      invalidates: (id: string) => [
        { key: ["items"] },
        { key: ["item", id], exact: true },
      ],
    } satisfies WriteSpec<[string]>,
    drop: {
      label: "drop",
      invalidates: () => [{ key: ["items"] }],
      removes: (id: string) => [{ key: ["item", id] }],
      settle: () => [{ key: ["count"] }],
    } satisfies WriteSpec<[string]>,
  },
  api,
});

let client: QueryClient;
let unbind: () => void;

/** Seed `keys` and count refetches per key through an observer-less queryFn. */
function seed(...keys: unknown[][]) {
  for (const key of keys) client.setQueryData(key, 1);
}
const stale = (key: unknown[]) => client.getQueryState(key)?.isInvalidated;

beforeEach(() => {
  client = new QueryClient();
  unbind = writes.bindWriteInvalidation(client);
  api.save.mockReset().mockResolvedValue({ ok: true });
  api.drop.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => unbind());

describe("mutate", () => {
  it("invalidates after a success, with the declared targets", async () => {
    seed(["items"], ["item", "a"], ["item", "b"], ["other"]);
    const out = await writes.mutate("save", "a");
    expect(out).toEqual({ ok: true });
    expect(stale(["items"])).toBe(true);
    expect(stale(["item", "a"])).toBe(true);
    expect(stale(["item", "b"])).toBe(false);
    expect(stale(["other"])).toBe(false);
  });

  it("changes nothing in the cache after a refusal, and rethrows", async () => {
    const boom = new Error("refused");
    api.save.mockRejectedValue(boom);
    seed(["items"], ["item", "a"]);
    const onError = vi.fn();
    const w = createWrites({
      table: { save: { label: "s", invalidates: () => [{ key: ["items"] }] } },
      api: { save: api.save },
      onError,
    });
    const un = w.bindWriteInvalidation(client);
    await expect(w.mutate("save", "a")).rejects.toBe(boom);
    expect(stale(["items"])).toBe(false);
    expect(onError).toHaveBeenCalledWith(boom, expect.any(Set), "save", ["a"]);
    un();
  });

  it("removes what the write makes meaningless", async () => {
    seed(["item", "a"], ["item", "b"], ["items"]);
    await writes.mutate("drop", "a");
    expect(client.getQueryData(["item", "a"])).toBeUndefined();
    expect(client.getQueryData(["item", "b"])).toBe(1);
    expect(stale(["items"])).toBe(true);
  });

  it("settle waits for the refetch before the write resolves", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let fetches = 0;
    // An active observer, so the invalidation refetches; the second read is held open.
    const unsub = new QueryObserver(client, {
      queryKey: ["count"],
      queryFn: async () => {
        fetches++;
        if (fetches > 1) await gate;
        return fetches;
      },
    }).subscribe(() => undefined);
    await waitFor(() => expect(fetches).toBe(1));
    let resolved = false;
    const p = writes.mutate("drop", "a").then(() => {
      resolved = true;
    });
    await waitFor(() => expect(fetches).toBe(2));
    expect(resolved).toBe(false);
    release();
    await p;
    expect(resolved).toBe(true);
    expect(client.getQueryData(["count"])).toBe(2);
    unsub();
  });
});

describe("mutateEach", () => {
  it("invalidates once for many writes, and not at all when every one fails", async () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    const outcomes = await writes.mutateEach("save", [["a"], ["b"], ["c"]]);
    expect(outcomes).toEqual([null, null, null]);
    // One declaration: save declares two targets, applied once.
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockClear();
    api.save.mockRejectedValue(new Error("no"));
    const failed = await writes.mutateEach("save", [["a"], ["b"]]);
    expect(failed.every((e) => e instanceof Error)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a failure does not stop the rest, and its error takes its place", async () => {
    api.save
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce({ ok: true });
    const outcomes = await writes.mutateEach("save", [["a"], ["b"], ["c"]]);
    expect(outcomes.map((o) => o?.message ?? null)).toEqual([
      null,
      "second",
      null,
    ]);
    expect(api.save).toHaveBeenCalledTimes(3);
  });
});

describe("invalidationFor", () => {
  it("answers the declared targets, and null for a name that is not a write", () => {
    expect(writes.invalidationFor("save", ["a"])).toHaveLength(2);
    expect(writes.invalidationFor("nope", [])).toBeNull();
  });
});

describe("useWrite", () => {
  it("runs the write on the surrounding client and invalidates after success only", async () => {
    seed(["items"]);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => writes.useWrite("save"), { wrapper });
    api.save.mockRejectedValueOnce(new Error("refused"));
    await act(async () => {
      await result.current.mutateAsync(["a"]).catch(() => undefined);
    });
    expect(stale(["items"])).toBe(false);
    await act(async () => {
      await result.current.mutateAsync(["a"]);
    });
    expect(stale(["items"])).toBe(true);
  });

  it("toArgs, call and onSuccess/onError shape a hook without skipping the table", async () => {
    seed(["items"]);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const call = vi.fn(async (id: string) => ({ ok: true, id }));
    const { result } = renderHook(
      () =>
        writes.useWrite("save", {
          toArgs: (v: { id: string }): [string] => [v.id],
          call,
          onSuccess,
          onError,
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.mutateAsync({ id: "z" });
    });
    expect(call).toHaveBeenCalledWith("z");
    expect(api.save).not.toHaveBeenCalled();
    expect(stale(["items"])).toBe(true);
    expect(onSuccess.mock.calls[0]!.slice(0, 2)).toEqual([
      { ok: true, id: "z" },
      { id: "z" },
    ]);
    call.mockRejectedValueOnce(new Error("no"));
    await act(async () => {
      await result.current.mutateAsync({ id: "y" }).catch(() => undefined);
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
