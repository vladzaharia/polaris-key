// @pkey-feature ui.kit sync.saves
//
// K.2T (SAVES.R): the SaveConflict screen and the CloudSyncStatus transfer states follow
// `adapter.cloudSync.saves` when the host passes no input: a running write is `transferring` with
// the counted fraction, a failed one `transfer-failed`, a conflict is settled with `resolve`.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type {
  SaveConflict as Conflict,
  SaveOutcome,
  SaveTransfer,
} from "@polaris-key/client-core/sync";

import { CloudSyncStatus } from "../src/kit/statusDrive.js";
import { SaveConflict } from "../src/kit/syncScreens.js";
import { PolarisContext } from "../src/react/context.js";
import type { BrowserSaves, SaveTransferEvent } from "../src/core/cloudSync.js";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    },
  );
});
afterEach(cleanup);

const CONFLICT: Conflict = {
  id: "slot1",
  local: { metadata: { n: 2 }, size: 10 },
  remote: {
    id: "slot1",
    version: 3,
    metadata: { n: 1 },
    file: null,
    newerFormat: false,
  },
  serverVersion: 3,
  bothAvailable: true,
};

function fakeSaves() {
  const listeners = new Set<(e: SaveTransferEvent | null) => void>();
  let running: SaveTransfer[] = [];
  let conflicts: Conflict[] = [];
  const resolve = vi.fn(async (..._a: unknown[]): Promise<SaveTransfer> => {
    const done: Promise<SaveOutcome> = Promise.resolve({
      state: "done",
      id: "slot1",
      kept: "remote",
      version: 3,
    });
    return {
      id: "saves:slot1",
      state: "done",
      progress: { done: 0, total: 0 },
      pause() {},
      resume() {},
      cancel: async () => undefined,
      done,
    };
  });
  const saves = {
    transfers: () => running,
    conflicts: () => conflicts,
    dismissConflict: vi.fn((id: string) => {
      conflicts = conflicts.filter((c) => c.id !== id);
      listeners.forEach((l) => l(null));
    }),
    onTransfers: (l: (e: SaveTransferEvent | null) => void) => (
      listeners.add(l),
      () => listeners.delete(l)
    ),
    resolve,
  } as unknown as BrowserSaves;
  return {
    saves,
    resolve,
    emit: (e: SaveTransferEvent | null) => listeners.forEach((l) => l(e)),
    setRunning: (t: SaveTransfer[]) => (running = t),
    setConflicts: (c: Conflict[]) => (conflicts = c),
  };
}

const inProvider = (saves: BrowserSaves, ui: React.ReactNode) =>
  render(
    <PolarisContext.Provider
      value={{ adapter: { cloudSync: { saves } } as never }}
    >
      {ui}
    </PolarisContext.Provider>,
  );

const write = (done: number, total: number): SaveTransfer =>
  ({
    id: "saves:slot1",
    state: "running",
    progress: { done, total },
  }) as unknown as SaveTransfer;

describe("CloudSyncStatus follows the saves", () => {
  it("is transferring with the counted fraction while a write runs, never Synced", () => {
    const f = fakeSaves();
    f.setRunning([write(30_000_000, 60_000_000)]);
    const { container } = inProvider(f.saves, <CloudSyncStatus />);
    expect(container.textContent).toMatch(/30 MB/);
    expect(container.textContent).toMatch(/60 MB/);
    expect(container.textContent).not.toMatch(/Synced/i);
    const bar = container.querySelector("[role=progressbar]");
    expect(bar?.getAttribute("aria-valuenow")).toBe("50");
  });

  it("is transfer-failed after a failed write, until the next one starts", async () => {
    const f = fakeSaves();
    const { container } = inProvider(f.saves, <CloudSyncStatus />);
    act(() =>
      f.emit({ type: "transferFailed", id: "saves:slot1", code: "rejected" }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('button[data-key="common.tryAgain"]'),
      ).not.toBeNull(),
    );
  });

  it("leaves the host's input alone while nothing moves", () => {
    const f = fakeSaves();
    const { container } = inProvider(
      f.saves,
      <CloudSyncStatus input={{ cloudSync: { state: "offline" } }} />,
    );
    expect(container.textContent).toMatch(/offline/i);
  });
});

describe("SaveConflict follows the saves", () => {
  it("draws the pending conflict and settles it with resolve, then Done dismisses it", async () => {
    const f = fakeSaves();
    f.setConflicts([CONFLICT]);
    const bytes = vi.fn(() => Uint8Array.of(1, 2, 3));
    const { container } = inProvider(f.saves, <SaveConflict bytes={bytes} />);
    const keepThis = container.querySelector<HTMLButtonElement>(
      'button[data-key="saveConflict.keepThis"]',
    )!;
    expect(keepThis).not.toBeNull();
    fireEvent.click(keepThis);
    await waitFor(() =>
      expect(
        container.querySelector('button[data-key="common.done"]'),
      ).not.toBeNull(),
    );
    expect(f.resolve).toHaveBeenCalledWith(
      CONFLICT,
      "local",
      Uint8Array.of(1, 2, 3),
    );
    fireEvent.click(container.querySelector('button[data-key="common.done"]')!);
    expect(f.saves.dismissConflict).toHaveBeenCalledWith("slot1");
  });

  it("fails with Try again when the local copy is missing", async () => {
    const f = fakeSaves();
    f.setConflicts([CONFLICT]);
    const { container } = inProvider(f.saves, <SaveConflict />);
    fireEvent.click(
      container.querySelector('button[data-key="saveConflict.keepThis"]')!,
    );
    await waitFor(() =>
      expect(
        container.querySelector('button[data-key="common.tryAgain"]'),
      ).not.toBeNull(),
    );
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it("keeps the other copy without any bytes from the host", async () => {
    const f = fakeSaves();
    f.setConflicts([CONFLICT]);
    const { container } = inProvider(f.saves, <SaveConflict />);
    fireEvent.click(
      container.querySelector('button[data-key="saveConflict.keepOther"]')!,
    );
    await waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(1));
    expect(f.resolve.mock.calls[0]![1]).toBe("remote");
  });

  it("is the host's plain part when it passes its own input and nothing is pending", () => {
    const f = fakeSaves();
    const { container } = inProvider(
      f.saves,
      <SaveConflict
        input={{
          saveConflict: {
            step: "choose",
            local: {},
            remote: {},
            bothAvailable: false,
          },
        }}
      />,
    );
    fireEvent.click(
      container.querySelector('button[data-key="saveConflict.keepThis"]')!,
    );
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it("merges the host's card data and describe() over the binding (B1)", async () => {
    const f = fakeSaves();
    f.setConflicts([CONFLICT]);
    const { container } = inProvider(
      f.saves,
      <SaveConflict
        bytes={() => Uint8Array.of(1)}
        describe={(c) => ({
          local: { when: "today 9:00" },
          remote: { device: "Laptop" },
          newer: c.local.metadata["n"] === 2 ? "local" : "remote",
        })}
        input={{ saveConflict: { step: "choose", remote: { when: "Mon" } } }}
      />,
    );
    expect(container.textContent).toMatch(/today 9:00/);
    expect(container.textContent).toMatch(/Laptop/);
    expect(container.textContent).toMatch(/Mon/);
    expect(container.textContent).toMatch(/Newer/i);
    fireEvent.click(
      container.querySelector('button[data-key="saveConflict.keepOther"]')!,
    );
    await waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(1));
  });

  it("Cancel keeps the conflict pending, calls onDismiss and the strip asks for review (M2, M7)", async () => {
    const f = fakeSaves();
    f.setConflicts([CONFLICT]);
    const onDismiss = vi.fn();
    const { container } = inProvider(
      f.saves,
      <>
        <SaveConflict onDismiss={onDismiss} />
        <CloudSyncStatus />
      </>,
    );
    const strip = () =>
      container.querySelector('[data-component="CloudSyncStatus"]');
    // The screen is open: the strip defers to it (one live region, M5).
    expect(
      strip()?.querySelector('button[data-key="common.review"]'),
    ).toBeFalsy();
    fireEvent.click(
      container.querySelector('button[data-key="common.cancel"]')!,
    );
    expect(f.saves.dismissConflict).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        strip()?.querySelector('button[data-key="common.review"]'),
      ).not.toBeNull(),
    );
    // Review opens the save conflict, not RingChange (B2).
    fireEvent.click(
      strip()!.querySelector('button[data-key="common.review"]')!,
    );
    await waitFor(() =>
      expect(
        container.querySelector('button[data-key="saveConflict.keepThis"]'),
      ).not.toBeNull(),
    );
  });

  it("returns focus to the opener when the screen closes (M7)", async () => {
    const f = fakeSaves();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    f.setConflicts([CONFLICT]);
    const { container } = inProvider(f.saves, <SaveConflict />);
    fireEvent.click(
      container.querySelector('button[data-key="common.cancel"]')!,
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it("mounts the keeping status empty, then fills it (UX2-web 6)", async () => {
    const f = fakeSaves();
    f.setConflicts([CONFLICT]);
    const { container } = inProvider(f.saves, <SaveConflict />);
    const node = container.querySelector('[role="status"]')!;
    expect(node.textContent).toBe("");
    fireEvent.click(
      container.querySelector('button[data-key="saveConflict.keepOther"]')!,
    );
    await waitFor(() => expect(node.textContent).not.toBe(""));
    expect(container.querySelector('[role="status"]')).toBe(node);
  });
});

describe("CloudSyncStatus states", () => {
  it("is indeterminate with no counted bytes (M4)", () => {
    const f = fakeSaves();
    f.setRunning([write(0, 12_000_000)]);
    const { container } = inProvider(f.saves, <CloudSyncStatus />);
    expect(container.textContent).not.toMatch(/0 B/);
    const bar = container.querySelector("[role=progressbar]");
    expect(bar?.getAttribute("aria-valuenow")).toBeNull();
  });

  it("waits for a connection at once when offline (M3)", () => {
    const f = fakeSaves();
    f.setRunning([write(0, 12_000_000)]);
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { container } = inProvider(f.saves, <CloudSyncStatus />);
    expect(container.textContent).toMatch(/connection/i);
    spy.mockRestore();
  });

  it("Try again calls onRetry and clears the notice (B3)", async () => {
    const f = fakeSaves();
    const onRetry = vi.fn();
    const { container } = inProvider(
      f.saves,
      <CloudSyncStatus onRetry={onRetry} />,
    );
    act(() =>
      f.emit({ type: "transferFailed", id: "saves:slot1", code: "rejected" }),
    );
    const btn = await waitFor(() => {
      const b = container.querySelector('button[data-key="common.tryAgain"]');
      expect(b).not.toBeNull();
      return b!;
    });
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        container.querySelector('button[data-key="common.tryAgain"]'),
      ).toBeNull(),
    );
  });
});
