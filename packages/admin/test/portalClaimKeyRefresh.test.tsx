import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useClaimKey,
  useProduct,
  useProductDownloads,
} from "../src/portal/data.js";

/** Adding a key refreshes the claimed product's view and downloads, not just the lists. */
describe("useClaimKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refetches an open product view and its downloads", async () => {
    const hits: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        hits.push(`${init?.method ?? "GET"} ${path}`);
        return new Response("{}", { status: 200 });
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        product: useProduct("djdl"),
        downloads: useProductDownloads("djdl", true),
        claim: useClaimKey(),
      }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.product.isSuccess).toBe(true);
      expect(result.current.downloads.isSuccess).toBe(true);
    });
    const count = (needle: string) =>
      hits.filter((h) => h.startsWith("GET") && h.includes(needle)).length;
    expect(count("/api/products/djdl/downloads")).toBe(1);
    expect(count("/api/products/djdl")).toBe(2); // the view and the downloads path

    await act(async () => {
      await result.current.claim.mutateAsync("pkey_x");
    });
    await waitFor(() => {
      expect(count("/api/products/djdl/downloads")).toBe(2);
      expect(count("/api/products/djdl")).toBe(4);
    });
    expect(hits).toContain("POST /api/claim/license-key");
  });
});
