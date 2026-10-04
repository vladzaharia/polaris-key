import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { defaultTheme } from "../src/components/theme.js";
import { useCapabilities, usePolarisKey } from "../src/react/hooks.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { SERVICE_SLUGS } from "../src/core/services.js";
import {
  emptyBridgeState,
  makeFakeBridge,
  makeFakeFetch,
  makeDoc,
  NOW_SEC,
  okBridgeState,
} from "./fixtures.js";

afterEach(cleanup);

function Mode(): JSX.Element {
  return <span data-testid="mode">{usePolarisKey().mode}</span>;
}

describe("PolarisKeyProvider — mode resolution", () => {
  it("mode='browser' constructs a browser adapter", async () => {
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        mode="browser"
        fetchImpl={makeFakeFetch(makeDoc())}
        now={() => NOW_SEC}
      >
        <Mode />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(within(container).getByTestId("mode").textContent).toBe("browser"),
    );
  });

  it("mode='desktop' with an explicit bridge constructs a desktop adapter", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        mode="desktop"
        bridge={bridge}
        now={() => NOW_SEC}
      >
        <Mode />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(within(container).getByTestId("mode").textContent).toBe("desktop"),
    );
  });

  it("mode='auto' picks desktop when a bridge prop is present", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        mode="auto"
        bridge={bridge}
        now={() => NOW_SEC}
      >
        <Mode />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(within(container).getByTestId("mode").textContent).toBe("desktop"),
    );
  });

  it("mode='auto' falls back to browser with no bridge", async () => {
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        mode="auto"
        fetchImpl={makeFakeFetch(null)}
        now={() => NOW_SEC}
      >
        <Mode />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(within(container).getByTestId("mode").textContent).toBe("browser"),
    );
  });

  it("an injected adapter bypasses mode resolution entirely", async () => {
    const bridge = makeFakeBridge(okBridgeState());
    // Inject a desktop adapter even though mode='browser' is requested.
    const adapter = (
      await import("../src/desktop/desktopAdapter.js")
    ).desktopAdapter({ bridge, now: () => NOW_SEC });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" mode="browser" adapter={adapter}>
        <Mode />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(within(container).getByTestId("mode").textContent).toBe("desktop"),
    );
    adapter.dispose();
  });

  it("disposes the adapter on unmount", async () => {
    const bridge = makeFakeBridge(okBridgeState());
    let disposed = false;
    const adapter = (
      await import("../src/desktop/desktopAdapter.js")
    ).desktopAdapter({ bridge, now: () => NOW_SEC });
    const realDispose = adapter.dispose.bind(adapter);
    adapter.dispose = () => {
      disposed = true;
      realDispose();
    };
    const { unmount } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <Mode />
      </PolarisKeyProvider>,
    );
    unmount();
    expect(disposed).toBe(true);
  });
});

describe("PolarisKeyProvider — theme variables reach portalled UI", () => {
  it("publishes the tokens on :root as well as the scoping wrapper", async () => {
    const { container, unmount } = render(
      <PolarisKeyProvider
        productSlug="acme"
        adapter={desktopAdapter({
          bridge: makeFakeBridge(emptyBridgeState()),
          now: () => NOW_SEC,
        })}
        theme={{ tokens: { accent: "rgb(1, 2, 3)" } }}
      >
        <Mode />
      </PolarisKeyProvider>,
    );
    // The wrapper copy scopes the brand so two providers can differ...
    const root = container.querySelector(
      "[data-polaris-key-root]",
    ) as HTMLElement;
    expect(root.style.getPropertyValue("--pk-accent")).toBe("rgb(1, 2, 3)");
    // ...and the :root copy is what a portalled dialog (mounted OUTSIDE that wrapper)
    // inherits from. Without it every portal renders unthemed.
    await waitFor(() =>
      expect(
        document.documentElement.style.getPropertyValue("--pk-accent"),
      ).toBe("rgb(1, 2, 3)"),
    );
    expect(document.documentElement.style.getPropertyValue("--pk-radius")).toBe(
      defaultTheme.tokens.radius,
    );

    // Only the keys this provider set are removed, so a host stylesheet is left alone.
    unmount();
    expect(document.documentElement.style.getPropertyValue("--pk-accent")).toBe(
      "",
    );
  });
});

// @pkey-feature core.discover
describe("PolarisKeyProvider — expectServices (D-21)", () => {
  it("forwards the configured expectation into a constructed browser adapter", async () => {
    function Caps(): JSX.Element {
      const caps = useCapabilities();
      return (
        <span data-testid="caps">
          {SERVICE_SLUGS.filter((s) => caps[s].enabled).join(",")}
        </span>
      );
    }
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        mode="browser"
        // Discovery 500s, so the expectation is what the client believes.
        fetchImpl={
          (async () =>
            new Response("nope", { status: 500 })) as unknown as typeof fetch
        }
        now={() => NOW_SEC}
        expectServices={["config", "update"]}
      >
        <Caps />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(within(container).getByTestId("caps").textContent).toBe(
        "config,update",
      ),
    );
  });

  it("defaults to license + config, never all-true", async () => {
    function Caps(): JSX.Element {
      const caps = useCapabilities();
      return (
        <span data-testid="caps">
          {SERVICE_SLUGS.filter((s) => caps[s].enabled).join(",")}
        </span>
      );
    }
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        mode="browser"
        fetchImpl={
          (async () =>
            new Response("nope", { status: 500 })) as unknown as typeof fetch
        }
        now={() => NOW_SEC}
      >
        <Caps />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(within(container).getByTestId("caps").textContent).toBe(
        "license,config",
      ),
    );
  });
});
