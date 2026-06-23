import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AdminProvider, StatusProvider, invalidate, resetCache, useAdmin, useResource, useStatus } from "../src/context.js";
import type { Me } from "../src/api.js";

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

describe("useResource — cache + dedupe", () => {
  it("loads once and exposes data", async () => {
    const fetcher = vi.fn(async () => ({ n: 1 }));
    const { result } = renderHook(() => useResource("k1", fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("two consumers of the same key share one fetch", async () => {
    const fetcher = vi.fn(async () => ({ n: 2 }));
    const { result: a } = renderHook(() => useResource("shared", fetcher));
    const { result: b } = renderHook(() => useResource("shared", fetcher));
    await waitFor(() => expect(a.current.data).toEqual({ n: 2 }));
    await waitFor(() => expect(b.current.data).toEqual({ n: 2 }));
    // The in-flight promise is deduped — only one fetch despite two subscribers.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("captures a fetcher rejection as an error string", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useResource("err", fetcher));
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.data).toBeNull();
  });

  it("reload() forces a refetch even when data is cached", async () => {
    let count = 0;
    const fetcher = vi.fn(async () => ({ n: ++count }));
    const { result } = renderHook(() => useResource("rk", fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("invalidate — prefix refetch", () => {
  it("re-fetches every key under the prefix on next render", async () => {
    let count = 0;
    const fetcher = vi.fn(async () => ({ n: ++count }));
    const { result, rerender } = renderHook(() => useResource("licenses:djdl", fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    act(() => invalidate("licenses:"));
    rerender();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("leaves keys outside the prefix untouched", async () => {
    const a = vi.fn(async () => ({ v: "a" }));
    const b = vi.fn(async () => ({ v: "b" }));
    renderHook(() => useResource("tiers:djdl", a));
    const hb = renderHook(() => useResource("licenses:djdl", b));
    await waitFor(() => expect(a).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(b).toHaveBeenCalledTimes(1));
    act(() => invalidate("tiers:"));
    hb.rerender();
    await new Promise((r) => setTimeout(r, 10));
    // The licenses key was not under "tiers:" so it must not refetch.
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("useAdmin", () => {
  it("returns the provided context value", () => {
    const { result } = renderHook(() => useAdmin(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <AdminProvider value={{ me: ME, product: "djdl", setProduct: () => undefined }}>{children}</AdminProvider>
      ),
    });
    expect(result.current.product).toBe("djdl");
    expect(result.current.me.name).toBe("Ada");
  });

  it("throws when used outside an AdminProvider", () => {
    expect(() => renderHook(() => useAdmin())).toThrowError(/useAdmin used outside AdminProvider/);
  });
});

describe("useStatus", () => {
  it("announce updates the live status region", async () => {
    function Announcer(): JSX.Element {
      const { announce } = useStatus();
      return <button onClick={() => announce("Saved!", "ok")}>announce</button>;
    }
    render(
      <StatusProvider>
        <Announcer />
      </StatusProvider>,
    );
    act(() => screen.getByText("announce").click());
    const region = await screen.findByRole("status");
    expect(region.textContent).toBe("Saved!");
    expect(region.className).toContain("app-status-ok");
  });

  it("returns a no-op outside a StatusProvider (does not throw)", () => {
    const { result } = renderHook(() => useStatus());
    expect(() => result.current.announce("x")).not.toThrow();
    expect(result.current.message).toBe("");
  });
});
