import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useClaimKey,
  useMintPersonalToken,
  usePreviewKey,
} from "../src/portal/data.js";

/** A key the person types, and a token the Worker mints, do not linger in the MutationCache. */
describe("mutations that carry a secret", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the mutation cache holds no key or token once the write settles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"token":"pkeyp_MINTEDSECRET"}')),
    );
    const client = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(
      () => ({
        claim: useClaimKey(),
        preview: usePreviewKey(),
        mint: useMintPersonalToken(),
      }),
      { wrapper },
    );
    await act(async () => {
      await result.current.claim.mutateAsync("pkey_TYPEDSECRET");
      await result.current.preview.mutateAsync("pkey_TYPEDSECRET");
      await result.current.mint.mutateAsync({ label: "ci" });
    });
    // The mutation is collected once nothing observes it (the component that made it is gone).
    unmount();
    await waitFor(() =>
      expect(client.getMutationCache().getAll()).toHaveLength(0),
    );
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toMatch(
      /pkey[pa]?_[A-Z]+SECRET/,
    );
  });
});
