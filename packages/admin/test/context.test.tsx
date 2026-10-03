import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  AdminProvider,
  invalidate,
  resetCache,
  useAdmin,
  useResource,
} from "../src/context.js";
import { qk } from "../src/console/data/queries.js";
import type { Me } from "../src/api.js";

/**
 * The chunk 2 adapter (docs/design/ADMIN.md §7.2): legacy views keep calling `useResource`, which
 * now reads through the one TanStack Query client with the structured keys of queries.ts.
 */

afterEach(cleanup);
beforeEach(() => resetCache());

const ME: Me = {
  sub: "u1",
  name: "Ada",
  email: "ada@x.io",
  csrf: "c",
  platformAdmin: false,
  products: [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }],
};

describe("useResource over the query client", () => {
  it("loads once and exposes data, loading and error", async () => {
    const fetcher = vi.fn(async () => ({ n: 1 }));
    const { result } = renderHook(() => useResource(["k1"], fetcher));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("two consumers of the same key share one fetch", async () => {
    const fetcher = vi.fn(async () => ({ n: 2 }));
    const { result: a } = renderHook(() => useResource(["shared"], fetcher));
    const { result: b } = renderHook(() => useResource(["shared"], fetcher));
    await waitFor(() => expect(a.current.data).toEqual({ n: 2 }));
    await waitFor(() => expect(b.current.data).toEqual({ n: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a rejection as an error string at once, with no silent retry", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useResource(["err"], fetcher));
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reload() refetches even when the data is fresh", async () => {
    let count = 0;
    const fetcher = vi.fn(async () => ({ n: ++count }));
    const { result } = renderHook(() => useResource(["rk"], fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the old data on screen while a refetch is in flight", async () => {
    let resolve: (v: { n: number }) => void = () => undefined;
    let first = true;
    const fetcher = vi.fn(() =>
      first
        ? ((first = false), Promise.resolve({ n: 1 }))
        : new Promise<{ n: number }>((r) => (resolve = r)),
    );
    const { result } = renderHook(() => useResource(["keep"], fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    act(() => result.current.reload());
    expect(result.current.data).toEqual({ n: 1 });
    expect(result.current.loading).toBe(false);
    await act(async () => resolve({ n: 2 }));
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
  });
});

describe("invalidate — prefix refetch", () => {
  it("refetches every query under the prefix", async () => {
    let count = 0;
    const list = vi.fn(async () => ({ n: ++count }));
    const record = vi.fn(async () => ({ id: "l1" }));
    renderHook(() => useResource(qk.licenses("djdl"), list));
    renderHook(() => useResource(qk.license("djdl", "l1"), record));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    act(() => invalidate(qk.licenses("djdl")));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
  });

  it("leaves keys outside the prefix alone", async () => {
    const tiers = vi.fn(async () => ({ v: "t" }));
    const licenses = vi.fn(async () => ({ v: "l" }));
    renderHook(() => useResource(qk.tiers("djdl"), tiers));
    renderHook(() => useResource(qk.licenses("djdl"), licenses));
    await waitFor(() => expect(tiers).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(licenses).toHaveBeenCalledTimes(1));
    act(() => invalidate(qk.tiers("djdl")));
    await waitFor(() => expect(tiers).toHaveBeenCalledTimes(2));
    expect(licenses).toHaveBeenCalledTimes(1);
  });

  it("scopes by product: another product's queries stay put", async () => {
    const a = vi.fn(async () => 1);
    const b = vi.fn(async () => 2);
    renderHook(() => useResource(qk.catalog("a"), a));
    renderHook(() => useResource(qk.catalog("b"), b));
    await waitFor(() => expect(b).toHaveBeenCalledTimes(1));
    act(() => invalidate(qk.product("a")));
    await waitFor(() => expect(a).toHaveBeenCalledTimes(2));
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("useAdmin", () => {
  it("returns the provided context value", () => {
    const { result } = renderHook(() => useAdmin(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <AdminProvider
          value={{ me: ME, product: "djdl", setProduct: () => undefined }}
        >
          {children}
        </AdminProvider>
      ),
    });
    expect(result.current.product).toBe("djdl");
    expect(result.current.me.name).toBe("Ada");
  });

  it("throws when used outside an AdminProvider", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect(() => renderHook(() => useAdmin())).toThrowError(
        /useAdmin used outside AdminProvider/,
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
