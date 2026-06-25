import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { usePolarisKey } from "../src/react/hooks.js";
import { makeFakeBridge, makeFakeFetch, makeDoc, NOW_SEC } from "./fixtures.js";

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
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
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
    expect(within(container).getByTestId("mode").textContent).toBe("desktop");
  });

  it("mode='auto' picks desktop when a bridge prop is present", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
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
    expect(within(container).getByTestId("mode").textContent).toBe("desktop");
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
    const bridge = makeFakeBridge({ hasToken: true, doc: makeDoc() });
    // Inject a desktop adapter even though mode='browser' is requested.
    const adapter = (
      await import("../src/desktop/desktopAdapter.js")
    ).desktopAdapter({ bridge, now: () => NOW_SEC });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" mode="browser" adapter={adapter}>
        <Mode />
      </PolarisKeyProvider>,
    );
    expect(within(container).getByTestId("mode").textContent).toBe("desktop");
    adapter.dispose();
  });

  it("disposes the adapter on unmount", async () => {
    const bridge = makeFakeBridge({ hasToken: true, doc: makeDoc() });
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
