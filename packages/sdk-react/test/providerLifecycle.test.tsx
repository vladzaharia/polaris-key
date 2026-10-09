// @pkey-feature ui.kit config.local
//
// The Provider's lifetime (UK-47): StrictMode runs its effects twice on one adapter, and the
// adapter must come out of that alive (`onConfigChange` still fires); inline literals for the
// props do not rebuild the adapter (a rebuilt adapter is a new load, a new discovery fetch); a
// page cross-origin to the Worker without pins gets one developer-only console error and its
// users a neutral screen.
import { StrictMode, useContext, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { PolarisContext } from "../src/react/context.js";
import { LicenseGate } from "../src/components/LicenseGate.js";
import { resetDeveloperErrors } from "../src/core/devNotice.js";
import type { ConfigChange, PolarisAdapter } from "../src/core/index.js";
import {
  NOW_SEC,
  discoveryBody,
  emptyBridgeState,
  entry,
  makeFakeBridge,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetDeveloperErrors();
});

function Listen(props: { onChange: (c: ConfigChange) => void }): null {
  const ctx = useContext(PolarisContext)!;
  useEffect(
    () => ctx.adapter.config.onConfigChange("*", props.onChange),
    [ctx.adapter, props.onChange],
  );
  return null;
}

describe("StrictMode", () => {
  it("onConfigChange fires: the double effect does not leave a dead adapter", async () => {
    const bridge = makeFakeBridge(
      okBridgeState({ config: { "ui.theme": entry("default", "dark") } }),
    );
    const seen: ConfigChange[] = [];
    const onChange = (c: ConfigChange): void => void seen.push(c);
    let adapter: PolarisAdapter | undefined;
    function Grab(): null {
      adapter = useContext(PolarisContext)!.adapter;
      return null;
    }
    render(
      <StrictMode>
        <PolarisKeyProvider
          productSlug="acme"
          mode="desktop"
          bridge={bridge}
          now={() => NOW_SEC}
        >
          <Grab />
          <Listen onChange={onChange} />
        </PolarisKeyProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(adapter!.snapshot().phase).toBe("ready"));
    // Let StrictMode's simulated unmount settle: a deferred disposal must have been cancelled.
    await new Promise((r) => setTimeout(r, 10));
    seen.length = 0;
    bridge.push(
      okBridgeState({ config: { "ui.theme": entry("default", "light") } }),
    );
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.at(-1)).toMatchObject({ key: "ui.theme", value: "light" });
  });

  it("a real unmount still disposes the adapter", async () => {
    const bridge = makeFakeBridge(okBridgeState());
    let adapter: PolarisAdapter | undefined;
    function Grab(): null {
      adapter = useContext(PolarisContext)!.adapter;
      return null;
    }
    const { unmount } = render(
      <StrictMode>
        <PolarisKeyProvider
          productSlug="acme"
          mode="desktop"
          bridge={bridge}
          now={() => NOW_SEC}
        >
          <Grab />
        </PolarisKeyProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(adapter!.snapshot().phase).toBe("ready"));
    const dispose = vi.spyOn(adapter!, "dispose");
    unmount();
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });
});

describe("one load, one discovery fetch", () => {
  it("inline literals for every prop do not rebuild the adapter", async () => {
    const discoveries = vi.fn();
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/.well-known/polaris.json")) {
        discoveries();
        return new Response(discoveryBody(services("license", "config")));
      }
      return new Response(JSON.stringify({ authenticated: false, doc: null }));
    }) as typeof fetch;
    function App(): React.JSX.Element {
      return (
        <PolarisKeyProvider
          productSlug="acme"
          mode="browser"
          auth="cookie"
          // Every one of these is a new object or closure on every render.
          fetchImpl={
            ((...a: Parameters<typeof fetch>) =>
              fetchImpl(...a)) as typeof fetch
          }
          now={() => NOW_SEC}
          navigate={() => undefined}
          localOverrides={{ "ui.theme": "dark" }}
          expectServices={["license", "config"]}
        >
          <LicenseGate>
            <div data-testid="app" />
          </LicenseGate>
        </PolarisKeyProvider>
      );
    }
    const { rerender, container } = render(<App />);
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-gate]")).toBeTruthy(),
    );
    for (let i = 0; i < 5; i += 1) rerender(<App />);
    await new Promise((r) => setTimeout(r, 20));
    expect(discoveries).toHaveBeenCalledTimes(1);
  });
});

describe("a page cross-origin to the Worker without pins", () => {
  it("logs one developer-only console error and shows users a neutral screen", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
    const view = (
      <PolarisKeyProvider
        productSlug="acme"
        mode="browser"
        baseUrl="https://key.plrs.im"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      >
        <LicenseGate>
          <div />
        </LicenseGate>
      </PolarisKeyProvider>
    );
    // jsdom is at http://localhost:3000, a different origin from key.plrs.im.
    const first = render(view);
    await waitFor(() =>
      expect(first.container.querySelector("[data-polaris-gate]")).toBeTruthy(),
    );
    const mine = error.mock.calls.filter((c) =>
      String(c[0]).startsWith("[polaris-key]"),
    );
    expect(mine).toHaveLength(1);
    expect(String(mine[0]![0])).toMatch(/trust=\{\{ pinnedKeys \}\}/);
    // Users see no developer words and no raw code.
    const text = first.container.textContent ?? "";
    expect(text).not.toMatch(/pinnedKeys|invalid-options|web\.origins/);
    expect(fetchImpl).not.toHaveBeenCalled();
    // A second page load of the same mistake says it again only after a reset; not twice at once.
    cleanup();
    render(view);
    expect(
      error.mock.calls.filter((c) => String(c[0]).startsWith("[polaris-key]")),
    ).toHaveLength(1);
  });

  it("says nothing in a production build", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    try {
      const { container } = render(
        <PolarisKeyProvider
          productSlug="acme"
          mode="browser"
          baseUrl="https://key.plrs.im"
          fetchImpl={vi.fn() as unknown as typeof fetch}
        >
          <LicenseGate>
            <div />
          </LicenseGate>
        </PolarisKeyProvider>,
      );
      await waitFor(() =>
        expect(container.querySelector("[data-polaris-gate]")).toBeTruthy(),
      );
      expect(
        error.mock.calls.filter((c) =>
          String(c[0]).startsWith("[polaris-key]"),
        ),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a bearer page whose origin is not listed gets one developer-only error naming web.origins", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        mode="browser"
        baseUrl="https://key.plrs.im"
        trust={{ pinnedKeys: { k1: "A".repeat(43) } }}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      >
        <LicenseGate>
          <div />
        </LicenseGate>
      </PolarisKeyProvider>,
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        error.mock.calls.some((c) => /web\.origins/.test(String(c[0]))),
      ).toBe(true),
    );
    expect(container.textContent ?? "").not.toMatch(/web\.origins/);
    void emptyBridgeState;
  });
});
