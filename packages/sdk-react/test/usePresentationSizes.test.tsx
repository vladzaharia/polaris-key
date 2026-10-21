// @pkey-feature core.presentation
//
// B-151: a change to the icon's sizes alone makes the source revoke the blob URL it handed out;
// `usePresentationOf` must fetch the new pick instead of keep showing the revoked one.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ProductPresentation } from "@polaris-key/client-core/presentation";
import type { ReactPresentationSource } from "../src/core/presentation.js";
import { usePresentationOf } from "../src/react/usePresentation.js";

afterEach(cleanup);

const A = "a".repeat(64);
const S1 = "1".repeat(64);
const S2 = "2".repeat(64);

function member(sizeSha: string): ProductPresentation {
  return {
    icon: {
      sha256: A,
      sizes: [{ sha256: sizeSha }],
    },
  } as unknown as ProductPresentation;
}

describe("usePresentationOf icon revocation", () => {
  it("refetches the icon URL when only the sizes change", async () => {
    let current = member(S1);
    const listeners = new Set<(p: ProductPresentation | null) => void>();
    const source = {
      current: () => current,
      subscribe(fn: (p: ProductPresentation | null) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      // The URL names the size it was picked from, as the real source's per-sha blob URLs do.
      iconUrl: async () => `blob:${current.icon!.sizes[0]!.sha256}`,
    } as unknown as ReactPresentationSource;

    const { result } = renderHook(() => usePresentationOf(source));
    await waitFor(() => expect(result.current.iconUrl).toBe(`blob:${S1}`));

    current = member(S2);
    act(() => {
      for (const fn of listeners) fn(current);
    });
    await waitFor(() => expect(result.current.iconUrl).toBe(`blob:${S2}`));
  });
});
