// @pkey-feature core.backend
//
// `usePolarisFetch()` under `<PolarisKeyProvider>`: `config.backend.origins` reaches the hook,
// the hook is stable across renders, and a bad origin is `invalid-options`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  PolarisKeyProvider,
  usePolarisFetch,
  type PolarisFetch,
} from "@polaris-key/react";
import type { PolarisAdapter } from "../src/core/index.js";
import { makeFakeBridge, emptyBridgeState } from "./fixtures.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function adapterWithHeaders(): PolarisAdapter {
  const adapter = desktopAdapter({
    bridge: {
      ...makeFakeBridge(emptyBridgeState()),
      version: 4,
      async invoke() {
        return { "X-PKey-License": "a.b.c", "X-PKey-Device": "dev-1" };
      },
    },
  });
  return adapter;
}

describe("usePolarisFetch", () => {
  it("sends to a configured origin with the headers, and refuses the rest", async () => {
    const seen: Headers[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return new Response("ok");
    });
    const adapter = adapterWithHeaders();
    const fetches: PolarisFetch[] = [];
    function Probe(): null {
      fetches.push(usePolarisFetch());
      return null;
    }
    const view = render(
      <PolarisKeyProvider
        config={{
          productSlug: "acme",
          adapter,
          backend: { origins: ["https://api.test"] },
        }}
      >
        <Probe />
      </PolarisKeyProvider>,
    );
    await waitFor(() => expect(fetches.length).toBeGreaterThan(0));
    const api = fetches.at(-1)!;
    await api("https://api.test/export");
    expect(seen[0]!.get("x-pkey-license")).toBe("a.b.c");
    await expect(api("https://evil.test/export")).rejects.toMatchObject({
      code: "backend-origin-not-allowed",
    });
    view.rerender(
      <PolarisKeyProvider
        config={{
          productSlug: "acme",
          adapter,
          backend: { origins: ["https://api.test"] },
        }}
      >
        <Probe />
      </PolarisKeyProvider>,
    );
    expect(fetches.at(-1)).toBe(api);
  });

  it("a bad backend origin is invalid-options at the provider", () => {
    const adapter = adapterWithHeaders();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <PolarisKeyProvider
          config={{
            productSlug: "acme",
            adapter,
            backend: { origins: ["http://api.test"] },
          }}
        >
          {null}
        </PolarisKeyProvider>,
      ),
    ).toThrow(/backend\.origins/);
    quiet.mockRestore();
  });
});
