// `useLatestVersion` + `<UpdatePrompt>`.
//
// The two behaviours worth pinning: the hook does not poll a service the product does not run
// (D-21, and a 404 loop is the failure mode), and the banner does NOT steal focus — an
// available update is information, not a blocker.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { UpdatePrompt } from "../src/components/UpdatePrompt.js";
import { useLatestVersion } from "../src/update/useLatestVersion.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisAdapter } from "../src/core/index.js";
import type { PolarisBridge } from "../src/desktop/bridge.js";
import {
  makeFakeBridge,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(cleanup);

/** `waitFor` treats a null RETURN as success — only a throw retries. This asserts inside the
 *  callback so the query actually waits for the element to appear. */
async function findEl<T extends Element>(
  container: HTMLElement,
  selector: string,
): Promise<T> {
  return (await waitFor(() => {
    const el = container.querySelector(selector);
    expect(el, selector).toBeTruthy();
    return el;
  })) as T;
}

const withUpdate = services("license", "config", "update");
const noUpdate = services("license", "config");

const newer = {
  version: "2.0.0",
  tag: "v2.0.0",
  url: "https://dl.example/2.0.0",
  updateAvailable: true,
};

function adapterWith(
  capabilities: ReturnType<typeof services>,
  invoke?: PolarisBridge["invoke"],
): PolarisAdapter {
  const bridge = makeFakeBridge(okBridgeState({ capabilities }));
  if (invoke) bridge.invoke = invoke;
  return desktopAdapter({
    bridge,
    now: () => NOW_SEC,
    expectServices: capabilities,
  });
}

function wrapperFor(adapter: PolarisAdapter) {
  return ({ children }: { children: ReactNode }) => (
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      {children}
    </PolarisKeyProvider>
  );
}

describe("useLatestVersion", () => {
  it("checks once on mount and reports the newest build", async () => {
    const invoke = vi.fn(async () => newer);
    const adapter = adapterWith(withUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(() => useLatestVersion(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.updateAvailable).toBe(true));
    expect(result.current.latest?.version).toBe("2.0.0");
    expect(invoke).toHaveBeenCalledWith("update", "check", {
      channel: undefined,
    });
    adapter.dispose();
  });

  it("does not poll at all when the product runs no Update service", async () => {
    const invoke = vi.fn(async () => newer);
    const adapter = adapterWith(noUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(() => useLatestVersion(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.enabled).toBe(false));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.latest).toBeNull();
    await act(async () => {
      expect(await result.current.check()).toBeNull();
    });
    adapter.dispose();
  });

  it("a host-supplied fetcher bypasses the adapter entirely — even with Update off", async () => {
    const invoke = vi.fn(async () => newer);
    const fetcher = vi.fn(async () => ({
      version: "9.9.9",
      tag: "v9.9.9",
      url: "https://internal/9.9.9",
      updateAvailable: true,
    }));
    const adapter = adapterWith(noUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(() => useLatestVersion({ fetcher }), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.latest?.version).toBe("9.9.9"));
    expect(invoke).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("passes the channel through and records a failure without throwing", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("feed down");
    });
    const adapter = adapterWith(withUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(() => useLatestVersion({ channel: "beta" }), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("update", "check", { channel: "beta" });
    expect(result.current.updateAvailable).toBe(false);
    adapter.dispose();
  });

  it("immediate:false defers the first check to the caller", async () => {
    const invoke = vi.fn(async () => newer);
    const adapter = adapterWith(withUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(
      () => useLatestVersion({ immediate: false }),
      { wrapper: wrapperFor(adapter) },
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.check();
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
});

describe("UpdatePrompt", () => {
  function renderPrompt(
    capabilities: ReturnType<typeof services>,
    check: () => Promise<typeof newer>,
    props: Partial<Parameters<typeof UpdatePrompt>[0]> = {},
  ) {
    const adapter = adapterWith(capabilities, (async () =>
      check()) as PolarisBridge["invoke"]);
    const utils = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <UpdatePrompt {...props} />
      </PolarisKeyProvider>,
    );
    return { ...utils, adapter };
  }

  it("renders a polite status banner that does NOT steal focus", async () => {
    const { container, adapter } = renderPrompt(withUpdate, async () => newer);
    const banner = await waitFor(() => within(container).getByRole("status"));
    expect(banner.getAttribute("aria-live")).toBe("polite");
    expect(banner.textContent).toContain("2.0.0");
    // An update is not a blocker: no dialog, and focus stays where the user put it.
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(document.body);
    adapter.dispose();
  });

  it("renders nothing when the running build is current", async () => {
    const { container, adapter } = renderPrompt(withUpdate, async () => ({
      ...newer,
      updateAvailable: false,
    }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.querySelector("[data-polaris-update]")).toBeNull();
    adapter.dispose();
  });

  it("renders nothing when the product runs no Update service", async () => {
    const { container, adapter } = renderPrompt(noUpdate, async () => newer);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.querySelector("[data-polaris-update]")).toBeNull();
    adapter.dispose();
  });

  it("dismiss removes the banner", async () => {
    const { container, adapter } = renderPrompt(withUpdate, async () => newer);
    const dismiss = await findEl<HTMLButtonElement>(
      container,
      "[data-polaris-update-dismiss]",
    );
    fireEvent.click(dismiss);
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-update]")).toBeNull(),
    );
    adapter.dispose();
  });

  it("onUpdate receives the live check instead of opening a window", async () => {
    const onUpdate = vi.fn();
    const { container, adapter } = renderPrompt(withUpdate, async () => newer, {
      onUpdate,
    });
    const action = await findEl<HTMLButtonElement>(
      container,
      "[data-polaris-update-action]",
    );
    fireEvent.click(action);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]?.[0]?.latest?.url).toBe(newer.url);
    adapter.dispose();
  });

  it("variant=dialog uses the blocking MessageScreen contract", async () => {
    const { container, adapter } = renderPrompt(withUpdate, async () => newer, {
      variant: "dialog",
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-update="dialog"]'),
      ).toBeTruthy(),
    );
    const dialog = within(container).getByRole("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const action = within(dialog).getByRole("button", {
      name: /get the update/i,
    });
    // A blocking screen moves focus to its action (WCAG 2.4.3).
    await waitFor(() => expect(document.activeElement).toBe(action));
    adapter.dispose();
  });

  it("a prompt slot fully replaces the UI", async () => {
    const { container, adapter } = renderPrompt(withUpdate, async () => newer, {
      slots: {
        prompt: (ctx) => (
          <div data-testid="custom">{ctx.latest?.version ?? "none"}</div>
        ),
      },
    });
    await waitFor(() =>
      expect(within(container).getByTestId("custom").textContent).toBe("2.0.0"),
    );
    adapter.dispose();
  });
});
