// @pkey-feature ui.kit
//
// The drop-in <CloudSyncStatus /> inside the provider, with no input, shows "Sync stopped." and
// Sign in to sync once the SDK reads blocked with `account_required` (live, and after a
// relaunch), and Sign in to sync starts the kit's own sign-in when the app wires no handler.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { stubResizeObserver } from "./autoFixtures.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { CloudSyncStatus } from "../src/kit/statusDrive.js";
import { PolarisContext } from "../src/react/context.js";

beforeAll(stubResizeObserver);
afterEach(cleanup);

function fakeClient(initial: { state: string; reason?: string }) {
  let status = initial;
  const statusListeners = new Set<() => void>();
  const eventListeners = new Set<(e: { type: string }[]) => void>();
  return {
    client: {
      unsupported: null,
      status: () => status,
      onStatus: (l: () => void) => (
        statusListeners.add(l),
        () => statusListeners.delete(l)
      ),
      onEvents: (l: (e: { type: string }[]) => void) => (
        eventListeners.add(l),
        () => eventListeners.delete(l)
      ),
    },
    set(next: { state: string; reason?: string }) {
      status = next;
      statusListeners.forEach((l) => l());
    },
    emit(e: { type: string }) {
      eventListeners.forEach((l) => l([e]));
    },
  };
}

const inProvider = (cloudSync: object, ui: React.ReactNode) => {
  const signInWithOidc = vi.fn(async () => undefined);
  const view = render(
    <PolarisContext.Provider
      value={{ adapter: { cloudSync, signInWithOidc } as never }}
    >
      {ui}
    </PolarisContext.Provider>,
  );
  return { ...view, signInWithOidc };
};

describe("CloudSyncStatus drop-in: sync stopped", () => {
  it("shows the row live after a 403, with no input", async () => {
    const f = fakeClient({ state: "idle" });
    const { container } = inProvider(f.client, <CloudSyncStatus />);
    expect(
      container.querySelector('[data-key="cloudSync.syncStopped"]'),
    ).toBeNull();
    act(() => f.set({ state: "blocked", reason: "account_required" }));
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="cloudSync.syncStopped"]')
          ?.textContent,
      ).toBe("Sync stopped."),
    );
    expect(
      container
        .querySelector('[data-part="status"]')
        ?.getAttribute("data-status"),
    ).toBe("neutral");
    const button = container.querySelector(
      'button[data-key="cloudSync.signIn"]',
    );
    expect(button?.getAttribute("data-variant")).toBe("secondary");
  });

  it("keeps an empty status region mounted before the 403, and the text lands in it", async () => {
    const f = fakeClient({ state: "idle" });
    const { container } = inProvider(f.client, <CloudSyncStatus />);
    const live = container.querySelector<HTMLElement>("[data-pk-live]");
    expect(live?.getAttribute("role")).toBe("status");
    expect(live?.textContent).toBe("");
    act(() => f.set({ state: "blocked", reason: "account_required" }));
    await waitFor(() => expect(live?.textContent).toBe("Sync stopped."));
    // The same node, not a new one inserted already filled.
    expect(container.querySelector("[data-pk-live]")).toBe(live);
  });

  it("has no region where the SDK reports no Cloud Sync", () => {
    const { container } = render(<CloudSyncStatus />);
    expect(container.querySelector("[data-pk-live]")).toBeNull();
  });

  it("shows the row after a relaunch (the machine restored its block)", () => {
    const f = fakeClient({ state: "blocked", reason: "account_required" });
    const { container } = inProvider(f.client, <CloudSyncStatus />);
    expect(
      container.querySelector('[data-key="cloudSync.syncStopped"]'),
    ).not.toBeNull();
  });

  it("is quiet for another block, and the host's own input stands", () => {
    const f = fakeClient({ state: "blocked", reason: "forbidden" });
    const { container } = inProvider(f.client, <CloudSyncStatus />);
    expect(
      container.querySelector('[data-component="CloudSyncStatus"]')
        ?.textContent ?? "",
    ).not.toMatch(/Sync stopped/);
    cleanup();
    const g = fakeClient({ state: "blocked", reason: "account_required" });
    const host = inProvider(
      g.client,
      <CloudSyncStatus input={{ cloudSync: { state: "synced" } } as never} />,
    );
    expect(
      host.container.querySelector('[data-key="cloudSync.syncStopped"]'),
    ).toBeNull();
  });

  it("starts the kit's own sign-in when the app wires no handler", async () => {
    const f = fakeClient({ state: "blocked", reason: "account_required" });
    const { container } = inProvider(f.client, <CloudSyncStatus />);
    fireEvent.click(
      container.querySelector('button[data-key="cloudSync.signIn"]')!,
    );
    await waitFor(() =>
      expect(document.querySelector("dialog[open], dialog")).not.toBeNull(),
    );
  });

  it("leaves the press to the app when it passes onAction", () => {
    const f = fakeClient({ state: "blocked", reason: "account_required" });
    const onAction = vi.fn();
    const { container } = inProvider(
      f.client,
      <CloudSyncStatus onAction={onAction} />,
    );
    fireEvent.click(
      container.querySelector('button[data-key="cloudSync.signIn"]')!,
    );
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ key: "cloudSync.signIn" }),
    );
    expect(document.querySelector("dialog")).toBeNull();
  });
});
